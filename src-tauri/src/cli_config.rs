//! M1 stopgap: the model comes from the agent86 CLI's own configuration.
//!
//! `agent86_core::sdk` reads no config file or keyring, so until the app has settings of its own
//! (M5, docs/PROJECT_PLAN.md D3) this module loads `~/.agent86/config.toml` with agent86-core's
//! loader and builds the provider with the CLI's factory. Keys therefore resolve exactly as the
//! CLI resolves them: the provider's `api_key_env` variable, then the OS keyring (service
//! `agent86`, account = provider section).
//!
//! These are agent86-core's hidden modules, outside its semver promise; Cargo.toml pins the crate
//! exactly, and this file is the only place that touches them for the model.

use agent86_core::config::{load_config, Config, ConfigPaths, Overrides, ProjectTrust};
use agent86_core::provider::capabilities::context_window_for;
use agent86_core::provider::provider_for_ref;
use agent86_core::sdk::Provider;
use agent86_core::types::ModelRef;
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
