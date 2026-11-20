mod cli_config;
mod commands;
mod sessions;
mod threads;
mod workspace_files;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(threads::ThreadManager::default())
        .setup(|app| {
            // Without a config folder (an unusual profile) the app still runs; it just does not
            // remember which folder each session ran in.
            let config_dir = app.path().app_config_dir().ok();
            app.manage(sessions::Sessions::new(config_dir.as_deref()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::model_info,
            commands::pick_workspace,
            commands::open_thread,
            commands::list_sessions,
            commands::rename_session,
            commands::prompt,
            commands::find_files,
            commands::cancel_turn,
            commands::answer,
            commands::close_thread,
        ])
        .run(tauri::generate_context!())
        .expect("error while running agent86-desktop");
}
