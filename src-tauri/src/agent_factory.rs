//! Settings to agent: the providers (with keys from the keyring), the default model or triage
//! routing, limits, guardrails, MCP servers, skills, and sub-agents a new thread is built with.
//!
//! Providers are built with `agent86_core::sdk::providers`' adapters, chosen and configured as the
//! CLI's provider factory chooses them, but from the app's own settings.

use crate::keys::{self, KeySource};
use crate::settings::{
    expand_home, home_dir, split_ref, Approval, Egress, Ingress, KeyUse, McpTransport,
    ProviderKind, ProviderSettings, Settings,
};
use crate::trust::ProjectContent;
use crate::unstable::{self, PriceTable};
use agent86_core::sdk::providers::{
    collect_completion, AnthropicConfig, AnthropicProvider, CompletionRequest, GoogleConfig,
    GoogleProvider, Message, OllamaConfig, OllamaProvider, OpenAiConfig, OpenAiProvider,
};
use agent86_core::sdk::{
    Agent, AgentBuilder, ApprovalMode, Builtins, EgressMode, GuardrailsConfig, IngressMode,
    McpServer, Model, Provider, Role, SubAgents,
};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A model ready to use.
pub struct ModelSetup {
    /// `provider:model`.
    pub reference: String,
    pub provider: Arc<dyn Provider>,
    pub context_window: u64,
    pub max_output_tokens: u32,
}

/// Build the model `reference` names, with its key. Fails with a message for the UI when the
/// provider is not set up or its key is missing.
pub fn model(
    settings: &Settings,
    reference: &str,
    keys: &dyn KeySource,
) -> Result<ModelSetup, String> {
    let prices = unstable::price_table(&settings.pricing, &settings.providers);
    model_priced(settings, reference, keys, &prices)
}

fn model_priced(
    settings: &Settings,
    reference: &str,
    keys: &dyn KeySource,
    prices: &PriceTable,
) -> Result<ModelSetup, String> {
    let (name, model) = split_ref(reference)
        .ok_or_else(|| format!("{reference:?} should be written provider:model."))?;
    let section = settings
        .providers
        .get(name)
        .ok_or_else(|| format!("Provider {name:?} is not set up (Settings, Providers)."))?;
    let key = keys::resolve(name, section, keys);
    let key_for_window = key.clone();
    if section.key_use() == KeyUse::Required && key.is_none() {
        let env = section
            .api_key_env
            .as_deref()
            .map(|env| format!(", or set {env}"))
            .unwrap_or_default();
        return Err(format!(
            "No API key for {name}. Add one in Settings, Providers (or `agent86 keys set {name}`{env})."
        ));
    }
    let max_output_tokens = max_output_tokens(settings, section);
    let provider = provider(
        name,
        section,
        model,
        reference,
        key,
        max_output_tokens,
        prices,
    )?;
    Ok(ModelSetup {
        reference: reference.trim().to_owned(),
        provider,
        context_window: context_window_with(settings, reference, |_, _, _| {
            unstable::discovered_context_window(
                name,
                section.kind,
                section.base_url.as_deref(),
                model,
                key_for_window,
            )
        }),
        max_output_tokens,
    })
}

/// The output cap: the provider's own, else the limit.
fn max_output_tokens(settings: &Settings, section: &ProviderSettings) -> u32 {
    section
        .max_tokens
        .filter(|&cap| cap > 0)
        .unwrap_or(settings.limits.max_output_tokens)
}

/// Tokens of context for `reference`: the user's figure (by the full ref, then the bare id), then
/// Ollama's `numCtx`, then what the provider's server reports (OpenRouter's catalogue, a vLLM
/// server's `max_model_len`, ...), then agent86's table. Blocking when it asks a server; call off
/// the UI thread.
pub fn context_window(settings: &Settings, reference: &str, keys: &dyn KeySource) -> u64 {
    context_window_with(settings, reference, |name, section, model| {
        let key = keys::resolve(name, section, keys);
        unstable::discovered_context_window(
            name,
            section.kind,
            section.base_url.as_deref(),
            model,
            key,
        )
    })
}

/// [`context_window`] with `discover` in place of asking the provider's server.
fn context_window_with(
    settings: &Settings,
    reference: &str,
    discover: impl FnOnce(&str, &ProviderSettings, &str) -> Option<u64>,
) -> u64 {
    let reference = reference.trim();
    let (name, model) = split_ref(reference).unwrap_or(("", reference));
    for key in [reference, model] {
        if let Some(&window) = settings.model.context_windows.get(key).filter(|&&w| w > 0) {
            return window;
        }
    }
    let Some(section) = settings.providers.get(name) else {
        return unstable::table_context_window(model);
    };
    match section.kind {
        ProviderKind::Ollama => section.num_ctx.filter(|&n| n > 0).map_or(8192, u64::from),
        // llama.cpp's window is a launch flag its API does not report.
        ProviderKind::Llamacpp => 8192,
        _ => {
            discover(name, section, model).unwrap_or_else(|| unstable::table_context_window(model))
        }
    }
}

