//! M1 stopgap: the model comes from the agent86 CLI's own configuration.
//!
//! `agent86_core::sdk` reads no config file or keyring, so until the app has settings of its own
//! (M5, docs/PROJECT_PLAN.md D3) this module loads `~/.agent86/config.toml` with agent86-core's
//! loader and builds the provider with the CLI's factory. Keys therefore resolve exactly as the
//! CLI resolves them: the provider's `api_key_env` variable, then the OS keyring (service
//! `agent86`, account = provider section).
//!
//! It also finds the user-level skills and specialists the CLI would offer outside a project.
//!
//! These are agent86-core's hidden modules, outside its semver promise; Cargo.toml pins the crate
//! exactly, and this file is the only place that touches them for configuration.

use agent86_core::config::{load_config, Config, ConfigPaths, Overrides, ProjectTrust};
use agent86_core::memory::embeddings::build_embedder;
use agent86_core::provider::capabilities::context_window_for;
use agent86_core::provider::provider_for_ref;
use agent86_core::sdk::{Memory, Provider, SubAgents};
use agent86_core::types::ModelRef;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

/// The model a new thread uses, and where that choice came from.
pub struct ModelSetup {
    /// `provider:model`, as the CLI writes it.
    pub reference: String,
    pub provider: Arc<dyn Provider>,
    pub context_window: u64,
    pub max_output_tokens: u32,
}

/// The CLI's user configuration (built-in defaults when there is no file), with `AGENT86_MODEL`
/// applied. No project file is read: the app does not run in a project directory, and project
/// settings wait for project trust (M6).
pub fn load() -> Result<Config, String> {
    let paths = ConfigPaths {
        user: ConfigPaths::discover().user,
        // A path that does not exist, so no project layer is merged (a missing file reads as
        // empty).
        project: no_project_path(),
        project_trust: ProjectTrust::Restricted,
    };
    let overrides = Overrides::from_env(None, None, None);
    load_config(&paths, &overrides).map_err(|error| error.to_string())
}

fn no_project_path() -> PathBuf {
    std::env::temp_dir()
        .join("agent86-desktop-no-project")
        .join(".agent86")
        .join("config.toml")
}

/// The provider for `config`'s default model, with its key resolved from the environment or the
/// OS keyring. Fails with agent86's own message when the model is unknown or the key is missing.
pub fn model_setup(config: &Config) -> Result<ModelSetup, String> {
    let reference = config.model.default.clone();
    let model_ref = ModelRef::parse(&reference).map_err(|error| error.to_string())?;
    let provider = provider_for_ref(&model_ref, config).map_err(|error| error.to_string())?;
    Ok(ModelSetup {
        context_window: context_window_for(&reference, config),
        max_output_tokens: config.max_output_tokens_for(&model_ref.provider),
        provider: Arc::from(provider),
        reference,
    })
}

/// Where the configuration came from, for the UI: the files merged, or the built-in defaults.
pub fn source_label(config: &Config) -> String {
    match config.sources.as_slice() {
        [] => "agent86 built-in defaults".to_owned(),
        sources => sources
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
    }
}

/// The user's home directory, as agent86 finds it.
pub fn home() -> Option<PathBuf> {
    ConfigPaths::discover()
        .user
        .and_then(|config| config.parent()?.parent().map(PathBuf::from))
}

/// The skill directories the CLI searches outside a project, highest precedence first:
/// `~/.agent86/skills`, `~/.claude/skills`, then `[skills] paths`. Only those that exist; none
/// when `[skills] enabled = false`. A project's own skills wait for project trust (M6).
pub fn user_skill_dirs(config: &Config) -> Vec<PathBuf> {
    if !config.skills.enabled {
        return Vec::new();
    }
    let mut dirs = Vec::new();
    if let Some(home) = home() {
        dirs.push(home.join(".agent86").join("skills"));
        dirs.push(home.join(".claude").join("skills"));
    }
    dirs.extend(
        config
            .skills
            .paths
            .iter()
            .map(|path| agent86_core::session::expand_home(path)),
    );
    dirs.into_iter().filter(|dir| dir.is_dir()).collect()
}

/// Sub-agents as `[agents]` configures them: agent86's built-in specialists and the user's own in
/// `~/.agent86/agents`. `None` when `[agents] enabled = false`.
pub fn subagents(config: &Config) -> Option<SubAgents> {
    let agents = &config.agents;
    if !agents.enabled {
        return None;
    }
    let mut subagents = SubAgents::new()
        .max_depth(agents.max_depth)
        .max_steps(agents.max_steps)
        .max_parallel(agents.max_parallel);
    if let Some(dir) = home()
        .map(|home| home.join(".agent86").join("agents"))
        .filter(|dir| dir.is_dir())
    {
        subagents = subagents.specialists_dir(dir);
    }
    Some(subagents)
}

/// The memory database the CLI uses, opened as the CLI opens it: `[memory] path`, its embedder
/// (`[memory] embeddings`, so episodes and facts stay findable from both), and its retention.
/// Returns the memory and agent86's note when the embedder fell back (a model not downloaded).
pub fn open_memory(config: &Config) -> Result<(Memory, PathBuf, Option<String>), String> {
    let memory = &config.memory;
    if !memory.enabled {
        return Err(
            "Memory is turned off ([memory] enabled = false in your agent86 config).".into(),
        );
    }
    let path = agent86_core::session::expand_home(&memory.path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    let (embedder, note) = build_embedder(&memory.embeddings, memory.hf_offline);
    let opened = Memory::open_with(&path, embedder)
        .map_err(|error| error.to_string())?
        .retention(
            memory.retention_max_episodes,
            memory.retention_max_sessions,
            memory.retention_max_age_days,
        );
    Ok((opened, path, note))
}

/// The workspace agent86's editor server recorded for each session it ran
/// (`~/.agent86/acp-sessions.json`: session id to folder). Read only, as a hint for reopening a
/// session the app did not start; never written.
pub fn acp_session_workspaces() -> HashMap<String, String> {
    let Some(path) = home().map(|home| home.join(".agent86").join("acp-sessions.json")) else {
        return HashMap::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}
