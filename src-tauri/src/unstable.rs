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
//! - Facts and episodes listed, pinned, and forgotten one at a time (the memory panel), with the
//!   pins in agent86's own table, as `agent86 memory` keeps them.
//! - A thread's secret vault: attached to the keyring with the CLI's per-project layout, so a
//!   secret remembered in either is loaded by both, and read for the secrets panel.
//! - Sub-agents' progress, reported through the harness's observer.
//! - A provider's model list (the thread's model menu), from agent86's catalog, which knows each
//!   provider's models endpoint and answer shape, as the CLI's `/model` does.
//!
//! The M1 stopgap that read the CLI's config.toml through agent86-core's loader is gone: the app
//! has its own settings (settings.rs) and imports the CLI's file itself (cli_import.rs).

use crate::memory_panel::{MemoryEntry, MemoryKind};
use crate::secrets::{SecretInfo, SecretList};
use crate::settings::{ModelPrice, ProviderKind, ProviderSettings};
use crate::threads::events::SubagentUpdate;
use agent86_core::config::{builtin_config, ProviderConfig};
use agent86_core::memory::entries::{Entry, EntryKind, ListQuery};
use agent86_core::sdk::{Agent, Embedder, Memory};
use agent86_core::subagent::SubagentEvent;
use agent86_core::vault::SecretVault;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

pub use agent86_core::pricing::PriceTable;

/// The models provider `section` offers, as `(id, label)` sorted by id, from its models endpoint.
/// Blocking (a short HTTP request); call off the UI thread. Fails with why there is no list.
pub fn model_catalog(
    section: &ProviderSettings,
    key: Option<&str>,
) -> Result<Vec<(String, String)>, String> {
    use agent86_core::provider::catalog;
    use std::time::Duration;
    let base = section
        .base_url
        .as_deref()
        .filter(|url| !url.trim().is_empty());
    let mut entries = match section.kind {
        ProviderKind::Anthropic => catalog::fetch_anthropic(key),
        ProviderKind::Ollama => catalog::fetch_ollama(base.unwrap_or("http://localhost:11434")),
        ProviderKind::Google => catalog::fetch_google(
            base.unwrap_or(agent86_core::provider::google::DEFAULT_BASE_URL),
            key,
        )
        .map(|models| models.into_iter().map(|m| (m.id, m.label)).collect()),
        ProviderKind::Llamacpp => Err(catalog::CatalogUnavailable(
            "llama.cpp has no model list; type the model's name.".to_owned(),
        )),
        ProviderKind::Lmstudio => {
            let base = base.unwrap_or("http://localhost:1234/v1");
            match catalog::fetch_lmstudio_models(base, key, Duration::from_secs(10)) {
                Ok(models) => Ok(models
                    .into_iter()
                    .filter(|m| m.kind == "llm")
                    .map(|m| (m.key, m.display_name))
                    .collect()),
                // An older LM Studio, or a proxy that passes only `/v1`: ids only.
                Err(_) => catalog::fetch_openai_compatible(base, key),
            }
        }
        ProviderKind::Openai | ProviderKind::Vllm => {
            catalog::fetch_openai_compatible(base.unwrap_or("https://api.openai.com/v1"), key)
        }
    }
    .map_err(|error| error.0)?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries.dedup_by(|a, b| a.0 == b.0);
    Ok(entries)
}

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

/// Facts or episodes, newest first, `limit` of them after skipping `offset`.
pub fn list_memory(
    memory: &Memory,
    kind: MemoryKind,
    pinned_only: bool,
    offset: usize,
    limit: usize,
) -> Result<Vec<MemoryEntry>, String> {
    memory
        .store()
        .list_entries(ListQuery {
            kind: entry_kind(kind),
            limit: Some(limit),
            offset,
            pinned_only,
        })
        .map(|entries| entries.into_iter().map(memory_entry).collect())
        .map_err(|error| error.0)
}

/// Pin or unpin one entry: the entry as it now stands, or `None` when there is no such entry.
pub fn pin_memory(
    memory: &Memory,
    kind: MemoryKind,
    id: i64,
    pinned: bool,
) -> Result<Option<MemoryEntry>, String> {
    memory
        .store()
        .set_pinned(entry_kind(kind), id, pinned)
        .map(|entry| entry.map(memory_entry))
        .map_err(|error| error.0)
}

