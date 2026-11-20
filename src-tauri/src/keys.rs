//! API keys: in the OS keyring under service `agent86`, account = the provider's name, exactly
//! where `agent86 keys set <provider>` puts them, so a key set in either is used by both. A
//! provider's `apiKeyEnv` variable, when set in the environment, wins, as in the CLI.
//!
//! Key values never go back to the WebView: the UI sees only whether a key is there and where
//! it comes from.

use crate::settings::{KeyUse, ProviderSettings};
use crate::unstable;
use serde::Serialize;
use std::collections::BTreeMap;
use ts_rs::TS;

/// Where keys are looked up. The app uses [`OsKeys`]; tests use a map.
pub trait KeySource: Send + Sync {
    /// Environment variable `name`, if set and not empty.
    fn env(&self, name: &str) -> Option<String>;
    /// The keyring entry for `account` (service `agent86`), if any.
    fn keyring(&self, account: &str) -> Option<String>;
}

/// The process environment and the OS keyring.
pub struct OsKeys;

impl KeySource for OsKeys {
    fn env(&self, name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|value| !value.is_empty())
    }

    fn keyring(&self, account: &str) -> Option<String> {
        unstable::keyring::get(account)
    }
}

/// Provider `name`'s key: its `apiKeyEnv` variable, then the keyring. `None` for a provider that
/// never sends one.
pub fn resolve(name: &str, provider: &ProviderSettings, keys: &dyn KeySource) -> Option<String> {
    if provider.key_use() == KeyUse::None {
        return None;
    }
    provider
        .api_key_env
        .as_deref()
        .filter(|env| !env.is_empty())
        .and_then(|env| keys.env(env))
        .or_else(|| keys.keyring(name))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum KeyState {
    /// Stored in the keyring.
    Keyring,
    /// Taken from the environment variable named in `env`.
    Env,
    /// Needed and not found: threads with this provider will not start.
    Missing,
    /// None found, and none is needed (a local server).
    NotSet,
    /// This provider never uses a key.
    NotUsed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KeyStatus {
    pub provider: String,
    pub state: KeyState,
    /// The environment variable consulted first, if the provider names one.
    pub env: Option<String>,
    /// Whether a key is also in the keyring (it may be shadowed by the environment).
    pub in_keyring: bool,
}

/// Where each provider's key would come from now.
pub fn statuses(
    providers: &BTreeMap<String, ProviderSettings>,
    keys: &dyn KeySource,
) -> Vec<KeyStatus> {
    providers
        .iter()
        .map(|(name, provider)| {
            let env = provider.api_key_env.clone().filter(|env| !env.is_empty());
            let in_keyring = keys.keyring(name).is_some();
            let from_env = env.as_deref().is_some_and(|env| keys.env(env).is_some());
            let state = match provider.key_use() {
                KeyUse::None => KeyState::NotUsed,
                _ if from_env => KeyState::Env,
                _ if in_keyring => KeyState::Keyring,
                KeyUse::Required => KeyState::Missing,
                KeyUse::Optional => KeyState::NotSet,
            };
            KeyStatus {
                provider: name.clone(),
                state,
                env,
                in_keyring,
            }
        })
        .collect()
}

/// Store `raw` (checked and trimmed first) as provider `provider`'s key.
pub fn set(provider: &str, raw: &str) -> Result<(), String> {
    check_account(provider)?;
    let key = unstable::keyring::validate(raw)?;
    unstable::keyring::set(provider, &key)
        .map_err(|error| format!("Could not store the key in the OS keyring: {error}"))
}

/// Remove provider `provider`'s key from the keyring. `Ok(false)` when there was none.
pub fn delete(provider: &str) -> Result<bool, String> {
    check_account(provider)?;
    unstable::keyring::delete(provider)
        .map_err(|error| format!("Could not remove the key from the OS keyring: {error}"))
}

fn check_account(provider: &str) -> Result<(), String> {
    let ok = !provider.is_empty()
        && provider.len() <= 64
        && provider
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        Err(format!("{provider:?} is not a provider name."))
    }
}

#[cfg(test)]
pub mod testing {
    use super::KeySource;
    use std::collections::HashMap;

    /// Keys from maps, never the real environment or keyring.
    #[derive(Default)]
    pub struct FakeKeys {
        pub env: HashMap<String, String>,
        pub keyring: HashMap<String, String>,
    }

    impl FakeKeys {
        pub fn keyring(entries: &[(&str, &str)]) -> Self {
            Self {
                keyring: entries
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                    .collect(),
                ..Self::default()
            }
        }
    }

    impl KeySource for FakeKeys {
        fn env(&self, name: &str) -> Option<String> {
            self.env.get(name).cloned()
        }

        fn keyring(&self, account: &str) -> Option<String> {
            self.keyring.get(account).cloned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::FakeKeys;
    use super::*;
    use crate::settings::{preset, ProviderKind};

    #[test]
    fn the_environment_wins_then_the_keyring_under_the_provider_name() {
        let openrouter = preset("openrouter").unwrap();
        let mut keys = FakeKeys::keyring(&[("openrouter", "from-keyring")]);
        assert_eq!(
            resolve("openrouter", &openrouter, &keys).as_deref(),
            Some("from-keyring")
        );
        keys.env
            .insert("OPENROUTER_API_KEY".into(), "from-env".into());
        assert_eq!(
            resolve("openrouter", &openrouter, &keys).as_deref(),
            Some("from-env")
        );
        assert_eq!(resolve("ollama", &preset("ollama").unwrap(), &keys), None);
    }

    #[test]
    fn statuses_tell_where_a_key_comes_from() {
        let mut providers = BTreeMap::new();
        providers.insert("openrouter".to_owned(), preset("openrouter").unwrap());
        providers.insert("anthropic".to_owned(), preset("anthropic").unwrap());
        providers.insert("vllm".to_owned(), preset("vllm").unwrap());
        providers.insert("ollama".to_owned(), preset("ollama").unwrap());
        providers.insert(
            "custom".to_owned(),
            ProviderSettings::of_kind(ProviderKind::Openai),
        );
        let mut keys = FakeKeys::keyring(&[("openrouter", "k1"), ("custom", "k2")]);
        keys.env.insert("OPENROUTER_API_KEY".into(), "k3".into());
        let by_name: BTreeMap<_, _> = statuses(&providers, &keys)
            .into_iter()
            .map(|status| (status.provider.clone(), status))
            .collect();
        assert_eq!(by_name["openrouter"].state, KeyState::Env);
        assert!(by_name["openrouter"].in_keyring);
        assert_eq!(by_name["custom"].state, KeyState::Keyring);
        assert_eq!(by_name["anthropic"].state, KeyState::Missing);
        assert_eq!(
            by_name["anthropic"].env.as_deref(),
            Some("ANTHROPIC_API_KEY")
        );
        assert_eq!(by_name["vllm"].state, KeyState::NotSet);
        assert_eq!(by_name["ollama"].state, KeyState::NotUsed);
    }

    #[test]
    fn odd_account_names_are_refused_before_the_keyring_is_touched() {
        assert!(set("../x", "sk-abcdef").is_err());
        assert!(delete("").is_err());
    }
}
