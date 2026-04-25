//! Backend orchestration for Dashboard "Analyze All" runs.
//!
//! This module moves long-running engine orchestration out of the frontend.
//! The frontend sends a run payload, then listens to incremental events with
//! per-game analysis results and progress updates.

use serde::{Deserialize, Serialize};
use shakmaty::{
    fen::Fen, san::San, san::SanPlus, uci::UciMove, CastlingMode, Chess,
};
use specta::Type;
use tauri::Emitter;
use futures_util::stream::{FuturesUnordered, StreamExt};
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::error::Error;
use crate::AppState;

use super::analysis::GameAnalysisService;
use super::types::{AnalysisOptions, EngineOption, GoMode, MoveAnalysis};

const STANDARD_START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DashboardAnalyzeAllJobInput {
    pub job_id: String,
    pub fen: Option<String>,
    pub moves: Option<Vec<String>>,
    pub pgn: Option<String>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DashboardAnalyzeAllRunRequest {
    pub run_id: String,
    pub engine: String,
    pub go_mode: GoMode,
    pub uci_options: Vec<EngineOption>,
    pub jobs: Vec<DashboardAnalyzeAllJobInput>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DashboardAnalyzeAllResultPayload {
    pub run_id: String,
    pub job_id: String,
    pub index: u32,
    pub total: u32,
    pub success: bool,
    pub analysis: Option<Vec<MoveAnalysis>>,
    pub error: Option<String>,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DashboardAnalyzeAllProgressPayload {
    pub run_id: String,
    pub completed: u32,
    pub total: u32,
    pub success: u32,
    pub failed: u32,
    pub cancelled: bool,
    pub finished: bool,
}

fn event_result_name() -> &'static str {
    "dashboard_analyze_all_result"
}

fn event_progress_name() -> &'static str {
    "dashboard_analyze_all_progress"
}

fn normalize_move_key(raw: &str) -> String {
    raw.trim().to_ascii_lowercase()
}

fn is_pgn_result_token(token: &str) -> bool {
    matches!(token.trim(), "1-0" | "0-1" | "1/2-1/2" | "*")
}

fn normalize_pgn_san_token(raw: &str) -> String {
    let mut token = raw.trim();
    if token.is_empty() || token.starts_with('$') {
        return String::new();
    }

    if let Some(dot_idx) = token.rfind('.') {
        token = &token[dot_idx + 1..];
    }

    token = token.trim();
    if token.is_empty() || token.starts_with('$') || is_pgn_result_token(token) {
        return token.to_string();
    }

    let mut end = token.len();
    while end > 0 {
        let ch = token[..end].chars().last().unwrap_or('\0');
        if ch == '!' || ch == '?' {
            end -= ch.len_utf8();
        } else {
            break;
        }
    }

    token[..end].trim().to_string()
}

fn strip_pgn_headers_comments_and_variations(pgn: &str) -> String {
    let mut body = String::new();
    for line in pgn.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            continue;
        }
        body.push_str(line);
        body.push('\n');
    }

    let mut out = String::with_capacity(body.len());
    let mut brace_depth = 0usize;
    let mut paren_depth = 0usize;
    let mut in_semicolon_comment = false;

    for ch in body.chars() {
        if in_semicolon_comment {
            if ch == '\n' {
                in_semicolon_comment = false;
                out.push(' ');
            }
            continue;
        }

        if ch == ';' && brace_depth == 0 && paren_depth == 0 {
            in_semicolon_comment = true;
            continue;
        }

        if ch == '{' && paren_depth == 0 {
            brace_depth += 1;
            continue;
        }
        if ch == '}' && brace_depth > 0 {
            brace_depth -= 1;
            continue;
        }
        if brace_depth > 0 {
            continue;
        }

        if ch == '(' {
            paren_depth += 1;
            continue;
        }
        if ch == ')' && paren_depth > 0 {
            paren_depth -= 1;
            continue;
        }
        if paren_depth > 0 {
            continue;
        }

        out.push(ch);
    }

    out
}

fn parse_position(initial_fen: &str) -> Result<Chess, Error> {
    let fen = Fen::from_ascii(initial_fen.as_bytes())?;
    Ok(fen.into_position(CastlingMode::Chess960)?)
}

fn extract_fen_from_pgn(pgn: &str) -> Option<String> {
    for line in pgn.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("[FEN ") {
            continue;
        }
        let start = trimmed.find('"')?;
        let end = trimmed.rfind('"')?;
        if end <= start + 1 {
            continue;
        }
        let fen = trimmed[start + 1..end].trim();
        if fen.is_empty() {
            continue;
        }
        return Some(fen.to_string());
    }
    None
}

