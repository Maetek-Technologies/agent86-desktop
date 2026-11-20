//! The app's own settings (docs/PROJECT_PLAN.md D3): providers and models, triage, limits,
//! guardrails, MCP servers, sub-agents, skills, memory, and the app's look, kept as JSON in
//! `{app config dir}/settings.json`.
//!
//! The defaults are agent86's built-in ones, so a value the user never touched behaves as it does
//! in the CLI. API keys are never stored here; they live in the OS keyring (`keys.rs`). The file
//! is written whole and moved into place, so a crash never leaves half of it.
//!
//! No file means the app has not been set up: the UI shows the first-run screen, which can import
//! the CLI's `~/.agent86/config.toml` once (`cli_import.rs`).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use ts_rs::TS;

/// The settings file's format. Bumped only for a change old builds would misread.
pub const SETTINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Settings {
    pub version: u32,
    pub model: ModelSettings,
    /// Provider sections by name. A model is named `provider:model`, and the provider's name is
    /// also the keyring account its API key is stored under, as in the CLI.
    pub providers: BTreeMap<String, ProviderSettings>,
    pub limits: LimitSettings,
    pub guardrails: GuardrailSettings,
    pub mcp_servers: BTreeMap<String, McpServerSettings>,
    pub agents: AgentSettings,
    pub skills: SkillSettings,
    pub memory: MemorySettings,
    pub tools: ToolSettings,
    /// How the app itself looks and behaves: theme, notifications, tray icon.
    pub ui: UiSettings,
    /// USD per million tokens by `provider:model` (or bare model id), for models agent86 has no
    /// built-in price for. Imported from the CLI's `[pricing.models]`.
    pub pricing: BTreeMap<String, ModelPrice>,
    /// The CLI config these settings were imported from, if they were.
    pub imported_from: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            model: ModelSettings::default(),
            providers: BTreeMap::new(),
            limits: LimitSettings::default(),
            guardrails: GuardrailSettings::default(),
            mcp_servers: BTreeMap::new(),
            agents: AgentSettings::default(),
            skills: SkillSettings::default(),
            memory: MemorySettings::default(),
            tools: ToolSettings::default(),
            ui: UiSettings::default(),
            pricing: BTreeMap::new(),
            imported_from: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ModelSettings {
    /// The model new threads use, `provider:model`. Empty until set up.
    pub default: String,
    /// Route each turn by its task: short, plain asks to `cheap`, the rest to `frontier` (agent86's
    /// `[model] router = "triage"`). `None` sends every turn to `default`.
    pub triage: Option<Triage>,
    /// Tokens of context by `provider:model` (or bare model id), where agent86's own table is
    /// wrong or does not know the model (a local server's).
    #[ts(type = "Record<string, number>")]
    pub context_windows: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Triage {
    pub cheap: String,
    pub frontier: String,
}

/// Which of agent86's adapters a provider uses.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ProviderKind {
    /// Any OpenAI-compatible endpoint: OpenAI, OpenRouter, Groq, Together, ...
    #[default]
    Openai,
    Anthropic,
    Google,
    Ollama,
    Vllm,
    Lmstudio,
    Llamacpp,
}

impl ProviderKind {
    /// Whether a provider of this kind may run without a key, and whether it sends one it finds.
    pub fn fixed_key_use(self) -> Option<KeyUse> {
        match self {
            Self::Anthropic | Self::Google => Some(KeyUse::Required),
            Self::Ollama => Some(KeyUse::None),
            Self::Vllm | Self::Lmstudio | Self::Llamacpp => Some(KeyUse::Optional),
            Self::Openai => None,
        }
    }
}

/// Whether a provider needs an API key.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum KeyUse {
    /// A thread cannot start without one.
    #[default]
    Required,
    /// Sent when one is stored (a local server started with a key); none is fine.
    Optional,
    /// Never sent.
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ProviderSettings {
    pub kind: ProviderKind,
    /// The endpoint; the adapter's default when unset.
    pub base_url: Option<String>,
    pub key: KeyUse,
    /// An environment variable that holds the key and wins over the keyring, as in the CLI.
    pub api_key_env: Option<String>,
    /// A standing output cap for this provider's models.
    pub max_tokens: Option<u32>,
    /// Ollama only: the context window to ask for.
    pub num_ctx: Option<u32>,
    pub connect_timeout_s: f64,
    /// The longest gap between streamed chunks, not a deadline for the whole answer.
    pub read_timeout_s: f64,
    pub max_retries: u32,
    /// Anthropic only: mark the stable prompt prefix cacheable.
    pub prompt_cache: bool,
    /// Google only: let Google keep the conversation.
    pub store: bool,
    /// OpenRouter's provider routing object, sent as the request's `provider` field.
    #[ts(type = "Record<string, unknown> | null")]
    pub routing: Option<serde_json::Map<String, serde_json::Value>>,
}

impl Default for ProviderSettings {
    fn default() -> Self {
        Self::of_kind(ProviderKind::Openai)
    }
}

impl ProviderSettings {
    /// A provider of `kind` with agent86's defaults for it.
    pub fn of_kind(kind: ProviderKind) -> Self {
        Self {
            kind,
            base_url: None,
            key: kind.fixed_key_use().unwrap_or(KeyUse::Required),
            api_key_env: None,
            max_tokens: None,
            num_ctx: None,
            connect_timeout_s: 10.0,
            read_timeout_s: if kind == ProviderKind::Google {
                1200.0
            } else {
                300.0
            },
            max_retries: 2,
            prompt_cache: true,
            store: false,
            routing: None,
        }
    }

    /// The key use that applies: the kind's own where it has one.
    pub fn key_use(&self) -> KeyUse {
        self.kind.fixed_key_use().unwrap_or(self.key)
    }
}

/// A provider agent86 knows by name, with its built-in section: the starting points for adding a
/// provider, and what a CLI config's sections are laid over.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderPreset {
    /// The section name, which is also the keyring account for its key.
    pub name: String,
    pub label: String,
    pub provider: ProviderSettings,
    /// A model to suggest when setting up.
    pub example_model: String,
}

