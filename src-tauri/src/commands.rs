//! Every command the WebView may call. Kept thin: validate, then hand off to the thread manager.
//! Commands that touch the disk, the keyring, or the network are `async`, so they never run on the
//! UI thread.

use crate::agent_factory;
use crate::cli_import::{self, ImportPreview};
use crate::desktop;
use crate::file_actions;
use crate::keys::{self, KeyStatus, OsKeys};
use crate::logs::{self, ActivityView, AppLogView, LogPaths};
use crate::sessions::{SessionList, Sessions};
use crate::settings::{self, Approval, ProviderPreset, ProviderSettings, Settings, SettingsStore};
use crate::threads::actor::{Capabilities, ThreadOptions};
use crate::threads::history::HistoryItem;
use crate::threads::manager::{ThreadOverrides, TurnRequest};
use crate::threads::questions::{Answer, UiAction};
use crate::threads::{DesktopEvent, ThreadManager};
use crate::trust::{self, ProjectStatus, TrustState, TrustStore};
use crate::updates::{self, UpdateInfo, UpdateProgress};
use agent86_core::sdk::Memory;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use ts_rs::TS;

/// The agent86-core version this build embeds. It matches the exact pin in Cargo.toml; the test
/// below fails if the two drift apart.
pub const AGENT86_CORE_VERSION: &str = "1.2.2";

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
    /// `provider:model`; empty before setup. Under triage, the frontier model.
    pub reference: String,
    #[ts(type = "number")]
    pub context_window: u64,
    /// Turns are routed between a cheap and a frontier model.
    pub triage: bool,
    /// Why a thread cannot start with these settings (not set up, no key), if it cannot.
    pub problem: Option<String>,
}

/// The model new threads will use, from the app's settings.
#[tauri::command]
pub async fn model_info(app: tauri::AppHandle) -> Result<ModelInfo, String> {
    // Keys are read from the keyring, which can block.
    tauri::async_runtime::spawn_blocking(move || describe_model(&app.state::<SettingsStore>()))
        .await
        .map_err(|error| error.to_string())
}

fn describe_model(store: &SettingsStore) -> ModelInfo {
    let settings = match store.require() {
        Ok(settings) => settings,
        Err(problem) => {
            return ModelInfo {
                reference: String::new(),
                context_window: 0,
                triage: false,
                problem: Some(problem),
            }
        }
    };
    let triage = settings.model.triage.as_ref();
    let reference = triage
        .map(|t| t.frontier.trim().to_owned())
        .unwrap_or_else(|| settings.model.default.trim().to_owned());
    let mut refs = vec![settings.model.default.clone()];
    if let Some(triage) = triage {
        refs.extend([triage.cheap.clone(), triage.frontier.clone()]);
    }
    let problem = refs
        .iter()
        .find_map(|r| agent_factory::model(&settings, r, &OsKeys).err());
    ModelInfo {
        context_window: agent_factory::context_window(&settings, &reference, &OsKeys),
        reference,
        triage: triage.is_some(),
        problem,
    }
}

/// The settings, the file they live in, and the CLI config that could be imported.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SettingsState {
    /// `None` before setup (the first-run screen) or when the file is unreadable.
    pub settings: Option<Settings>,
    /// Why the settings file could not be read, if it could not.
    pub problem: Option<String>,
    /// Where the settings are kept.
    pub path: Option<String>,
    /// The agent86 CLI's config file, when there is one to import.
    pub cli_config: Option<String>,
    /// agent86's built-in providers, the starting points for adding one.
    pub presets: Vec<ProviderPreset>,
    /// Settings with every default and no model, for the first-run screen to start from.
    pub defaults: Settings,
    /// The memory database is already open, so memory settings apply after a restart.
    pub memory_open: bool,
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> SettingsState {
    let store = app.state::<SettingsStore>();
    let (settings, problem) = match store.get() {
        Ok(settings) => (settings, None),
        Err(problem) => (None, Some(problem)),
    };
    SettingsState {
        settings,
        problem,
        path: store.path().map(|path| path.display().to_string()),
        cli_config: cli_import::cli_config_path()
            .filter(|path| path.is_file())
            .map(|path| path.display().to_string()),
        presets: settings::presets(),
        defaults: Settings::default(),
        memory_open: app.state::<Sessions>().memory_opened(),
    }
}

