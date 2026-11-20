//! Saved sessions: the memory database shared with the agent86 CLI (docs/PROJECT_PLAN.md D2),
//! opened once for the whole app, and which workspace each session belongs to.
//!
//! agent86's session table records no folder, but a session must reopen in one (it is the jail).
//! The app keeps its own record of where it ran each session, and falls back to what agent86's
//! editor server recorded; otherwise the UI asks for the folder.

use crate::settings::{expand_home, home_dir, MemorySettings};
use crate::unstable;
use agent86_core::sdk::Memory;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
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
    /// Opened on first use with the settings of that moment, then kept for the app's life.
    memory: Mutex<Option<Result<OpenMemory, String>>>,
    /// `{app config dir}/session-workspaces.json`: session id to folder. `None` when the app has
    /// no config folder; then nothing is remembered and the UI asks for folders.
    workspaces_file: Option<PathBuf>,
    workspaces: Mutex<Option<HashMap<String, String>>>,
}

impl Sessions {
    pub fn new(app_config_dir: Option<&Path>) -> Self {
        Self {
            memory: Mutex::new(None),
            workspaces_file: app_config_dir.map(|dir| dir.join("session-workspaces.json")),
            workspaces: Mutex::new(None),
        }
    }

    /// The shared memory, opened on first use as `settings` say (loading the embedder can take a
    /// few seconds, so call this off the UI thread). Stays as first opened for the app's life, so
    /// a change to the memory settings applies after a restart.
    pub fn memory(&self, settings: &MemorySettings) -> Result<OpenMemory, String> {
        let mut guard = self
            .memory
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.get_or_insert_with(|| open_memory(settings)).clone()
    }

    /// Whether the memory database has been opened (successfully or not).
    pub fn memory_opened(&self) -> bool {
        self.memory
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
    }

    /// Recent sessions, newest first.
    pub fn list(&self, settings: Option<&MemorySettings>, limit: usize) -> SessionList {
        let Some(settings) = settings else {
            return SessionList {
                sessions: Vec::new(),
                database: None,
                problem: Some("Set up a model to see saved sessions.".into()),
                note: None,
            };
        };
        let opened = match self.memory(settings) {
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
        let acp = acp_session_workspaces();
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
    pub fn rename(
        &self,
        settings: &MemorySettings,
        id: &str,
        title: &str,
    ) -> Result<String, String> {
        let title = unstable::clean_title(title)
            .ok_or_else(|| "A title needs some visible text.".to_owned())?;
        let opened = self.memory(settings)?;
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

/// The memory database the CLI uses, opened as the CLI opens it: its path, its embedder (so
/// episodes and facts stay findable from both), and its retention.
fn open_memory(settings: &MemorySettings) -> Result<OpenMemory, String> {
    if !settings.enabled {
        return Err("Memory is turned off (Settings, Memory), so sessions are not saved.".into());
    }
    let path = expand_home(&settings.path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    let (memory, note) = unstable::open_memory(&path, &settings.embeddings, settings.hf_offline)?;
    let memory = memory.retention(
        settings.retention_max_episodes,
        settings.retention_max_sessions,
        settings.retention_max_age_days,
    );
    Ok(OpenMemory { memory, path, note })
}

/// The workspace agent86's editor server recorded for each session it ran
/// (`~/.agent86/acp-sessions.json`: session id to folder). Read only, as a hint for reopening a
/// session the app did not start; never written.
fn acp_session_workspaces() -> HashMap<String, String> {
    let Some(path) = home_dir().map(|home| home.join(".agent86").join("acp-sessions.json")) else {
        return HashMap::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
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
    fn without_settings_or_with_memory_off_the_list_says_why() {
        let sessions = Sessions::new(None);
        let unset = sessions.list(None, 10).problem.unwrap();
        assert!(unset.contains("Set up"), "{unset}");
        assert!(
            !sessions.memory_opened(),
            "not set up must not be remembered"
        );
        let off = MemorySettings {
            enabled: false,
            ..MemorySettings::default()
        };
        let problem = sessions.list(Some(&off), 10).problem.unwrap();
        assert!(problem.contains("turned off"), "{problem}");
        assert!(sessions.memory_opened());
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