/// agent86's built-in provider sections (its defaults TOML), in the order the setup screen lists
/// them.
pub fn presets() -> Vec<ProviderPreset> {
    let preset = |name: &str,
                  label: &str,
                  kind: ProviderKind,
                  base_url: Option<&str>,
                  env: Option<&str>,
                  example: &str| {
        let mut provider = ProviderSettings::of_kind(kind);
        provider.base_url = base_url.map(str::to_owned);
        provider.api_key_env = env.map(str::to_owned);
        ProviderPreset {
            name: name.to_owned(),
            label: label.to_owned(),
            provider,
            example_model: example.to_owned(),
        }
    };
    use ProviderKind::*;
    vec![
        preset(
            "openrouter",
            "OpenRouter",
            Openai,
            Some("https://openrouter.ai/api/v1"),
            Some("OPENROUTER_API_KEY"),
            "anthropic/claude-sonnet-4.6",
        ),
        preset(
            "anthropic",
            "Anthropic",
            Anthropic,
            None,
            Some("ANTHROPIC_API_KEY"),
            "claude-opus-4-8",
        ),
        preset(
            "openai",
            "OpenAI",
            Openai,
            Some("https://api.openai.com/v1"),
            Some("OPENAI_API_KEY"),
            "gpt-5.1",
        ),
        preset(
            "google",
            "Google Gemini",
            Google,
            None,
            Some("GEMINI_API_KEY"),
            "gemini-3-pro",
        ),
        preset(
            "groq",
            "Groq",
            Openai,
            Some("https://api.groq.com/openai/v1"),
            Some("GROQ_API_KEY"),
            "llama-3.3-70b-versatile",
        ),
        preset(
            "ollama",
            "Ollama",
            Ollama,
            Some("http://localhost:11434"),
            None,
            "llama3.1",
        ),
        preset(
            "vllm",
            "vLLM",
            Vllm,
            Some("http://localhost:8000/v1"),
            Some("VLLM_API_KEY"),
            "Qwen/Qwen3-32B",
        ),
        preset(
            "lmstudio",
            "LM Studio",
            Lmstudio,
            Some("http://localhost:1234/v1"),
            Some("LM_API_TOKEN"),
            "qwen3-32b",
        ),
        preset(
            "llamacpp",
            "llama.cpp",
            Llamacpp,
            Some("http://localhost:8080"),
            None,
            "default",
        ),
    ]
}

