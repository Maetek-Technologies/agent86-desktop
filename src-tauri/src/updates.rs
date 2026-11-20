//! Updates from GitHub Releases (docs/PROJECT_PLAN.md §3.3, M8), through tauri-plugin-updater used
//! from Rust only. The release workflow publishes `latest.json` and installers signed with the
//! updater key; the public half is in tauri.conf.json, so only builds signed with that key install.
//! Drafts and pre-releases are not offered: the endpoint is the latest published release.

use serde::Serialize;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use ts_rs::TS;

/// The update found by the last check, kept until it is installed.
#[derive(Default)]
pub struct Updates {
    found: Mutex<Option<Update>>,
}

/// A newer version, as the UI shows it.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// The release notes.
    pub notes: Option<String>,
    /// The day it was published (`2026-11-20`), if the release says.
    pub date: Option<String>,
}

/// How a download goes.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdateProgress {
    /// `downloaded` bytes of `total`, when the server says how many.
    Downloading {
        #[ts(type = "number")]
        downloaded: u64,
        #[ts(type = "number | null")]
        total: Option<u64>,
    },
    /// Downloaded and verified; the installer runs now.
    Installing,
}

/// Ask GitHub Releases for a newer version. `None` when this is the latest.
pub async fn check(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(describe)?;
    let found = updater.check().await.map_err(|error| {
        let text = describe(error);
        log::info!("Update check: {text}");
        text
    })?;
    match &found {
        Some(update) => log::info!("Update check: version {} is available", update.version),
        None => log::info!("Update check: this is the latest version"),
    }
    let info = found.as_ref().map(|update| UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone().filter(|notes| !notes.trim().is_empty()),
        date: update.date.map(|date| date.date().to_string()),
    });
    *lock(&app.state::<Updates>().found) = found;
    Ok(info)
}

/// Download, verify, and install the update the last check found. On Windows the installer
/// closes the app; elsewhere the caller restarts it.
pub async fn install(app: &AppHandle, progress: Channel<UpdateProgress>) -> Result<(), String> {
    let update = lock(&app.state::<Updates>().found)
        .clone()
        .ok_or("Check for updates first.")?;
    log::info!("Installing version {}", update.version);
    let mut downloaded = 0u64;
    let on_finish = progress.clone();
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.send(UpdateProgress::Downloading { downloaded, total });
            },
            move || {
                let _ = on_finish.send(UpdateProgress::Installing);
            },
        )
        .await
        .map_err(|error| {
            let text = describe(error);
            log::warn!("The update was not installed: {text}");
            text
        })
}

/// The updater's errors in the user's terms.
fn describe(error: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match error {
        Error::ReleaseNotFound => "No release has been published yet.".into(),
        Error::UnsupportedOs => "Updates are not supported on this system.".into(),
        Error::TargetNotFound(target) => {
            format!("The latest release has no update for this platform ({target}).")
        }
        Error::EmptyEndpoints => "This build has no update address.".into(),
        Error::Minisign(_) => {
            "The download does not match the release's update signature, so it was not installed."
                .into()
        }
        other => {
            let text = other.to_string();
            // Installed from a .deb or .rpm: the package manager updates the app.
            if text.contains("AppImage") || text.contains("package manager") {
                format!("{text} Install the new version with your package manager.")
            } else {
                text
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
