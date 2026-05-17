//! Tauri command handlers for chess engine management and analysis.
//!
//! This module exposes async functions as Tauri commands for engine process control, game analysis, and engine configuration.
//! It acts as the bridge between the frontend and backend chess logic.

#![allow(unused_mut)]

use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::path::PathBuf;
use std::time::Duration;

use chrono::Utc;
use shakmaty::{fen::Fen, Color};
use specta::Type;
use tauri::Emitter;
use tokio::time::{timeout, Instant};
use vampirc_uci::parse_one;

use crate::error::Error;
use crate::variant_coverage_graph::{
    apply_critical_line_flags, get_next_fen_from_san, variant_coverage_graph_cache_path,
    variant_coverage_read_graph_cache, variant_coverage_write_graph_cache,
    VariantCoverageGraphNodeDto, VariantCoverageResponseRarityDto, VariantCoverageTierDto,
};
use crate::variant_positions::{fetch_variant_position, upsert_variant_position_entry};
use crate::AppState;

use super::analysis::GameAnalysisService;
use super::human_game_analyzer::{
    analyze_game_human_report as analyze_game_human_report_inner,
    build_human_strategic_live_report as build_human_strategic_live_report_inner,
    HumanAnnotatedGameReport, HumanGameAnalysisRequest, HumanStrategicLiveRequest,
    HumanStrategicLiveResponse,
};
use super::human_strategy::{
    pick_human_strategic_move as pick_human_strategic_move_inner, HumanStrategicRequest,
    HumanStrategicSelection,
};
use super::manager::EngineManager;
use super::process::EngineProcess;
use super::types::*;

pub struct CoverageEngineSession {
    engine_name: String,
    process: EngineProcess,
    reader: tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    filtered_options: Vec<EngineOption>,
}

const COVERAGE_ENGINE_SESSION_PROGRESS_EVENT: &str = "coverage_engine_session_progress";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageEngineSessionProgressPayload {
    pub run_id: Option<String>,
    pub session_id: String,
    pub index: u32,
    pub total: u32,
    pub completed: u32,
    pub saved: u32,
    pub cached: u32,
    pub failed: u32,
    pub fen: String,
    pub label: String,
    pub error: Option<String>,
    pub has_score: bool,
}

#[derive(Clone, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverageEngineAnalysisTarget {
    pub fen: String,
    pub label: String,
}

#[derive(Clone, serde::Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverageEngineAnalysisResultEntry {
    pub fen: String,
    pub label: String,
    pub advantage: Option<String>,
    pub engine_name: String,
    pub engine_ms: u32,
    pub best_move: Option<String>,
    pub cached: bool,
    pub error: Option<String>,
}

#[derive(Clone, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverageEngineAnalysisRunRequest {
    pub engine_name: String,
    pub engine_path: String,
    pub source_node_id: String,
    pub source_node: Option<VariantCoverageGraphNodeDto>,
    pub graph_root: Option<VariantCoverageGraphNodeDto>,
    pub graph_cache_path: Option<String>,
    pub variant_path: Option<String>,
    pub coverage_graph_source_signature: Option<String>,
    pub ms: u32,
    pub engine_settings: Vec<EngineOption>,
    pub emit_progress: bool,
    pub write_graph_cache: bool,
    pub run_id: Option<String>,
}

#[derive(Clone, serde::Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverageEngineAnalysisRunResult {
    pub total: u32,
    pub completed: u32,
    pub saved: u32,
    pub cached: u32,
    pub failed: u32,
    pub applied: u32,
    pub failed_details: Vec<String>,
    pub results: Vec<CoverageEngineAnalysisResultEntry>,
    pub updated_graph_root: Option<VariantCoverageGraphNodeDto>,
    pub updated_action_node: Option<VariantCoverageGraphNodeDto>,
    pub graph_cache_written: bool,
    pub resolved_graph_cache_path: Option<String>,
}

fn coverage_run_id_for_log(run_id: &Option<String>) -> &str {
    run_id.as_deref().unwrap_or("none")
}

fn coverage_fen_for_log(fen: &str) -> String {
    fen.split_whitespace().take(4).collect::<Vec<_>>().join(" ")
}

fn check_coverage_engine_child_exit(
    process: &mut EngineProcess,
    trace_id: &str,
    phase: &str,
) -> Result<bool, Error> {
    match process.child.try_wait() {
        Ok(Some(status)) => {
            log::warn!(
                "coverage engine eval child exited: trace_id={} phase={} status={} code={:?}",
                trace_id,
                phase,
                status,
                status.code()
            );
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(err) => {
            log::warn!(
                "coverage engine eval child status check failed: trace_id={} phase={} error={}",
                trace_id,
                phase,
                err
            );
            Err(Error::Io(err))
        }
    }
}

fn coverage_engine_exited_error(trace_id: &str, phase: &str) -> Error {
    Error::Io(std::io::Error::new(
        ErrorKind::BrokenPipe,
        format!("Coverage engine process exited during {phase}: {trace_id}"),
    ))
}

fn emit_coverage_engine_session_progress(
    app: &tauri::AppHandle,
    payload: CoverageEngineSessionProgressPayload,
) {
    let app_for_emit = app.clone();
    if let Err(err) = app.run_on_main_thread(move || {
        if let Err(emit_err) = app_for_emit.emit(COVERAGE_ENGINE_SESSION_PROGRESS_EVENT, payload) {
            log::warn!("failed to emit coverage engine session progress event: {emit_err}");
        }
    }) {
        log::warn!("failed to schedule coverage engine session progress event: {err}");
    }
}

fn is_uci_bestmove_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed == "bestmove" || trimmed.starts_with("bestmove ")
}

fn sanitize_coverage_engine_options(extra_options: Vec<EngineOption>) -> Vec<EngineOption> {
    let mut options: Vec<EngineOption> = extra_options
        .into_iter()
        .filter(|option| option.name.trim().to_ascii_lowercase() != "multipv")
        .collect();
    options.push(EngineOption {
        name: "MultiPV".to_string(),
        value: "1".to_string(),
    });
    options
}