/// The built-in section for provider `name`, if agent86 has one.
pub fn preset(name: &str) -> Option<ProviderSettings> {
    presets()
        .into_iter()
        .find(|preset| preset.name == name)
        .map(|preset| preset.provider)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct LimitSettings {
    /// Model calls one turn may make.
    pub max_steps: u32,
    /// Spend at which a turn stops; 0 for no cap. Only priced models count.
    pub max_cost_usd: f64,
    /// Seconds a turn may run; 0 for no limit.
    #[ts(type = "number")]
    pub max_wall_clock_s: u64,
    /// Seconds one command or fetch may run.
    #[ts(type = "number")]
    pub tool_timeout_s: u64,
    /// The most tokens one model call may write, unless the provider sets its own cap.
    pub max_output_tokens: u32,
}

impl Default for LimitSettings {
    fn default() -> Self {
        Self {
            max_steps: 40,
            max_cost_usd: 5.0,
            max_wall_clock_s: 900,
            tool_timeout_s: 60,
            max_output_tokens: 8192,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Approval {
    /// Side-effecting tool calls wait for the user.
    #[default]
    Ask,
    /// They run without asking.
    Auto,
    /// They are refused.
    Deny,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Ingress {
    Off,
    /// Scan what comes in and report findings.
    #[default]
    Warn,
    /// Also refuse turns carrying prompt injection.
    Block,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Egress {
    Off,
    /// Scan what goes out and report findings.
    #[default]
    Warn,
    /// Also rewrite secrets and personal data out of it.
    Redact,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct GuardrailSettings {
    pub approval: Approval,
    pub ingress: Ingress,
    pub egress: Egress,
    /// Scan tool results for prompt injection too.
    pub scan_observations: bool,
}

impl Default for GuardrailSettings {
    fn default() -> Self {
        Self {
            approval: Approval::Ask,
            ingress: Ingress::Warn,
            egress: Egress::Warn,
            scan_observations: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum McpTransport {
    /// A program agent86 starts, speaking MCP on its standard streams.
    #[default]
    Stdio,
    /// Streamable HTTP.
    Http,
    /// The older server-sent events transport.
    Sse,
}

/// An MCP server. A `${NAME}` in its arguments, environment, URL, or headers is replaced when a
/// thread starts, from the environment variable `NAME` or else the keyring entry `NAME` (service
/// `agent86`), as the CLI does; so a token need not be written here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct McpServerSettings {
    pub enabled: bool,
    pub transport: McpTransport,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub connect_timeout_s: f64,
    pub call_timeout_s: f64,
    #[ts(type = "number")]
    pub max_result_chars: usize,
}

impl Default for McpServerSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            transport: McpTransport::Stdio,
            command: String::new(),
            args: Vec::new(),
            env: BTreeMap::new(),
            url: String::new(),
            headers: BTreeMap::new(),
            connect_timeout_s: 30.0,
            call_timeout_s: 120.0,
            max_result_chars: 8000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct AgentSettings {
    /// Offer `delegate` and the specialists.
    pub enabled: bool,
    pub max_depth: u32,
    /// Model calls one sub-agent may make.
    pub max_steps: u32,
    pub max_parallel: u32,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_depth: 2,
            max_steps: 8,
            max_parallel: 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct SkillSettings {
    pub enabled: bool,
    /// More skill folders, after `~/.agent86/skills` and `~/.claude/skills`.
    pub paths: Vec<String>,
}

impl Default for SkillSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            paths: Vec::new(),
        }
    }
}

/// The memory database, shared with the CLI (D2). Read once when the app starts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct MemorySettings {
    pub enabled: bool,
    pub path: String,
    /// The embedder; must match the CLI's for memory written by one to be found by the other.
    pub embeddings: String,
    /// Never download the embedding model.
    pub hf_offline: bool,
    #[ts(type = "number")]
    pub retention_max_episodes: i64,
    #[ts(type = "number")]
    pub retention_max_sessions: i64,
    pub retention_max_age_days: f64,
}

impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            path: "~/.agent86/memory.db".to_owned(),
            embeddings: "sentence-transformers:all-MiniLM-L6-v2".to_owned(),
            hf_offline: true,
            retention_max_episodes: 1000,
            retention_max_sessions: 500,
            retention_max_age_days: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ToolSettings {
    /// The most bytes of one `@` mentioned file inlined into a prompt.
    #[ts(type = "number")]
    pub mention_max_bytes: u64,
}

impl Default for ToolSettings {
    fn default() -> Self {
        Self {
            mention_max_bytes: 200_000,
        }
    }
}

/// The app's colours: the system's, or always light or dark.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct UiSettings {
    pub theme: Theme,
    /// Notify when an approval or question waits, or a long turn finishes, while the app or
    /// that tab is not in front.
    pub notifications: bool,
    /// Show a tray (menu bar) icon with the number of running turns.
    pub tray: bool,
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            notifications: true,
            tray: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ModelPrice {
    // The aliases read the CLI's `[pricing.models]` tables as they are written.
    #[serde(alias = "input_per_mtok")]
    pub input_per_mtok: f64,
    #[serde(alias = "output_per_mtok")]
    pub output_per_mtok: f64,
}

/// `provider:model` split at the first colon, both parts non-empty.
pub fn split_ref(reference: &str) -> Option<(&str, &str)> {
    let (provider, model) = reference.trim().split_once(':')?;
    (!provider.is_empty() && !model.is_empty()).then_some((provider, model))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

impl Settings {
    /// What is wrong with these settings, in words for the UI; empty when they can be saved. A
    /// missing API key is not a problem here: keys are not part of the settings.
    pub fn problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        let check_ref =
            |what: &str, reference: &str, problems: &mut Vec<String>| match split_ref(reference) {
                None if reference.trim().is_empty() => problems.push(format!("Choose the {what}.")),
                None => problems.push(format!(
                    "The {what} {reference:?} should be written provider:model."
                )),
                Some((provider, _)) if !self.providers.contains_key(provider) => problems.push(
                    format!("The {what} uses provider {provider:?}, which is not set up."),
                ),
                Some(_) => {}
            };
        check_ref("default model", &self.model.default, &mut problems);
        if let Some(triage) = &self.model.triage {
            check_ref("triage's cheap model", &triage.cheap, &mut problems);
            check_ref("triage's frontier model", &triage.frontier, &mut problems);
        }
        for (name, provider) in &self.providers {
            if !valid_name(name) {
                problems.push(format!(
                    "Provider name {name:?} may use only letters, digits, '-', '_', and '.'."
                ));
            }
            if let Some(url) = &provider.base_url {
                if !(url.starts_with("http://") || url.starts_with("https://")) {
                    problems.push(format!(
                        "{name}: the URL should start with http:// or https://."
                    ));
                }
            }
            if provider.kind == ProviderKind::Openai
                && provider.base_url.as_deref().is_none_or(str::is_empty)
                && name != "openai"
            {
                problems.push(format!(
                    "{name}: an OpenAI-compatible provider needs a URL."
                ));
            }
            if let Some(env) = &provider.api_key_env {
                if !valid_env_name(env) {
                    problems.push(format!(
                        "{name}: {env:?} is not an environment variable name."
                    ));
                }
            }
            for (field, value) in [
                ("connect timeout", provider.connect_timeout_s),
                ("read timeout", provider.read_timeout_s),
            ] {
                if !value.is_finite() || value <= 0.0 {
                    problems.push(format!("{name}: the {field} should be a positive number."));
                }
            }
        }
        for (name, server) in &self.mcp_servers {
            if !valid_name(name) || name.contains('.') {
                problems.push(format!(
                    "MCP server name {name:?} may use only letters, digits, '-', and '_'."
                ));
            }
            match server.transport {
                McpTransport::Stdio if server.command.trim().is_empty() => {
                    problems.push(format!("MCP server {name}: give the command to run."));
                }
                McpTransport::Http | McpTransport::Sse
                    if !(server.url.starts_with("http://")
                        || server.url.starts_with("https://")) =>
                {
                    problems.push(format!(
                        "MCP server {name}: the URL should start with http:// or https://."
                    ));
                }
                _ => {}
            }
            for (field, value) in [
                ("connect timeout", server.connect_timeout_s),
                ("call timeout", server.call_timeout_s),
            ] {
                if !value.is_finite() || value <= 0.0 {
                    problems.push(format!(
                        "MCP server {name}: the {field} should be a positive number."
                    ));
                }
            }
        }
        let limits = &self.limits;
        if limits.max_steps == 0 {
            problems.push("A turn needs at least one step.".into());
        }
        if !limits.max_cost_usd.is_finite() || limits.max_cost_usd < 0.0 {
            problems.push("The spending cap should be 0 (none) or more.".into());
        }
        if limits.tool_timeout_s == 0 {
            problems.push("The tool timeout should be at least one second.".into());
        }
        if limits.max_output_tokens == 0 {
            problems.push("The output cap should be at least one token.".into());
        }
        if self.agents.enabled && (self.agents.max_steps == 0 || self.agents.max_parallel == 0) {
            problems.push("Sub-agents need at least one step and one at a time.".into());
        }
        problems
    }
}

/// `~` or `~/...` made absolute with the home folder, as agent86 does; anything else as given.
pub fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix('~'), home_dir()) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            let mut expanded = home;
            for part in rest.split(['/', '\\']).filter(|part| !part.is_empty()) {
                expanded.push(part);
            }
            expanded
        }
        _ => PathBuf::from(path),
    }
}

/// The user's home folder, as agent86 finds it (`USERPROFILE` on Windows, `HOME` elsewhere).
pub fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

/// The settings file and what it holds, for the whole app.
pub struct SettingsStore {
    path: Option<PathBuf>,
    current: Mutex<Loaded>,
}

#[derive(Debug, Clone)]
enum Loaded {
    /// No file: first run.
    Missing,
    Ready(Box<Settings>),
    /// The file is there but unreadable; it is left alone until the user saves over it.
    Broken(String),
}

impl SettingsStore {
    /// The store for `{config_dir}/settings.json`. Without a config folder (an unusual profile)
    /// settings last only until the app quits.
    pub fn open(config_dir: Option<&Path>) -> Self {
        let path = config_dir.map(|dir| dir.join("settings.json"));
        let current = match &path {
            Some(path) => read(path),
            None => Loaded::Missing,
        };
        Self {
            path,
            current: Mutex::new(current),
        }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The settings, or why there are none: `Ok(None)` before setup.
    pub fn get(&self) -> Result<Option<Settings>, String> {
        match &*self.lock() {
            Loaded::Missing => Ok(None),
            Loaded::Ready(settings) => Ok(Some((**settings).clone())),
            Loaded::Broken(problem) => Err(problem.clone()),
        }
    }

    /// The settings new threads use, or a message saying what to do first.
    pub fn require(&self) -> Result<Settings, String> {
        self.get()?
            .ok_or_else(|| "Set up a model first (Settings).".to_owned())
    }

    /// Check and keep `settings`. Refused, with the problems, when they are not valid.
    pub fn save(&self, mut settings: Settings) -> Result<Settings, String> {
        settings.version = SETTINGS_VERSION;
        let problems = settings.problems();
        if !problems.is_empty() {
            return Err(problems.join("\n"));
        }
        if let Some(path) = &self.path {
            write(path, &settings).map_err(|error| format!("{}: {error}", path.display()))?;
        }
        *self.lock() = Loaded::Ready(Box::new(settings.clone()));
        Ok(settings)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Loaded> {
        self.current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn read(path: &Path) -> Loaded {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Loaded::Missing,
        Err(error) => return Loaded::Broken(format!("{}: {error}", path.display())),
    };
    match serde_json::from_str::<Settings>(&text) {
        Ok(settings) if settings.version > SETTINGS_VERSION => Loaded::Broken(format!(
            "{} was written by a newer version of the app (format {}); this one reads format \
             {SETTINGS_VERSION}.",
            path.display(),
            settings.version
        )),
        Ok(settings) => Loaded::Ready(Box::new(settings)),
        Err(error) => Loaded::Broken(format!("{}: {error}", path.display())),
    }
}

fn write(path: &Path, settings: &Settings) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(std::io::Error::other)?;
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, text + "\n")?;
    std::fs::rename(partial, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn working() -> Settings {
        let mut settings = Settings::default();
        settings
            .providers
            .insert("vllm".into(), preset("vllm").unwrap());
        settings.model.default = "vllm:qwen".into();
        settings
    }

    #[test]
    fn defaults_are_agent86s_and_need_a_model() {
        let settings = Settings::default();
        assert_eq!(settings.limits.max_steps, 40);
        assert_eq!(settings.limits.max_cost_usd, 5.0);
        assert_eq!(settings.guardrails.approval, Approval::Ask);
        assert_eq!(settings.memory.path, "~/.agent86/memory.db");
        assert_eq!(settings.problems(), vec!["Choose the default model."]);
        assert!(working().problems().is_empty());
    }

    #[test]
    fn models_must_name_a_provider_that_is_set_up() {
        let mut settings = working();
        settings.model.default = "qwen".into();
        assert!(settings.problems()[0].contains("provider:model"));
        settings.model.default = "openrouter:x".into();
        assert!(settings.problems()[0].contains("\"openrouter\""));
        settings.model.default = "vllm:qwen".into();
        settings.model.triage = Some(Triage {
            cheap: "vllm:small".into(),
            frontier: "nope:big".into(),
        });
        assert_eq!(settings.problems().len(), 1);
    }

    #[test]
    fn bad_providers_and_servers_are_named() {
        let mut settings = working();
        let mut custom = ProviderSettings::of_kind(ProviderKind::Openai);
        custom.api_key_env = Some("NOT A VAR".into());
        settings.providers.insert("my host".into(), custom);
        settings.mcp_servers.insert(
            "files".into(),
            McpServerSettings {
                transport: McpTransport::Http,
                url: "ftp://x".into(),
                ..McpServerSettings::default()
            },
        );
        let problems = settings.problems().join("\n");
        assert!(problems.contains("\"my host\""), "{problems}");
        assert!(problems.contains("needs a URL"), "{problems}");
        assert!(problems.contains("environment variable"), "{problems}");
        assert!(problems.contains("MCP server files"), "{problems}");
    }

    #[test]
    fn a_kinds_own_key_use_wins() {
        let mut anthropic = ProviderSettings::of_kind(ProviderKind::Anthropic);
        anthropic.key = KeyUse::None;
        assert_eq!(anthropic.key_use(), KeyUse::Required);
        let mut custom = ProviderSettings::of_kind(ProviderKind::Openai);
        custom.key = KeyUse::Optional;
        assert_eq!(custom.key_use(), KeyUse::Optional);
        assert_eq!(preset("ollama").unwrap().key_use(), KeyUse::None);
    }

    #[test]
    fn saves_and_reads_back_and_refuses_invalid_settings() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(Some(dir.path()));
        assert_eq!(store.get(), Ok(None));
        assert!(store.require().is_err());
        assert!(store.save(Settings::default()).is_err());
        assert!(!dir.path().join("settings.json").exists());
        store.save(working()).unwrap();
        let again = SettingsStore::open(Some(dir.path()));
        assert_eq!(again.get().unwrap(), Some(working()));
        assert!(!dir.path().join("settings.json.partial").exists());
    }

    #[test]
    fn a_partial_file_takes_defaults_and_a_broken_one_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"version":1,"limits":{"maxSteps":7}}"#).unwrap();
        let settings = SettingsStore::open(Some(dir.path()))
            .get()
            .unwrap()
            .unwrap();
        assert_eq!(settings.limits.max_steps, 7);
        assert_eq!(settings.limits.tool_timeout_s, 60);
        std::fs::write(&path, "{not json").unwrap();
        assert!(SettingsStore::open(Some(dir.path())).get().is_err());
        std::fs::write(&path, r#"{"version":99}"#).unwrap();
        let newer = SettingsStore::open(Some(dir.path())).get().unwrap_err();
        assert!(newer.contains("newer version"), "{newer}");
    }

    #[test]
    fn refs_split_at_the_first_colon() {
        assert_eq!(
            split_ref("openrouter:openai/gpt-4o:free"),
            Some(("openrouter", "openai/gpt-4o:free"))
        );
        assert_eq!(split_ref("vllm:"), None);
        assert_eq!(split_ref(":x"), None);
    }

    #[test]
    fn home_is_expanded_part_by_part() {
        let Some(home) = home_dir() else { return };
        assert_eq!(
            expand_home("~/.agent86/memory.db"),
            home.join(".agent86").join("memory.db")
        );
        assert_eq!(expand_home("/abs/x"), PathBuf::from("/abs/x"));
        assert_eq!(expand_home("~other/x"), PathBuf::from("~other/x"));
    }
}
