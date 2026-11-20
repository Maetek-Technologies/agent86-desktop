//! Every command the WebView may call. Kept thin: validate, then hand off to the managers that
//! arrive in later milestones.

use agent86_core::sdk::Memory;
use serde::Serialize;

/// The agent86-core version this build embeds. It matches the exact pin in Cargo.toml; the test
/// below fails if the two drift apart.
pub const AGENT86_CORE_VERSION: &str = "1.1.0";

#[derive(Debug, Serialize, PartialEq, Eq)]
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
}