fn seconds(name: &str, field: &str, value: f64) -> Result<Duration, String> {
    Duration::try_from_secs_f64(value)
        .map_err(|_| format!("{name}: the {field} should be a positive number of seconds."))
}

/// One provider adapter for `model`, as the CLI's factory would build it for this section.
fn provider(
    name: &str,
    section: &ProviderSettings,
    model: &str,
    reference: &str,
    key: Option<String>,
    max_tokens: u32,
    prices: &PriceTable,
) -> Result<Arc<dyn Provider>, String> {
    let connect_timeout = seconds(name, "connect timeout", section.connect_timeout_s)?;
    let read_timeout = seconds(name, "read timeout", section.read_timeout_s)?;
    let base_url = section
        .base_url
        .clone()
        .filter(|url| !url.trim().is_empty());
    let max_tokens = Some(max_tokens);
    let error = |error: agent86_core::sdk::providers::ProviderError| error.to_string();
    Ok(match section.kind {
        ProviderKind::Anthropic => {
            let mut config = AnthropicConfig {
                base_url,
                max_tokens,
                prompt_cache: section.prompt_cache,
                max_retries: section.max_retries,
                ..AnthropicConfig::default()
            };
            if let Some(env) = &section.api_key_env {
                config.api_key_env = env.clone();
            }
            Arc::new(
                AnthropicProvider::new(model, config, key)
                    .map_err(error)?
                    .with_pricing(prices.clone(), reference),
            )
        }
        ProviderKind::Google => Arc::new(
            GoogleProvider::new(
                model,
                GoogleConfig {
                    base_url,
                    api_key_env: section
                        .api_key_env
                        .clone()
                        .unwrap_or_else(|| "GEMINI_API_KEY".to_owned()),
                    config_name: name.to_owned(),
                    max_tokens,
                    connect_timeout,
                    read_timeout,
                    max_retries: section.max_retries,
                    store: section.store,
                },
                key,
            )
            .map_err(error)?
            .with_pricing(prices.clone(), reference),
        ),
        ProviderKind::Ollama => Arc::new(
            OllamaProvider::new(
                model,
                OllamaConfig {
                    base_url,
                    num_ctx: section.num_ctx.filter(|&n| n > 0),
                    max_tokens,
                    connect_timeout,
                    read_timeout,
                    max_retries: section.max_retries,
                },
            )
            .map_err(error)?,
        ),
        kind => {
            let (adapter, default_url) = match kind {
                ProviderKind::Vllm => ("vllm", Some("http://localhost:8000/v1")),
                ProviderKind::Lmstudio => ("lmstudio", Some("http://localhost:1234/v1")),
                ProviderKind::Llamacpp => ("llamacpp", Some("http://localhost:8080")),
                _ => ("openai", None),
            };
            let config = OpenAiConfig {
                base_url: base_url.or(default_url.map(str::to_owned)),
                api_key_env: section.api_key_env.clone(),
                config_name: name.to_owned(),
                adapter,
                require_key: section.key_use() == KeyUse::Required,
                max_tokens,
                connect_timeout,
                read_timeout,
                max_retries: section.max_retries,
                routing: section.routing.clone(),
                // LM Studio reports the window of the model it loaded, unless the user set one.
                live_window: kind == ProviderKind::Lmstudio,
            };
            Arc::new(
                OpenAiProvider::new(model, config, key)
                    .map_err(error)?
                    .with_pricing(prices.clone(), reference),
            )
        }
    })
}

/// What a new thread is built from, resolved before its actor starts, so a missing key or an
/// unset `${VAR}` fails the open with a clear message.
pub struct ThreadPlan {
    pub builder: AgentBuilder,
    /// What to tell the user about how it was built (a project server the settings shadow).
    pub notes: Vec<String>,
    /// The model the thread starts on (`provider:model`), or the frontier model under triage.
    pub model: String,
    pub context_window: u64,
}

