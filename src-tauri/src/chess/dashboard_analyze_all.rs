//! Backend orchestration for Dashboard "Analyze All" runs.
//!
//! This module moves long-running engine orchestration out of the frontend.
//! The frontend sends a run payload, then listens to incremental events with
//! per-game analysis results and progress updates.

use futures_util::stream::{FuturesUnordered, StreamExt};
use pgn_reader::{BufferedReader, SanPlus as ReaderSanPlus, Skip, Visitor};
use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, san::SanPlus, uci::UciMove, CastlingMode, Chess};
use specta::Type;
use std::sync::Arc;
use tauri::Emitter;
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
    // Remove all PGN tag pairs (`[Tag "Value"]`) before movetext parsing.
    // Some inputs arrive with headers compacted in a single line, so line-based
    // filtering is not sufficient and can leak words like "game" into movetext.
    let mut body = String::with_capacity(pgn.len());
    let mut in_tag_pair = false;
    for ch in pgn.chars() {
        if in_tag_pair {
            if ch == ']' {
                in_tag_pair = false;
                body.push(' ');
            }
            continue;
        }
        if ch == '[' {
            in_tag_pair = true;
            continue;
        }
        body.push(ch);
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
    if let Ok(pos) = fen.clone().into_position(CastlingMode::Standard) {
        return Ok(pos);
    }
    Ok(fen.into_position(CastlingMode::Chess960)?)
}

fn extract_tag_value_from_pgn(pgn: &str, tag: &str) -> Option<String> {
    for chunk in pgn.split('[').skip(1) {
        let Some(end_idx) = chunk.find(']') else {
            continue;
        };

        let header_body = chunk[..end_idx].trim();
        let mut parts = header_body.splitn(2, char::is_whitespace);
        let Some(tag_name_raw) = parts.next() else {
            continue;
        };
        let tag_name = tag_name_raw.trim();
        if !tag_name.eq_ignore_ascii_case(tag) {
            continue;
        }

        let remainder = parts.next().unwrap_or("").trim();
        let Some(start) = remainder.find('"') else {
            continue;
        };
        let value_start = start + 1;
        if value_start >= remainder.len() {
            continue;
        }
        let quoted_tail = &remainder[value_start..];
        let Some(end_rel) = quoted_tail.find('"') else {
            continue;
        };
        let value = quoted_tail[..end_rel].trim();
        if value.is_empty() {
            continue;
        }
        return Some(value.to_string());
    }
    None
}

fn extract_fen_from_pgn(pgn: &str) -> Option<String> {
    extract_tag_value_from_pgn(pgn, "FEN")
}

fn setup_is_from_position(pgn: &str) -> bool {
    extract_tag_value_from_pgn(pgn, "SetUp")
        .map(|v| v.trim().eq_ignore_ascii_case("1"))
        .unwrap_or(false)
}

fn normalize_uci_like_token(raw: &str) -> String {
    let mut out = raw.trim().to_ascii_lowercase();
    if out.is_empty() {
        return out;
    }
    out = out.replace('-', "");
    out = out.replace('x', "");
    out = out.replace('=', "");
    out.retain(|c| c.is_ascii_alphanumeric());
    out
}

#[derive(Default)]
struct MainlineSanCollector {
    sans: Vec<String>,
    variation_depth: usize,
}

impl Visitor for MainlineSanCollector {
    type Result = Vec<String>;

    fn san(&mut self, san: ReaderSanPlus) {
        if self.variation_depth == 0 {
            self.sans.push(san.to_string());
        }
    }

    fn begin_variation(&mut self) -> Skip {
        self.variation_depth += 1;
        Skip(false)
    }

    fn end_variation(&mut self) {
        self.variation_depth = self.variation_depth.saturating_sub(1);
    }

    fn end_game(&mut self) -> Self::Result {
        std::mem::take(&mut self.sans)
    }
}

fn collect_mainline_san_tokens_from_pgn(pgn: &str) -> Result<Vec<String>, Error> {
    let mut reader = BufferedReader::new(pgn.as_bytes());
    let mut collector = MainlineSanCollector::default();
    let parsed = reader
        .read_game(&mut collector)
        .map_err(|error| Error::InvalidInput(format!("Analyze-all PGN parser error: {}", error)))?;
    Ok(parsed.unwrap_or_default())
}

