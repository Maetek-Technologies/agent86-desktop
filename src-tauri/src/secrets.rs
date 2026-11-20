//! What the secrets panel shows of a thread's secrets: names, never values.

use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SecretInfo {
    pub name: String,
    /// Kept in the OS keyring for this project, and loaded into every thread opened in it (by
    /// the app or the CLI).
    pub remembered: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SecretList {
    pub secrets: Vec<SecretInfo>,
    /// Whether a secret can be remembered for the project (an OS keyring is there).
    pub can_remember: bool,
}
