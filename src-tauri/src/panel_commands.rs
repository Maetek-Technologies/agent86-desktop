//! Commands behind the memory and secrets panels and project trust. Thin, like commands.rs.

use crate::memory_panel::{self, MemoryEntry, MemoryKind, MemoryPage};
use crate::secrets::SecretList;
use crate::sessions::Sessions;
use crate::settings::SettingsStore;
use crate::threads::ThreadManager;
use crate::trust::{self, ProjectContent, TrustStore, TrustedProject};
use agent86_core::sdk::Memory;
use std::path::PathBuf;
use tauri::{Manager, State};

/// The shared memory database, opened as the settings say.
fn memory(app: &tauri::AppHandle) -> Result<Memory, String> {
    let settings = app.state::<SettingsStore>().require()?;
    Ok(app.state::<Sessions>().memory(&settings.memory)?.memory)
}

/// Run `f` off the async workers (the database and the keyring can block).
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|error| error.to_string())?
}

/// A page of facts or episodes, newest first.
#[tauri::command]
pub async fn list_memory(
    app: tauri::AppHandle,
    kind: MemoryKind,
    pinned_only: bool,
    offset: usize,
    limit: usize,
) -> Result<MemoryPage, String> {
    blocking(move || memory_panel::page(&memory(&app)?, kind, pinned_only, offset, limit)).await
}

/// Pin an entry (retention never prunes it) or unpin it. Resolves to the entry as it stands.
#[tauri::command]
pub async fn pin_memory(
    app: tauri::AppHandle,
    kind: MemoryKind,
    id: i64,
    pinned: bool,
) -> Result<MemoryEntry, String> {
    blocking(move || memory_panel::pin(&memory(&app)?, kind, id, pinned)).await
}

/// Delete a fact or episode for good.
#[tauri::command]
pub async fn forget_memory(app: tauri::AppHandle, kind: MemoryKind, id: i64) -> Result<(), String> {
    blocking(move || memory_panel::forget(&memory(&app)?, kind, id)).await
}

/// The secrets thread `thread_id` holds or its project remembers: names only.
#[tauri::command]
pub async fn list_secrets(
    threads: State<'_, ThreadManager>,
    thread_id: String,
) -> Result<SecretList, String> {
    let secrets = threads.secrets(&thread_id)?;
    blocking(move || Ok(secrets.list())).await
}

/// Hold a secret for thread `thread_id` (tools get it as the environment variable `name`; the
/// model sees only `${secret:NAME}`), and keep it for the project too if `remember`.
#[tauri::command]
pub async fn set_secret(
    threads: State<'_, ThreadManager>,
    thread_id: String,
    name: String,
    value: String,
    remember: bool,
) -> Result<SecretList, String> {
    let secrets = threads.secrets(&thread_id)?;
    blocking(move || {
        secrets.set(name.trim(), value, remember)?;
        Ok(secrets.list())
    })
    .await
}

/// Drop a secret from the thread and from the project's keyring entries.
#[tauri::command]
pub async fn forget_secret(
    threads: State<'_, ThreadManager>,
    thread_id: String,
    name: String,
) -> Result<SecretList, String> {
    let secrets = threads.secrets(&thread_id)?;
    blocking(move || {
        secrets.forget(&name)?;
        Ok(secrets.list())
    })
    .await
}

/// Everything thread `thread_id`'s workspace would load once trusted, for review; `None` when
/// it brings nothing.
#[tauri::command]
pub async fn review_project(
    threads: State<'_, ThreadManager>,
    thread_id: String,
) -> Result<Option<ProjectContent>, String> {
    let workspace = threads.workspace(&thread_id)?;
    blocking(move || trust::scan(&workspace)).await
}

/// Trust thread `thread_id`'s workspace as reviewed (`sha256`). Refused if it changed since.
/// Reload the thread for it to take effect.
#[tauri::command]
pub async fn trust_project(
    app: tauri::AppHandle,
    thread_id: String,
    sha256: String,
) -> Result<(), String> {
    let workspace = app.state::<ThreadManager>().workspace(&thread_id)?;
    blocking(move || {
        app.state::<TrustStore>().trust(&workspace, &sha256)?;
        Ok(())
    })
    .await
}

/// The projects trusted so far.
#[tauri::command]
pub fn trusted_projects(store: State<'_, TrustStore>) -> Vec<TrustedProject> {
    store.list()
}

/// Stop trusting `workspace`; threads opened there afterwards load none of what it brings.
#[tauri::command]
pub fn forget_trust(store: State<'_, TrustStore>, workspace: String) -> Result<bool, String> {
    store.forget(&PathBuf::from(&workspace).display().to_string())
}
