use std::path::PathBuf;

#[cfg(target_os = "android")]
use log::{info, warn};

use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

/// On Android, find libstockfish.so in the native library directory.
/// This is the ONLY reliable way to execute a binary on Android devices with noexec app data.
/// Uses multiple detection methods with fallbacks.
#[cfg(target_os = "android")]
fn find_bundled_stockfish() -> Option<PathBuf> {
    // Method 1: Parse /proc/self/maps to find where libocs_lib.so is loaded.
    // If native libraries are extracted, Stockfish should be in the same directory.
    // Note: Some builds map libs directly from inside the APK (e.g. `base.apk!/lib/...`),
    // which is not a real filesystem path. In that case, we try to derive the extracted
    // lib dir from the APK location, but the correct fix is enabling extraction via
    // `android:extractNativeLibs="true"` / legacy JNI packaging.
    if let Ok(maps) = std::fs::read_to_string("/proc/self/maps") {
        for line in maps.lines() {
            if !line.contains("/libocs_lib.so") {
                continue;
            }
            if let Some(lib_path) = line.split_whitespace().last() {
                if lib_path.starts_with('/') {
                    if lib_path.contains("base.apk!/") {
                        warn!(
                            "Native libs appear mapped from inside the APK ({}). For bundled engine execution, ensure native libs are extracted (android:extractNativeLibs=true / useLegacyPackaging).",
                            lib_path
                        );
                    }

                    let p = PathBuf::from(lib_path);
                    if let Some(parent) = p.parent() {
                        let candidate = parent.join("libstockfish.so");
                        info!(
                            "Checking for libstockfish.so via /proc/self/maps: {}",
                            candidate.display()
                        );
                        if candidate.is_file() {
                            info!("Found libstockfish.so via /proc/self/maps: {}", candidate.display());
                            return Some(candidate);
                        } else {
                            warn!(
                                "libstockfish.so NOT found at {} (derived from libocs_lib.so)",
                                candidate.display()
                            );
                        }
                    }

                    // If the path is of the form `/.../base.apk!/lib/<abi>/libocs_lib.so`, try to
                    // derive `/.../<pkg>/lib/<abi>/libstockfish.so` next to the APK directory.
                    if let Some((apk_path, in_apk_rel)) = lib_path.split_once("!/") {
                        if let Some(abi) = in_apk_rel
                            .strip_prefix("lib/")
                            .and_then(|s| s.split('/').next())
                            .filter(|s| !s.is_empty())
                        {
                            if let Some(apk_parent) = std::path::Path::new(apk_path).parent() {
                                let candidate = apk_parent
                                    .join("lib")
                                    .join(abi)
                                    .join("libstockfish.so");
                                info!(
                                    "Checking for extracted libstockfish.so derived from APK path: {}",
                                    candidate.display()
                                );
                                if candidate.is_file() {
                                    info!(
                                        "Found libstockfish.so via APK-derived lib dir: {}",
                                        candidate.display()
                                    );
                                    return Some(candidate);
                                }
                            }
                        }
                    }
                }
            }
        }
    } else {
        warn!("Could not read /proc/self/maps");
    }

    // Method 2: Check LD_LIBRARY_PATH
    if let Ok(ld_library_path) = std::env::var("LD_LIBRARY_PATH") {
        info!("LD_LIBRARY_PATH = {}", ld_library_path);
        for dir in ld_library_path.split(':').filter(|s| !s.is_empty()) {
            let candidate = PathBuf::from(dir).join("libstockfish.so");
            if candidate.is_file() {
                info!("Found libstockfish.so via LD_LIBRARY_PATH: {}", candidate.display());
                return Some(candidate);
            }
        }
    } else {
        warn!("LD_LIBRARY_PATH not set");
    }

    // Method 3: Scan /data/app for com.ocs directories
    // Native libs are extracted to /data/app/~~<random>/com.ocs-<random>/lib/arm64/
    if let Ok(entries) = std::fs::read_dir("/data/app") {
        for entry in entries.flatten() {
            let base_path = entry.path();
            if !base_path.is_dir() {
                continue;
            }
            // Check subdirectories for com.ocs-*
            if let Ok(sub_entries) = std::fs::read_dir(&base_path) {
                for sub_entry in sub_entries.flatten() {
                    let sub_path = sub_entry.path();
                    if let Some(name) = sub_path.file_name().and_then(|n| n.to_str()) {
                        if name.starts_with("com.ocs") {
                            // Try arm64-v8a path
                            let candidate = sub_path.join("lib/arm64/libstockfish.so");
                            if candidate.is_file() {
                                info!("Found libstockfish.so via /data/app scan: {}", candidate.display());
                                return Some(candidate);
                            }
                            // Also try arm64-v8a naming
                            let candidate2 = sub_path.join("lib/arm64-v8a/libstockfish.so");
                            if candidate2.is_file() {
                                info!("Found libstockfish.so via /data/app scan: {}", candidate2.display());
                                return Some(candidate2);
                            }
                        }
                    }
                }
            }
        }
    }

    warn!("Could not find libstockfish.so in any native library directory");
    None
}

