mod agent_factory;
mod cli_import;
mod commands;
mod desktop;
mod file_actions;
mod keys;
mod memory_panel;
mod panel_commands;
mod secrets;
mod sessions;
mod settings;
mod threads;
mod trust;
mod unstable;
mod updates;
mod workspace_files;

use tauri::Manager;

pub fn run() {
    let config_override = config_override();
    let mut builder = tauri::Builder::default();
    // A second launch brings the running app forward instead of opening another window. A
    // separate config folder (AGENT86_DESKTOP_CONFIG_DIR) is a separate profile, so it runs as
    // an instance of its own. The plugin must be registered first.
    if config_override.is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            desktop::show_main(app)
        }));
    }
    // The window's size and place are kept beside the settings (an absolute file name replaces
    // the plugin's own folder, so a separate profile keeps its own).
    let window_state_file = match &config_override {
        Some(dir) => dir.join("window-state.json").display().to_string(),
        None => "window-state.json".to_owned(),
    };
    builder
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_filename(window_state_file)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(threads::ThreadManager::default())
        .manage(desktop::Desktop::default())
        .manage(updates::Updates::default())
        .setup(move |app| {
            // Without a config folder (an unusual profile) the app still runs; it just does not
            // remember its settings or which folder each session ran in.
            let config_dir = config_override
                .clone()
                .or_else(|| app.path().app_config_dir().ok());
            let store = settings::SettingsStore::open(config_dir.as_deref());
            let ui = store.get().ok().flatten().map(|s| s.ui).unwrap_or_default();
            app.manage(store);
            app.manage(sessions::Sessions::new(config_dir.as_deref()));
            app.manage(trust::TrustStore::open(config_dir.as_deref()));
            desktop::apply_ui(app.handle(), &ui);
            desktop::listen_for_notification_clicks(app.handle());
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
            commands::set_thread_model,
            commands::set_thread_approval,
            commands::list_models,
            commands::notify,
            commands::open_path,
            commands::check_update,
            commands::install_update,
            commands::restart_app,
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

/// `AGENT86_DESKTOP_CONFIG_DIR`, when set: a config folder used instead of the platform's (for
/// trying the app without touching its real settings, such as a first run).
fn config_override() -> Option<std::path::PathBuf> {
    std::env::var_os("AGENT86_DESKTOP_CONFIG_DIR")
        .filter(|dir| !dir.is_empty())
        .map(std::path::PathBuf::from)
}
