//! Every command the WebView may call. Kept thin: validate, then hand off to the thread manager.
//! Commands that touch the disk or the network are `async`, so they never run on the UI thread.

use crate::cli_config;
use crate::sessions::{SessionList, Sessions};
use crate::threads::actor::Capabilities;
use crate::threads::history::HistoryItem;
use crate::threads::manager::TurnRequest;
use crate::threads::questions::Answer;
use crate::threads::{DesktopEvent, ThreadManager};
use agent86_core::sdk::{Agent, ApprovalMode, Builtins, Memory};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use ts_rs::TS;

/// The agent86-core version this build embeds. It matches the exact pin in Cargo.toml; the test
/// below fails if the two drift apart.
pub const AGENT86_CORE_VERSION: &str = "1.1.0";

#[derive(Debug, Serialize, PartialEq, Eq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_version: String,
    pub core_version: String,
    pub os: String,
    pub arch: String,
    pub memory_ok: bool,
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle) -> AppInfo {
    build_info(app.package_info().version.to_string())
}

fn build_info(app_version: String) -> AppInfo {
    AppInfo {
        app_version,
        core_version: AGENT86_CORE_VERSION.to_owned(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        // Proves the SDK and its bundled SQLite are linked and work on this platform.
        memory_ok: Memory::in_memory().is_ok(),
    }
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// `provider:model`.
    pub reference: String,
    #[ts(type = "number")]
    pub context_window: u64,
    /// The config files the model came from.
    pub source: String,
    /// Why a thread cannot start with this model (no key, unknown provider), if it cannot.
    pub problem: Option<String>,
}

/// The model new threads will use (M1: the agent86 CLI's default model).
#[tauri::command]
pub async fn model_info() -> Result<ModelInfo, String> {
    let config = cli_config::load()?;
    let source = cli_config::source_label(&config);
    Ok(match cli_config::model_setup(&config) {
        Ok(setup) => ModelInfo {
            reference: setup.reference,
            context_window: setup.context_window,
            source,
            problem: None,
        },
        Err(problem) => ModelInfo {
            reference: config.model.default.clone(),
            context_window: 0,
            source,
            problem: Some(problem),
        },
    })
}

/// Ask for a workspace folder with the native dialog. `None` when the user cancels.
#[tauri::command]
pub async fn pick_workspace(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|error| error.to_string())?;
    Ok(Some(path.display().to_string()))
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct OpenedThread {
    pub thread_id: String,
    /// The workspace as resolved (absolute, symlinks followed).
    pub workspace: String,
    pub model: String,
    /// Tokens of context the model holds, for the context meter.
    #[ts(type = "number")]
    pub context_window: u64,
    pub capabilities: Capabilities,
    /// The agent86 session this thread saves to (new, or the one reopened).
    pub session_id: String,
    /// A reopened session's conversation; empty for a new one.
    pub history: Vec<HistoryItem>,
    /// Something to know about saving: the embedder fell back, or memory is off.
    pub memory_note: Option<String>,
}

/// Start a thread in `workspace`, continuing saved session `session_id` if given. Its events
/// stream on `on_event` for the thread's life. Sessions are saved to the memory database shared
/// with the agent86 CLI.
#[tauri::command]
pub async fn open_thread(
    app: tauri::AppHandle,
    workspace: String,
    session_id: Option<String>,
    on_event: Channel<DesktopEvent>,
) -> Result<OpenedThread, String> {
    // Loading the embedder (first time) and building the agent block, so not on an async worker.
    tauri::async_runtime::spawn_blocking(move || {
        open_thread_blocking(&app, &workspace, session_id, on_event)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn open_thread_blocking(
    app: &tauri::AppHandle,
    workspace: &str,
    session_id: Option<String>,
    on_event: Channel<DesktopEvent>,
) -> Result<OpenedThread, String> {
    let threads = app.state::<ThreadManager>();
    let sessions = app.state::<Sessions>();
    let workspace = resolve_workspace(workspace)?;
    let config = cli_config::load()?;
    let setup = cli_config::model_setup(&config)?;
    let model = setup.reference.clone();
    let context_window = setup.context_window;
    let limits = config.limits.clone();
    let guardrails = config.guardrails.clone();
    let skill_dirs = cli_config::user_skill_dirs(&config);
    let subagents = cli_config::subagents(&config);
    let agent_workspace = workspace.clone();
    let (memory, memory_note) = match sessions.memory() {
        Ok(opened) => (Some(opened.memory), opened.note),
        Err(_) if session_id.is_some() => {
            return Err(
                "The memory database is not available, so saved sessions cannot be reopened."
                    .into(),
            )
        }
        Err(problem) => (None, Some(format!("This thread is not saved: {problem}"))),
    };
    let resume = session_id.clone();

    let opened = threads.open(
        Box::new(move || {
            let mut builder = Agent::builder()
                .provider(setup.provider)
                .workspace(agent_workspace)
                .builtins(Builtins::All)
                // Side-effecting calls go to the user; the thread actor installs the approver.
                .approval(ApprovalMode::Ask)
                .guardrails(guardrails)
                .context_window(setup.context_window)
                .max_output_tokens(setup.max_output_tokens)
                .max_steps(limits.max_steps)
                .max_cost_usd(limits.max_cost_usd)
                .max_wall_clock_s(limits.max_wall_clock_s)
                .tool_timeout(Duration::from_secs(limits.tool_timeout_s));
            for dir in skill_dirs {
                builder = builder.skills_dir(dir);
            }
            if let Some(subagents) = subagents {
                builder = builder.subagents(subagents);
            }
            if let Some(memory) = memory {
                builder = builder.memory(memory);
                if let Some(id) = resume {
                    builder = builder.session(id);
                }
            }
            Ok(builder)
        }),
        Arc::new(move |event| {
            // A send fails only when the page has gone; the thread goes on regardless.
            let _ = on_event.send(event);
        }),
        workspace.clone(),
        config.tools.mention_max_bytes,
        session_id.as_deref(),
    )?;
    sessions.record_workspace(&opened.session_id, &workspace);
    Ok(OpenedThread {
        thread_id: opened.id,
        workspace: workspace.display().to_string(),
        model,
        context_window,
        capabilities: opened.capabilities,
        session_id: opened.session_id,
        history: opened.history,
        memory_note,
    })
}

/// Recent saved sessions, newest first, from the memory database shared with the agent86 CLI.
#[tauri::command]
pub async fn list_sessions(
    app: tauri::AppHandle,
    limit: Option<usize>,
) -> Result<SessionList, String> {
    let limit = limit.unwrap_or(100).min(500);
    tauri::async_runtime::spawn_blocking(move || app.state::<Sessions>().list(limit))
        .await
        .map_err(|error| error.to_string())
}

/// Give a saved session a title (as agent86's `/rename`). Returns the title kept.
#[tauri::command]
pub async fn rename_session(
    app: tauri::AppHandle,
    session_id: String,
    title: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Sessions>().rename(&session_id, &title)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Start a turn: a message (with its `@` mentions inlined), a skill, or a specialist.
#[tauri::command]
pub fn prompt(
    threads: State<'_, ThreadManager>,
    thread_id: String,
    turn: TurnRequest,
) -> Result<(), String> {
    threads.prompt(&thread_id, turn)
}

/// Workspace files matching `query`, for the `@` menu.
#[tauri::command]
pub async fn find_files(
    threads: State<'_, ThreadManager>,
    thread_id: String,
    query: String,
) -> Result<Vec<String>, String> {
    threads.find_files(&thread_id, &query)
}

#[tauri::command]
pub fn cancel_turn(threads: State<'_, ThreadManager>, thread_id: String) -> Result<(), String> {
    threads.cancel(&thread_id)
}

/// The user's answer to a question the running turn asked (an approval, a limit, a secret).
#[tauri::command]
pub fn answer(
    threads: State<'_, ThreadManager>,
    thread_id: String,
    qid: u64,
    answer: Answer,
) -> Result<(), String> {
    threads.answer(&thread_id, qid, answer)
}

#[tauri::command]
pub fn close_thread(threads: State<'_, ThreadManager>, thread_id: String) -> Result<(), String> {
    threads.close(&thread_id)
}

/// An existing directory, made absolute with symlinks followed, as agent86-core's jail sees it.
fn resolve_workspace(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("Choose a workspace folder first.".into());
    }
    let path = std::fs::canonicalize(raw).map_err(|error| format!("{raw}: {error}"))?;
    if !path.is_dir() {
        return Err(format!("{raw} is not a folder."));
    }
    // canonicalize gives `\\?\C:\...` on Windows; agent86 and the UI read the plain form better.
    Ok(strip_verbatim(path))
}

#[cfg(windows)]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.display().to_string();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

#[cfg(not(windows))]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_reports_core_and_a_working_memory_store() {
        let info = build_info("9.9.9".into());
        assert_eq!(info.app_version, "9.9.9");
        assert_eq!(info.core_version, AGENT86_CORE_VERSION);
        assert!(info.memory_ok);
    }

    #[test]
    fn core_version_matches_the_cargo_pin() {
        let manifest = include_str!("../Cargo.toml");
        let pin = format!("agent86-core = \"={AGENT86_CORE_VERSION}\"");
        assert!(manifest.contains(&pin), "Cargo.toml should contain {pin}");
    }

    #[test]
    fn workspace_must_be_an_existing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(resolve_workspace("").is_err());
        assert!(resolve_workspace(&file.display().to_string()).is_err());
        assert!(resolve_workspace(&dir.path().join("missing").display().to_string()).is_err());
        let resolved = resolve_workspace(&dir.path().display().to_string()).unwrap();
        assert!(resolved.is_absolute());
        assert!(!resolved.display().to_string().starts_with(r"\\?\"));
    }
}