pub fn resolve_engine_path(engine: &str, app: &AppHandle) -> PathBuf {
    #[cfg(not(target_os = "android"))]
    let _ = app;
    let path = PathBuf::from(engine);

    // On Android, ALWAYS prefer the bundled libstockfish.so from native libs
    // This is the only reliable way to execute on devices with noexec app data
    #[cfg(target_os = "android")]
    {
        // Check if this is a stockfish engine request (by name or path)
        let engine_lc = engine.to_ascii_lowercase();
        let file_lc = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let is_stockfish = engine_lc.contains("stockfish") || file_lc.contains("stockfish");

        if is_stockfish {
            info!("Resolving Stockfish engine path for: {}", engine);
            if let Some(bundled) = find_bundled_stockfish() {
                info!(
                    "Using bundled libstockfish.so: {} (instead of {})",
                    bundled.display(),
                    engine
                );
                return bundled;
            } else {
                warn!(
                    "Bundled libstockfish.so not found, falling back to original path: {}",
                    engine
                );
            }
        }
    }

    if path.exists() {
        #[cfg(target_os = "android")]
        {
            // Defensive: some installs can leave `engine` pointing at a directory (e.g. `.../engines/stockfish/`).
            // Trying to execute a directory yields `Permission denied (os error 13)` on Android.
            if path.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&path) {
                    let mut stockfish: Option<PathBuf> = None;
                    let mut stockfish_android: Option<PathBuf> = None;
                    let mut single_file: Option<PathBuf> = None;
                    let mut file_count = 0usize;

                    for entry in entries.flatten() {
                        let p = entry.path();
                        if !p.is_file() {
                            continue;
                        }
                        file_count += 1;
                        single_file = Some(p.clone());
                        if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                            if name == "stockfish" {
                                stockfish = Some(p);
                                break;
                            }
                            if name.starts_with("stockfish-android-") {
                                stockfish_android = Some(p);
                            }
                        }
                    }

                    if let Some(p) = stockfish {
                        return p;
                    }
                    if let Some(p) = stockfish_android {
                        return p;
                    }
                    if file_count == 1 {
                        if let Some(p) = single_file {
                            return p;
                        }
                    }
                }
            }
        }
        return path;
    }

    // Path doesn't exist, try to find the engine in known locations
    #[cfg(target_os = "android")]
    {
        let file_name = path
            .file_name()
            .or_else(|| std::path::Path::new(engine).file_name())
            .map(|name| name.to_owned());

        if let Some(file_name) = file_name {
            let mut candidates: Vec<PathBuf> = Vec::new();

            // Check LD_LIBRARY_PATH first (native libs)
            if let Ok(ld_library_path) = std::env::var("LD_LIBRARY_PATH") {
                candidates.extend(
                    ld_library_path
                        .split(':')
                        .filter(|entry| !entry.trim().is_empty())
                        .map(PathBuf::from),
                );
            }

            if let Ok(app_data_dir) = app.path().app_data_dir() {
                candidates.push(app_data_dir.join("engines"));
                candidates.push(app_data_dir.join("files").join("engines"));
                candidates.push(app_data_dir.join("files"));
                candidates.push(app_data_dir);
            }

            if let Ok(app_local_data_dir) = app.path().app_local_data_dir() {
                candidates.push(app_local_data_dir.join("engines"));
                candidates.push(app_local_data_dir.join("files").join("engines"));
                candidates.push(app_local_data_dir.join("files"));
                candidates.push(app_local_data_dir);
            }

            if let Ok(app_cache_dir) = app.path().app_cache_dir() {
                candidates.push(app_cache_dir.join("engines"));
                candidates.push(app_cache_dir);
            }

            if let Ok(resource_dir) = app.path().resource_dir() {
                candidates.push(resource_dir);
            }

            for dir in candidates {
                let candidate = dir.join(&file_name);
                if candidate.is_file() {
                    return candidate;
                }

                // Try lib*.so naming convention
                if let Some(stem) = file_name.to_str() {
                    let so_name = format!("lib{stem}.so");
                    let so_candidate = dir.join(so_name);
                    if so_candidate.is_file() {
                        return so_candidate;
                    }
                }
            }
        }
    }

    path
}
