//! Tauri command handlers for chess engine management and analysis.
//!
//! This module exposes async functions as Tauri commands for engine process control, game analysis, and engine configuration.
//! It acts as the bridge between the frontend and backend chess logic.

use std::path::PathBuf;
use std::io::ErrorKind;

use vampirc_uci::parse_one;

use crate::error::Error;
use crate::AppState;

use super::analysis::GameAnalysisService;
use super::manager::EngineManager;
use super::types::*;

/// Kill all engine processes associated with a given tab.
/// FIXED: Proper error handling to prevent zombie processes
#[tauri::command]
#[specta::specta]
pub async fn kill_engines(tab: String, state: tauri::State<'_, AppState>) -> Result<(), Error> {
    let keys: Vec<_> = state
        .engine_processes
        .iter()
        .map(|x| x.key().clone())
        .collect();
    for key in keys {
        if key.0.starts_with(&tab) {
            // FIXED: Safe cleanup even if kill fails
            if let Some(process_arc) = state.engine_processes.get(&key) {
                let mut process = process_arc.lock().await;
                // Attempt to kill, but always remove from map
                let _ = process.kill().await; // Ignore errors, ensure cleanup
            }
            state.engine_processes.remove(&key);
        }
    }
    Ok(())
}

/// Kill a specific engine process by engine name and tab.
/// FIXED: Always remove from map to prevent memory leaks
#[tauri::command]
#[specta::specta]
pub async fn kill_engine(
    engine: String,
    tab: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let key = (tab, engine);
    if let Some(process_arc) = state.engine_processes.get(&key) {
        let mut process = process_arc.lock().await;
        // Attempt to kill, but always remove from map
        let _ = process.kill().await; // Ignore errors, ensure cleanup
    }
    // FIXED: Always remove to prevent memory leak
    state.engine_processes.remove(&key);
    Ok(())
}

/// Stop a specific engine process (without killing it) by engine name and tab.
#[tauri::command]
#[specta::specta]
pub async fn stop_engine(
    engine: String,
    tab: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let key = (tab, engine);
    if let Some(process) = state.engine_processes.get(&key) {
        let mut process = process.lock().await;
        process.stop().await?;
    }
    Ok(())
}

/// Retrieve logs for a specific engine process.
#[tauri::command]
#[specta::specta]
pub async fn get_engine_logs(
    engine: String,
    tab: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<EngineLog>, Error> {
    let key = (tab, engine);
    if let Some(process) = state.engine_processes.get(&key) {
        let process = process.lock().await;
        Ok(process.logs.clone())
    } else {
        Ok(Vec::new())
    }
}

/// Get best moves from the engine for a given position and options.
#[tauri::command]
#[specta::specta]
pub async fn get_best_moves(
    id: String,
    engine: String,
    tab: String,
    go_mode: GoMode,
    options: EngineOptions,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<(f32, Vec<BestMoves>)>, Error> {
    EngineManager::new(state)
        .get_best_moves(id, engine, tab, go_mode, options, app)
        .await
}

/// Analyze a game using the engine, returning move-by-move analysis.
#[tauri::command]
#[specta::specta]
pub async fn analyze_game(
    id: String,
    engine: String,
    go_mode: GoMode,
    options: AnalysisOptions,
    uci_options: Vec<EngineOption>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<MoveAnalysis>, Error> {
    GameAnalysisService::analyze_game(id, engine, go_mode, options, uci_options, state, app).await
}

/// Query a UCI engine for its configuration (name and options).
/// FIXED: Proper process cleanup with timeout to prevent zombie processes
#[tauri::command]
#[specta::specta]
pub async fn get_engine_config(path: PathBuf, app: tauri::AppHandle) -> Result<EngineConfig, Error> {
    use tokio::io::AsyncBufReadExt;
    use tokio::time::{timeout, Duration};

    let path = super::engine_path::resolve_engine_path(path.to_string_lossy().as_ref(), &app);

    if path.is_dir() {
        return Err(Error::PackageManager(format!(
            "Engine path points to a directory, not a binary: {}",
            path.display()
        )));
    }

    #[cfg(unix)]
    super::uci::ensure_executable(path.as_path())?;

    #[cfg(target_os = "android")]
    super::uci::validate_android_elf(path.as_path())?;

    let mut command = tokio::process::Command::new(&path);
    // FIXED: Safe parent path handling
    if let Some(parent) = path.parent() {
        command.current_dir(parent);
    }
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(super::process::CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|e| {
        if e.kind() == ErrorKind::PermissionDenied {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let file_mode = std::fs::metadata(&path)
                    .map(|m| m.permissions().mode() & 0o777)
                    .unwrap_or(0);
                let parent_mode = path
                    .parent()
                    .and_then(|p| std::fs::metadata(p).ok().map(|m| m.permissions().mode() & 0o777));

                return Error::PackageManager(format!(
                    "Failed to start engine (permission denied): {} (file_mode={:o}, parent_mode={}). If file/parent are executable but this persists, the device may block execution from this filesystem (noexec/policy). error={}",
                    path.display(),
                    file_mode,
                    parent_mode
                        .map(|m| format!("{:o}", m))
                        .unwrap_or_else(|| "<unknown>".to_string()),
                    e
                ));
            }

            #[cfg(not(unix))]
            {
                return Error::PackageManager(format!(
                    "Failed to start engine (permission denied): {}. error={}",
                    path.display(),
                    e
                ));
            }
        }
        Error::Io(e)
    })?;
    let mut stdin = child.stdin.take().ok_or(Error::NoStdin)?;
    let stdout = child.stdout.take().ok_or(Error::NoStdout)?;
    let mut stdout = tokio::io::BufReader::new(stdout).lines();

    use tokio::io::AsyncWriteExt;
    stdin.write_all(b"uci\n").await?;

    let mut config = EngineConfig::default();

    // FIXED: Add timeout to prevent hanging on unresponsive engines
    let config_future = async {
        loop {
            match stdout.next_line().await? {
                Some(line) => {
                    if let vampirc_uci::UciMessage::Id {
                        name: Some(name),
                        author: _,
                    } = parse_one(&line)
                    {
                        config.name = name;
                    }
                    if let vampirc_uci::UciMessage::Option(opt) = parse_one(&line) {
                        config.options.push(UciOptionConfig::from(opt));
                    }
                    if let vampirc_uci::UciMessage::UciOk = parse_one(&line) {
                        break;
                    }
                }
                None => {
                    return Err(Error::PackageManager(format!(
                        "Engine exited before responding to UCI: {}",
                        path.display()
                    )));
                }
            }
        }
        Ok::<_, Error>(config)
    };

    // Engines can be slow to start on some Android devices. Give them more time there.
    let timeout_secs: u64 = if cfg!(target_os = "android") { 20 } else { 5 };
    let result = timeout(Duration::from_secs(timeout_secs), config_future).await;

    // FIXED: Always kill the child process to prevent zombies
    let _ = child.kill().await;

    match result {
        Ok(Ok(cfg)) => Ok(cfg),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(Error::EngineTimeout),
    }
}
