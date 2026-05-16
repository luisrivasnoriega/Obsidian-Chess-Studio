use log::LevelFilter;
#[cfg(desktop)]
use tauri::Manager;
use tauri::{App, Window};

use crate::AppState;

pub mod desktop;
pub mod mobile;
pub mod shared;

#[tauri::command]
#[specta::specta]
pub async fn screen_capture(_window: Window) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let main_window = _window.get_webview_window("main").ok_or_else(|| {
            let error_msg = "No window labeled 'main' found";
            log::error!("{}", error_msg);
            String::from(error_msg)
        })?;
        main_window.show().map_err(|e| {
            let error_msg = format!("Failed to show main window: {}", e);
            log::error!("{}", error_msg);
            error_msg
        })?;

        if let Err(e) = main_window.set_focus() {
            log::warn!("Failed to focus main window: {}", e);
        }
    }

    #[cfg(mobile)]
    {
        // Mobile platforms handle window visibility automatically
    }

    Ok(())
}

/// Gets the AppData directory path for logs (Roaming on Windows)
/// This matches BaseDirectory::AppData behavior but is needed before app initialization
fn get_app_data_log_dir() -> std::path::PathBuf {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    const APP_IDENTIFIER: &str = "com.ocs";

    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            // APPDATA on Windows points to Roaming (AppData\Roaming)
            let mut path = std::path::PathBuf::from(appdata);
            path.push(APP_IDENTIFIER);
            path.push("logs");
            return path;
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            let mut path = std::path::PathBuf::from(home);
            path.push("Library");
            path.push("Application Support");
            path.push(APP_IDENTIFIER);
            path.push("logs");
            return path;
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg_data_home) = std::env::var("XDG_DATA_HOME") {
            let mut path = std::path::PathBuf::from(xdg_data_home);
            path.push(APP_IDENTIFIER);
            path.push("logs");
            return path;
        }
        if let Ok(home) = std::env::var("HOME") {
            let mut path = std::path::PathBuf::from(home);
            path.push(".local");
            path.push("share");
            path.push(APP_IDENTIFIER);
            path.push("logs");
            return path;
        }
    }

    // Fallback to temp directory if we can't determine the proper location
    std::env::temp_dir()
}

/// Gets the production log level for warning and error output.
fn get_log_level() -> LevelFilter {
    match std::env::var("RUST_LOG").as_deref() {
        Ok("warn") => LevelFilter::Warn,
        Ok("error") => LevelFilter::Error,
        Ok("off") => LevelFilter::Off,
        _ => LevelFilter::Warn,
    }
}

pub fn setup_tauri_plugins(
    builder: tauri::Builder<tauri::Wry>,
    specta_builder: &tauri_specta::Builder,
) -> tauri::Builder<tauri::Wry> {
    let log_level = get_log_level();

    // Get AppData directory path for logs (Roaming on Windows)
    let log_dir = get_app_data_log_dir();

    let builder = builder
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Folder {
                        path: log_dir,
                        file_name: Some("obsidian-chess-studio".to_string()),
                    },
                )])
                .level(log_level)
                .level_for("h2", LevelFilter::Warn)
                .level_for("hyper", LevelFilter::Warn)
                .level_for("hyper_util", LevelFilter::Warn)
                .level_for("reqwest", LevelFilter::Warn)
                .build(),
        );

    #[cfg(desktop)]
    let builder = desktop::setup_desktop_plugins(builder);

    #[cfg(mobile)]
    let builder = mobile::setup_mobile_plugins(builder);

    let builder = builder
        .invoke_handler(specta_builder.invoke_handler())
        .manage(AppState::default());

    builder
}

pub fn init_platform(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(desktop)]
    desktop::init_desktop_platform(app)?;

    #[cfg(mobile)]
    mobile::init_mobile_platform()?;

    shared::ensure_required_directories(&app.handle())
        .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
    shared::ensure_required_files(&app.handle())
        .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;

    Ok(())
}