/// Delete one entry, pinned or not; whether there was one.
pub fn forget_memory(memory: &Memory, kind: MemoryKind, id: i64) -> Result<bool, String> {
    memory
        .store()
        .forget(entry_kind(kind), id)
        .map_err(|error| error.0)
}

fn entry_kind(kind: MemoryKind) -> EntryKind {
    match kind {
        MemoryKind::Fact => EntryKind::Fact,
        MemoryKind::Episode => EntryKind::Episode,
    }
}

fn memory_entry(entry: Entry) -> MemoryEntry {
    MemoryEntry {
        kind: match entry.kind {
            EntryKind::Fact => MemoryKind::Fact,
            EntryKind::Episode => MemoryKind::Episode,
        },
        id: entry.id,
        stored_at: entry.ts,
        text: entry.text,
        outcome: entry.outcome,
        session_id: entry.session_id,
        category: entry.category,
        pinned: entry.pinned_at.is_some(),
    }
}

/// A thread's secrets: the agent's vault (clones share it), so the panel and the question
/// callbacks see what the agent holds, from any thread.
#[derive(Clone, Default)]
pub struct ThreadSecrets(SecretVault);

impl ThreadSecrets {
    /// The vault of `agent`.
    pub fn of(agent: &Agent) -> Self {
        Self(agent.harness().context.secrets.clone())
    }

    /// Remember secrets for `workspace` in the OS keyring, as the CLI does (account
    /// `secret:<workspace hash>:<NAME>`), and load what was remembered there. The names loaded.
    pub fn attach_keyring(&self, workspace: &Path) -> Vec<String> {
        self.0
            .attach_store(Arc::new(agent86_core::secrets::OsKeyring), workspace);
        self.0.load_remembered()
    }

    /// Names only, with whether each is remembered for the project.
    pub fn list(&self) -> SecretList {
        let remembered = self.0.remembered_names();
        let held = self.0.names();
        let mut secrets: Vec<SecretInfo> = held
            .iter()
            .map(|name| SecretInfo {
                name: name.clone(),
                remembered: remembered.contains(name),
            })
            .collect();
        // Remembered but not loaded (the keyring lost the value): listed, so it can be forgotten.
        for name in remembered.iter().filter(|name| !held.contains(name)) {
            secrets.push(SecretInfo {
                name: name.clone(),
                remembered: true,
            });
        }
        SecretList {
            secrets,
            can_remember: self.0.can_remember(),
        }
    }

    /// Hold `value` as `name` for the thread, and in the keyring for the project if `remember`.
    pub fn set(&self, name: &str, value: String, remember: bool) -> Result<(), String> {
        check_secret(name, &value)?;
        self.0.set(name, value);
        if remember {
            self.0.remember(name).map_err(|error| {
                format!("{name} is held for this thread, but not remembered: {error}")
            })?;
        }
        Ok(())
    }

    /// Drop `name` from the thread and the keyring; whether either had it.
    pub fn forget(&self, name: &str) -> Result<bool, String> {
        self.0.forget(name)
    }

    /// Hold every secret `other` holds that this vault does not (a thread rebuilt).
    pub fn carry_over(&self, other: &ThreadSecrets) {
        for (name, value) in other.0.entries() {
            if !self.0.contains(&name) {
                self.0.set(&name, value);
            }
        }
    }

    /// `value` with every held secret replaced by its placeholder.
    pub fn redact_value(&self, value: &mut serde_json::Value) {
        self.0.redact_value(value);
    }
}

/// Why `name` and `value` cannot be a secret, as agent86's `/secret` says.
pub fn check_secret(name: &str, value: &str) -> Result<(), String> {
    use agent86_core::vault::{reserved_name, valid_name, MIN_SECRET_CHARS};
    if !valid_name(name) {
        return Err(format!(
            "{name:?} is not a valid name: use letters, digits, and _, not starting with a digit."
        ));
    }
    if reserved_name(name) {
        return Err(format!(
            "{name} would change how programs run, so it cannot be a secret."
        ));
    }
    if value.chars().count() < MIN_SECRET_CHARS {
        return Err(format!(
            "A secret needs at least {MIN_SECRET_CHARS} characters."
        ));
    }
    Ok(())
}

