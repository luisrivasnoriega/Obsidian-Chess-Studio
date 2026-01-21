pub mod linux;
pub mod macos;
pub mod windows;

/// Desktop-specific plugin setup
#[cfg(desktop)]
pub fn setup_desktop_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
}

/// Desktop-specific initialization that runs on all desktop platforms
#[cfg(desktop)]
pub fn init_desktop_platform(_app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    log::info!("Initializing desktop platform");

    #[cfg(target_os = "windows")]
    windows::init_windows_platform()?;

    #[cfg(target_os = "macos")]
    macos::init_macos_platform()?;

    #[cfg(target_os = "linux")]
    linux::init_linux_platform()?;

    Ok(())
}

