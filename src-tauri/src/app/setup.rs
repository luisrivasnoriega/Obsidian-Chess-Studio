use tauri::App;

use crate::app::platform;

/// Shared app setup logic for both desktop and mobile
pub fn setup_tauri_app(app: &App, specta_builder: &tauri_specta::Builder) -> Result<(), Box<dyn std::error::Error>> {
    log::info!("Setting up tauri application");

    platform::init_platform(app)?;

    specta_builder.mount_events(app);

    log::info!("Finished tauri application initialization");
    Ok(())
}