/// Check and keep `settings`; threads opened from now on use them. Fails listing every problem.
#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<Settings, String> {
    let saved = app
        .state::<SettingsStore>()
        .save(settings)
        .inspect_err(|problems| {
            log::info!("Settings were not saved: {}", problems.replace('\n', "; "))
        })?;
    log::info!("Settings saved");
    desktop::apply_ui(&app, &saved.ui);
    Ok(saved)
}

/// What importing the agent86 CLI's config would give. Nothing is kept until it is saved.
#[tauri::command]
pub async fn preview_cli_import() -> Result<ImportPreview, String> {
    let path = cli_import::cli_config_path()
        .filter(|path| path.is_file())
        .ok_or_else(|| "There is no agent86 CLI config (~/.agent86/config.toml).".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || cli_import::preview(&path))
        .await
        .map_err(|error| error.to_string())?
}

/// Where each provider's key comes from. `providers` may be unsaved (the settings being edited).
#[tauri::command]
pub async fn key_statuses(
    providers: BTreeMap<String, ProviderSettings>,
) -> Result<Vec<KeyStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || keys::statuses(&providers, &OsKeys))
        .await
        .map_err(|error| error.to_string())
}

/// Store an API key for `provider` in the OS keyring, where `agent86 keys set` keeps it.
#[tauri::command]
pub async fn set_key(provider: String, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || keys::set(&provider, &key))
        .await
        .map_err(|error| error.to_string())?
}

/// Remove `provider`'s key from the OS keyring. Resolves to whether there was one.
#[tauri::command]
pub async fn delete_key(provider: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || keys::delete(&provider))
        .await
        .map_err(|error| error.to_string())?
}