/// An agent builder for a thread in `workspace` with `settings`: provider (or triage), limits,
/// guardrails, MCP servers, skills, and sub-agents, plus what `project` brings when the user
/// trusts it. The caller adds memory, a session to resume, and the thread's question callbacks.
pub fn thread_plan(
    settings: &Settings,
    workspace: PathBuf,
    project: Option<&ProjectContent>,
    keys: &dyn KeySource,
) -> Result<ThreadPlan, String> {
    let prices = unstable::price_table(&settings.pricing, &settings.providers);
    let default = model_priced(settings, &settings.model.default, keys, &prices)?;
    let limits = &settings.limits;
    let guardrails = &settings.guardrails;
    let mut builder = Agent::builder()
        .provider(default.provider.clone())
        .workspace(workspace)
        .system_prompt(unstable::system_prompt())
        .builtins(Builtins::All)
        .approval(match guardrails.approval {
            Approval::Ask => ApprovalMode::Ask,
            Approval::Auto => ApprovalMode::Auto,
            Approval::Deny => ApprovalMode::Deny,
        })
        .guardrails(GuardrailsConfig {
            approval: ApprovalMode::Ask,
            ingress: match guardrails.ingress {
                Ingress::Off => IngressMode::Off,
                Ingress::Warn => IngressMode::Warn,
                Ingress::Block => IngressMode::Block,
            },
            egress: match guardrails.egress {
                Egress::Off => EgressMode::Off,
                Egress::Warn => EgressMode::Warn,
                Egress::Redact => EgressMode::Redact,
            },
            scan_observations: guardrails.scan_observations,
        })
        .context_window(default.context_window)
        .max_output_tokens(default.max_output_tokens)
        .max_steps(limits.max_steps)
        .max_cost_usd(limits.max_cost_usd)
        .max_wall_clock_s(limits.max_wall_clock_s)
        .tool_timeout(Duration::from_secs(limits.tool_timeout_s));

    // The default model is named too, so a specialist whose `model:` line names it resolves.
    builder = builder.model(default.reference.clone(), named(&default));
    let mut model = default.reference.clone();
    let mut window = default.context_window;
    if let Some(triage) = &settings.model.triage {
        for reference in [&triage.cheap, &triage.frontier] {
            if reference.trim() != default.reference {
                let setup = model_priced(settings, reference, keys, &prices)?;
                builder = builder.model(setup.reference.clone(), named(&setup));
            }
        }
        builder = builder.triage(triage.cheap.trim(), triage.frontier.trim());
        model = triage.frontier.trim().to_owned();
        window = context_window(settings, &model, keys);
    }

    let mut notes = Vec::new();
    for (name, server) in settings.mcp_servers.iter().filter(|(_, s)| s.enabled) {
        builder = builder.mcp_server(name, mcp_server(name, server, keys)?);
    }
    if let Some(project) = project {
        for (name, server) in project.mcp_servers.iter().filter(|(_, s)| s.enabled) {
            if settings.mcp_servers.contains_key(name) {
                notes.push(format!(
                    "The project's MCP server {name} was not started: your settings have one of that name."
                ));
                continue;
            }
            builder = builder.mcp_server(name, mcp_server(name, server, keys)?);
        }
    }
    // A project's skills come first: an earlier folder wins a name both hold, as in agent86.
    if settings.skills.enabled {
        for dir in project.map(ProjectContent::skill_dirs).unwrap_or_default() {
            builder = builder.skills_dir(dir);
        }
    }
    for dir in skill_dirs(settings) {
        builder = builder.skills_dir(dir);
    }
    if let Some(mut subagents) = subagents(settings) {
        // A later folder replaces a specialist of the same name: the project's win, as in agent86.
        if let Some(dir) = project.and_then(ProjectContent::agents_dir) {
            subagents = subagents.specialists_dir(dir);
        }
        builder = builder.subagents(subagents);
    }
    if let Some(dir) = settings.trace.dir() {
        // The SDK refuses to build when the folder cannot be made; the thread runs unrecorded.
        match std::fs::create_dir_all(&dir) {
            Ok(()) => builder = builder.trace_dir(dir),
            Err(error) => notes.push(format!(
                "Activity is not recorded: {} could not be created ({error}).",
                dir.display()
            )),
        }
    }
    Ok(ThreadPlan {
        builder,
        notes,
        model,
        context_window: window,
    })
}

fn named(setup: &ModelSetup) -> Model {
    Model::new(setup.provider.clone())
        .context_window(setup.context_window)
        .max_output_tokens(setup.max_output_tokens)
}

