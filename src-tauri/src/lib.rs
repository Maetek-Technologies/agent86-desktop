mod cli_config;
mod commands;
mod threads;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(threads::ThreadManager::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::model_info,
            commands::pick_workspace,
            commands::open_thread,
            commands::prompt,
            commands::cancel_turn,
            commands::answer,
            commands::close_thread,
        ])
        .run(tauri::generate_context!())
        .expect("error while running agent86-desktop");
}