fn pgn_mainline_to_uci_moves(initial_fen: &str, pgn: &str) -> Result<Vec<String>, Error> {
    let mut position = parse_position(initial_fen)?;
    let movetext = strip_pgn_headers_comments_and_variations(pgn);
    let mut out = Vec::new();

    for raw_token in movetext.split_whitespace() {
        let san_token = normalize_pgn_san_token(raw_token);
        if san_token.is_empty() {
            continue;
        }
        if is_pgn_result_token(&san_token) {
            break;
        }

        let san = San::from_ascii(san_token.as_bytes())?;
        let mv = san.to_move(&position)?;
        let uci = UciMove::from_move(&mv, CastlingMode::Standard).to_string();
        SanPlus::from_move_and_play_unchecked(&mut position, &mv);
        out.push(normalize_move_key(&uci));
    }

    Ok(out)
}

fn resolve_job(job: &DashboardAnalyzeAllJobInput) -> Result<(String, Vec<String>), Error> {
    if let Some(moves) = &job.moves {
        let normalized: Vec<String> = moves
            .iter()
            .map(|m| normalize_move_key(m))
            .filter(|m| !m.is_empty())
            .collect();
        if !normalized.is_empty() {
            let fen = job
                .fen
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(STANDARD_START_FEN)
                .to_string();
            return Ok((fen, normalized));
        }
    }

    let pgn = job
        .pgn
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::InvalidInput(format!("Analyze-all job '{}' has no PGN/moves", job.job_id)))?;

    let fen = job
        .fen
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| extract_fen_from_pgn(pgn))
        .unwrap_or_else(|| STANDARD_START_FEN.to_string());

    let moves = pgn_mainline_to_uci_moves(&fen, pgn)?;
    if moves.is_empty() {
        return Err(Error::InvalidInput(format!(
            "Analyze-all job '{}' has no parseable moves",
            job.job_id
        )));
    }
    Ok((fen, moves))
}

fn is_cancelled(state: &AppState, run_id: &str) -> bool {
    state
        .dashboard_analyze_all_cancellations
        .get(run_id)
        .map(|v| *v)
        .unwrap_or(false)
}

fn enforce_single_thread_uci_options(options: &[EngineOption]) -> Vec<EngineOption> {
    let mut sanitized: Vec<EngineOption> = options
        .iter()
        .filter(|opt| !opt.name.eq_ignore_ascii_case("threads"))
        .cloned()
        .collect();
    sanitized.push(EngineOption {
        name: "Threads".to_string(),
        value: "1".to_string(),
    });
    sanitized
}

fn max_parallel_jobs(total_jobs: usize) -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let half_cores = (cores / 2).max(1);
    half_cores.min(total_jobs.max(1))
}

#[derive(Debug)]
struct DashboardAnalyzeAllWorkerResult {
    job_id: String,
    index: u32,
    success: bool,
    analysis: Option<Vec<MoveAnalysis>>,
    error: Option<String>,
    cancelled: bool,
}

async fn run_single_analyze_all_job(
    run_id: String,
    engine: String,
    go_mode: GoMode,
    uci_options: Vec<EngineOption>,
    job: DashboardAnalyzeAllJobInput,
    index: u32,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    _permit: OwnedSemaphorePermit,
) -> DashboardAnalyzeAllWorkerResult {
    if is_cancelled(&state, &run_id) {
        return DashboardAnalyzeAllWorkerResult {
            job_id: job.job_id,
            index,
            success: false,
            analysis: None,
            error: Some("Cancelled".to_string()),
            cancelled: true,
        };
    }

    let analysis_id = format!("dashboard_analyze_all_{}_{}", run_id, index);
    state
        .dashboard_analyze_all_active
        .insert((run_id.clone(), analysis_id.clone()), engine.clone());

    let job_id = job.job_id.clone();
    let result = match resolve_job(&job) {
        Ok((fen, moves)) => {
            let analysis = GameAnalysisService::analyze_game(
                analysis_id.clone(),
                engine.clone(),
                go_mode,
                AnalysisOptions {
                    fen,
                    moves,
                    annotate_novelties: false,
                    reference_db: None,
                    reversed: false,
                },
                uci_options,
                state.clone(),
                app,
            )
            .await;
            match analysis {
                Ok(analysis) => DashboardAnalyzeAllWorkerResult {
                    job_id,
                    index,
                    success: true,
                    analysis: Some(analysis),
                    error: None,
                    cancelled: false,
                },
                Err(error) => DashboardAnalyzeAllWorkerResult {
                    job_id,
                    index,
                    success: false,
                    analysis: None,
                    error: Some(error.to_string()),
                    cancelled: is_cancelled(&state, &run_id),
                },
            }
        }
        Err(error) => DashboardAnalyzeAllWorkerResult {
            job_id,
            index,
            success: false,
            analysis: None,
            error: Some(error.to_string()),
            cancelled: false,
        },
    };

    state
        .dashboard_analyze_all_active
        .remove(&(run_id, analysis_id));
    result
}