fn mcp_server(
    name: &str,
    server: &crate::settings::McpServerSettings,
    keys: &dyn KeySource,
) -> Result<McpServer, String> {
    let expand = |text: &str| {
        expand_vars(text, keys).map_err(|problem| format!("MCP server {name}: {problem}"))
    };
    let mut built = match server.transport {
        McpTransport::Stdio => McpServer::stdio(
            expand(&server.command)?,
            server
                .args
                .iter()
                .map(|arg| expand(arg))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        McpTransport::Http => McpServer::http(expand(&server.url)?),
        McpTransport::Sse => McpServer::sse(expand(&server.url)?),
    };
    for (key, value) in &server.env {
        built = built.env(key, expand(value)?);
    }
    for (key, value) in &server.headers {
        built = built.header(key, expand(value)?);
    }
    Ok(built
        .connect_timeout(seconds(name, "connect timeout", server.connect_timeout_s)?)
        .call_timeout(seconds(name, "call timeout", server.call_timeout_s)?)
        .max_result_chars(server.max_result_chars))
}

/// `text` with each `${NAME}` replaced by environment variable `NAME`, else the keyring entry
/// `NAME` (service `agent86`), as the CLI expands MCP values. Fails on the first name found in
/// neither. Anything not of that form (`$HOME`, `${not a name}`) is left as written.
pub fn expand_vars(text: &str, keys: &dyn KeySource) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let name = after.find('}').map(|end| &after[..end]).filter(|name| {
            let mut chars = name.chars();
            chars
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        });
        match name {
            Some(name) => {
                let value = keys.env(name).or_else(|| keys.keyring(name)).ok_or_else(|| {
                    format!("'${{{name}}}' is not set (checked the environment, then the OS keyring)")
                })?;
                out.push_str(&value);
                rest = &after[name.len() + 1..];
            }
            None => {
                out.push_str("${");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// The skill folders a thread searches, highest precedence first: `~/.agent86/skills`,
/// `~/.claude/skills`, then the user's own. Only those that exist. A project's own skills wait
/// for project trust (M6).
pub fn skill_dirs(settings: &Settings) -> Vec<PathBuf> {
    if !settings.skills.enabled {
        return Vec::new();
    }
    let mut dirs = Vec::new();
    if let Some(home) = home_dir() {
        dirs.push(home.join(".agent86").join("skills"));
        dirs.push(home.join(".claude").join("skills"));
    }
    dirs.extend(settings.skills.paths.iter().map(|path| expand_home(path)));
    dirs.into_iter().filter(|dir| dir.is_dir()).collect()
}

/// Sub-agents: agent86's built-in specialists and the user's own in `~/.agent86/agents`.
pub fn subagents(settings: &Settings) -> Option<SubAgents> {
    let agents = &settings.agents;
    if !agents.enabled {
        return None;
    }
    let mut subagents = SubAgents::new()
        .max_depth(agents.max_depth)
        .max_steps(agents.max_steps)
        .max_parallel(agents.max_parallel);
    if let Some(dir) = home_dir()
        .map(|home| home.join(".agent86").join("agents"))
        .filter(|dir| dir.is_dir())
    {
        subagents = subagents.specialists_dir(dir);
    }
    Some(subagents)
}

/// Send `reference` a one-line request, to check the URL, the key, and the model name. Returns a
/// short description of the reply.
pub async fn test_model(
    settings: &Settings,
    reference: &str,
    keys: &dyn KeySource,
) -> Result<String, String> {
    let setup = model(settings, reference, keys)?;
    let started = Instant::now();
    let request = CompletionRequest {
        model: setup.provider.model().to_owned(),
        messages: vec![Message {
            role: Role::User,
            content: "Reply with the single word: ready".to_owned(),
            tool_calls: Vec::new(),
            tool_call_id: None,
            name: None,
        }],
        tools: Vec::new(),
        temperature: 0.0,
        // Room for a reasoning model's thinking before the word.
        max_tokens: Some(512),
        stream: true,
    };
    let reply = collect_completion(setup.provider.model(), setup.provider.stream(request))
        .await
        .map_err(|error| error.to_string())?;
    let elapsed = started.elapsed().as_secs_f64();
    let text: String = reply.text.trim().chars().take(60).collect();
    Ok(if text.is_empty() {
        format!("{} answered in {elapsed:.1} s.", setup.reference)
    } else {
        format!("{} answered “{text}” in {elapsed:.1} s.", setup.reference)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::testing::FakeKeys;
    use crate::settings::{preset, McpServerSettings, Triage};

    fn settings() -> Settings {
        let mut settings = Settings::default();
        settings
            .providers
            .insert("vllm".into(), preset("vllm").unwrap());
        settings
            .providers
            .insert("openrouter".into(), preset("openrouter").unwrap());
        settings.model.default = "vllm:qwen".into();
        settings
    }

    #[test]
    fn builds_the_default_model_without_a_key_for_a_local_server() {
        let setup = model(&settings(), "vllm:qwen", &FakeKeys::default()).unwrap();
        assert_eq!(setup.reference, "vllm:qwen");
        assert_eq!(setup.provider.model(), "qwen");
        assert_eq!(setup.max_output_tokens, 8192);
    }

    #[test]
    fn a_required_key_must_be_found() {
        let err = model(&settings(), "openrouter:x/y", &FakeKeys::default())
            .err()
            .unwrap();
        assert!(err.contains("agent86 keys set openrouter"), "{err}");
        assert!(err.contains("OPENROUTER_API_KEY"), "{err}");
        let keys = FakeKeys::keyring(&[("openrouter", "sk-or-123456")]);
        assert!(model(&settings(), "openrouter:x/y", &keys).is_ok());
        assert!(model(&settings(), "groq:x", &keys)
            .err()
            .unwrap()
            .contains("not set up"));
    }

    #[test]
    fn context_windows_come_from_settings_then_ollama_then_the_server_then_the_table() {
        let never = |_: &str, _: &ProviderSettings, _: &str| -> Option<u64> {
            panic!("the server is not asked when the window is known")
        };
        let mut settings = settings();
        settings.model.context_windows.insert("qwen".into(), 65_536);
        assert_eq!(context_window_with(&settings, "vllm:qwen", never), 65_536);
        settings
            .model
            .context_windows
            .insert("vllm:qwen".into(), 131_072);
        assert_eq!(context_window_with(&settings, "vllm:qwen", never), 131_072);
        let mut ollama = preset("ollama").unwrap();
        ollama.num_ctx = Some(16_384);
        settings.providers.insert("ollama".into(), ollama);
        assert_eq!(
            context_window_with(&settings, "ollama:llama3.1:8b", never),
            16_384
        );
        // What the server reports beats the table's guess from the name.
        let reported = context_window_with(
            &settings,
            "openrouter:anthropic/claude-opus-5.5",
            |name, section, model| {
                assert_eq!(name, "openrouter");
                assert_eq!(section.kind, ProviderKind::Openai);
                assert_eq!(model, "anthropic/claude-opus-5.5");
                Some(1_000_000)
            },
        );
        assert_eq!(reported, 1_000_000);
        // A server that does not answer leaves the table.
        assert_eq!(
            context_window_with(&settings, "openrouter:anthropic/x", |_, _, _| None),
            unstable::table_context_window("anthropic/x")
        );
    }

    #[test]
    fn a_plan_carries_triage_and_its_frontier_model() {
        let mut settings = settings();
        settings.model.triage = Some(Triage {
            cheap: "vllm:small".into(),
            frontier: "vllm:big".into(),
        });
        let dir = tempfile::tempdir().unwrap();
        let plan = thread_plan(&settings, dir.path().into(), None, &FakeKeys::default()).unwrap();
        assert_eq!(plan.model, "vllm:big");
        // The builder accepts what the plan named: both triage models are registered.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _entered = runtime.enter();
        assert!(plan.builder.build().is_ok());
    }

    #[test]
    fn an_unset_variable_in_an_mcp_server_fails_the_plan() {
        let mut settings = settings();
        settings.mcp_servers.insert(
            "remote".into(),
            McpServerSettings {
                transport: McpTransport::Http,
                url: "https://mcp.example/v1".into(),
                headers: [("Authorization".to_owned(), "Bearer ${TOKEN_X}".to_owned())].into(),
                ..McpServerSettings::default()
            },
        );
        let dir = tempfile::tempdir().unwrap();
        let err = thread_plan(&settings, dir.path().into(), None, &FakeKeys::default())
            .err()
            .unwrap();
        assert!(
            err.contains("MCP server remote") && err.contains("${TOKEN_X}"),
            "{err}"
        );
        settings.mcp_servers.get_mut("remote").unwrap().enabled = false;
        assert!(thread_plan(&settings, dir.path().into(), None, &FakeKeys::default()).is_ok());
    }

    #[test]
    fn variables_expand_from_the_environment_then_the_keyring() {
        let mut keys = FakeKeys::keyring(&[("TOKEN", "from-keyring"), ("OTHER", "o")]);
        assert_eq!(
            expand_vars("Bearer ${TOKEN}", &keys).unwrap(),
            "Bearer from-keyring"
        );
        keys.env.insert("TOKEN".into(), "from-env".into());
        assert_eq!(
            expand_vars("${TOKEN}-${OTHER}", &keys).unwrap(),
            "from-env-o"
        );
        assert_eq!(
            expand_vars("$HOME ${not a name} ${", &keys).unwrap(),
            "$HOME ${not a name} ${"
        );
        assert!(expand_vars("${MISSING}", &keys).is_err());
    }
}