/// Report `agent`'s sub-agents to `report` as (card id, whether the card's call was shown,
/// update). Arguments are redacted with `secrets`: agent86 leaves that to the surface, as it
/// does for the main loop's calls.
pub fn observe_subagents(
    agent: &Agent,
    secrets: ThreadSecrets,
    report: impl Fn(String, bool, SubagentUpdate) + Send + Sync + 'static,
) {
    let observer = move |event: &SubagentEvent<'_>| {
        let (card, update) = match *event {
            SubagentEvent::Started {
                card,
                run,
                name,
                depth,
                task,
            } => (
                card,
                SubagentUpdate::Started {
                    run,
                    name: name.to_owned(),
                    depth,
                    task: task.to_owned(),
                },
            ),
            SubagentEvent::ToolCall { card, call } => {
                let mut arguments = serde_json::Value::Object(call.arguments.clone());
                secrets.redact_value(&mut arguments);
                (
                    card,
                    SubagentUpdate::ToolCall {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        arguments,
                    },
                )
            }
            SubagentEvent::ToolResult { card, call, result } => (
                card,
                SubagentUpdate::tool_result(
                    &call.id,
                    &call.name,
                    result.ok,
                    &result.content,
                    result.error.clone(),
                ),
            ),
            SubagentEvent::Notice { card, text } => (
                card,
                SubagentUpdate::Notice {
                    text: text.to_owned(),
                },
            ),
            SubagentEvent::Finished {
                card,
                run,
                name,
                depth,
                ok,
                usage,
            } => (
                card,
                SubagentUpdate::Finished {
                    run,
                    name: name.to_owned(),
                    depth,
                    ok,
                    usage: usage.into(),
                },
            ),
        };
        report(card.id.clone(), card.announced, update);
    };
    agent
        .harness()
        .subagents
        .set_observer(Some(Arc::new(observer)));
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
    fn secrets_are_checked_as_agent86_checks_them() {
        assert!(check_secret("API_TOKEN", "abcdef").is_ok());
        assert!(check_secret("1BAD", "abcdef").is_err());
        assert!(check_secret("PATH", "abcdef").is_err());
        assert!(check_secret("TOKEN", "abc").is_err());
    }

    #[test]
    fn a_vault_without_a_keyring_holds_lists_and_forgets() {
        let secrets = ThreadSecrets::default();
        secrets.set("TOKEN", "s3cr3t-value".into(), false).unwrap();
        let list = secrets.list();
        assert!(!list.can_remember);
        assert_eq!(list.secrets[0].name, "TOKEN");
        assert!(!list.secrets[0].remembered);
        // Nowhere to remember it: still held, and the caller hears why it was not kept.
        assert!(secrets.set("OTHER", "s3cr3t-2".into(), true).is_err());
        let mut value = serde_json::json!({"cmd": "curl -H s3cr3t-value"});
        secrets.redact_value(&mut value);
        assert_eq!(value["cmd"], "curl -H ${secret:TOKEN}");
        let rebuilt = ThreadSecrets::default();
        rebuilt.carry_over(&secrets);
        assert_eq!(rebuilt.list().secrets.len(), 2);
        assert!(secrets.forget("TOKEN").unwrap());
        assert!(!secrets.forget("TOKEN").unwrap());
    }

    #[test]
    fn memory_entries_are_listed_pinned_and_forgotten() {
        let memory = Memory::in_memory().unwrap();
        assert!(list_memory(&memory, MemoryKind::Fact, false, 0, 10)
            .unwrap()
            .is_empty());
        assert_eq!(
            pin_memory(&memory, MemoryKind::Fact, 1, true).unwrap(),
            None
        );
        assert!(!forget_memory(&memory, MemoryKind::Episode, 1).unwrap());
    }

    #[test]
    fn keys_are_checked_before_they_are_stored() {
        assert_eq!(keyring::validate("  sk-abc  ").as_deref(), Ok("sk-abc"));
        assert!(keyring::validate("sk a").is_err());
        assert!(keyring::validate("").is_err());
    }
}
