//! Engine process management for UCI chess engines.
//!
//! This module provides the `EngineManager` struct, which manages engine processes, handles best-move queries,
//! and spawns background tasks for engine output parsing and progress reporting.

use std::sync::Arc;

use log::warn;
use tauri_specta::Event;
use tokio::sync::Mutex;

use crate::error::Error;
use crate::AppState;

use super::engine_path::resolve_engine_path;
use super::process::EngineProcess;
use super::types::{EngineLog, EngineOptions, GoMode};

/// Manager for UCI engine processes, handling best-move queries and process lifecycle.
pub struct EngineManager<'a> {
    state: tauri::State<'a, AppState>,
}

impl<'a> EngineManager<'a> {
    /// Create a new `EngineManager` with the given application state.
    pub fn new(state: tauri::State<'a, AppState>) -> Self {
        Self { state }
    }

    /// Get best moves from the engine for a given position and options.
    ///
    /// If an engine process is already running for the given key, it will reuse or update it as needed.
    /// Otherwise, it spawns a new process and background reader task.
    ///
    /// # Arguments
    /// * `id` - Unique analysis session identifier.
    /// * `engine` - Path to the UCI engine binary.
    /// * `tab` - Tab identifier for engine process grouping.
    /// * `go_mode` - Engine search mode (depth, time, etc).
    /// * `options` - Engine options (FEN, moves, etc).
    /// * `app` - Tauri app handle for event emission.
    ///
    /// # Returns
    /// Optionally returns the last progress and best moves if already available.
    ///
    /// # Errors
    /// Returns `Error` if engine operations fail.
    pub async fn get_best_moves(
        &self,
        id: String,
        engine: String,
        tab: String,
        go_mode: GoMode,
        options: EngineOptions,
        app: tauri::AppHandle,
    ) -> Result<Option<(f32, Vec<super::types::BestMoves>)>, Error> {
        let path = resolve_engine_path(&engine, &app);
        let key = (tab.clone(), engine.clone());
        // If an engine process already exists for this key, reuse or update it.
        if let Some(process) = self
            .state
            .engine_processes
            .get(&key)
            .map(|entry| entry.value().clone())
        {
            {
                let mut process = process.lock().await;
                // If options and mode match and engine is running, return cached result.
                if options == process.options && go_mode == process.go_mode && process.running {
                    return Ok(Some((
                        process.last_progress,
                        process.last_best_moves.clone(),
                    )));
                }
                // If already reconfiguring, skip this request to avoid race conditions
                if process.reconfiguring {
                    return Ok(None);
                }
                // Mark as reconfiguring to prevent concurrent reconfigurations
                process.reconfiguring = true;
                // Otherwise, stop and reconfigure the engine.
                if let Err(err) = process.stop().await {
                    process.reconfiguring = false;
                    return Err(err);
                }
            }
            // Wait for engine to process stop command and settle.
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            {
                let mut process = process.lock().await;
                // The process can be removed asynchronously while we are waiting (e.g. engine exits).
                // In that case, do not panic; fall through and spawn a fresh process below.
                if !self.state.engine_processes.contains_key(&key) {
                    process.reconfiguring = false;
                } else {
                    let reconfigure_result = async {
                        process.set_options(options.clone()).await?;
                        process.go(&go_mode).await?;
                        Ok::<(), Error>(())
                    }
                    .await;
                    process.reconfiguring = false;
                    reconfigure_result?;
                    return Ok(None);
                }
            }
        }

        let (mut process, mut reader) = EngineProcess::new(path).await?;
        process.set_options(options.clone()).await?;
        process.go(&go_mode).await?;

        let process = Arc::new(Mutex::new(process));
        self.state
            .engine_processes
            .insert(key.clone(), process.clone());

        // Spawn background reader task so multiple engines can run concurrently.
        let app_cloned = app.clone();
        let id_cloned = id.clone();
        let tab_cloned = tab.clone();
        let key_cloned = key.clone();
        let engines_map = self.state.engine_processes.clone();
        tokio::spawn(async move {
            // OPTIMIZED: Increased emission rate from 5 to 10 events/sec for more responsive UI
            let lim = governor::RateLimiter::direct(governor::Quota::per_second(
                nonzero_ext::nonzero!(10u32),
            ));
            while let Ok(Some(line)) = reader.next_line().await {
                if let Some(proc_arc) = engines_map
                    .get(&key_cloned)
                    .map(|entry| entry.value().clone())
                {
                    let mut proc = proc_arc.lock().await;
                    match vampirc_uci::parse_one(&line) {
                        vampirc_uci::UciMessage::Info(attrs) => {
                            // Skip processing if engine is reconfiguring or not running
                            // This prevents processing residual messages from previous searches
                            if proc.reconfiguring || !proc.running {
                                continue;
                            }
                            // Also skip if message has WDL but no PV in the line (residual message from stopped search)
                            let has_wdl_in_line = line.contains("wdl") || line.contains("WDL");
                            let has_pv_in_line = line.contains(" pv ");
                            if has_wdl_in_line && !has_pv_in_line {
                                continue;
                            }
                            let parsed_fen = match proc.options.fen.parse() {
                                Ok(fen) => fen,
                                Err(err) => {
                                    warn!(
                                        "Skipping UCI info line due to invalid FEN in engine options: {}",
                                        err
                                    );
                                    continue;
                                }
                            };
                            let parse_result = super::process::parse_uci_attrs_with_line(
                                attrs,
                                &parsed_fen,
                                &proc.options.moves,
                                Some(&line),
                            );
                            if let Ok(best_moves) = parse_result {
                                let multipv = best_moves.multipv;
                                let cur_depth = best_moves.depth;
                                let cur_nodes = best_moves.nodes;
                                if multipv as usize == proc.best_moves.len() + 1 {
                                    proc.best_moves.push(best_moves);
                                    if multipv == proc.real_multipv {
                                        // Only emit if all lines are at the same depth and rate limit allows.
                                        let all_same_depth =
                                            proc.best_moves.iter().all(|x| x.depth == cur_depth);
                                        let depth_ok = cur_depth >= proc.last_depth;
                                        if all_same_depth && depth_ok {
                                            let (progress, should_emit) = match proc.go_mode {
                                                GoMode::Depth(depth) => (
                                                    (cur_depth as f64 / depth as f64) * 100.0,
                                                    true,
                                                ),
                                                GoMode::Time(time) => (
                                                    (proc.start.elapsed().as_millis() as f64
                                                        / time as f64)
                                                        * 100.0,
                                                    true,
                                                ),
                                                GoMode::Nodes(nodes) => (
                                                    (cur_nodes as f64 / nodes as f64) * 100.0,
                                                    true,
                                                ),
                                                // PlayersTime/Infinite: emit 99.99 only when depth increases or first time (avoid flood)
                                                GoMode::PlayersTime(_) | GoMode::Infinite => (
                                                    99.99,
                                                    cur_depth > proc.last_depth
                                                        || proc.last_progress < 99.0,
                                                ),
                                            };
                                            proc.last_depth = cur_depth;
                                            proc.last_best_moves = proc.best_moves.clone();
                                            proc.last_progress = progress as f32;

                                            if should_emit && lim.check().is_ok() {
                                                super::types::BestMovesPayload {
                                                    best_lines: proc.best_moves.clone(),
                                                    engine: id_cloned.clone(),
                                                    tab: tab_cloned.clone(),
                                                    fen: proc.options.fen.clone(),
                                                    moves: proc.options.moves.clone(),
                                                    progress,
                                                }
                                                .emit(&app_cloned)
                                                .ok();
                                            }
                                        }
                                        proc.best_moves.clear();
                                    }
                                }
                            }
                        }
                        vampirc_uci::UciMessage::BestMove { .. } => {
                            // Emit final result when engine signals best move.
                            super::types::BestMovesPayload {
                                best_lines: proc.last_best_moves.clone(),
                                engine: id_cloned.clone(),
                                tab: tab_cloned.clone(),
                                fen: proc.options.fen.clone(),
                                moves: proc.options.moves.clone(),
                                progress: 100.0,
                            }
                            .emit(&app_cloned)
                            .ok();
                            proc.last_progress = 100.0;
                        }
                        _ => {}
                    }
                    proc.append_log(EngineLog::Engine(line));
                }
            }
            engines_map.remove(&key_cloned);
        });

        Ok(None)
    }
}