/// Send `reference` a one-line request with `settings` (which may be unsaved), to check the URL,
/// the key, and the model name. Resolves to a short description of the reply.
#[tauri::command]
pub async fn test_model(settings: Settings, reference: String) -> Result<String, String> {
    let test = async move {
        tokio::time::timeout(
            Duration::from_secs(60),
            agent_factory::test_model(&settings, &reference, &OsKeys),
        )
        .await
        .unwrap_or_else(|_| Err("No answer within 60 seconds.".into()))
    };
    tauri::async_runtime::spawn(test)
        .await
        .map_err(|error| error.to_string())?
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
    /// The thread runs on a model chosen in its header rather than the settings' (always false
    /// for a thread just opened).
    pub own_model: bool,
    /// What happens to side-effecting tool calls in this thread.
    pub approval: Approval,
    /// `approval` was chosen in the thread's header rather than taken from the settings.
    pub own_approval: bool,
    /// The agent86 session this thread saves to (new, or the one reopened).
    pub session_id: String,
    /// A reopened session's conversation; empty for a new one.
    pub history: Vec<HistoryItem>,
    /// agent86UI: the surfaces the reopened session left up, rebuilt by agent86 from its history,
    /// each as one A2UI `createSurface` message; empty for a new session.
    #[ts(type = "Array<Record<string, unknown>>")]
    pub surfaces: Vec<serde_json::Value>,
    /// Something to know about saving: the embedder fell back, or memory is off.
    pub memory_note: Option<String>,
    /// What the workspace brings (skills, specialists, MCP servers) and whether it is trusted;
    /// `None` when it brings nothing.
    pub project: Option<ProjectStatus>,
    /// What else to know about how the thread was set up.
    pub notes: Vec<String>,
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
        let opened = open_thread_blocking(&app, &workspace, session_id, on_event);
        match &opened {
            Ok(thread) => log::info!(
                "Thread {} opened in {} on {} (session {})",
                thread.thread_id,
                thread.workspace,
                thread.model,
                thread.session_id
            ),
            Err(error) => log::warn!("A thread could not be opened in {workspace}: {error}"),
        }
        opened
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
    let settings = app.state::<SettingsStore>().require()?;
    let setup = prepare(app, &settings, &workspace)?;
    let (memory, memory_note) = match sessions.memory(&settings.memory) {
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
    let mut builder = setup.plan.builder;
    let app_for_events = app.clone();
    let log_name = workspace.display().to_string();

    let opened = threads.open(
        Box::new(move || {
            if let Some(memory) = memory {
                builder = builder.memory(memory);
                if let Some(id) = resume {
                    builder = builder.session(id);
                }
            }
            Ok(builder)
        }),
        Arc::new(move |event| {
            let ended = match &event {
                DesktopEvent::TurnEnded {
                    stop_reason, usage, ..
                } => {
                    log::info!(
                        "Turn ended in {log_name} ({stop_reason:?}; {} in / {} out tokens, ${:.4})",
                        usage.input_tokens,
                        usage.output_tokens,
                        usage.cost_usd
                    );
                    true
                }
                DesktopEvent::TurnFailed { error } => {
                    log::warn!("Turn failed in {log_name}: {error}");
                    true
                }
                _ => false,
            };
            // A send fails only when the page has gone; the thread goes on regardless.
            let _ = on_event.send(event);
            if ended {
                desktop::refresh_tray(&app_for_events);
            }
        }),
        workspace.clone(),
        settings.tools.mention_max_bytes,
        session_id.as_deref(),
        ThreadOptions {
            keyring_workspace: Some(workspace.clone()),
            // The app draws agent86UI surfaces (src/thread/surface/).
            agent86ui: true,
        },
    )?;
    sessions.record_workspace(&opened.session_id, &workspace);
    let mut notes = setup.plan.notes;
    if !opened.loaded_secrets.is_empty() {
        notes.push(format!(
            "Secrets remembered for this project: {}.",
            opened.loaded_secrets.join(", ")
        ));
    }
    Ok(OpenedThread {
        thread_id: opened.id,
        workspace: workspace.display().to_string(),
        model: setup.plan.model,
        context_window: setup.plan.context_window,
        capabilities: opened.capabilities,
        own_model: false,
        approval: settings.guardrails.approval,
        own_approval: false,
        session_id: opened.session_id,
        history: opened.history,
        surfaces: opened.surfaces,
        memory_note,
        project: setup.project,
        notes,
    })
}

/// A thread's plan from `settings`, with what its project brings when the user trusts it.
struct Setup {
    plan: agent_factory::ThreadPlan,
    project: Option<ProjectStatus>,
}

fn prepare(app: &tauri::AppHandle, settings: &Settings, workspace: &Path) -> Result<Setup, String> {
    let (content, project, mut notes) = match trust::scan(workspace) {
        Ok(Some(content)) => {
            let state = app.state::<TrustStore>().state(&content);
            let status = content.status(state);
            (
                (state == TrustState::Trusted).then_some(content),
                Some(status),
                Vec::new(),
            )
        }
        Ok(None) => (None, None, Vec::new()),
        // Too big to review: nothing of the project loads, and the user hears why.
        Err(problem) => (None, None, vec![problem]),
    };
    let mut plan =
        agent_factory::thread_plan(settings, workspace.to_owned(), content.as_ref(), &OsKeys)?;
    notes.append(&mut plan.notes);
    plan.notes = notes;
    Ok(Setup { plan, project })
}

/// A thread rebuilt with the current settings and project trust, keeping its conversation.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReloadedThread {
    pub model: String,
    /// The thread runs on a model chosen in its header rather than the settings'.
    pub own_model: bool,
    pub approval: Approval,
    pub own_approval: bool,
    #[ts(type = "number")]
    pub context_window: u64,
    pub capabilities: Capabilities,
    pub project: Option<ProjectStatus>,
    pub notes: Vec<String>,
}

