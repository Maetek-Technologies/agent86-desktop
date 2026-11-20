//! What makes the app feel native (docs/PROJECT_PLAN.md §3.3): the window's theme, an optional
//! tray icon with the turns running, and notifications that bring the app forward on the tab
//! that asked. All of it is driven from Rust; the webview gets no plugin permissions for it.

use crate::settings::{Theme, UiSettings};
use crate::threads::ThreadManager;
use std::collections::HashMap;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_notification::NotificationExt;

const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "agent86";

/// The event the webview hears when a notification for one of its tabs is clicked; the payload
/// is the tab's key.
pub const ACTIVATE_TAB_EVENT: &str = "activate-tab";

/// The app-wide state this module keeps.
#[derive(Default)]
pub struct Desktop {
    /// The tray menu's first line, which says what is running; set while the tray is shown.
    tray_status: Mutex<Option<MenuItem<Wry>>>,
    next_notification: AtomicI32,
    /// Which tab each notification shown was about.
    notified_tabs: Mutex<HashMap<i32, String>>,
}

/// Apply `ui` to the running app: the window's theme and whether the tray icon is shown.
pub fn apply_ui(app: &AppHandle, ui: &UiSettings) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let theme = match ui.theme {
            Theme::System => None,
            Theme::Light => Some(tauri::Theme::Light),
            Theme::Dark => Some(tauri::Theme::Dark),
        };
        let _ = window.set_theme(theme);
    }
    if ui.tray {
        if let Err(error) = show_tray(app) {
            log::warn!("Could not show the tray icon: {error}");
        }
    } else {
        hide_tray(app);
    }
}

fn show_tray(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        refresh_tray(app);
        return Ok(());
    }
    let status = MenuItem::with_id(app, "status", "No turns running", false, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Agent 86", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Agent 86", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&status, &separator, &show, &quit])?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Agent 86")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    *lock(&app.state::<Desktop>().tray_status) = Some(status);
    refresh_tray(app);
    Ok(())
}

fn hide_tray(app: &AppHandle) {
    let _ = app.remove_tray_by_id(TRAY_ID);
    *lock(&app.state::<Desktop>().tray_status) = None;
}

/// Bring the tray's text up to date with the turns running. Call when a turn starts or ends.
pub fn refresh_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let running = app.state::<ThreadManager>().running();
    let folders: Vec<String> = running
        .iter()
        .map(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.display().to_string())
        })
        .collect();
    let status = running_text(&folders);
    let _ = tray.set_tooltip(Some(format!("Agent 86: {status}")));
    // Beside the icon in the macOS menu bar (and some Linux panels); ignored elsewhere.
    let _ = tray.set_title((!running.is_empty()).then(|| running.len().to_string()));
    if let Some(item) = lock(&app.state::<Desktop>().tray_status).as_ref() {
        let _ = item.set_text(&status);
    }
}

/// "No turns running", "1 turn running (web)", "2 turns running (web, api)".
fn running_text(folders: &[String]) -> String {
    match folders.len() {
        0 => "No turns running".to_owned(),
        1 => format!("1 turn running ({})", folders[0]),
        n => format!("{n} turns running ({})", folders.join(", ")),
    }
}

/// Unminimize, show, and focus the main window.
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Listen for clicks on the app's notifications: each brings the window forward on its tab.
pub fn listen_for_notification_clicks(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.notification().on_action(move |action| {
        if action.action_id() != "tap" {
            return;
        }
        show_main(&handle);
        let tab = action
            .notification()
            .and_then(|n| lock(&handle.state::<Desktop>().notified_tabs).remove(&n.id()));
        if let Some(tab) = tab {
            let _ = handle.emit_to(MAIN_WINDOW, ACTIVATE_TAB_EVENT, tab);
        }
    });
}

/// Show a notification; clicking it brings the app forward on `tab`, if given.
pub fn notify(app: &AppHandle, title: &str, body: &str, tab: Option<String>) -> Result<(), String> {
    let desktop = app.state::<Desktop>();
    let id = desktop.next_notification.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(tab) = tab {
        let mut tabs = lock(&desktop.notified_tabs);
        // Old ones are only ever clicked from the notification centre; keep the map small.
        if tabs.len() > 100 {
            tabs.clear();
        }
        tabs.insert(id, tab);
    }
    app.notification()
        .builder()
        .id(id)
        .title(title)
        .body(body)
        .show()
        .map_err(|error| {
            log::warn!("A notification could not be shown: {error}");
            error.to_string()
        })
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tray_names_what_is_running() {
        assert_eq!(running_text(&[]), "No turns running");
        assert_eq!(running_text(&["web".into()]), "1 turn running (web)");
        assert_eq!(
            running_text(&["web".into(), "api".into()]),
            "2 turns running (web, api)"
        );
    }
}