fn looks_like_move_start(ch: char) -> bool {
    matches!(
        ch,
        'a'..='h' | 'N' | 'B' | 'R' | 'Q' | 'K' | 'O' | 'o' | '0'
    )
}

fn find_first_move_index(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut i = 0usize;
    while i < len {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }

        let mut j = i;
        while j < len && bytes[j].is_ascii_digit() {
            j += 1;
        }

        let mut k = j;
        while k < len && bytes[k] == b'.' {
            k += 1;
        }
        let dot_count = k.saturating_sub(j);
        if dot_count == 0 || dot_count > 3 {
            i = j;
            continue;
        }
        // Avoid dates like 2026.04.20
        if k < len && bytes[k].is_ascii_digit() {
            i = j;
            continue;
        }

        let mut m = k;
        while m < len && bytes[m].is_ascii_whitespace() {
            m += 1;
        }
        if m >= len {
            i = j;
            continue;
        }
        if looks_like_move_start(bytes[m] as char) {
            return Some(i);
        }

        i = j;
    }
    None
}

fn is_obvious_non_move_token(token: &str) -> bool {
    let trimmed = token.trim_matches(|c: char| {
        c == '"' || c == '\'' || c == '[' || c == ']' || c == ',' || c == ';' || c == ':'
    });
    if trimmed.is_empty() {
        return true;
    }
    if matches!(trimmed, "O-O" | "O-O-O" | "0-0" | "0-0-0") {
        return false;
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("http")
        || lower.contains("lichess.org")
        || lower.contains("chess.com")
        || lower.contains("stockfish")
    {
        return true;
    }

    if matches!(
        lower.as_str(),
        "event"
            | "site"
            | "date"
            | "round"
            | "white"
            | "black"
            | "result"
            | "variant"
            | "setup"
            | "fen"
            | "orientation"
            | "timecontrol"
            | "whiteelo"
            | "blackelo"
            | "game"
            | "from"
            | "position"
            | "casual"
            | "blitz"
            | "rated"
    ) {
        return true;
    }

    // Plain words (no square digits) are not SAN/UCI moves.
    if lower
        .chars()
        .all(|c| c.is_ascii_alphabetic() || c == '_' || c == '-')
    {
        return true;
    }

    false
}

fn try_parse_move_from_token(token: &str, position: &Chess) -> Option<shakmaty::Move> {
    let token = token.trim();
    if token.is_empty() {
        return None;
    }

    // 1) Strict SAN+suffix first.
    if let Ok(san_plus) = SanPlus::from_ascii(token.as_bytes()) {
        if let Ok(mv) = san_plus.san.to_move(position) {
            return Some(mv);
        }
    }

    // 2) Compatible fallback for older shakmaty versions (no from_ascii_prefix):
    // progressively trim trailing noise, e.g. "Qb6Invalid" -> "Qb6".
    let mut cut_points: Vec<usize> = token.char_indices().map(|(idx, _)| idx).collect();
    cut_points.push(token.len());
    for end in cut_points.into_iter().rev() {
        if end >= token.len() || end == 0 {
            continue;
        }
        let mut candidate = token[..end].trim_end();
        if candidate.is_empty() {
            continue;
        }
        candidate =
            candidate.trim_end_matches(|c: char| matches!(c, '!' | '?' | ',' | ';' | ':' | '.'));
        if candidate.len() < 2 {
            continue;
        }
        if let Ok(san_plus) = SanPlus::from_ascii(candidate.as_bytes()) {
            if let Ok(mv) = san_plus.san.to_move(position) {
                return Some(mv);
            }
        }
    }

    // 3) UCI / UCI-like fallback.
    let uci_token = normalize_uci_like_token(token);
    if uci_token.len() >= 4 {
        // Prefer canonical UCI lengths.
        for len in [5usize, 4usize] {
            if uci_token.len() < len {
                continue;
            }
            let prefix = &uci_token[..len];
            if let Ok(uci) = UciMove::from_ascii(prefix.as_bytes()) {
                if let Ok(mv) = uci.to_move(position) {
                    return Some(mv);
                }
            }
        }

        // Last resort: progressively trim trailing garbage.
        for end in (4..uci_token.len()).rev() {
            let prefix = &uci_token[..end];
            if let Ok(uci) = UciMove::from_ascii(prefix.as_bytes()) {
                if let Ok(mv) = uci.to_move(position) {
                    return Some(mv);
                }
            }
        }
    }

    None
}

fn pgn_mainline_to_uci_moves(initial_fen: &str, pgn: &str) -> Result<Vec<String>, Error> {
    let mut position = parse_position(initial_fen)?;
    let mut out = Vec::new();

    // Primary path: robust PGN parsing from backend parser (`pgn_reader`), keeping only
    // mainline SAN tokens and excluding variations/comments by construction.
    if let Ok(mainline_sans) = collect_mainline_san_tokens_from_pgn(pgn) {
        for raw_token in mainline_sans {
            let san_token = normalize_pgn_san_token(&raw_token);
            if san_token.is_empty() || is_pgn_result_token(&san_token) {
                continue;
            }

            let Some(parsed_move) = try_parse_move_from_token(&san_token, &position) else {
                return Err(Error::InvalidInput(format!(
                    "Analyze-all could not parse PGN token '{}' from position '{}'",
                    san_token, initial_fen
                )));
            };

            let uci = UciMove::from_move(&parsed_move, CastlingMode::Standard).to_string();
            SanPlus::from_move_and_play_unchecked(&mut position, &parsed_move);
            out.push(normalize_move_key(&uci));
        }
        if !out.is_empty() {
            return Ok(out);
        }
    }

    // Fallback path: permissive tokenization for partially malformed PGN strings.
    let movetext = strip_pgn_headers_comments_and_variations(pgn);
    let movetext = if let Some(start_idx) = find_first_move_index(&movetext) {
        movetext[start_idx..].to_string()
    } else {
        movetext
    };

    for raw_token in movetext.split_whitespace() {
        let san_token = normalize_pgn_san_token(raw_token);
        if san_token.is_empty() {
            continue;
        }
        if is_pgn_result_token(&san_token) {
            break;
        }

        let Some(parsed_move) = try_parse_move_from_token(&san_token, &position) else {
            if is_obvious_non_move_token(&san_token) {
                continue;
            }
            return Err(Error::InvalidInput(format!(
                "Analyze-all could not parse PGN token '{}' from position '{}'",
                san_token, initial_fen
            )));
        };

        let uci = UciMove::from_move(&parsed_move, CastlingMode::Standard).to_string();
        SanPlus::from_move_and_play_unchecked(&mut position, &parsed_move);
        out.push(normalize_move_key(&uci));
    }

    Ok(out)
}

fn resolve_job(job: &DashboardAnalyzeAllJobInput) -> Result<(String, Vec<String>), Error> {
    let pgn_text = job.pgn.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let pgn_setup_from_position = pgn_text.map(setup_is_from_position).unwrap_or(false);
    let pgn_fen = pgn_text.and_then(extract_fen_from_pgn);

    if let Some(moves) = &job.moves {
        let normalized: Vec<String> = moves
            .iter()
            .map(|m| normalize_move_key(m))
            .filter(|m| !m.is_empty())
            .collect();
        if !normalized.is_empty() {
            let job_fen = job
                .fen
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let fen = if pgn_setup_from_position {
                pgn_fen.clone().or(job_fen)
            } else {
                job_fen.or(pgn_fen.clone())
            }
            .unwrap_or_else(|| STANDARD_START_FEN.to_string());

            let all_uci = normalized
                .iter()
                .all(|m| UciMove::from_ascii(m.as_bytes()).is_ok());
            if all_uci {
                return Ok((fen, normalized));
            }

            if pgn_text.is_none() {
                return Err(Error::InvalidInput(format!(
                    "Analyze-all job '{}' has non-UCI moves and no PGN fallback",
                    job.job_id
                )));
            }
        }
    }

    let pgn = pgn_text.ok_or_else(|| {
        Error::InvalidInput(format!("Analyze-all job '{}' has no PGN/moves", job.job_id))
    })?;

    let fen = job
        .fen
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            if pgn_setup_from_position {
                pgn_fen.clone()
            } else {
                None
            }
        })
        .or(pgn_fen)
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