/// Rebuild thread `thread_id` with the settings and project trust as they are now (a project
/// just trusted, settings changed). Its conversation and secrets carry over. Only between turns.
#[tauri::command]
pub async fn reload_thread(
    app: tauri::AppHandle,
    thread_id: String,
) -> Result<ReloadedThread, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let overrides = app.state::<ThreadManager>().overrides(&thread_id)?;
        rebuild(&app, &thread_id, &overrides)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Run thread `thread_id` on `model` (`provider:model`) from now on, keeping its conversation:
/// the model menu in its header. An empty `model` goes back to the settings' model (and triage).
/// Only between turns; other threads and the settings keep theirs.
#[tauri::command]
pub async fn set_thread_model(
    app: tauri::AppHandle,
    thread_id: String,
    model: String,
) -> Result<ReloadedThread, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let threads = app.state::<ThreadManager>();
        let overrides = ThreadOverrides {
            model: Some(model.trim().to_owned()).filter(|model| !model.is_empty()),
            ..threads.overrides(&thread_id)?
        };
        let reloaded = rebuild(&app, &thread_id, &overrides)?;
        threads.set_overrides(&thread_id, overrides)?;
        Ok(reloaded)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Set what happens to side-effecting tool calls in thread `thread_id` from now on (ask, run
/// without asking, refuse), keeping its conversation and its "always allow" choices: the
/// permission menu in its header. `None` goes back to the settings' mode. Only between turns.
#[tauri::command]
pub async fn set_thread_approval(
    app: tauri::AppHandle,
    thread_id: String,
    approval: Option<Approval>,
) -> Result<ReloadedThread, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let threads = app.state::<ThreadManager>();
        let overrides = ThreadOverrides {
            approval,
            ..threads.overrides(&thread_id)?
        };
        let reloaded = rebuild(&app, &thread_id, &overrides)?;
        threads.set_overrides(&thread_id, overrides)?;
        Ok(reloaded)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The settings a thread runs with: the app's, with what its header chose laid over them (a model
/// runs alone, without triage).
fn settings_for(settings: Settings, overrides: &ThreadOverrides) -> Settings {
    let mut settings = settings;
    if let Some(model) = &overrides.model {
        settings.model.default = model.clone();
        settings.model.triage = None;
    }
    if let Some(approval) = overrides.approval {
        settings.guardrails.approval = approval;
    }
    settings
}

/// Rebuild thread `thread_id` from the current settings and project trust, with `overrides`.
fn rebuild(
    app: &tauri::AppHandle,
    thread_id: &str,
    overrides: &ThreadOverrides,
) -> Result<ReloadedThread, String> {
    let threads = app.state::<ThreadManager>();
    let workspace = threads.workspace(thread_id)?;
    let settings = settings_for(app.state::<SettingsStore>().require()?, overrides);
    let result = rebuild_with(app, thread_id, overrides, &settings, &workspace);
    if let Err(error) = &result {
        log::warn!("Thread {thread_id} was not rebuilt: {error}");
    }
    result
}

fn rebuild_with(
    app: &tauri::AppHandle,
    thread_id: &str,
    overrides: &ThreadOverrides,
    settings: &Settings,
    workspace: &Path,
) -> Result<ReloadedThread, String> {
    let threads = app.state::<ThreadManager>();
    if let Some(model) = &overrides.model {
        // Say plainly what is wrong (no such provider, no key) before touching the thread.
        agent_factory::model(settings, model, &OsKeys)?;
    }
    let setup = prepare(app, settings, workspace)?;
    // The conversation comes over from the old agent; memory keeps saving it.
    let memory = app.state::<Sessions>().memory(&settings.memory).ok();
    let mut builder = setup.plan.builder;
    let capabilities = threads.reload(
        thread_id,
        Box::new(move || {
            if let Some(opened) = memory {
                builder = builder.memory(opened.memory);
            }
            Ok(builder)
        }),
    )?;
    log::info!(
        "Thread {thread_id} rebuilt on {} with approval {:?}{}{}",
        setup.plan.model,
        settings.guardrails.approval,
        if overrides.model.is_some() {
            " (own model)"
        } else {
            ""
        },
        if overrides.approval.is_some() {
            " (own approval)"
        } else {
            ""
        }
    );
    Ok(ReloadedThread {
        model: setup.plan.model,
        own_model: overrides.model.is_some(),
        approval: settings.guardrails.approval,
        own_approval: overrides.approval.is_some(),
        context_window: setup.plan.context_window,
        capabilities,
        project: setup.project,
        notes: setup.plan.notes,
    })
}

/// The models a thread's menu offers.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ModelMenu {
    /// The models the settings name (default, triage), as `provider:model`.
    pub configured: Vec<String>,
    /// Each provider's own list, by provider name, in settings order.
    pub providers: Vec<ProviderModels>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModels {
    pub provider: String,
    pub models: Vec<ModelChoice>,
    /// Why the provider gave no list (unreachable, no key, no listing), if it gave none.
    pub problem: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    /// `provider:model`.
    pub reference: String,
    /// The provider's display name when it differs from the id.
    pub label: Option<String>,
}

/// The models to choose from: those the settings name, and what each provider says it offers
/// (asked in parallel, a few seconds at most each).
#[tauri::command]
pub async fn list_models(app: tauri::AppHandle) -> Result<ModelMenu, String> {
    let settings = app.state::<SettingsStore>().require()?;
    let mut configured = vec![settings.model.default.trim().to_owned()];
    if let Some(triage) = &settings.model.triage {
        configured.extend([
            triage.frontier.trim().to_owned(),
            triage.cheap.trim().to_owned(),
        ]);
    }
    configured.retain(|reference| !reference.is_empty());
    configured.dedup();
    let asks = settings.providers.iter().map(|(name, section)| {
        let (name, section) = (name.clone(), section.clone());
        tauri::async_runtime::spawn_blocking(move || {
            let key = keys::resolve(&name, &section, &OsKeys);
            let listed = crate::unstable::model_catalog(&section, key.as_deref());
            (name, listed)
        })
    });
    let mut providers = Vec::new();
    for ask in asks.collect::<Vec<_>>() {
        let (provider, listed) = ask.await.map_err(|error| error.to_string())?;
        providers.push(match listed {
            Ok(entries) => ProviderModels {
                models: entries
                    .into_iter()
                    .map(|(id, label)| ModelChoice {
                        reference: format!("{provider}:{id}"),
                        label: (label != id && !label.trim().is_empty()).then_some(label),
                    })
                    .collect(),
                provider,
                problem: None,
            },
            Err(problem) => ProviderModels {
                provider,
                models: Vec::new(),
                problem: Some(problem),
            },
        });
    }
    Ok(ModelMenu {
        configured,
        providers,
    })
}

/// Recent saved sessions, newest first, from the memory database shared with the agent86 CLI.
#[tauri::command]
pub async fn list_sessions(
    app: tauri::AppHandle,
    limit: Option<usize>,
) -> Result<SessionList, String> {
    let limit = limit.unwrap_or(100).min(500);
    tauri::async_runtime::spawn_blocking(move || {
        let settings = app.state::<SettingsStore>().get().ok().flatten();
        app.state::<Sessions>()
            .list(settings.as_ref().map(|s| &s.memory), limit)
    })
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
        let settings = app.state::<SettingsStore>().require()?;
        app.state::<Sessions>()
            .rename(&settings.memory, &session_id, &title)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Start a turn: a message (with its `@` mentions inlined), a skill, or a specialist.
#[tauri::command]
pub fn prompt(
    app: tauri::AppHandle,
    threads: State<'_, ThreadManager>,
    thread_id: String,
    turn: TurnRequest,
) -> Result<(), String> {
    let kind = match &turn {
        TurnRequest::Goal { .. } => "message",
        TurnRequest::Skill { .. } => "skill",
        TurnRequest::Specialist { .. } => "specialist",
    };
    threads.prompt(&thread_id, turn)?;
    log::info!("Thread {thread_id}: turn started ({kind})");
    desktop::refresh_tray(&app);
    Ok(())
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

/// A button pressed on an agent86UI surface that no call waits on: it becomes the
/// next user message and runs a turn, now or, while one runs, when it ends. Returns whether it
/// was held. (An action a waiting call asked for is an `answer` instead.)
#[tauri::command]
pub fn ui_action(
    app: tauri::AppHandle,
    threads: State<'_, ThreadManager>,
    thread_id: String,
    action: UiAction,
) -> Result<bool, String> {
    let held = threads.ui_action(&thread_id, action)?;
    if held {
        log::info!("Thread {thread_id}: surface action held for the running turn");
    } else {
        log::info!("Thread {thread_id}: turn started (surface action)");
        desktop::refresh_tray(&app);
    }
    Ok(held)
}

/// Open a link a surface's `openUrl` asked for, after the user saw it and agreed. Only `http`
/// and `https` (src/surface_links.rs).
#[tauri::command]
pub fn open_surface_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = crate::surface_links::checked(&url)?;
    log::info!(
        "Opening a surface link to {}",
        url.host_str().unwrap_or_default()
    );
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn close_thread(
    app: tauri::AppHandle,
    threads: State<'_, ThreadManager>,
    thread_id: String,
) -> Result<(), String> {
    threads.close(&thread_id)?;
    log::info!("Thread {thread_id} closed");
    desktop::refresh_tray(&app);
    Ok(())
}

/// Show a desktop notification, unless notifications are off in Settings. Clicking it brings the
/// app forward on tab `tab` (the webview's own key for it).
#[tauri::command]
pub fn notify(
    app: tauri::AppHandle,
    title: String,
    body: String,
    tab: Option<String>,
) -> Result<(), String> {
    let enabled = app
        .state::<SettingsStore>()
        .get()
        .ok()
        .flatten()
        .is_none_or(|settings| settings.ui.notifications);
    if !enabled {
        return Ok(());
    }
    desktop::notify(&app, &title, &body, tab)
}

/// Open `path` with its default app, or with `reveal`, show it in Explorer or Finder. Only files
/// inside thread `thread_id`'s workspace, or a worktree its sub-agents kept, and never a program
/// or script by opening it.
#[tauri::command]
pub async fn open_path(
    app: tauri::AppHandle,
    thread_id: String,
    path: String,
    reveal: bool,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let roots = app.state::<ThreadManager>().file_roots(&thread_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = file_actions::resolve(&path, &roots).inspect_err(|error| {
            log::warn!("Open refused: {error}");
        })?;
        if !reveal && file_actions::runs_when_opened(&resolved) {
            log::warn!("Open refused: {path} would run if opened");
            return Err(format!(
                "{path} would run if opened, so the app only reveals it in the file manager."
            ));
        }
        let shown = file_actions::shown(resolved);
        let opener = app.opener();
        if reveal {
            opener.reveal_item_in_dir(&shown)
        } else {
            opener.open_path(shown.display().to_string(), None::<&str>)
        }
        .map_err(|error| format!("{}: {error}", shown.display()))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Open a link from Markdown the model wrote (a chat reply): http, https, or mailto
/// (`surface_links::checked_document_link`), with the system's browser or mail app. The webview
/// has no opener permission of its own (capabilities/default.json), so this is the only way out.
#[tauri::command]
pub fn open_document_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = crate::surface_links::checked_document_link(&url)?;
    log::info!(
        "Opening a document link ({}) to {}",
        url.scheme(),
        url.host_str().unwrap_or_default()
    );
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// Look for a newer version on GitHub Releases. `None` when this one is the latest.
#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    updates::check(&app).await
}

/// Download and install the update the last check found; `on_progress` hears how it goes. On
/// Windows the installer then closes the app; elsewhere call `restart_app`.
#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    on_progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    updates::install(&app, on_progress).await
}

/// Restart the app (after an update is installed). Running turns stop.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart()
}

/// The last `limit` events of agent86's activity log (the flight recorder), oldest first.
#[tauri::command]
pub async fn read_activity(app: tauri::AppHandle, limit: Option<usize>) -> ActivityView {
    let limit = limit.unwrap_or(1000).clamp(1, 20_000);
    let dir = app
        .state::<SettingsStore>()
        .get()
        .ok()
        .flatten()
        .unwrap_or_default()
        .trace
        .dir();
    tauri::async_runtime::spawn_blocking(move || {
        logs::read_activity(dir.map(|dir| logs::trace_file(&dir)).as_deref(), limit)
    })
    .await
    .unwrap_or_else(|error| ActivityView {
        path: None,
        events: Vec::new(),
        note: Some(error.to_string()),
    })
}

/// The last `limit` entries of the app's own log, oldest first.
#[tauri::command]
pub async fn read_app_log(app: tauri::AppHandle, limit: Option<usize>) -> AppLogView {
    let limit = limit.unwrap_or(1000).clamp(1, 20_000);
    let path = app.state::<LogPaths>().app_log.clone();
    tauri::async_runtime::spawn_blocking(move || logs::read_app_log(path.as_deref(), limit))
        .await
        .unwrap_or_else(|error| AppLogView {
            path: None,
            lines: Vec::new(),
            note: Some(error.to_string()),
        })
}

/// Show a log file in Explorer or Finder: `activity` (agent86's trace) or `app` (the app's log).
#[tauri::command]
pub async fn reveal_log(app: tauri::AppHandle, which: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = match which.as_str() {
        "activity" => app
            .state::<SettingsStore>()
            .get()
            .ok()
            .flatten()
            .unwrap_or_default()
            .trace
            .dir()
            .map(|dir| logs::trace_file(&dir)),
        "app" => app.state::<LogPaths>().app_log.clone(),
        _ => None,
    }
    .ok_or("There is no such log.")?;
    // The file when it exists, else its folder.
    let target = if path.exists() {
        path
    } else {
        path.parent()
            .map(Path::to_path_buf)
            .ok_or("There is no such log.")?
    };
    if !target.exists() {
        return Err(format!("{} does not exist yet.", target.display()));
    }
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|error| format!("{}: {error}", target.display()))
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
pub(crate) fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.display().to_string();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

#[cfg(not(windows))]
pub(crate) fn strip_verbatim(path: PathBuf) -> PathBuf {
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
    fn before_setup_the_model_says_to_set_one_up() {
        let info = describe_model(&SettingsStore::open(None));
        assert_eq!(info.reference, "");
        assert!(info.problem.unwrap().contains("Set up a model"));
    }

    #[test]
    fn a_threads_own_model_replaces_the_default_and_triage() {
        let mut settings = Settings::default();
        settings.model.default = "vllm:a".into();
        settings.model.triage = Some(crate::settings::Triage {
            cheap: "vllm:c".into(),
            frontier: "vllm:f".into(),
        });
        let model = ThreadOverrides {
            model: Some("openrouter:x".into()),
            approval: None,
        };
        let own = settings_for(settings.clone(), &model);
        assert_eq!(own.model.default, "openrouter:x");
        assert!(own.model.triage.is_none());
        assert_eq!(own.guardrails.approval, settings.guardrails.approval);
        assert_eq!(
            settings_for(settings.clone(), &ThreadOverrides::default()),
            settings
        );
    }

    #[test]
    fn a_threads_own_approval_mode_replaces_the_settings() {
        let settings = Settings::default();
        assert_eq!(settings.guardrails.approval, Approval::Ask);
        let auto = ThreadOverrides {
            model: None,
            approval: Some(Approval::Auto),
        };
        let own = settings_for(settings.clone(), &auto);
        assert_eq!(own.guardrails.approval, Approval::Auto);
        assert_eq!(own.model, settings.model);
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
