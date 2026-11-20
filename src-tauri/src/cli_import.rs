//! The one-time import of the agent86 CLI's `~/.agent86/config.toml` into the app's settings
//! (docs/PROJECT_PLAN.md D3, §4).
//!
//! The file is parsed here with `toml`, not with agent86-core's config loader (which has no
//! stability promise), and laid over agent86's built-in defaults as the CLI lays it: settings the
//! file leaves out keep agent86's values, and a provider section is merged with the built-in
//! section of the same name. Only the user file is read; a project's `.agent86/config.toml` is
//! not, and `AGENT86_MODEL` is not applied.

use crate::settings::{
    preset, split_ref, Approval, Egress, Ingress, KeyUse, McpServerSettings, McpTransport,
    ModelPrice, ProviderKind, ProviderSettings, Settings, Triage,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// What importing a CLI config would give, for the UI to show before it is kept.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportPreview {
    pub path: String,
    pub settings: Settings,
    /// What was left out or needs a look, in words.
    pub notes: Vec<String>,
}

/// The CLI's user config: `~/.agent86/config.toml`.
pub fn cli_config_path() -> Option<PathBuf> {
    crate::settings::home_dir().map(|home| home.join(".agent86").join("config.toml"))
}

/// Read and convert the CLI config at `path`.
pub fn preview(path: &Path) -> Result<ImportPreview, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let (mut settings, notes) =
        convert(&text).map_err(|error| format!("{}: {error}", path.display()))?;
    settings.imported_from = Some(path.display().to_string());
    Ok(ImportPreview {
        path: path.display().to_string(),
        settings,
        notes,
    })
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct File {
    model: FileModel,
    providers: BTreeMap<String, FileProvider>,
    limits: FileLimits,
    guardrails: FileGuardrails,
    mcp: FileMcp,
    mcp_servers: BTreeMap<String, FileMcpServer>,
    agents: FileAgents,
    skills: FileSkills,
    memory: FileMemory,
    tools: FileTools,
    pricing: FilePricing,
    sandbox: Option<toml::Value>,
    observability: Option<toml::Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct FileModel {
    default: Option<String>,
    router: Option<String>,
    route: FileRoute,
    context_window: BTreeMap<String, u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct FileRoute {
    cheap: Option<String>,
    frontier: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct FileProvider {
    api_key_env: Option<String>,
    base_url: Option<String>,
    adapter: Option<String>,
    num_ctx: Option<u32>,
    connect_timeout_s: Option<f64>,
    read_timeout_s: Option<f64>,
    max_retries: Option<u32>,
    max_tokens: Option<u32>,
    prompt_cache: Option<bool>,
    store: Option<bool>,
    routing: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct FileLimits {
    max_steps: Option<u32>,
    max_cost_usd: Option<f64>,
    max_wall_clock_s: Option<u64>,
    tool_timeout_s: Option<u64>,
    max_output_tokens: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct FileGuardrails {
    approval: Option<Approval>,
    ingress: Option<Ingress>,
    egress: Option<Egress>,
    scan_observations: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct FileMcp {
    enabled: Option<bool>,
    servers: BTreeMap<String, FileMcpServer>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct FileMcpServer {
    command: Option<String>,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    url: Option<String>,
    headers: BTreeMap<String, String>,
    transport: Option<String>,
    enabled: Option<bool>,
    connect_timeout_s: Option<f64>,
    call_timeout_s: Option<f64>,
    max_result_chars: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct FileAgents {
    enabled: Option<bool>,
    max_depth: Option<u32>,
    max_steps: Option<u32>,
    max_parallel: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct FileSkills {
    enabled: Option<bool>,
    paths: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct FileMemory {
    enabled: Option<bool>,
    path: Option<String>,
    embeddings: Option<String>,
    hf_offline: Option<bool>,
    retention_max_episodes: Option<i64>,
    retention_max_sessions: Option<i64>,
    retention_max_age_days: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct FileTools {
    mention_max_bytes: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct FilePricing {
    models: BTreeMap<String, ModelPrice>,
}

macro_rules! take {
    ($target:expr, $value:expr) => {
        if let Some(value) = $value {
            $target = value;
        }
    };
}

/// The CLI config `text` as app settings, with notes on what was left out.
pub fn convert(text: &str) -> Result<(Settings, Vec<String>), String> {
    let file: File = toml::from_str(text).map_err(|error| error.to_string())?;
    let mut notes = Vec::new();
    let mut settings = Settings::default();

    // Models: the CLI's built-in default model when the file names none.
    let model = &file.model;
    settings.model.default = model
        .default
        .clone()
        .unwrap_or_else(|| "anthropic:claude-opus-4-8".to_owned());
    if model.router.as_deref() == Some("triage") {
        settings.model.triage = Some(Triage {
            cheap: model
                .route
                .cheap
                .clone()
                .unwrap_or_else(|| "ollama:llama3.1".to_owned()),
            frontier: model
                .route
                .frontier
                .clone()
                .unwrap_or_else(|| "anthropic:claude-opus-4-8".to_owned()),
        });
    }
    settings.model.context_windows = model.context_window.clone();

    // Providers: the file's sections, and the built-in ones its models use.
    for (name, section) in &file.providers {
        settings
            .providers
            .insert(name.clone(), provider(name, section));
    }
    let mut refs = vec![settings.model.default.clone()];
    if let Some(triage) = &settings.model.triage {
        refs.push(triage.cheap.clone());
        refs.push(triage.frontier.clone());
    }
    for reference in refs {
        match split_ref(&reference) {
            Some((name, _)) if !settings.providers.contains_key(name) => match preset(name) {
                Some(builtin) => {
                    settings.providers.insert(name.to_owned(), builtin);
                }
                None => notes.push(format!(
                    "{reference} uses provider {name:?}, which the config does not define. Add it \
                     under Providers."
                )),
            },
            Some(_) => {}
            None => notes.push(format!("{reference:?} is not a provider:model name.")),
        }
    }

    let limits = &file.limits;
    take!(settings.limits.max_steps, limits.max_steps);
    take!(settings.limits.max_cost_usd, limits.max_cost_usd);
    take!(settings.limits.max_wall_clock_s, limits.max_wall_clock_s);
    take!(settings.limits.tool_timeout_s, limits.tool_timeout_s);
    take!(settings.limits.max_output_tokens, limits.max_output_tokens);

    let guardrails = &file.guardrails;
    take!(settings.guardrails.approval, guardrails.approval);
    take!(settings.guardrails.ingress, guardrails.ingress);
    take!(settings.guardrails.egress, guardrails.egress);
    take!(
        settings.guardrails.scan_observations,
        guardrails.scan_observations
    );

    // `[mcp.servers.<name>]` and the older `[mcp_servers.<name>]`, the first winning.
    let mcp_on = file.mcp.enabled.unwrap_or(true);
    let servers = file.mcp_servers.iter().chain(file.mcp.servers.iter());
    for (name, server) in servers {
        if settings.mcp_servers.contains_key(name) {
            continue;
        }
        match mcp_server(server) {
            Ok(mut converted) => {
                converted.enabled &= mcp_on;
                if literal_secret(&converted) {
                    notes.push(format!(
                        "MCP server {name} has a token written out in its settings. You can keep \
                         it in the keyring instead: store it as an entry and write ${{NAME}}."
                    ));
                }
                settings.mcp_servers.insert(name.clone(), converted);
            }
            Err(problem) => notes.push(format!("MCP server {name} was skipped: {problem}")),
        }
    }
    if !mcp_on && !settings.mcp_servers.is_empty() {
        notes.push(
            "MCP is turned off in the config, so its servers were imported turned off.".into(),
        );
    }

    let agents = &file.agents;
    take!(settings.agents.enabled, agents.enabled);
    take!(settings.agents.max_depth, agents.max_depth);
    take!(settings.agents.max_steps, agents.max_steps);
    take!(settings.agents.max_parallel, agents.max_parallel);

    take!(settings.skills.enabled, file.skills.enabled);
    take!(settings.skills.paths, file.skills.paths.clone());

    let memory = &file.memory;
    take!(settings.memory.enabled, memory.enabled);
    take!(settings.memory.path, memory.path.clone());
    take!(settings.memory.embeddings, memory.embeddings.clone());
    take!(settings.memory.hf_offline, memory.hf_offline);
    take!(
        settings.memory.retention_max_episodes,
        memory.retention_max_episodes
    );
    take!(
        settings.memory.retention_max_sessions,
        memory.retention_max_sessions
    );
    take!(
        settings.memory.retention_max_age_days,
        memory.retention_max_age_days
    );

    take!(
        settings.tools.mention_max_bytes,
        file.tools.mention_max_bytes
    );
    settings.pricing = file.pricing.models;

    let skipped: Vec<&str> = [
        ("[sandbox]", file.sandbox.is_some()),
        ("[observability]", file.observability.is_some()),
    ]
    .into_iter()
    .filter_map(|(section, present)| present.then_some(section))
    .collect();
    if !skipped.is_empty() {
        notes.push(format!(
            "Not imported (the app does not use them yet): {}.",
            skipped.join(", ")
        ));
    }
    Ok((settings, notes))
}

/// A provider section laid over the built-in one of the same name, its adapter chosen as the
/// CLI chooses it.
fn provider(name: &str, section: &FileProvider) -> ProviderSettings {
    let kind = match (name, section.adapter.as_deref().map(str::trim)) {
        (_, Some("vllm")) => ProviderKind::Vllm,
        (_, Some("lmstudio")) => ProviderKind::Lmstudio,
        ("anthropic", _) => ProviderKind::Anthropic,
        ("google", _) => ProviderKind::Google,
        ("ollama", _) => ProviderKind::Ollama,
        ("llamacpp", _) => ProviderKind::Llamacpp,
        ("vllm", _) => ProviderKind::Vllm,
        ("lmstudio", _) => ProviderKind::Lmstudio,
        _ => ProviderKind::Openai,
    };
    let mut provider = preset(name)
        .filter(|builtin| builtin.kind == kind)
        .unwrap_or_else(|| ProviderSettings::of_kind(kind));
    take!(provider.base_url, section.base_url.clone().map(Some));
    take!(provider.api_key_env, section.api_key_env.clone().map(Some));
    take!(provider.num_ctx, section.num_ctx.map(Some));
    take!(provider.connect_timeout_s, section.connect_timeout_s);
    take!(provider.read_timeout_s, section.read_timeout_s);
    take!(provider.max_retries, section.max_retries);
    take!(provider.max_tokens, section.max_tokens.map(Some));
    take!(provider.prompt_cache, section.prompt_cache);
    take!(provider.store, section.store);
    take!(provider.routing, section.routing.clone().map(Some));
    if kind == ProviderKind::Openai {
        // The CLI requires a key for OpenAI itself, and for another endpoint only when its
        // section names a key variable.
        provider.key =
            if matches!(name, "openai" | "openai-compatible") || provider.api_key_env.is_some() {
                KeyUse::Required
            } else {
                KeyUse::None
            };
    }
    provider
}

fn mcp_server(server: &FileMcpServer) -> Result<McpServerSettings, String> {
    let command = server.command.clone().unwrap_or_default();
    let url = server.url.clone().unwrap_or_default();
    let (has_command, has_url) = (!command.is_empty(), !url.is_empty());
    if has_command && has_url {
        return Err("it sets both a command and a URL".into());
    }
    if !has_command && !has_url {
        return Err("it sets neither a command nor a URL".into());
    }
    let given = server
        .transport
        .clone()
        .unwrap_or_else(|| if has_command { "stdio" } else { "http" }.to_owned());
    let transport = match given.to_lowercase().replace('-', "_").as_str() {
        "stdio" if has_command => McpTransport::Stdio,
        "http" | "streamable_http" if has_url => McpTransport::Http,
        "sse" if has_url => McpTransport::Sse,
        _ => return Err(format!("its transport {given:?} does not fit what it sets")),
    };
    let defaults = McpServerSettings::default();
    Ok(McpServerSettings {
        enabled: server.enabled.unwrap_or(true),
        transport,
        command,
        args: server.args.clone(),
        env: server.env.clone(),
        url,
        headers: server.headers.clone(),
        connect_timeout_s: server
            .connect_timeout_s
            .unwrap_or(defaults.connect_timeout_s),
        call_timeout_s: server.call_timeout_s.unwrap_or(defaults.call_timeout_s),
        max_result_chars: server.max_result_chars.unwrap_or(defaults.max_result_chars),
    })
}

/// A header or variable that looks like a token written out (no `${...}` in it).
fn literal_secret(server: &McpServerSettings) -> bool {
    let secretish = |key: &str| {
        let key = key.to_ascii_lowercase();
        ["authorization", "token", "key", "secret", "password"]
            .iter()
            .any(|word| key.contains(word))
    };
    server
        .headers
        .iter()
        .chain(server.env.iter())
        .any(|(key, value)| secretish(key) && !value.trim().is_empty() && !value.contains("${"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_file_gives_agent86s_defaults_and_its_default_model() {
        let (settings, notes) = convert("").unwrap();
        assert_eq!(settings.model.default, "anthropic:claude-opus-4-8");
        assert_eq!(
            settings.providers["anthropic"].kind,
            ProviderKind::Anthropic
        );
        assert_eq!(settings.limits, Settings::default().limits);
        assert!(notes.is_empty(), "{notes:?}");
        assert!(settings.problems().is_empty(), "{:?}", settings.problems());
    }

    #[test]
    fn a_typical_config_is_carried_over() {
        let text = r#"
[mcp.servers.firecrawl]
url = "https://mcp.example.dev/v2/mcp"
headers = { Authorization = "Bearer fc-123456" }

[mcp.servers.files]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "${HOME_DIR}"]
enabled = false

[model]
default = "vllm:cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit"
router = "triage"
route = { cheap = "spark:small", frontier = "openrouter:anthropic/claude" }
context_window = { "vllm:cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit" = 131072 }

[providers.openrouter]
base_url = "https://openrouter.ai/api/v1"

[providers.vllm]
base_url = "http://gpu-box:8000/v1"

[providers.spark]
base_url = "http://spark:8001/v1"
adapter = "vllm"

[providers.together]
base_url = "https://api.together.xyz/v1"

[limits]
max_steps = 60
max_cost_usd = 2.5

[guardrails]
approval = "auto"
egress = "redact"

[sandbox]
mode = "docker"

[pricing.models]
"openrouter:x/y" = { input_per_mtok = 0.8, output_per_mtok = 1.6 }
"#;
        let (settings, notes) = convert(text).unwrap();
        assert!(settings.problems().is_empty(), "{:?}", settings.problems());
        assert_eq!(
            settings.model.default,
            "vllm:cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit"
        );
        assert_eq!(
            settings.model.triage,
            Some(Triage {
                cheap: "spark:small".into(),
                frontier: "openrouter:anthropic/claude".into()
            })
        );
        assert_eq!(
            settings.model.context_windows["vllm:cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit"],
            131_072
        );

        let vllm = &settings.providers["vllm"];
        assert_eq!(vllm.kind, ProviderKind::Vllm);
        assert_eq!(vllm.base_url.as_deref(), Some("http://gpu-box:8000/v1"));
        assert_eq!(vllm.api_key_env.as_deref(), Some("VLLM_API_KEY"));
        assert_eq!(vllm.key_use(), KeyUse::Optional);
        // Laid over the built-in section, which names the key variable.
        let openrouter = &settings.providers["openrouter"];
        assert_eq!(
            openrouter.api_key_env.as_deref(),
            Some("OPENROUTER_API_KEY")
        );
        assert_eq!(openrouter.key_use(), KeyUse::Required);
        assert_eq!(settings.providers["spark"].kind, ProviderKind::Vllm);
        assert_eq!(settings.providers["together"].key_use(), KeyUse::None);

        assert_eq!(settings.limits.max_steps, 60);
        assert_eq!(settings.limits.max_cost_usd, 2.5);
        assert_eq!(settings.limits.tool_timeout_s, 60);
        assert_eq!(settings.guardrails.approval, Approval::Auto);
        assert_eq!(settings.guardrails.egress, Egress::Redact);
        assert_eq!(settings.guardrails.ingress, Ingress::Warn);

        let firecrawl = &settings.mcp_servers["firecrawl"];
        assert_eq!(firecrawl.transport, McpTransport::Http);
        assert!(firecrawl.enabled);
        let files = &settings.mcp_servers["files"];
        assert_eq!(files.transport, McpTransport::Stdio);
        assert!(!files.enabled);
        assert_eq!(files.args[2], "${HOME_DIR}");

        assert_eq!(settings.pricing["openrouter:x/y"].output_per_mtok, 1.6);
        let notes = notes.join("\n");
        assert!(
            notes.contains("MCP server firecrawl has a token"),
            "{notes}"
        );
        assert!(!notes.contains("MCP server files"), "{notes}");
        assert!(notes.contains("[sandbox]"), "{notes}");
    }

    #[test]
    fn a_model_on_an_unknown_provider_is_noted() {
        let (settings, notes) = convert("[model]\ndefault = \"mystery:m\"\n").unwrap();
        assert!(notes[0].contains("\"mystery\""), "{notes:?}");
        assert!(!settings.problems().is_empty());
    }

    #[test]
    fn bad_servers_are_skipped_and_mcp_off_turns_them_off() {
        let text = r#"
[mcp]
enabled = false
[mcp.servers.both]
command = "x"
url = "https://x"
[mcp.servers.ok]
command = "x"
"#;
        let (settings, notes) = convert(text).unwrap();
        assert!(!settings.mcp_servers.contains_key("both"));
        assert!(!settings.mcp_servers["ok"].enabled);
        assert!(
            notes.iter().any(|n| n.contains("both was skipped")),
            "{notes:?}"
        );
    }

    #[test]
    fn broken_toml_is_an_error() {
        assert!(convert("[model\n").is_err());
        assert!(convert("[limits]\nmax_steps = \"many\"\n").is_err());
    }

    #[test]
    fn preview_reads_a_file_and_marks_where_it_came_from() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "[model]\ndefault = \"ollama:llama3.1\"\n").unwrap();
        let preview = preview(&path).unwrap();
        assert_eq!(
            preview.settings.imported_from.as_deref(),
            Some(preview.path.as_str())
        );
        assert_eq!(
            preview.settings.providers["ollama"].kind,
            ProviderKind::Ollama
        );
        assert!(super::preview(&dir.path().join("missing.toml")).is_err());
    }
}
