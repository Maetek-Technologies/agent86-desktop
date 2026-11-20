//! Saved sessions: the memory database shared with the agent86 CLI (docs/PROJECT_PLAN.md D2),
//! opened once for the whole app, and which workspace each session belongs to.
//!
//! agent86's session table records no folder, but a session must reopen in one (it is the jail).
//! The app keeps its own record of where it ran each session, and falls back to what agent86's
//! editor server recorded; otherwise the UI asks for the folder.

use crate::cli_config;
use agent86_core::sdk::Memory;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use ts_rs::TS;

/// The memory database as opened, shared by every thread (its clones share one connection).
#[derive(Clone)]
pub struct OpenMemory {
    pub memory: Memory,
    pub path: PathBuf,
    /// agent86's note when the embedder fell back to the hash embedder.
    pub note: Option<String>,
}

/// One saved session, for the list.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionSummary {
    pub id: String,
    pub title: Option<String>,
    /// Seconds since the Unix epoch.
    pub updated_at: f64,
    /// The folder it ran in, when known.
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionList {
    pub sessions: Vec<SessionSummary>,
    /// The memory database, when it is open.
    pub database: Option<String>,
    /// Why there are no sessions (memory off, the database would not open).
    pub problem: Option<String>,
    /// agent86's note about the embedder, if it fell back.
    pub note: Option<String>,
}

pub struct Sessions {
    memory: OnceLock<Result<OpenMemory, String>>,
    /// `{app config dir}/session-workspaces.json`: session id to folder. `None` when the app has
    /// no config folder; then nothing is remembered and the UI asks for folders.
    workspaces_file: Option<PathBuf>,
    workspaces: Mutex<Option<HashMap<String, String>>>,
}

impl Sessions {
    pub fn new(app_config_dir: Option<&Path>) -> Self {
        Self {
            memory: OnceLock::new(),
            workspaces_file: app_config_dir.map(|dir| dir.join("session-workspaces.json")),
            workspaces: Mutex::new(None),
        }
    }

    /// The shared memory, opened on first use (loading the embedder can take a few seconds, so
    /// call this off the UI thread). Stays as first opened for the app's life.
    pub fn memory(&self) -> Result<OpenMemory, String> {
        self.memory
            .get_or_init(|| {
                let config = cli_config::load()?;
                let (memory, path, note) = cli_config::open_memory(&config)?;
                Ok(OpenMemory { memory, path, note })
            })
            .clone()
    }

    /// Recent sessions, newest first.
    pub fn list(&self, limit: usize) -> SessionList {
        let opened = match self.memory() {
            Ok(opened) => opened,
            Err(problem) => {
                return SessionList {
                    sessions: Vec::new(),
                    database: None,
                    problem: Some(problem),
                    note: None,
                }
            }
        };
        let recent = match opened.memory.store().recent_sessions(limit) {
            Ok(recent) => recent,
            Err(error) => {
                return SessionList {
                    sessions: Vec::new(),
                    database: Some(opened.path.display().to_string()),
                    problem: Some(error.0),
                    note: opened.note,
                }
            }
        };
        let own = self.own_workspaces();
        let acp = cli_config::acp_session_workspaces();
        let sessions = recent
            .into_iter()
            .map(|session| {
                let workspace = own
                    .get(&session.session_id)
                    .or_else(|| acp.get(&session.session_id))
                    .filter(|folder| Path::new(folder).is_dir())
                    .cloned();
                SessionSummary {
                    id: session.session_id,
                    title: session.title,
                    updated_at: session.updated_at,
                    workspace,
                }
            })
            .collect();
        SessionList {
            sessions,
            database: Some(opened.path.display().to_string()),
            problem: None,
            note: opened.note,
        }
    }

    /// Give session `id` a title, cleaned as agent86's `/rename` cleans it. Returns the title kept.
    pub fn rename(&self, id: &str, title: &str) -> Result<String, String> {
        let title = agent86_core::session::clean_title(title)
            .map_err(|_| "A title needs some visible text.".to_owned())?;
        let opened = self.memory()?;
        match opened.memory.store().set_title(id, &title) {
            Ok(true) => Ok(title),
            Ok(false) => Err("That session has not been saved yet; send a message first.".into()),
            Err(error) => Err(error.0),
        }
    }

    /// Remember that session `id` runs in `workspace`.
    pub fn record_workspace(&self, id: &str, workspace: &Path) {
        let mut guard = self
            .workspaces
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let map = guard.get_or_insert_with(|| read_map(self.workspaces_file.as_deref()));
        let folder = workspace.display().to_string();
        if map.get(id) == Some(&folder) {
            return;
        }
        map.insert(id.to_owned(), folder);
        // Not remembered if this fails; the UI asks for the folder next time instead.
        if let Some(file) = &self.workspaces_file {
            let _ = write_map(file, map);
        }
    }

    fn own_workspaces(&self) -> HashMap<String, String> {
        let mut guard = self
            .workspaces
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .get_or_insert_with(|| read_map(self.workspaces_file.as_deref()))
            .clone()
    }
}

fn read_map(path: Option<&Path>) -> HashMap<String, String> {
    let Some(path) = path else {
        return HashMap::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_map(path: &Path, map: &HashMap<String, String>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(map).map_err(std::io::Error::other)?;
    // Written whole to a temporary file, then moved over, so a crash never leaves half a file.
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, text)?;
    std::fs::rename(partial, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_workspaces_and_reads_them_back_after_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let sessions = Sessions::new(Some(dir.path()));
        sessions.record_workspace("abc", folder.path());
        sessions.record_workspace("abc", folder.path());
        let again = Sessions::new(Some(dir.path()));
        assert_eq!(
            again.own_workspaces().get("abc").map(String::as_str),
            Some(folder.path().display().to_string().as_str())
        );
        assert!(!dir.path().join("session-workspaces.json.partial").exists());
    }

    #[test]
    fn without_a_config_folder_nothing_is_remembered_and_nothing_fails() {
        let folder = tempfile::tempdir().unwrap();
        let sessions = Sessions::new(None);
        sessions.record_workspace("abc", folder.path());
        assert!(sessions.own_workspaces().contains_key("abc"));
        assert!(Sessions::new(None).own_workspaces().is_empty());
    }
}
