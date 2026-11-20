mod agent_factory;
mod cli_import;
mod commands;
mod keys;
mod memory_panel;
mod panel_commands;
mod secrets;
mod sessions;
mod settings;
mod threads;
mod trust;
mod unstable;
mod workspace_files;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(threads::ThreadManager::default())
        .setup(|app| {
            // Without a config folder (an unusual profile) the app still runs; it just does not
            // remember its settings or which folder each session ran in.
            let config_dir = config_dir(app);
            app.manage(settings::SettingsStore::open(config_dir.as_deref()));
            app.manage(sessions::Sessions::new(config_dir.as_deref()));
            app.manage(trust::TrustStore::open(config_dir.as_deref()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::model_info,
            commands::get_settings,
            commands::save_settings,
            commands::preview_cli_import,
            commands::key_statuses,
            commands::set_key,
            commands::delete_key,
            commands::test_model,
            commands::pick_workspace,
            commands::open_thread,
            commands::list_sessions,
            commands::rename_session,
            commands::prompt,
            commands::find_files,
            commands::cancel_turn,
            commands::answer,
            commands::close_thread,
            commands::reload_thread,
            panel_commands::list_memory,
            panel_commands::pin_memory,
            panel_commands::forget_memory,
            panel_commands::list_secrets,
            panel_commands::set_secret,
            panel_commands::forget_secret,
            panel_commands::review_project,
            panel_commands::trust_project,
            panel_commands::trusted_projects,
            panel_commands::forget_trust,
        ])
        .run(tauri::generate_context!())
        .expect("error while running agent86-desktop");
}

/// The app's config folder: `AGENT86_DESKTOP_CONFIG_DIR` when set (for trying the app without
/// touching its real settings, such as a first run), else the platform's.
fn config_dir(app: &tauri::App) -> Option<std::path::PathBuf> {
    std::env::var_os("AGENT86_DESKTOP_CONFIG_DIR")
        .filter(|dir| !dir.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| app.path().app_config_dir().ok())
}