fn coverage_engine_cache_options(settings: Vec<EngineOption>) -> Vec<EngineOption> {
    let mut options: Vec<EngineOption> = settings
        .into_iter()
        .filter_map(|option| {
            let name = option.name.trim().to_string();
            if name.is_empty() || name.eq_ignore_ascii_case("multipv") {
                return None;
            }
            Some(EngineOption {
                name,
                value: option.value.trim().to_string(),
            })
        })
        .collect();
    options.push(EngineOption {
        name: "MultiPV".to_string(),
        value: "1".to_string(),
    });
    options
}

fn coverage_engine_runtime_options(settings: Vec<EngineOption>) -> Vec<EngineOption> {
    let mut options: Vec<EngineOption> = coverage_engine_cache_options(settings)
        .into_iter()
        .filter(|option| {
            let name = option.name.trim();
            !name.eq_ignore_ascii_case("multipv")
                && !name.eq_ignore_ascii_case("threads")
                && !name.eq_ignore_ascii_case("hash")
        })
        .collect();
    options.push(EngineOption {
        name: "MultiPV".to_string(),
        value: "1".to_string(),
    });
    options.push(EngineOption {
        name: "Threads".to_string(),
        value: "1".to_string(),
    });
    options.push(EngineOption {
        name: "Hash".to_string(),
        value: "256".to_string(),
    });
    options
}

fn coverage_engine_cache_signature(
    engine_name: &str,
    engine_path: &str,
    options: &[EngineOption],
) -> String {
    let mut option_parts: Vec<String> = options
        .iter()
        .map(|option| format!("{}={}", option.name.trim(), option.value.trim()))
        .collect();
    option_parts.sort();
    format!(
        "{}|{}|is960=false|{}",
        engine_name.trim(),
        engine_path.trim(),
        option_parts.join(";")
    )
}

fn parse_u32_token(value: Option<&&str>) -> Option<u32> {
    value?
        .parse::<u64>()
        .ok()
        .map(|n| n.min(u32::MAX as u64) as u32)
}

fn format_coverage_engine_advantage(score: &Score) -> String {
    match &score.value {
        ScoreValue::Mate(value) => {
            if *value > 0 {
                format!("M{value}")
            } else {
                format!("-M{}", (*value).abs())
            }
        }
        ScoreValue::Cp(value) => {
            let pawns = *value as f64 / 100.0;
            if pawns > 0.0 {
                format!("+{pawns:.2}")
            } else {
                format!("{pawns:.2}")
            }
        }
    }
}

fn coverage_engine_result_from_cached(
    target: &CoverageEngineAnalysisTarget,
    engine_name: &str,
    cached_advantage: String,
    cached_ms: u32,
) -> CoverageEngineAnalysisResultEntry {
    CoverageEngineAnalysisResultEntry {
        fen: target.fen.clone(),
        label: target.label.clone(),
        advantage: Some(cached_advantage),
        engine_name: engine_name.to_string(),
        engine_ms: cached_ms,
        best_move: None,
        cached: true,
        error: None,
    }
}

fn coverage_engine_result_error(
    target: &CoverageEngineAnalysisTarget,
    engine_name: &str,
    engine_ms: u32,
    message: String,
) -> CoverageEngineAnalysisResultEntry {
    CoverageEngineAnalysisResultEntry {
        fen: target.fen.clone(),
        label: target.label.clone(),
        advantage: None,
        engine_name: engine_name.to_string(),
        engine_ms,
        best_move: None,
        cached: false,
        error: Some(message),
    }
}

fn coverage_engine_result_from_best_line(
    target: &CoverageEngineAnalysisTarget,
    engine_name: &str,
    engine_ms: u32,
    best_line: &BestMoves,
) -> CoverageEngineAnalysisResultEntry {
    let base_advantage = format_coverage_engine_advantage(&best_line.score);
    let best_move = best_line
        .san_moves
        .first()
        .or_else(|| best_line.uci_moves.first())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "best".to_string());
    let advantage = if best_move.is_empty() {
        base_advantage
    } else {
        format!("{base_advantage} ({best_move})")
    };

    CoverageEngineAnalysisResultEntry {
        fen: target.fen.clone(),
        label: target.label.clone(),
        advantage: Some(advantage),
        engine_name: engine_name.to_string(),
        engine_ms,
        best_move: Some(best_move),
        cached: false,
        error: None,
    }
}

#[derive(Clone)]
struct CoverageEngineGraphInfo {
    advantage: String,
    engine_name: String,
    engine_ms: u32,
}

fn coverage_engine_fen_key(fen: &str) -> String {
    let parts: Vec<&str> = fen.trim().split_whitespace().collect();
    if parts.len() < 4 {
        return fen.trim().to_string();
    }
    format!("{} {} {} {}", parts[0], parts[1], parts[2], parts[3])
}

