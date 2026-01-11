use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri::Manager;

pub fn resolve_engine_path(engine: &str, app: &AppHandle) -> PathBuf {
    let path = PathBuf::from(engine);
    if path.exists() {
        return path;
    }

    #[cfg(target_os = "android")]
    {
        let file_name = path
            .file_name()
            .or_else(|| Path::new(engine).file_name())
            .map(|name| name.to_owned());

        if let Some(file_name) = file_name {
            let mut candidates: Vec<PathBuf> = Vec::new();

            if let Ok(ld_library_path) = std::env::var("LD_LIBRARY_PATH") {
                candidates.extend(
                    ld_library_path
                        .split(':')
                        .filter(|entry| !entry.trim().is_empty())
                        .map(PathBuf::from),
                );
            }

            if let Ok(app_data_dir) = app.path().app_data_dir() {
                candidates.push(app_data_dir);
            }

            if let Ok(resource_dir) = app.path().resource_dir() {
                candidates.push(resource_dir);
            }

            for dir in candidates {
                let candidate = dir.join(&file_name);
                if candidate.exists() {
                    return candidate;
                }
            }
        }
    }

    path
}