fn clear_run_state(state: &AppState, run_id: &str) {
    let active_keys: Vec<(String, String)> = state
        .dashboard_analyze_all_active
        .iter()
        .filter_map(|entry| {
            let key = entry.key();
            if key.0 == run_id {
                Some((key.0.clone(), key.1.clone()))
            } else {
                None
            }
        })
        .collect();
    for key in active_keys {
        state.dashboard_analyze_all_active.remove(&key);
    }
    state.dashboard_analyze_all_cancellations.remove(run_id);
}

#[tauri::command]
#[specta::specta]
pub async fn dashboard_analyze_all_cancel(
    run_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    state
        .dashboard_analyze_all_cancellations
        .insert(run_id.clone(), true);

    let active: Vec<((String, String), String)> = state
        .dashboard_analyze_all_active
        .iter()
        .filter_map(|entry| {
            let key = entry.key();
            if key.0 == run_id {
                Some(((key.0.clone(), key.1.clone()), entry.value().clone()))
            } else {
                None
            }
        })
        .collect();

    for ((run_key, analysis_id), engine) in active {
        let key = (analysis_id.clone(), engine.clone());
        if let Some(process) = state.engine_processes.get(&key) {
            let mut process = process.lock().await;
            let _ = process.stop().await;
            let _ = process.kill().await;
        }
        state.engine_processes.remove(&key);
        state
            .dashboard_analyze_all_active
            .remove(&(run_key, analysis_id));
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn dashboard_analyze_all_run(
    request: DashboardAnalyzeAllRunRequest,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), Error> {
    if request.jobs.is_empty() {
        app.emit(
            event_progress_name(),
            DashboardAnalyzeAllProgressPayload {
                run_id: request.run_id.clone(),
                completed: 0,
                total: 0,
                success: 0,
                failed: 0,
                cancelled: false,
                finished: true,
            },
        )?;
        clear_run_state(&state, &request.run_id);
        return Ok(());
    }

    let DashboardAnalyzeAllRunRequest {
        run_id,
        engine,
        go_mode,
        uci_options,
        jobs,
    } = request;

    state
        .dashboard_analyze_all_cancellations
        .insert(run_id.clone(), false);

    let run_result: Result<(), Error> = async {
        let total = jobs.len() as u32;
        let parallelism = max_parallel_jobs(jobs.len());
        let semaphore = Arc::new(Semaphore::new(parallelism));
        let normalized_uci_options = enforce_single_thread_uci_options(&uci_options);
        let mut completed = 0u32;
        let mut success = 0u32;
        let mut failed = 0u32;
        let mut cancelled = false;
        let mut workers = FuturesUnordered::new();

        for (index, job) in jobs.into_iter().enumerate() {
            let run_id_worker = run_id.clone();
            let engine_worker = engine.clone();
            let go_mode_worker = go_mode.clone();
            let uci_options_worker = normalized_uci_options.clone();
            let state_ref = state.clone();
            let app_handle = app.clone();
            let sem = semaphore.clone();
            workers.push(async move {
                let permit = match sem.acquire_owned().await {
                    Ok(permit) => permit,
                    Err(_) => {
                        return DashboardAnalyzeAllWorkerResult {
                            job_id: job.job_id,
                            index: index as u32,
                            success: false,
                            analysis: None,
                            error: Some("Analyze-all scheduler is shutting down".to_string()),
                            cancelled: true,
                        };
                    }
                };
                run_single_analyze_all_job(
                    run_id_worker,
                    engine_worker,
                    go_mode_worker,
                    uci_options_worker,
                    job,
                    index as u32,
                    state_ref,
                    app_handle,
                    permit,
                )
                .await
            });
        }

        while let Some(result) = workers.next().await {
            if result.cancelled {
                cancelled = true;
            }
            if result.success {
                success = success.saturating_add(1);
            } else {
                failed = failed.saturating_add(1);
            }

            app.emit(
                event_result_name(),
                DashboardAnalyzeAllResultPayload {
                    run_id: run_id.clone(),
                    job_id: result.job_id,
                    index: result.index,
                    total,
                    success: result.success,
                    analysis: result.analysis,
                    error: result.error,
                    cancelled: result.cancelled,
                },
            )?;

            completed = completed.saturating_add(1);
            app.emit(
                event_progress_name(),
                DashboardAnalyzeAllProgressPayload {
                    run_id: run_id.clone(),
                    completed,
                    total,
                    success,
                    failed,
                    cancelled,
                    finished: false,
                },
            )?;
        }

        if is_cancelled(&state, &run_id) {
            cancelled = true;
        }

        app.emit(
            event_progress_name(),
            DashboardAnalyzeAllProgressPayload {
                run_id: run_id.clone(),
                completed,
                total,
                success,
                failed,
                cancelled,
                finished: true,
            },
        )?;
        Ok(())
    }
    .await;

    clear_run_state(&state, &run_id);
    run_result
}
