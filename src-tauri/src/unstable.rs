//! Every use of agent86-core outside `agent86_core::sdk`, the crate's semver-covered surface.
//!
//! These modules are public for the `agent86` binary and promise nothing, so Cargo.toml pins the
//! crate exactly and nothing else in the app names them. What is left here has no `sdk`
//! equivalent, and each piece is something the app must do exactly as the CLI does:
//!
//! - API keys in the OS keyring with the CLI's layout (service `agent86`, account = provider
//!   section). On Windows that is the Python `keyring` package's Credential Manager scheme, which
//!   moves a displaced account to `account@agent86`; reimplementing it would risk keys that
//!   `agent86 keys set` cannot see, or the reverse.
//! - The memory embedder (D2): memory written with one embedder is only found with the same one.
//! - agent86's table of model context windows, and its price table with the user's overrides.
//! - Session titles cleaned as `/rename` cleans them.
//!
//! The M1 stopgap that read the CLI's config.toml through agent86-core's loader is gone: the app
//! has its own settings (settings.rs) and imports the CLI's file itself (cli_import.rs).

use crate::settings::{ModelPrice, ProviderKind, ProviderSettings};
use agent86_core::config::{builtin_config, ProviderConfig};
use agent86_core::sdk::{Embedder, Memory};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

pub use agent86_core::pricing::PriceTable;

/// The keyring service agent86 keeps its keys under.
pub const KEYRING_SERVICE: &str = agent86_core::secrets::SERVICE_NAME;

/// The OS keyring as the CLI uses it.
pub mod keyring {
    use super::KEYRING_SERVICE;
    use agent86_core::secrets::{OsKeyring, SecretStore};

    /// The secret stored for `account`, if any (unreadable reads as none).
    pub fn get(account: &str) -> Option<String> {
        OsKeyring
            .get_password(KEYRING_SERVICE, account)
            .filter(|value| !value.is_empty())
    }

    pub fn set(account: &str, secret: &str) -> Result<(), String> {
        OsKeyring
            .set_password(KEYRING_SERVICE, account, secret)
            .map_err(|error| error.to_string())
    }

    /// `Ok(false)` when nothing was stored.
    pub fn delete(account: &str) -> Result<bool, String> {
        OsKeyring
            .delete_password(KEYRING_SERVICE, account)
            .map_err(|error| error.to_string())
    }

    /// A pasted key, trimmed, or why it would not work (empty, whitespace inside, pasted twice).
    pub fn validate(raw: &str) -> Result<String, String> {
        agent86_core::secrets::validate_api_key(raw)
    }
}

/// Open the memory database at `path` with the embedder `spec` (`[memory] embeddings`), and
/// agent86's note when that embedder fell back to the offline hash one.
pub fn open_memory(
    path: &Path,
    spec: &str,
    hf_offline: bool,
) -> Result<(Memory, Option<String>), String> {
    let (embedder, note): (Arc<dyn Embedder>, Option<String>) =
        agent86_core::memory::embeddings::build_embedder(spec, hf_offline);
    let memory = Memory::open_with(path, embedder).map_err(|error| error.to_string())?;
    Ok((memory, note))
}

/// agent86's context window for `model` (a bare model id) from its built-in table, or its default
/// when the table does not know the model. Asks no server.
pub fn table_context_window(model: &str) -> u64 {
    // A placeholder provider, so a model id with a colon in it (`openai/gpt-4o:free`) is not
    // split, and no provider-specific rule applies.
    agent86_core::provider::capabilities::context_window_for(
        &format!("table:{model}"),
        &builtin_config(),
    )
}

/// agent86's built-in prices plus `overrides`. Providers of a local-server kind are priced as
/// free under any name, as the CLI prices them.
pub fn price_table(
    overrides: &BTreeMap<String, ModelPrice>,
    providers: &BTreeMap<String, ProviderSettings>,
) -> PriceTable {
    let mut config = builtin_config();
    config.pricing.models = overrides
        .iter()
        .map(|(model, price)| {
            (
                model.clone(),
                agent86_core::config::ModelPrice {
                    input_per_mtok: price.input_per_mtok,
                    output_per_mtok: price.output_per_mtok,
                },
            )
        })
        .collect();
    config.providers.clear();
    for (name, provider) in providers {
        let adapter = match provider.kind {
            ProviderKind::Vllm => Some("vllm"),
            ProviderKind::Lmstudio => Some("lmstudio"),
            _ => None,
        };
        if let Some(adapter) = adapter {
            let section = ProviderConfig {
                adapter: Some(adapter.to_owned()),
                ..ProviderConfig::default()
            };
            config.providers.insert(name.clone(), section);
        }
    }
    PriceTable::from_config(&config)
}

/// A session title cleaned as agent86's `/rename` cleans it; `None` when nothing visible is left.
pub fn clean_title(raw: &str) -> Option<String> {
    agent86_core::session::clean_title(raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_knows_common_models_and_defaults_the_rest() {
        assert!(table_context_window("claude-opus-4-8") >= 200_000);
        assert_eq!(
            table_context_window("someone/unheard-of:free"),
            table_context_window("another-unknown")
        );
    }

    #[test]
    fn titles_are_cleaned_as_rename_cleans_them() {
        assert_eq!(clean_title("  Fix it \nmore").as_deref(), Some("Fix it"));
        assert_eq!(clean_title("   "), None);
    }

    #[test]
    fn keys_are_checked_before_they_are_stored() {
        assert_eq!(keyring::validate("  sk-abc  ").as_deref(), Ok("sk-abc"));
        assert!(keyring::validate("sk a").is_err());
        assert!(keyring::validate("").is_err());
    }
}