fn coverage_label_target_name(label: &str, fallback: &str) -> String {
    let value = label.split('|').next().unwrap_or(label).trim();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

fn coverage_forced_reply_primary_label(label: &str) -> Option<String> {
    let value = label
        .split('|')
        .next()
        .unwrap_or(label)
        .split("->")
        .next()
        .unwrap_or(label)
        .split(" - ")
        .next()
        .unwrap_or(label)
        .trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn extract_san_from_root_label(label: &str) -> Vec<String> {
    let before_arrow = label.split("->").next().unwrap_or(label).trim();
    let before_pipe = before_arrow
        .split('|')
        .next()
        .unwrap_or(before_arrow)
        .trim();
    let before_variant_name = before_pipe
        .split(" - ")
        .next()
        .unwrap_or(before_pipe)
        .trim();
    if before_variant_name.is_empty() {
        return Vec::new();
    }
    before_variant_name
        .split_whitespace()
        .map(str::trim)
        .filter(|token| !token.is_empty() && *token != "...")
        .map(ToOwned::to_owned)
        .collect()
}

fn merge_coverage_label_with_forced_reply(coverage_label: &str, forced_label: &str) -> String {
    let forced_primary = coverage_forced_reply_primary_label(forced_label);
    let mut parts = coverage_label.split('|');
    let left = parts.next().unwrap_or(coverage_label).trim();
    let percent = left
        .split_whitespace()
        .find(|token| token.ends_with('%'))
        .map(str::to_string);

    let move_san = match percent.as_deref() {
        Some(percent_token) => left
            .split(percent_token)
            .next()
            .unwrap_or(left)
            .trim()
            .to_string(),
        None => left.to_string(),
    };

    match (percent, forced_primary) {
        (Some(percent), Some(forced)) if !move_san.is_empty() => {
            format!("{move_san}, {forced} | {percent}")
        }
        (Some(percent), None) if !move_san.is_empty() => format!("{move_san} | {percent}"),
        (_, Some(forced)) => format!("{coverage_label}, {forced}"),
        _ => coverage_label.to_string(),
    }
}

fn coverage_response_rarity(percent: Option<f64>) -> Option<VariantCoverageResponseRarityDto> {
    let percent = percent?;
    if !percent.is_finite() {
        return None;
    }
    if percent < 5.0 {
        Some(VariantCoverageResponseRarityDto::Novelty)
    } else if percent < 20.0 {
        Some(VariantCoverageResponseRarityDto::LowFrequency)
    } else {
        None
    }
}

fn get_coverage_engine_target_node(
    node: &VariantCoverageGraphNodeDto,
    allow_root: bool,
) -> Option<VariantCoverageGraphNodeDto> {
    if node.tier == VariantCoverageTierDto::Root {
        return allow_root.then(|| node.clone());
    }

    let forced_reply =
        if node.children.len() == 1 && node.children[0].tier == VariantCoverageTierDto::Root {
            Some(&node.children[0])
        } else {
            None
        }?;

    let forced_san = extract_san_from_root_label(&forced_reply.label)
        .into_iter()
        .next();
    let computed_result_fen = forced_san.as_deref().and_then(|san| {
        node.fen
            .as_deref()
            .and_then(|fen| get_next_fen_from_san(fen, san))
    });
    let result_fen = computed_result_fen
        .or_else(|| forced_reply.fen.clone())
        .or_else(|| node.fen.clone());

    let mut target = node.clone();
    target.label = merge_coverage_label_with_forced_reply(&node.label, &forced_reply.label);
    target.response_percent = forced_reply.percent.or(node.response_percent);
    target.response_rarity =
        coverage_response_rarity(forced_reply.percent).or(node.response_rarity);
    target.fen = result_fen;
    target.opening_name = forced_reply
        .opening_name
        .clone()
        .or_else(|| node.opening_name.clone());
    target.active_moves_used = forced_reply.active_moves_used.or(node.active_moves_used);
    target.active_win_rate = forced_reply.active_win_rate;
    target.active_loss_rate = forced_reply.active_loss_rate;
    target.profile_win_rate = forced_reply.profile_win_rate;
    target.profile_loss_rate = forced_reply.profile_loss_rate;
    target.engine_advantage = forced_reply.engine_advantage.clone();
    target.engine_name = forced_reply.engine_name.clone();
    target.engine_ms = forced_reply.engine_ms;
    target.unmapped_response = Some(false);
    target.children = forced_reply.children.clone();
    Some(target)
}

fn collect_coverage_engine_targets_from_node(
    source_node: &VariantCoverageGraphNodeDto,
) -> Vec<CoverageEngineAnalysisTarget> {
    fn add_target(
        candidate: &VariantCoverageGraphNodeDto,
        seen: &mut HashSet<String>,
        targets: &mut Vec<CoverageEngineAnalysisTarget>,
    ) {
        let fen = candidate
            .fen
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_string();
        if fen.is_empty() {
            return;
        }
        let fen_key = coverage_engine_fen_key(&fen);
        if !seen.insert(fen_key.clone()) {
            return;
        }
        targets.push(CoverageEngineAnalysisTarget {
            fen,
            label: coverage_label_target_name(&candidate.label, &fen_key),
        });
    }

    fn visit(
        candidate: &VariantCoverageGraphNodeDto,
        seen: &mut HashSet<String>,
        targets: &mut Vec<CoverageEngineAnalysisTarget>,
    ) {
        add_target(candidate, seen, targets);
        if candidate.collapsed == Some(true) {
            return;
        }
        for child in &candidate.children {
            if let Some(child_target) = get_coverage_engine_target_node(child, false) {
                visit(&child_target, seen, targets);
            }
        }
    }

    let Some(target_node) = get_coverage_engine_target_node(source_node, true) else {
        return Vec::new();
    };

    let mut seen = HashSet::new();
    let mut targets = Vec::new();
    visit(&target_node, &mut seen, &mut targets);
    targets
}

fn apply_coverage_engine_info_to_graph(
    mut node: VariantCoverageGraphNodeDto,
    engine_info_by_fen: &HashMap<String, CoverageEngineGraphInfo>,
) -> VariantCoverageGraphNodeDto {
    node.children = node
        .children
        .into_iter()
        .map(|child| apply_coverage_engine_info_to_graph(child, engine_info_by_fen))
        .collect();

    let Some(fen) = node
        .fen
        .as_deref()
        .map(str::trim)
        .filter(|fen| !fen.is_empty())
    else {
        return node;
    };
    let Some(engine_info) = engine_info_by_fen.get(&coverage_engine_fen_key(fen)) else {
        return node;
    };

    node.engine_advantage = Some(engine_info.advantage.clone());
    node.engine_name = Some(engine_info.engine_name.clone());
    node.engine_ms = Some(i64::from(engine_info.engine_ms));
    node
}

fn find_coverage_node_by_id(
    node: &VariantCoverageGraphNodeDto,
    id: &str,
) -> Option<VariantCoverageGraphNodeDto> {
    if node.id == id {
        return Some(node.clone());
    }
    for child in &node.children {
        if let Some(found) = find_coverage_node_by_id(child, id) {
            return Some(found);
        }
    }
    None
}

fn is_likely_uci_move(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 4 && bytes.len() != 5 {
        return false;
    }

    let is_file = |byte: u8| matches!(byte, b'a'..=b'h');
    let is_rank = |byte: u8| matches!(byte, b'1'..=b'8');
    if !is_file(bytes[0]) || !is_rank(bytes[1]) || !is_file(bytes[2]) || !is_rank(bytes[3]) {
        return false;
    }

    bytes.len() == 4
        || matches!(
            bytes[4],
            b'b' | b'n' | b'q' | b'r' | b'B' | b'N' | b'Q' | b'R'
        )
}

fn parse_engine_info_line(line: &str, fen: &Fen) -> Result<Option<BestMoves>, Error> {
    let trimmed = line.trim_start();
    if trimmed != "info" && !trimmed.starts_with("info ") {
        return Ok(None);
    }
    if !trimmed.contains(" score ") || !trimmed.contains(" pv ") {
        return Ok(None);
    }

    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    let mut best_moves = BestMoves::default();
    let mut has_score = false;
    let mut pv_start: Option<usize> = None;
    let mut index = 1;

    while index < tokens.len() {
        match tokens[index] {
            "depth" => {
                if let Some(depth) = parse_u32_token(tokens.get(index + 1)) {
                    best_moves.depth = depth;
                }
                index += 2;
            }
            "nodes" => {
                if let Some(nodes) = parse_u32_token(tokens.get(index + 1)) {
                    best_moves.nodes = nodes;
                }
                index += 2;
            }
            "nps" => {
                if let Some(nps) = parse_u32_token(tokens.get(index + 1)) {
                    best_moves.nps = nps;
                }
                index += 2;
            }
            "multipv" => {
                if let Some(multipv) = tokens
                    .get(index + 1)
                    .and_then(|value| value.parse::<u16>().ok())
                {
                    best_moves.multipv = multipv;
                }
                index += 2;
            }
            "score" => {
                if let (Some(kind), Some(raw_value)) =
                    (tokens.get(index + 1), tokens.get(index + 2))
                {
                    if let Ok(value) = raw_value.parse::<i32>() {
                        match *kind {
                            "cp" => {
                                best_moves.score.value = ScoreValue::Cp(value);
                                has_score = true;
                            }
                            "mate" => {
                                best_moves.score.value = ScoreValue::Mate(value);
                                has_score = true;
                            }
                            _ => {}
                        }
                    }
                }
                index += 3;
            }
            "wdl" => {
                if let (Some(w), Some(d), Some(l)) = (
                    tokens.get(index + 1),
                    tokens.get(index + 2),
                    tokens.get(index + 3),
                ) {
                    if let (Ok(w), Ok(d), Ok(l)) =
                        (w.parse::<u32>(), d.parse::<u32>(), l.parse::<u32>())
                    {
                        best_moves.score.wdl = Some((w, d, l));
                    }
                }
                index += 4;
            }
            "pv" => {
                pv_start = Some(index + 1);
                break;
            }
            _ => {
                index += 1;
            }
        }
    }

    if let Some(start) = pv_start {
        if let Some(move_token) = tokens
            .get(start)
            .copied()
            .filter(|move_token| is_likely_uci_move(move_token))
        {
            best_moves.uci_moves.push(move_token.to_ascii_lowercase());
        }
    }

    if !has_score {
        return Ok(None);
    }

    if fen.0.turn == Color::Black {
        best_moves.score = Score {
            value: match best_moves.score.value.clone() {
                ScoreValue::Cp(value) => ScoreValue::Cp(-value),
                ScoreValue::Mate(value) => ScoreValue::Mate(-value),
            },
            wdl: best_moves.score.wdl.map(|(w, d, l)| (l, d, w)),
        };
    }

    Ok(Some(best_moves))
}

async fn drain_until_bestmove(
    reader: &mut tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    max_wait: Duration,
    _trace_id: &str,
) {
    let started_at = Instant::now();
    while started_at.elapsed() < max_wait {
        let remaining = max_wait.saturating_sub(started_at.elapsed());
        match timeout(
            remaining.min(Duration::from_millis(250)),
            reader.next_line(),
        )
        .await
        {
            Ok(Ok(Some(line))) => {
                if is_uci_bestmove_line(&line) {
                    break;
                }
            }
            Ok(Ok(None)) | Ok(Err(_)) => break,
            Err(_) => continue,
        }
    }
}

async fn drain_until_readyok(
    process: &mut EngineProcess,
    reader: &mut tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    max_wait: Duration,
    trace_id: &str,
    capture_logs: bool,
) -> bool {
    let started_at = Instant::now();
    let mut drained_lines = 0_u32;
    while started_at.elapsed() < max_wait {
        let remaining = max_wait.saturating_sub(started_at.elapsed());
        match timeout(
            remaining.min(Duration::from_millis(250)),
            reader.next_line(),
        )
        .await
        {
            Ok(Ok(Some(line))) => {
                let is_ready = line.trim() == "readyok";
                drained_lines = drained_lines.saturating_add(1);
                if capture_logs {
                    process.append_log(EngineLog::Engine(line));
                }
                if is_ready {
                    return true;
                }
            }
            Ok(Ok(None)) | Ok(Err(_)) => break,
            Err(_) => continue,
        }
    }
    log::warn!(
        "coverage engine eval ready drain timed out or closed: trace_id={} drained_lines={}",
        trace_id,
        drained_lines
    );
    false
}

async fn evaluate_engine_position_with_process(
    process: &mut EngineProcess,
    reader: &mut tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    fen: &str,
    requested_ms: u32,
    extra_options: Vec<EngineOption>,
    trace_id: &str,
    capture_logs: bool,
) -> Result<Option<BestMoves>, Error> {
    let fen_log = coverage_fen_for_log(fen);
    if check_coverage_engine_child_exit(process, trace_id, "begin")? {
        return Err(coverage_engine_exited_error(trace_id, "begin"));
    }

    let set_options_requests_ready = extra_options
        .iter()
        .any(|option| option.name.trim().eq_ignore_ascii_case("UCI_ShowWDL"));
    process
        .set_options(EngineOptions {
            fen: fen.trim().to_string(),
            moves: Vec::new(),
            extra_options,
        })
        .await?;
    if check_coverage_engine_child_exit(process, trace_id, "after_set_options")? {
        return Err(coverage_engine_exited_error(trace_id, "after_set_options"));
    }

    if !set_options_requests_ready {
        process.request_ready().await?;
    }
    let ready = drain_until_readyok(
        process,
        reader,
        Duration::from_secs(5),
        trace_id,
        capture_logs,
    )
    .await;
    if !ready {
        if check_coverage_engine_child_exit(process, trace_id, "ready_timeout")? {
            return Err(coverage_engine_exited_error(trace_id, "ready_timeout"));
        }
        return Err(Error::EngineTimeout);
    }
    process.go(&GoMode::Time(requested_ms)).await?;
    if check_coverage_engine_child_exit(process, trace_id, "after_go")? {
        return Err(coverage_engine_exited_error(trace_id, "after_go"));
    }

    let parsed_fen: Fen = process.options.fen.parse()?;
    let started_at = Instant::now();
    let max_wait = Duration::from_millis(requested_ms.saturating_add(7000) as u64);
    let mut best_line: Option<BestMoves> = None;
    let mut timeout_ticks = 0_u32;

    loop {
        if started_at.elapsed() >= max_wait {
            log::warn!(
                "coverage engine eval timeout reached: trace_id={} elapsed_ms={} max_wait_ms={}",
                trace_id,
                started_at.elapsed().as_millis(),
                max_wait.as_millis()
            );
            let _ = process.stop().await;
            drain_until_bestmove(reader, Duration::from_secs(2), trace_id).await;
            break;
        }

        let remaining = max_wait.saturating_sub(started_at.elapsed());
        let line_result = timeout(
            remaining.min(Duration::from_millis(500)),
            reader.next_line(),
        )
        .await;
        let line = match line_result {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => {
                let exited = check_coverage_engine_child_exit(process, trace_id, "stdout_closed")?;
                log::warn!(
                    "coverage engine eval stdout closed: trace_id={} child_exited={}",
                    trace_id,
                    exited
                );
                if exited {
                    return Err(coverage_engine_exited_error(trace_id, "stdout_closed"));
                }
                break;
            }
            Ok(Err(err)) => return Err(Error::Io(err)),
            Err(_) => {
                timeout_ticks = timeout_ticks.saturating_add(1);
                if timeout_ticks % 10 == 0 {
                    if check_coverage_engine_child_exit(process, trace_id, "read_wait")? {
                        return Err(coverage_engine_exited_error(trace_id, "read_wait"));
                    }
                }
                continue;
            }
        };

        match parse_engine_info_line(&line, &parsed_fen) {
            Ok(Some(candidate)) => {
                if candidate.multipv == 1 {
                    best_line = Some(candidate);
                }
            }
            Ok(None) => {
                if is_uci_bestmove_line(&line) {
                    break;
                }
            }
            Err(err) => {
                log::warn!(
                    "Ignoring malformed engine info line: trace_id={} fen={} error={}",
                    trace_id,
                    fen_log,
                    err
                );
            }
        }
        if capture_logs {
            process.append_log(EngineLog::Engine(line));
        }
    }

    process.running = false;
    Ok(best_line)
}

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
            if let Some(process_arc) = state
                .engine_processes
                .get(&key)
                .map(|entry| entry.value().clone())
            {
                #[allow(unused_mut)]
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
    if let Some(process_arc) = state
        .engine_processes
        .get(&key)
        .map(|entry| entry.value().clone())
    {
        #[allow(unused_mut)]
        let mut process = process_arc.lock().await;
        // Attempt to kill, but always remove from map
        let _ = process.kill().await; // Ignore errors, ensure cleanup
    }
    // FIXED: Always remove to prevent memory leak
    state.engine_processes.remove(&key);
    Ok(())
}

/// Stop a specific engine process by engine name and tab.
/// This command performs a definitive shutdown (`stop` + `quit/kill`) and removes the process from the map.
#[tauri::command]
#[specta::specta]
pub async fn stop_engine(
    engine: String,
    tab: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let key = (tab.clone(), engine.clone());
    let mut keys_to_stop = Vec::new();
    if state.engine_processes.contains_key(&key) {
        keys_to_stop.push(key);
    } else {
        // Fallback: handle tab variants that append suffixes (e.g. turn/channel suffixes).
        keys_to_stop = state
            .engine_processes
            .iter()
            .map(|x| x.key().clone())
            .filter(|k| k.1 == engine && k.0.starts_with(&tab))
            .collect();
    }

    for k in keys_to_stop {
        if let Some(process) = state
            .engine_processes
            .get(&k)
            .map(|entry| entry.value().clone())
        {
            #[allow(unused_mut)]
            let mut process = process.lock().await;
            // Best effort graceful stop first, then definitive process termination.
            let _ = process.stop().await;
            let _ = process.kill().await;
        }
        // Always remove from map to avoid stale entries.
        state.engine_processes.remove(&k);
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
    if let Some(process) = state
        .engine_processes
        .get(&key)
        .map(|entry| entry.value().clone())
    {
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

/// Evaluate one position in an isolated engine process and return the final principal variation.
#[tauri::command]
#[specta::specta]
pub async fn evaluate_engine_position_once(
    engine_name: String,
    engine_path: String,
    fen: String,
    ms: u32,
    extra_options: Vec<EngineOption>,
    app: tauri::AppHandle,
) -> Result<Option<BestMoves>, Error> {
    let resolved_path = super::engine_path::resolve_engine_path(&engine_path, &app);
    let requested_ms = ms.clamp(100, 60_000);
    let filtered_options = sanitize_coverage_engine_options(extra_options);
    let trace_id = format!(
        "mode=once engine={} fen={}",
        engine_name,
        coverage_fen_for_log(&fen)
    );

    let (mut process, mut reader) = EngineProcess::new(resolved_path).await?;
    let best_line = match evaluate_engine_position_with_process(
        &mut process,
        &mut reader,
        &fen,
        requested_ms,
        filtered_options,
        &trace_id,
        false,
    )
    .await
    {
        Ok(best_line) => best_line,
        Err(err) => {
            let _ = process.kill().await;
            return Err(err);
        }
    };

    let _ = process.kill().await;

    Ok(best_line)
}

#[tauri::command]
#[specta::specta]
pub async fn start_coverage_engine_session(
    engine_name: String,
    engine_path: String,
    extra_options: Vec<EngineOption>,
    run_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, Error> {
    let _ = run_id;
    let resolved_path = super::engine_path::resolve_engine_path(&engine_path, &app);
    let filtered_options = sanitize_coverage_engine_options(extra_options);
    let (process, reader) = EngineProcess::new(resolved_path).await?;
    let session_id = uuid::Uuid::new_v4().to_string();

    state.coverage_engine_sessions.insert(
        session_id.clone(),
        std::sync::Arc::new(tokio::sync::Mutex::new(CoverageEngineSession {
            engine_name,
            process,
            reader,
            filtered_options,
        })),
    );

    Ok(session_id)
}

#[tauri::command]
#[specta::specta]
pub async fn evaluate_coverage_engine_session_position(
    session_id: String,
    fen: String,
    index: u32,
    total: u32,
    label: String,
    ms: u32,
    emit_progress: bool,
    run_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<BestMoves>, Error> {
    let Some(session_arc) = state
        .coverage_engine_sessions
        .get(&session_id)
        .map(|entry| entry.value().clone())
    else {
        return Err(Error::InvalidInput(
            "Coverage engine session not found".to_string(),
        ));
    };

    let requested_ms = ms.clamp(100, 60_000);
    let fen_log = fen.split_whitespace().take(4).collect::<Vec<_>>().join(" ");
    let eval_started_at = Instant::now();
    let (engine_name, eval_result) = {
        let mut session = session_arc.lock().await;
        let CoverageEngineSession {
            engine_name,
            process,
            reader,
            filtered_options,
        } = &mut *session;
        let engine_name = engine_name.clone();
        let filtered_options = filtered_options.clone();
        let trace_id = format!(
            "mode=session run_id={} session_id={} engine={} index={} total={} fen={}",
            coverage_run_id_for_log(&run_id),
            session_id,
            engine_name,
            index,
            total,
            fen_log
        );
        let eval_result = evaluate_engine_position_with_process(
            process,
            reader,
            &fen,
            requested_ms,
            filtered_options,
            &trace_id,
            false,
        )
        .await;
        (engine_name, eval_result)
    };
    let elapsed_ms = eval_started_at.elapsed().as_millis();

    match eval_result {
        Ok(best_line) => {
            if emit_progress {
                let payload = CoverageEngineSessionProgressPayload {
                    run_id: run_id.clone(),
                    session_id: session_id.clone(),
                    index,
                    total,
                    completed: index.saturating_add(1).min(total),
                    saved: 0,
                    cached: 0,
                    failed: 0,
                    fen,
                    label,
                    has_score: best_line.is_some(),
                    error: None,
                };
                emit_coverage_engine_session_progress(&app, payload);
            }
            Ok(best_line)
        }
        Err(err) => {
            let error_message = err.to_string();
            log::warn!(
                "coverage engine session eval failed: run_id={} session_id={} engine={} index={} total={} fen={} ms={} elapsed_ms={} error={}",
                coverage_run_id_for_log(&run_id),
                session_id,
                engine_name,
                index,
                total,
                fen_log,
                requested_ms,
                elapsed_ms,
                error_message
            );
            if emit_progress {
                let payload = CoverageEngineSessionProgressPayload {
                    run_id: run_id.clone(),
                    session_id: session_id.clone(),
                    index,
                    total,
                    completed: index.saturating_add(1).min(total),
                    saved: 0,
                    cached: 0,
                    failed: 1,
                    fen,
                    label,
                    error: Some(error_message),
                    has_score: false,
                };
                emit_coverage_engine_session_progress(&app, payload);
            }
            Err(err)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn stop_coverage_engine_session(
    session_id: String,
    run_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let _ = run_id;
    if let Some((_key, session_arc)) = state.coverage_engine_sessions.remove(&session_id) {
        let mut session = session_arc.lock().await;
        let _ = session.process.kill().await;
    }
    Ok(())
}

/// Run a full coverage engine job in the backend.
///
/// The frontend supplies the selected graph node and receives progress/result summaries.
/// Target collection, cache lookup, engine evaluation, score formatting, SQLite writes, and graph cache writes all happen here.
#[tauri::command]
#[specta::specta]
pub async fn run_coverage_engine_analysis(
    request: CoverageEngineAnalysisRunRequest,
    app: tauri::AppHandle,
) -> Result<CoverageEngineAnalysisRunResult, Error> {
    let CoverageEngineAnalysisRunRequest {
        engine_name,
        engine_path,
        source_node_id,
        source_node,
        graph_root,
        graph_cache_path,
        variant_path,
        coverage_graph_source_signature,
        ms,
        engine_settings,
        emit_progress,
        write_graph_cache,
        run_id,
    } = request;

    let source_node_id = source_node_id.trim().to_string();
    let source_node = graph_root
        .as_ref()
        .and_then(|root| find_coverage_node_by_id(root, &source_node_id))
        .or(source_node)
        .ok_or_else(|| {
            Error::InvalidInput("Coverage engine analysis source node not found".to_string())
        })?;

    let requested_ms = ms.clamp(100, 60_000);
    let targets = collect_coverage_engine_targets_from_node(&source_node);
    let total = targets.len().min(u32::MAX as usize) as u32;
    let session_id = uuid::Uuid::new_v4().to_string();
    let cache_options = coverage_engine_cache_options(engine_settings.clone());
    let engine_cache_signature =
        coverage_engine_cache_signature(&engine_name, &engine_path, &cache_options);
    let filtered_options =
        sanitize_coverage_engine_options(coverage_engine_runtime_options(engine_settings));
    let resolved_graph_cache_path = graph_cache_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            let variant_path = variant_path.as_deref()?.trim();
            let source_signature = coverage_graph_source_signature.as_deref()?.trim();
            if variant_path.is_empty() || source_signature.is_empty() {
                return None;
            }
            match variant_coverage_graph_cache_path(variant_path.to_string(), source_signature.to_string()) {
                Ok(path) => Some(path),
                Err(err) => {
                    log::warn!(
                        "coverage engine backend graph cache path failed: run_id={} session_id={} error={}",
                        coverage_run_id_for_log(&run_id),
                        session_id,
                        err
                    );
                    None
                }
            }
        });
    let graph_repertoire_color = resolved_graph_cache_path
        .as_deref()
        .and_then(|cache_path| {
            variant_coverage_read_graph_cache(cache_path.to_string())
                .ok()
                .flatten()
        })
        .map(|cache| cache.repertoire_color);
    let mut results = Vec::with_capacity(targets.len());
    let mut engine_info_by_fen: HashMap<String, CoverageEngineGraphInfo> = HashMap::new();
    let mut completed = 0_u32;
    let mut saved = 0_u32;
    let mut cached = 0_u32;
    let mut failed = 0_u32;
    let mut pending = Vec::new();
    let mut failed_details = Vec::new();

    for target in targets {
        let fen = target.fen.trim().to_string();
        if fen.is_empty() {
            failed = failed.saturating_add(1);
            completed = completed.saturating_add(1);
            let entry = coverage_engine_result_error(
                &target,
                &engine_name,
                requested_ms,
                "Missing FEN".to_string(),
            );
            if emit_progress {
                emit_coverage_engine_session_progress(
                    &app,
                    CoverageEngineSessionProgressPayload {
                        run_id: run_id.clone(),
                        session_id: session_id.clone(),
                        index: completed.saturating_sub(1),
                        total,
                        completed,
                        saved,
                        cached,
                        failed,
                        fen: target.fen.clone(),
                        label: target.label.clone(),
                        error: entry.error.clone(),
                        has_score: false,
                    },
                );
            }
            if let Some(error) = entry.error.as_deref() {
                failed_details.push(format!("{}: {}", entry.label, error));
            }
            results.push(entry);
            continue;
        }

        let cached_entry = fetch_variant_position(&app, &fen, &engine_cache_signature)?;
        let cached_advantage = cached_entry
            .as_ref()
            .and_then(|entry| entry.engine_advantage.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        let cached_ms = cached_entry
            .as_ref()
            .and_then(|entry| u32::try_from(entry.ms).ok())
            .unwrap_or(0);

        if let Some(cached_advantage) = cached_advantage {
            if cached_ms >= requested_ms {
                cached = cached.saturating_add(1);
                completed = completed.saturating_add(1);
                let entry = coverage_engine_result_from_cached(
                    &target,
                    &engine_name,
                    cached_advantage,
                    cached_ms,
                );
                if let Some(advantage) = entry.advantage.as_deref() {
                    engine_info_by_fen.insert(
                        coverage_engine_fen_key(&entry.fen),
                        CoverageEngineGraphInfo {
                            advantage: advantage.to_string(),
                            engine_name: entry.engine_name.clone(),
                            engine_ms: entry.engine_ms,
                        },
                    );
                }
                if emit_progress {
                    emit_coverage_engine_session_progress(
                        &app,
                        CoverageEngineSessionProgressPayload {
                            run_id: run_id.clone(),
                            session_id: session_id.clone(),
                            index: completed.saturating_sub(1),
                            total,
                            completed,
                            saved,
                            cached,
                            failed,
                            fen: target.fen.clone(),
                            label: target.label.clone(),
                            error: None,
                            has_score: true,
                        },
                    );
                }
                results.push(entry);
                continue;
            }
        }

        pending.push(target);
    }

    if !pending.is_empty() {
        let resolved_path = super::engine_path::resolve_engine_path(&engine_path, &app);
        let (mut process, mut reader) = EngineProcess::new(resolved_path).await?;

        for target in pending {
            let target_index = completed;
            let fen_log = coverage_fen_for_log(&target.fen);
            let trace_id = format!(
                "mode=backend-run run_id={} session_id={} engine={} index={} total={} fen={}",
                coverage_run_id_for_log(&run_id),
                session_id,
                engine_name,
                target_index,
                total,
                fen_log
            );

            let eval_result = evaluate_engine_position_with_process(
                &mut process,
                &mut reader,
                &target.fen,
                requested_ms,
                filtered_options.clone(),
                &trace_id,
                false,
            )
            .await;

            let entry = match eval_result {
                Ok(Some(best_line)) => {
                    let entry = coverage_engine_result_from_best_line(
                        &target,
                        &engine_name,
                        requested_ms,
                        &best_line,
                    );
                    if let (Some(best_move), Some(advantage)) =
                        (entry.best_move.as_deref(), entry.advantage.as_deref())
                    {
                        if let Err(err) = upsert_variant_position_entry(
                            &app,
                            &target.fen,
                            &engine_cache_signature,
                            best_move,
                            Some(advantage),
                            i64::from(requested_ms),
                        ) {
                            failed = failed.saturating_add(1);
                            coverage_engine_result_error(
                                &target,
                                &engine_name,
                                requested_ms,
                                format!("Save error: {err}"),
                            )
                        } else {
                            saved = saved.saturating_add(1);
                            if let Some(advantage) = entry.advantage.as_deref() {
                                engine_info_by_fen.insert(
                                    coverage_engine_fen_key(&entry.fen),
                                    CoverageEngineGraphInfo {
                                        advantage: advantage.to_string(),
                                        engine_name: entry.engine_name.clone(),
                                        engine_ms: entry.engine_ms,
                                    },
                                );
                            }
                            entry
                        }
                    } else {
                        failed = failed.saturating_add(1);
                        coverage_engine_result_error(
                            &target,
                            &engine_name,
                            requested_ms,
                            "No best move".to_string(),
                        )
                    }
                }
                Ok(None) => {
                    failed = failed.saturating_add(1);
                    coverage_engine_result_error(
                        &target,
                        &engine_name,
                        requested_ms,
                        "No score".to_string(),
                    )
                }
                Err(err) => {
                    failed = failed.saturating_add(1);
                    coverage_engine_result_error(
                        &target,
                        &engine_name,
                        requested_ms,
                        err.to_string(),
                    )
                }
            };

            completed = completed.saturating_add(1);
            if let Some(error) = entry.error.as_deref() {
                failed_details.push(format!("{}: {}", entry.label, error));
            }
            if emit_progress {
                emit_coverage_engine_session_progress(
                    &app,
                    CoverageEngineSessionProgressPayload {
                        run_id: run_id.clone(),
                        session_id: session_id.clone(),
                        index: target_index,
                        total,
                        completed,
                        saved,
                        cached,
                        failed,
                        fen: target.fen.clone(),
                        label: target.label.clone(),
                        has_score: entry.advantage.is_some(),
                        error: entry.error.clone(),
                    },
                );
            }
            results.push(entry);
        }

        let _ = process.kill().await;
    }

    let updated_graph_root = if engine_info_by_fen.is_empty() {
        None
    } else {
        graph_root.map(|root| {
            let updated = apply_coverage_engine_info_to_graph(root, &engine_info_by_fen);
            if let Some(color) = graph_repertoire_color {
                apply_critical_line_flags(updated, color)
            } else {
                updated
            }
        })
    };
    let updated_action_node = updated_graph_root
        .as_ref()
        .and_then(|root| find_coverage_node_by_id(root, &source_node.id));
    let mut graph_cache_written = false;

    if write_graph_cache && !engine_info_by_fen.is_empty() {
        if let Some(cache_path) = resolved_graph_cache_path.as_deref() {
            match variant_coverage_read_graph_cache(cache_path.to_string()) {
                Ok(Some(mut cache)) => {
                    cache.graph_root = apply_critical_line_flags(
                        apply_coverage_engine_info_to_graph(cache.graph_root, &engine_info_by_fen),
                        cache.repertoire_color,
                    );
                    cache.generated_at = Utc::now().to_rfc3339();
                    match variant_coverage_write_graph_cache(cache_path.to_string(), cache) {
                        Ok(()) => {
                            graph_cache_written = true;
                        }
                        Err(err) => {
                            log::warn!(
                                "coverage engine backend graph cache write failed: run_id={} session_id={} path={} error={}",
                                coverage_run_id_for_log(&run_id),
                                session_id,
                                cache_path,
                                err
                            );
                        }
                    }
                }
                Ok(None) => {
                    log::warn!(
                        "coverage engine backend graph cache missing: run_id={} session_id={} path={}",
                        coverage_run_id_for_log(&run_id),
                        session_id,
                        cache_path
                    );
                }
                Err(err) => {
                    log::warn!(
                        "coverage engine backend graph cache read failed: run_id={} session_id={} path={} error={}",
                        coverage_run_id_for_log(&run_id),
                        session_id,
                        cache_path,
                        err
                    );
                }
            }
        }
    }
    let applied = engine_info_by_fen.len().min(u32::MAX as usize) as u32;

    Ok(CoverageEngineAnalysisRunResult {
        total,
        completed,
        saved,
        cached,
        failed,
        applied,
        failed_details,
        results,
        updated_graph_root,
        updated_action_node,
        graph_cache_written,
        resolved_graph_cache_path,
    })
}

/// Evaluate multiple positions in one isolated engine process.
#[tauri::command]
#[specta::specta]
pub async fn evaluate_engine_positions_batch(
    engine_name: String,
    engine_path: String,
    fens: Vec<String>,
    ms: u32,
    extra_options: Vec<EngineOption>,
    request_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<Vec<Option<BestMoves>>, Error> {
    let _ = request_id;
    let resolved_path = super::engine_path::resolve_engine_path(&engine_path, &app);
    let requested_ms = ms.clamp(100, 60_000);
    let filtered_options = sanitize_coverage_engine_options(extra_options);

    let (mut process, mut reader) = EngineProcess::new(resolved_path).await?;
    let mut results = Vec::with_capacity(fens.len());

    for fen in &fens {
        let trace_id = format!(
            "mode=batch engine={} fen={}",
            engine_name,
            coverage_fen_for_log(fen)
        );
        let best_line = match evaluate_engine_position_with_process(
            &mut process,
            &mut reader,
            fen,
            requested_ms,
            filtered_options.clone(),
            &trace_id,
            false,
        )
        .await
        {
            Ok(best_line) => best_line,
            Err(err) => {
                let message = err.to_string();
                log::warn!(
                    "coverage engine batch eval failed: engine={} fen={} ms={} error={}",
                    engine_name,
                    fen.split_whitespace().take(4).collect::<Vec<_>>().join(" "),
                    requested_ms,
                    message
                );
                results.push(None);
                continue;
            }
        };

        results.push(best_line);
    }

    let _ = process.kill().await;
    Ok(results)
}

/// Pick a practical strategic move from engine MultiPV candidates under safety guardrails.
#[tauri::command]
#[specta::specta]
pub fn pick_human_strategic_move(
    request: HumanStrategicRequest,
) -> Result<HumanStrategicSelection, Error> {
    pick_human_strategic_move_inner(request)
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

/// Analyze a game with human strategic narratives and return an annotated PGN.
#[tauri::command]
#[specta::specta]
pub async fn analyze_game_human_report(
    request: HumanGameAnalysisRequest,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<HumanAnnotatedGameReport, Error> {
    analyze_game_human_report_inner(request, state, app).await
}

/// Build live strategic explanations for the current engine MultiPV lines.
#[tauri::command]
#[specta::specta]
pub fn build_human_strategic_live_report(
    request: HumanStrategicLiveRequest,
) -> Result<HumanStrategicLiveResponse, Error> {
    build_human_strategic_live_report_inner(request)
}

/// Query a UCI engine for its configuration (name and options).
/// FIXED: Proper process cleanup with timeout to prevent zombie processes
#[tauri::command]
#[specta::specta]
pub async fn get_engine_config(
    path: PathBuf,
    app: tauri::AppHandle,
) -> Result<EngineConfig, Error> {
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

    #[allow(unused_mut)]
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
    #[allow(unused_mut)]
    let mut stdin = child.stdin.take().ok_or(Error::NoStdin)?;
    let stdout = child.stdout.take().ok_or(Error::NoStdout)?;
    #[allow(unused_mut)]
    let mut stdout = tokio::io::BufReader::new(stdout).lines();

    use tokio::io::AsyncWriteExt;
    stdin.write_all(b"uci\n").await?;

    #[allow(unused_mut)]
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
