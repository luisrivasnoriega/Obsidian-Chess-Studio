use crate::analysis_storage::{analysis_db_get_analyzed_games_bulk, analysis_db_get_game_stats_bulk};
use crate::db::{
    encoding::extract_main_line_moves,
    get_games, get_players, GameQueryJs, GameSort, PlayerQuery, PlayerSort, QueryOptions,
    SortDirection, Sides,
};
use crate::error::{Error, Result};
use crate::AppState;
use chrono::{
    DateTime, Datelike, Duration, Local, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc,
};
use shakmaty::{fen::Fen, san::SanPlus, CastlingMode, Chess};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use rusqlite::{params, Connection, OptionalExtension};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GamesHistoryKind {
    Local,
    Chesscom,
    Lichess,
    Chessbase,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GamesHistoryRow {
    pub kind: GamesHistoryKind,
    /// UI identifier (Chess.com URL, Lichess id, or local id).
    /// This is stable for rendering & actions like "open URL" or "favorite".
    pub game_key: String,
    /// Key used to LEFT JOIN with analysis.db3 (`game_analysis.game_id`).
    /// For profile DB games this is `Games.ID` (as string). For local games it's the local id.
    pub analysis_game_id: String,
    /// For online games: URL for chess.com, `https://lichess.org/<id>` for lichess. Null for local.
    pub external_url: Option<String>,
    pub opponent: String,
    pub color: String,
    /// "win" | "loss" | "draw" | "unknown"
    pub outcome: String,
    /// Original PGN if available (may be overwritten by analyzed PGN if present).
    pub pgn: Option<String>,
    /// Initial FEN (start position) when available. Useful for from-position games
    /// whose movetext may not contain PGN headers.
    pub initial_fen: Option<String>,
    pub accuracy: Option<f64>,
    pub acpl: Option<f64>,
    pub estimated_elo: Option<i64>,
    pub resistance: Option<f64>,
    pub elo_estimated_balanced: Option<i64>,
    /// Approximate number of full moves.
    pub moves: i32,
    pub time_control: Option<String>,
    pub time_control_category: Option<String>,
    pub timestamp_ms: i64,
    pub event_id: Option<i32>,
    pub event_name: Option<String>,
    pub is_analyzed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GamesHistoryResponse {
    pub rows: Vec<GamesHistoryRow>,
    pub total_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GamesHistoryFilterMetaResponse {
    pub available_time_control_categories: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GamesHistoryRequest {
    pub profile_id: String,
    pub game_history_limit: i32,
    pub page: i32,
    pub page_size: i32,
    pub event_filter_id: Option<i32>,
    pub selected_opponent_id: Option<i32>,
    pub opponent_contains: Option<String>,
    pub time_control_category: Option<String>,
    pub result_filter: Option<String>, // win/loss/draw
    pub player_color: Option<String>,  // white/black
    pub min_moves: Option<i32>,        // minimum full moves
    pub sort_by: Option<String>,       // "elo" | "date"
    pub sort_direction: Option<String>, // "asc" | "desc"
    pub profile_usernames: Vec<String>,
    pub include_base_pgn: Option<bool>,
    pub include_analyzed_pgn: Option<bool>,
    pub include_analysis_stats: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GamesHistoryFilterMetaRequest {
    pub profile_id: String,
    pub game_history_limit: i32,
    pub event_filter_id: Option<i32>,
    pub selected_opponent_id: Option<i32>,
    pub opponent_contains: Option<String>,
    pub result_filter: Option<String>,
    pub player_color: Option<String>,
    pub min_moves: Option<i32>,
    pub profile_usernames: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DashboardOverviewRequest {
    pub profile_id: String,
    pub game_history_limit: i32,
    pub profile_usernames: Vec<String>,
    pub sample_size: Option<i32>,
    pub trend_weeks: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DashboardAcplByTimeControl {
    pub classical: Option<f64>,
    pub rapid: Option<f64>,
    pub blitz: Option<f64>,
    pub bullet: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DashboardAccuracyByColor {
    pub white: Option<f64>,
    pub black: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DashboardPuzzleVariantsColorCoverage {
    pub white_puzzles: i32,
    pub black_puzzles: i32,
    pub total_puzzles: i32,
    pub white_percent: i32,
    pub black_percent: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DashboardOverviewResponse {
    pub week_start_ms: i64,
    pub week_end_ms: i64,
    pub week_games_count: i32,
    pub week_wins: i32,
    pub week_losses: i32,
    pub week_draws: i32,
    pub week_outcome_count: i32,
    pub week_win_rate: i32,
    pub previous_week_games_count: i32,
    pub previous_week_wins: i32,
    pub previous_week_losses: i32,
    pub previous_week_draws: i32,
    pub previous_week_outcome_count: i32,
    pub previous_week_win_rate: i32,
    pub sample_games_count: i32,
    pub sample_size: i32,
    pub sample_avg_estimated_elo: Option<i64>,
    pub week_avg_estimated_elo: Option<i64>,
    pub previous_week_avg_estimated_elo: Option<i64>,
    pub week_blunder_rate: Option<f64>,
    pub previous_week_blunder_rate: Option<f64>,
    pub blunder_delta_pp: Option<f64>,
    pub week_brilliant_rate: Option<f64>,
    pub previous_week_brilliant_rate: Option<f64>,
    pub brilliant_delta_pp: Option<f64>,
    pub week_mistake_rate: Option<f64>,
    pub previous_week_mistake_rate: Option<f64>,
    pub mistake_delta_pp: Option<f64>,
    pub week_inaccuracy_rate: Option<f64>,
    pub previous_week_inaccuracy_rate: Option<f64>,
    pub inaccuracy_delta_pp: Option<f64>,
    pub week_accuracy: Option<f64>,
    pub previous_week_accuracy: Option<f64>,
    pub accuracy_delta: Option<f64>,
    pub week_acpl: Option<f64>,
    pub previous_week_acpl: Option<f64>,
    pub acpl_delta: Option<f64>,
    pub week_analyzed_games: i32,
    pub previous_week_analyzed_games: i32,
    pub blunder_rate_trend: Vec<Option<f64>>,
    pub week_acpl_by_time_control: DashboardAcplByTimeControl,
    pub week_accuracy_by_color: DashboardAccuracyByColor,
    pub puzzle_variants_color_coverage: DashboardPuzzleVariantsColorCoverage,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AnalyzeAllTarget {
    Local,
    Chesscom,
    Lichess,
    Chessbase,
    All,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeAllCountsRequest {
    pub profile_id: String,
    pub game_history_limit: i32,
    pub event_filter_id: Option<i32>,
    pub selected_opponent_id: Option<i32>,
    pub time_control_category: Option<String>,
    pub player_color: Option<String>,
    pub min_moves: Option<i32>,
    pub profile_usernames: Vec<String>,
    pub target: AnalyzeAllTarget,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeAllCountsBulkRequest {
    pub profile_id: String,
    pub game_history_limit: i32,
    pub event_filter_id: Option<i32>,
    pub selected_opponent_id: Option<i32>,
    pub time_control_category: Option<String>,
    pub player_color: Option<String>,
    pub min_moves: Option<i32>,
    pub profile_usernames: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeAllCountsResponse {
    pub total: i32,
    pub analyzed: i32,
    pub unanalyzed: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeAllCountsBulkResponse {
    pub all: AnalyzeAllCountsResponse,
    pub local: AnalyzeAllCountsResponse,
    pub chesscom: AnalyzeAllCountsResponse,
    pub lichess: AnalyzeAllCountsResponse,
    pub chessbase: AnalyzeAllCountsResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DecodedGameMovesResponse {
    pub initial_fen: String,
    pub moves: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalGameStats {
    accuracy: f64,
    acpl: f64,
    #[serde(alias = "estimated_elo")]
    estimated_elo: Option<i64>,
    resistance: Option<f64>,
    #[serde(alias = "elo_estimated_balanced")]
    elo_estimated_balanced: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct LocalSide {
    #[serde(rename = "type")]
    side_type: String,
    name: Option<String>,
    engine: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalGameRecord {
    id: String,
    #[allow(dead_code)]
    profile_id: Option<String>,
    white: LocalSide,
    black: LocalSide,
    result: String,
    time_control: Option<String>,
    timestamp: i64,
    moves: Vec<String>,
    #[allow(dead_code)]
    variant: Option<String>,
    #[allow(dead_code)]
    fen: String,
    #[allow(dead_code)]
    initial_fen: Option<String>,
    pgn: Option<String>,
    stats: Option<LocalGameStats>,
}

const DASHBOARD_OVERVIEW_DEFAULT_SAMPLE_SIZE: i32 = 100;
const DASHBOARD_OVERVIEW_DEFAULT_TREND_WEEKS: i32 = 4;
const DASHBOARD_OVERVIEW_MAX_LIMIT: i32 = 5000;
const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Default)]
struct WeeklyQualityBucket {
    analyzed_games: i64,
    annotated_moves: i64,
    brilliants: i64,
    blunders: i64,
    mistakes: i64,
    inaccuracies: i64,
    accuracy_sum: f64,
    accuracy_count: i64,
    acpl_sum: f64,
    acpl_count: i64,
}

#[derive(Debug, Clone, Copy, Default)]
struct SumCount {
    sum: f64,
    count: i64,
}

#[derive(Debug, Clone, Copy, Default)]
struct AcplByTimeControlAcc {
    classical: SumCount,
    rapid: SumCount,
    blitz: SumCount,
    bullet: SumCount,
}

#[derive(Debug, Clone, Copy, Default)]
struct AccuracyByColorAcc {
    white: SumCount,
    black: SumCount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PuzzleSide {
    White,
    Black,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct DashboardFileInfoMetadata {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
enum AnnotationClass {
    Brilliant,
    Blunder,
    Mistake,
    Inaccuracy,
    Positive,
}

#[derive(Debug, Clone, Copy, Default)]
struct AnnotationSummary {
    annotated_moves: i64,
    brilliants: i64,
    blunders: i64,
    mistakes: i64,
    inaccuracies: i64,
}

fn strip_account_key(value: &str) -> &str {
    if let Some(rest) = value.strip_prefix("lichess:") {
        return rest;
    }
    if let Some(rest) = value.strip_prefix("chesscom:") {
        return rest;
    }
    value
}

fn usernames_lower_set(usernames: &[String]) -> HashSet<String> {
    let mut set = HashSet::new();
    for u in usernames {
        let raw = u.trim().to_lowercase();
        if !raw.is_empty() {
            set.insert(raw.clone());
        }
        let stripped = strip_account_key(u).trim().to_lowercase();
        if !stripped.is_empty() {
            set.insert(stripped);
        }
    }
    set
}

fn parse_site_tag(moves: &str) -> Option<String> {
    // Fast parse: find `[Site "` then read until `"]`
    let needle = "[Site \"";
    let start = moves.find(needle)? + needle.len();
    let rest = &moves[start..];
    let end = rest.find("\"]")?;
    Some(rest[..end].to_string())
}

fn parse_link_tag(moves: &str) -> Option<String> {
    let needle = "[Link \"";
    let start = moves.find(needle)? + needle.len();
    let rest = &moves[start..];
    let end = rest.find("\"]")?;
    Some(rest[..end].to_string())
}

fn parse_pgn_tag_line(line: &str) -> Option<(&str, String)> {
    let trimmed = line.trim();
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return None;
    }
    let inner = &trimmed[1..trimmed.len() - 1];
    let mut parts = inner.splitn(2, char::is_whitespace);
    let key = parts.next()?.trim();
    let rest = parts.next()?.trim();
    if !rest.starts_with('"') || !rest.ends_with('"') || rest.len() < 2 {
        return None;
    }
    let value = rest[1..rest.len() - 1].to_string();
    Some((key, value))
}

fn normalize_player_name_for_match(name: &str) -> String {
    strip_account_key(name).trim().to_lowercase()
}

fn find_chesscom_link_in_pgn_export(
    pgn_path: &PathBuf,
    target_date: &str,
    target_time: &str,
    target_white: &str,
    target_black: &str,
) -> Option<String> {
    let file = File::open(pgn_path).ok()?;
    let reader = BufReader::new(file);

    let mut headers: HashMap<String, String> = HashMap::new();
    let mut in_movetext = false;

    let target_date = target_date.trim();
    let target_time = target_time.trim();
    let target_white_norm = normalize_player_name_for_match(target_white);
    let target_black_norm = normalize_player_name_for_match(target_black);

    let finalize_game = |headers: &mut HashMap<String, String>, in_movetext: &mut bool| -> Option<String> {
        if headers.is_empty() {
            *in_movetext = false;
            return None;
        }
        let date_ok = headers.get("UTCDate").or_else(|| headers.get("Date")).map(|v| v.trim()) == Some(target_date);
        let time_ok = headers
            .get("UTCTime")
            .or_else(|| headers.get("Time"))
            .or_else(|| headers.get("StartTime"))
            .map(|v| v.trim())
            == Some(target_time);

        let white_norm = headers
            .get("White")
            .map(|v| normalize_player_name_for_match(v))
            .unwrap_or_default();
        let black_norm = headers
            .get("Black")
            .map(|v| normalize_player_name_for_match(v))
            .unwrap_or_default();

        let players_ok = white_norm == target_white_norm && black_norm == target_black_norm;

        let resolved = if date_ok && time_ok && players_ok {
            headers.get("Link").and_then(|v| extract_chesscom_url(v))
        } else {
            None
        };

        headers.clear();
        *in_movetext = false;
        resolved
    };

    for line_res in reader.lines() {
        let line = match line_res {
            Ok(v) => v,
            Err(_) => continue,
        };
        let trimmed = line.trim();

        if trimmed.is_empty() {
            if *&in_movetext {
                if let Some(link) = finalize_game(&mut headers, &mut in_movetext) {
                    return Some(link);
                }
            }
            continue;
        }

        if let Some((key, value)) = parse_pgn_tag_line(trimmed) {
            headers.insert(key.to_string(), value);
            continue;
        }

        if !headers.is_empty() {
            in_movetext = true;
        }
    }

    finalize_game(&mut headers, &mut in_movetext)
}

fn extract_lichess_id_from_site(site: &str) -> Option<String> {
    if !site.contains("lichess.org") {
        return None;
    }
    // lichess.org/{id} or lichess.org/game/{id}
    let idx = site.find("lichess.org")?;
    let after = &site[idx + "lichess.org".len()..];
    let after = after.trim_start_matches('/');
    let after = after.strip_prefix("game/").unwrap_or(after);
    let id = after
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect::<String>();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

fn extract_chesscom_url(site: &str) -> Option<String> {
    let s = site.trim();
    if s.is_empty() {
        return None;
    }

    if s.contains("chess.com") && (s.starts_with("http://") || s.starts_with("https://")) {
        return Some(s.to_string());
    }

    let lower = s.to_lowercase();
    let needle = "chess.com/";
    let idx = lower.find(needle)?;
    let start = if idx >= 8 && &lower[idx - 8..idx] == "https://" {
        idx - 8
    } else if idx >= 7 && &lower[idx - 7..idx] == "http://" {
        idx - 7
    } else if idx >= 4 && &lower[idx - 4..idx] == "www." {
        idx - 4
    } else {
        idx
    };
    let tail = &s[start..];
    let end = tail
        .find(|c: char| c.is_whitespace() || c == '"' || c == ']' || c == '>' || c == '<')
        .unwrap_or(tail.len());
    let candidate = tail[..end].trim();
    if candidate.is_empty() {
        return None;
    }
    if candidate.starts_with("http://") || candidate.starts_with("https://") {
        Some(candidate.to_string())
    } else {
        Some(format!("https://{}", candidate))
    }
}

fn parse_profile_db_path(app: &AppHandle, profile_id: &str) -> Result<PathBuf> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::PackageManager(format!("Failed to resolve AppData dir: {}", e)))?;
    Ok(app_data
        .join("db")
        .join(format!("profile_{}.db3", profile_id)))
}

fn parse_timestamp_ms(date: Option<&str>, time: Option<&str>) -> i64 {
    let date_str = date.unwrap_or("").trim();
    if date_str.is_empty() {
        return Utc::now().timestamp_millis();
    }

    // Accept "YYYY.MM.DD" and "YYYY-MM-DD"
    let date = NaiveDate::parse_from_str(date_str, "%Y.%m.%d")
        .or_else(|_| NaiveDate::parse_from_str(date_str, "%Y-%m-%d"));
    let Ok(date) = date else {
        return Utc::now().timestamp_millis();
    };

    let t = time.unwrap_or("").trim();
    let nt = if t.is_empty() {
        NaiveTime::from_hms_opt(0, 0, 0).unwrap()
    } else {
        NaiveTime::parse_from_str(t, "%H:%M:%S")
            .or_else(|_| NaiveTime::parse_from_str(t, "%H:%M"))
            .unwrap_or_else(|_| NaiveTime::from_hms_opt(0, 0, 0).unwrap())
    };

    let dt = NaiveDateTime::new(date, nt);
    Utc.from_utc_datetime(&dt).timestamp_millis()
}

fn has_analysis_markers(pgn: &str) -> bool {
    // Treat as "analyzed" only when PGN contains explicit engine evaluations.
    // Clock tags (`[%clk ...]`) and annotation glyphs can appear in non-analyzed imports
    // (e.g. raw Lichess/Chess.com PGNs) and must not mark a game as analyzed.
    let lower = pgn.to_lowercase();
    lower.contains("[%eval")
}

fn has_any_pgn_tag(text: &str) -> bool {
    for chunk in text.split('[').skip(1).take(32) {
        let Some(end_idx) = chunk.find(']') else {
            continue;
        };
        let body = chunk[..end_idx].trim();
        if body.is_empty() || !body.contains('"') {
            continue;
        }
        let tag = body.split_whitespace().next().unwrap_or("");
        if tag.is_empty() {
            continue;
        }
        if tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return true;
        }
    }
    false
}

fn format_pgn_movetext_from_san(san_moves: &[String], black_to_move: bool) -> String {
    if san_moves.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    let mut idx = 0usize;
    let mut move_no = 1usize;
    if black_to_move {
        out.push_str(&format!("{}... {}", move_no, san_moves[0]));
        idx = 1;
        move_no += 1;
    }
    while idx < san_moves.len() {
        let white = &san_moves[idx];
        idx += 1;
        let black = if idx < san_moves.len() {
            let b = Some(&san_moves[idx]);
            idx += 1;
            b
        } else {
            None
        };
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&format!("{}.", move_no));
        out.push(' ');
        out.push_str(white);
        if let Some(b) = black {
            out.push(' ');
            out.push_str(b);
        }
        move_no += 1;
    }
    out
}

fn decode_san_movetext_from_blob(
    conn: &Connection,
    game_id: i32,
    initial_fen: Option<&str>,
) -> Option<String> {
    let moves_blob: Vec<u8> = conn
        .query_row("SELECT Moves FROM Games WHERE ID = ?1 LIMIT 1", [game_id], |row| row.get(0))
        .ok()?;

    let start_pos = initial_fen
        .and_then(|f| Fen::from_ascii(f.trim().as_bytes()).ok())
        .and_then(|f| f.into_position(CastlingMode::Chess960).ok());
    let mut pos: Chess = start_pos.clone().unwrap_or_default();
    let decoded = extract_main_line_moves(&moves_blob, start_pos).ok()?;
    if decoded.is_empty() {
        return None;
    }

    let mut sans: Vec<String> = Vec::with_capacity(decoded.len());
    for mv in decoded {
        let san = SanPlus::from_move_and_play_unchecked(&mut pos, &mv).to_string();
        sans.push(san);
    }

    let black_to_move = initial_fen
        .map(|f| f.split_whitespace().nth(1).unwrap_or("w") == "b")
        .unwrap_or(false);
    let movetext = format_pgn_movetext_from_san(&sans, black_to_move);
    if movetext.trim().is_empty() {
        None
    } else {
        Some(movetext)
    }
}

fn decode_uci_moves_from_blob(
    moves_blob: &[u8],
    initial_fen: Option<&str>,
) -> Option<(String, Vec<String>)> {
    let trimmed_fen = initial_fen
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
        .to_string();

    let mut start_positions: Vec<Option<Chess>> = Vec::new();
    if let Ok(fen_obj) = Fen::from_ascii(trimmed_fen.as_bytes()) {
        if let Ok(pos_std) = fen_obj.clone().into_position(CastlingMode::Standard) {
            start_positions.push(Some(pos_std));
        }
        if let Ok(pos_960) = fen_obj.into_position(CastlingMode::Chess960) {
            start_positions.push(Some(pos_960));
        }
    }
    start_positions.push(None);

    for start in start_positions {
        let decoded = match extract_main_line_moves(moves_blob, start.clone()) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if decoded.is_empty() {
            continue;
        }
        let moves = decoded
            .into_iter()
            .map(|m| m.to_uci(CastlingMode::Standard).to_string())
            .collect::<Vec<_>>();
        if !moves.is_empty() {
            return Some((trimmed_fen.clone(), moves));
        }
    }

    None
}

fn time_control_category(site: GamesHistoryKind, time_control: &str) -> Option<String> {
    let trimmed = time_control.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_lowercase();
    if lower.contains("ultra") {
        return Some("ultra_bullet".to_string());
    }
    if lower.contains("bullet") {
        return Some("bullet".to_string());
    }
    if lower.contains("blitz") {
        return Some("blitz".to_string());
    }
    if lower.contains("rapid") {
        return Some("rapid".to_string());
    }
    if lower.contains("classical") {
        return Some("classical".to_string());
    }
    if lower.contains("correspondence") {
        return Some("correspondence".to_string());
    }

    match site {
        GamesHistoryKind::Chesscom => {
            if lower.starts_with("1/") {
                return Some("daily".to_string());
            }
        }
        GamesHistoryKind::Lichess => {
            if trimmed == "-" {
                return Some("correspondence".to_string());
            }
        }
        GamesHistoryKind::Local | GamesHistoryKind::Chessbase => {}
    }

    // Parse "initial+increment" or seconds.
    if let Some((a, b)) = trimmed.split_once('+') {
        if let (Ok(init), Ok(inc)) = (a.trim().parse::<i64>(), b.trim().parse::<i64>()) {
            let total = init + inc * 40;
            return Some(seconds_to_category(total));
        }
    }
    if let Ok(sec) = trimmed.parse::<i64>() {
        return Some(seconds_to_category(sec));
    }
    None
}

fn seconds_to_category(total_seconds: i64) -> String {
    if total_seconds < 30 {
        "ultra_bullet".to_string()
    } else if total_seconds < 180 {
        "bullet".to_string()
    } else if total_seconds < 480 {
        "blitz".to_string()
    } else if total_seconds < 1500 {
        "rapid".to_string()
    } else {
        "classical".to_string()
    }
}

fn outcome_from_result(user_color: &str, result: &str) -> String {
    let r = result.trim().to_lowercase();
    if r.is_empty() {
        return "unknown".to_string();
    }
    if r == "draw" || r == "1/2-1/2" || r == "½-½" || r == "0.5-0.5" {
        return "draw".to_string();
    }
    if r == "1-0" {
        return if user_color == "white" { "win" } else { "loss" }.to_string();
    }
    if r == "0-1" {
        return if user_color == "black" { "win" } else { "loss" }.to_string();
    }
    if r == "win" {
        return "win".to_string();
    }
    if r == "loss" || r == "lose" {
        return "loss".to_string();
    }
    "unknown".to_string()
}

fn to_one_decimal(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn to_rate_percent(value: i64, total: i64) -> Option<f64> {
    if total <= 0 || value < 0 {
        return None;
    }
    Some(to_one_decimal((value as f64 / total as f64) * 100.0))
}

fn to_average(sum: f64, count: i64) -> Option<f64> {
    if count <= 0 {
        return None;
    }
    Some(to_one_decimal(sum / count as f64))
}

fn to_average_sum_count(value: SumCount) -> Option<f64> {
    to_average(value.sum, value.count)
}

fn acpl_by_time_control_from_acc(acc: AcplByTimeControlAcc) -> DashboardAcplByTimeControl {
    DashboardAcplByTimeControl {
        classical: to_average_sum_count(acc.classical),
        rapid: to_average_sum_count(acc.rapid),
        blitz: to_average_sum_count(acc.blitz),
        bullet: to_average_sum_count(acc.bullet),
    }
}

fn accuracy_by_color_from_acc(acc: AccuracyByColorAcc) -> DashboardAccuracyByColor {
    DashboardAccuracyByColor {
        white: to_average_sum_count(acc.white),
        black: to_average_sum_count(acc.black),
    }
}

fn parse_puzzle_side_from_tags(tags: &[String]) -> Option<PuzzleSide> {
    for raw in tags {
        let tag = raw.to_ascii_lowercase();
        for prefix in ["orientation:", "side:", "color:"] {
            if !tag.starts_with(prefix) {
                continue;
            }
            let value = tag[prefix.len()..].trim();
            if value == "white" {
                return Some(PuzzleSide::White);
            }
            if value == "black" {
                return Some(PuzzleSide::Black);
            }
        }
    }
    None
}

fn parse_puzzle_side_from_pgn_headers(raw_pgn: &str) -> Option<PuzzleSide> {
    let mut white_name: Option<String> = None;
    let mut black_name: Option<String> = None;
    for line in raw_pgn.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        let Some((key, value)) = parse_pgn_tag_line(trimmed) else {
            continue;
        };
        if key.eq_ignore_ascii_case("Orientation") {
            let side = value.trim().to_ascii_lowercase();
            if side == "white" {
                return Some(PuzzleSide::White);
            }
            if side == "black" {
                return Some(PuzzleSide::Black);
            }
        }
        if key.eq_ignore_ascii_case("White") {
            white_name = Some(value);
        } else if key.eq_ignore_ascii_case("Black") {
            black_name = Some(value);
        }
    }

    if let Some(white) = white_name {
        if white.trim().eq_ignore_ascii_case("Puzzle") {
            return Some(PuzzleSide::White);
        }
    }
    if let Some(black) = black_name {
        if black.trim().eq_ignore_ascii_case("Puzzle") {
            return Some(PuzzleSide::Black);
        }
    }
    None
}

fn count_puzzles_in_pgn(raw_pgn: &str) -> i64 {
    let count = raw_pgn.match_indices("[Event ").count() as i64;
    if count > 0 {
        count
    } else if raw_pgn.trim().is_empty() {
        0
    } else {
        1
    }
}

fn collect_puzzle_variant_files(root: &Path, out: &mut Vec<(PathBuf, DashboardFileInfoMetadata)>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_puzzle_variant_files(&path, out);
            continue;
        }
        if path.extension().and_then(|v| v.to_str()) != Some("info") {
            continue;
        }
        let Ok(info_raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(info) = serde_json::from_str::<DashboardFileInfoMetadata>(&info_raw) else {
            continue;
        };
        if !info.r#type.eq_ignore_ascii_case("puzzle") {
            continue;
        }
        if !info
            .tags
            .iter()
            .any(|tag| tag.trim().eq_ignore_ascii_case("puzzle-variants"))
        {
            continue;
        }
        out.push((path.with_extension("pgn"), info));
    }
}

fn load_puzzle_variants_color_coverage(app: &AppHandle) -> DashboardPuzzleVariantsColorCoverage {
    let documents_dir = match app.path().app_data_dir() {
        Ok(path) => path.join("documents"),
        Err(_) => {
            return DashboardPuzzleVariantsColorCoverage {
                white_puzzles: 0,
                black_puzzles: 0,
                total_puzzles: 0,
                white_percent: 0,
                black_percent: 0,
            };
        }
    };
    if !documents_dir.exists() {
        return DashboardPuzzleVariantsColorCoverage {
            white_puzzles: 0,
            black_puzzles: 0,
            total_puzzles: 0,
            white_percent: 0,
            black_percent: 0,
        };
    }

    let mut files: Vec<(PathBuf, DashboardFileInfoMetadata)> = Vec::new();
    collect_puzzle_variant_files(&documents_dir, &mut files);

    let mut white_puzzles = 0i64;
    let mut black_puzzles = 0i64;
    for (pgn_path, metadata) in files {
        let Ok(raw_pgn) = fs::read_to_string(&pgn_path) else {
            continue;
        };
        let side = parse_puzzle_side_from_tags(&metadata.tags).or_else(|| parse_puzzle_side_from_pgn_headers(&raw_pgn));
        let puzzle_count = count_puzzles_in_pgn(&raw_pgn);
        if puzzle_count <= 0 {
            continue;
        }
        match side {
            Some(PuzzleSide::White) => white_puzzles += puzzle_count,
            Some(PuzzleSide::Black) => black_puzzles += puzzle_count,
            None => {}
        }
    }

    let total_puzzles = white_puzzles + black_puzzles;
    let (white_percent, black_percent) = if total_puzzles > 0 {
        (
            ((white_puzzles as f64 / total_puzzles as f64) * 100.0).round() as i32,
            ((black_puzzles as f64 / total_puzzles as f64) * 100.0).round() as i32,
        )
    } else {
        (0, 0)
    };

    DashboardPuzzleVariantsColorCoverage {
        white_puzzles: i64_to_i32_saturating(white_puzzles),
        black_puzzles: i64_to_i32_saturating(black_puzzles),
        total_puzzles: i64_to_i32_saturating(total_puzzles),
        white_percent,
        black_percent,
    }
}

fn to_delta(current: Option<f64>, previous: Option<f64>) -> Option<f64> {
    match (current, previous) {
        (Some(current), Some(previous)) => Some(to_one_decimal(current - previous)),
        _ => None,
    }
}

fn i64_to_i32_saturating(value: i64) -> i32 {
    if value > i32::MAX as i64 {
        i32::MAX
    } else if value < i32::MIN as i64 {
        i32::MIN
    } else {
        value as i32
    }
}

fn average_elo(values: &[i64]) -> Option<i64> {
    if values.is_empty() {
        return None;
    }
    let sum: i64 = values.iter().copied().sum();
    Some(((sum as f64) / (values.len() as f64)).round() as i64)
}

fn round_local_midnight_to_ms(local_dt: DateTime<Local>) -> i64 {
    let midnight = local_dt
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap_or_else(|| local_dt.naive_local());
    match Local.from_local_datetime(&midnight) {
        LocalResult::Single(value) => value.timestamp_millis(),
        LocalResult::Ambiguous(first, second) => {
            if first <= second {
                first.timestamp_millis()
            } else {
                second.timestamp_millis()
            }
        }
        LocalResult::None => Utc.from_utc_datetime(&midnight).timestamp_millis(),
    }
}

fn get_start_of_week_sunday_ms(reference_ms: i64) -> i64 {
    let utc_dt = match Utc.timestamp_millis_opt(reference_ms).single() {
        Some(value) => value,
        None => Utc::now(),
    };
    let local_dt = utc_dt.with_timezone(&Local);
    let weekday_offset = local_dt.weekday().num_days_from_sunday() as i64;
    let week_start_local = local_dt - Duration::days(weekday_offset);
    round_local_midnight_to_ms(week_start_local)
}

fn strip_move_number_prefix(token: &str) -> &str {
    let bytes = token.as_bytes();
    let mut idx = 0usize;
    while idx < bytes.len() && bytes[idx].is_ascii_digit() {
        idx += 1;
    }
    if idx == 0 {
        return token;
    }
    let mut dot_idx = idx;
    while dot_idx < bytes.len() && bytes[dot_idx] == b'.' {
        dot_idx += 1;
    }
    if dot_idx > idx {
        &token[dot_idx..]
    } else {
        token
    }
}

fn is_result_token(token: &str) -> bool {
    let normalized = token.trim();
    if normalized.is_empty() {
        return false;
    }
    matches!(
        normalized,
        "1-0" | "0-1" | "1/2-1/2" | "0.5-0.5" | "½-½" | "*"
    )
}

fn extract_fen_tag_from_pgn(pgn: &str) -> Option<String> {
    for line in pgn.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        let Some((key, value)) = parse_pgn_tag_line(trimmed) else {
            continue;
        };
        if key.eq_ignore_ascii_case("FEN") {
            let v = value.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn get_white_to_move_from_fen(initial_fen: Option<&str>, pgn: &str) -> bool {
    let fen_candidate = initial_fen
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .or_else(|| extract_fen_tag_from_pgn(pgn));

    let Some(fen) = fen_candidate else {
        return true;
    };
    let side = fen.split_whitespace().nth(1).unwrap_or("w");
    side.eq_ignore_ascii_case("w")
}

fn strip_pgn_to_movetext(pgn: &str) -> String {
    let mut without_tags = String::with_capacity(pgn.len());
    for line in pgn.lines() {
        if line.trim_start().starts_with('[') {
            continue;
        }
        without_tags.push_str(line);
        without_tags.push('\n');
    }

    let mut out = String::with_capacity(without_tags.len());
    let mut in_line_comment = false;
    let mut brace_depth = 0usize;
    let mut paren_depth = 0usize;

    for ch in without_tags.chars() {
        if in_line_comment {
            if ch == '\n' {
                in_line_comment = false;
                out.push(' ');
            }
            continue;
        }

        if brace_depth > 0 {
            if ch == '{' {
                brace_depth += 1;
            } else if ch == '}' {
                brace_depth = brace_depth.saturating_sub(1);
                if brace_depth == 0 {
                    out.push(' ');
                }
            }
            continue;
        }

        if paren_depth > 0 {
            if ch == '(' {
                paren_depth += 1;
            } else if ch == ')' {
                paren_depth = paren_depth.saturating_sub(1);
                if paren_depth == 0 {
                    out.push(' ');
                }
            }
            continue;
        }

        match ch {
            ';' => in_line_comment = true,
            '{' => brace_depth = 1,
            '(' => paren_depth = 1,
            '\r' | '\n' | '\t' => out.push(' '),
            _ => out.push(ch),
        }
    }

    out
}

fn classify_annotation(token: &str) -> Option<AnnotationClass> {
    if token.is_empty() {
        return None;
    }

    let mut start_idx = token.len();
    for (idx, ch) in token.char_indices().rev() {
        if matches!(ch, '!' | '?' | '+' | '#') {
            start_idx = idx;
            continue;
        }
        break;
    }
    if start_idx >= token.len() {
        return None;
    }

    let marks: String = token[start_idx..]
        .chars()
        .filter(|ch| *ch == '!' || *ch == '?')
        .collect();
    if marks.is_empty() {
        return None;
    }

    if marks.ends_with("??") {
        return Some(AnnotationClass::Blunder);
    }
    if marks.ends_with("?!") {
        return Some(AnnotationClass::Inaccuracy);
    }
    if marks.ends_with("!!") {
        return Some(AnnotationClass::Brilliant);
    }
    if marks.ends_with("!?") {
        return Some(AnnotationClass::Positive);
    }
    if marks.ends_with('?') {
        return Some(AnnotationClass::Mistake);
    }
    if marks.ends_with('!') {
        return Some(AnnotationClass::Positive);
    }
    None
}

fn collect_player_annotation_summary(
    pgn: &str,
    initial_fen: Option<&str>,
    player_color: &str,
) -> AnnotationSummary {
    let player_is_white = match player_color {
        "white" => true,
        "black" => false,
        _ => return AnnotationSummary::default(),
    };
    let mut white_to_move = get_white_to_move_from_fen(initial_fen, pgn);
    let movetext = strip_pgn_to_movetext(pgn);
    let mut summary = AnnotationSummary::default();

    for raw in movetext.split_whitespace() {
        let mut token = strip_move_number_prefix(raw).trim();
        if token.is_empty() {
            continue;
        }

        token = token.trim_start_matches('.');
        token = strip_move_number_prefix(token).trim();
        if token.is_empty() {
            continue;
        }

        let sanitized = token.trim_matches(|ch: char| matches!(ch, '"' | '\'' | ',' | ';'));
        if sanitized.is_empty() {
            continue;
        }

        if is_result_token(sanitized) {
            break;
        }
        if sanitized.chars().all(|ch| ch == '.') {
            continue;
        }
        if sanitized.starts_with('$') && sanitized[1..].chars().all(|ch| ch.is_ascii_digit()) {
            continue;
        }

        if white_to_move == player_is_white {
            if let Some(annotation) = classify_annotation(sanitized) {
                summary.annotated_moves += 1;
                match annotation {
                    AnnotationClass::Brilliant => summary.brilliants += 1,
                    AnnotationClass::Blunder => summary.blunders += 1,
                    AnnotationClass::Mistake => summary.mistakes += 1,
                    AnnotationClass::Inaccuracy => summary.inaccuracies += 1,
                    AnnotationClass::Positive => {}
                }
            }
        }

        white_to_move = !white_to_move;
    }

    summary
}

fn extract_row_estimated_elo(row: &GamesHistoryRow) -> Option<i64> {
    if let Some(value) = row.elo_estimated_balanced {
        if value > 0 {
            return Some(value);
        }
    }
    if let Some(value) = row.estimated_elo {
        if value > 0 {
            return Some(value);
        }
    }
    None
}

fn empty_dashboard_overview(now_ms: i64, sample_size: i32, trend_weeks: usize) -> DashboardOverviewResponse {
    let week_start_ms = get_start_of_week_sunday_ms(now_ms);
    DashboardOverviewResponse {
        week_start_ms,
        week_end_ms: now_ms,
        week_games_count: 0,
        week_wins: 0,
        week_losses: 0,
        week_draws: 0,
        week_outcome_count: 0,
        week_win_rate: 0,
        previous_week_games_count: 0,
        previous_week_wins: 0,
        previous_week_losses: 0,
        previous_week_draws: 0,
        previous_week_outcome_count: 0,
        previous_week_win_rate: 0,
        sample_games_count: 0,
        sample_size,
        sample_avg_estimated_elo: None,
        week_avg_estimated_elo: None,
        previous_week_avg_estimated_elo: None,
        week_blunder_rate: None,
        previous_week_blunder_rate: None,
        blunder_delta_pp: None,
        week_brilliant_rate: None,
        previous_week_brilliant_rate: None,
        brilliant_delta_pp: None,
        week_mistake_rate: None,
        previous_week_mistake_rate: None,
        mistake_delta_pp: None,
        week_inaccuracy_rate: None,
        previous_week_inaccuracy_rate: None,
        inaccuracy_delta_pp: None,
        week_accuracy: None,
        previous_week_accuracy: None,
        accuracy_delta: None,
        week_acpl: None,
        previous_week_acpl: None,
        acpl_delta: None,
        week_analyzed_games: 0,
        previous_week_analyzed_games: 0,
        blunder_rate_trend: vec![None; trend_weeks],
        week_acpl_by_time_control: DashboardAcplByTimeControl {
            classical: None,
            rapid: None,
            blitz: None,
            bullet: None,
        },
        week_accuracy_by_color: DashboardAccuracyByColor {
            white: None,
            black: None,
        },
        puzzle_variants_color_coverage: DashboardPuzzleVariantsColorCoverage {
            white_puzzles: 0,
            black_puzzles: 0,
            total_puzzles: 0,
            white_percent: 0,
            black_percent: 0,
        },
    }
}

/// Local games were previously stored in played_games.json; that file is deprecated.
/// Games are now stored in the profile DB. This returns an empty list so callers
/// only see profile DB and online games.
fn load_local_games(_app: &AppHandle, _profile_id: &str, _limit: usize) -> Result<Vec<LocalGameRecord>> {
    Ok(vec![])
}

fn normalize_https_url(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if s.starts_with("http://") || s.starts_with("https://") {
        return Some(s.to_string());
    }
    // Handle values like "lichess.org/..." stored in Sites.Name.
    if s.starts_with("lichess.org/") || s.starts_with("www.chess.com/") || s.starts_with("chess.com/") {
        return Some(format!("https://{}", s));
    }
    None
}

fn build_minimal_pgn_from_db_game(
    white: &str,
    black: &str,
    event: &str,
    site: &str,
    date: Option<&str>,
    time: Option<&str>,
    time_control: Option<&str>,
    fen: Option<&str>,
    result: &str,
    moves: &str,
) -> String {
    let mut out = String::new();
    out.push_str(&format!("[Event \"{}\"]\n", event));
    out.push_str(&format!("[Site \"{}\"]\n", site));
    out.push_str(&format!("[Date \"{}\"]\n", date.unwrap_or("????.??.??")));
    if let Some(t) = time {
        if !t.trim().is_empty() {
            out.push_str(&format!("[UTCTime \"{}\"]\n", t.trim()));
        }
    }
    if let Some(tc) = time_control {
        let tc = tc.trim();
        if !tc.is_empty() {
            out.push_str(&format!("[TimeControl \"{}\"]\n", tc));
        }
    }
    if let Some(fen) = fen {
        let fen = fen.trim();
        if !fen.is_empty() {
            out.push_str("[SetUp \"1\"]\n");
            out.push_str(&format!("[FEN \"{}\"]\n", fen));
        }
    }
    out.push_str(&format!("[White \"{}\"]\n", white));
    out.push_str(&format!("[Black \"{}\"]\n", black));
    out.push_str(&format!("[Result \"{}\"]\n", result));
    out.push('\n');
    out.push_str(moves.trim());
    if !out.ends_with(' ') && !out.ends_with('\n') {
        out.push(' ');
    } else if out.ends_with('\n') {
        // ok
    }
    if !out.ends_with(result) {
        out.push_str(result);
    }
    out
}

fn load_profile_player_id(conn: &Connection) -> Option<i32> {
    let value: Option<String> = conn
        .query_row(
            "SELECT Value FROM Info WHERE Name = 'ProfilePlayerId' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    value.and_then(|v| v.trim().parse::<i32>().ok()).filter(|v| *v > 0)
}

fn infer_profile_player_id(conn: &Connection) -> Option<i32> {
    // Infer the "main" player from the imported games when a profile DB is missing
    // ProfilePlayerId (older DBs or created without a known player). We pick the
    // player that appears the most across WhiteId/BlackId.
    conn.query_row(
        r#"
        SELECT player_id
        FROM (
            SELECT WhiteId AS player_id, COUNT(*) AS c FROM Games GROUP BY WhiteId
            UNION ALL
            SELECT BlackId AS player_id, COUNT(*) AS c FROM Games GROUP BY BlackId
        )
        GROUP BY player_id
        ORDER BY SUM(c) DESC
        LIMIT 1
        "#,
        [],
        |row| row.get::<_, i32>(0),
    )
    .optional()
    .ok()
    .flatten()
    .filter(|v| *v > 0)
}

fn ensure_profile_player_id(conn: &Connection) -> Option<i32> {
    if let Some(pid) = load_profile_player_id(conn) {
        return Some(pid);
    }

    let pid = infer_profile_player_id(conn)?;

    // Best-effort persistence so future calls don't need to infer again.
    let _ = conn.execute(
        "INSERT INTO Info (Name, Value) VALUES ('ProfilePlayerId', ?) ON CONFLICT(Name) DO UPDATE SET Value=excluded.Value",
        [pid.to_string()],
    );

    let name: Option<String> = conn
        .query_row(
            "SELECT Name FROM Players WHERE Id = ? LIMIT 1",
            [pid],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();

    if let Some(name) = name {
        let name = name.trim().to_string();
        if !name.is_empty() {
            let _ = conn.execute(
                "INSERT INTO Info (Name, Value) VALUES ('ProfilePlayerName', ?) ON CONFLICT(Name) DO UPDATE SET Value=excluded.Value",
                [name],
            );
        }
    }

    Some(pid)
}

fn find_profile_player_ids_by_usernames(conn: &Connection, usernames_lower: &HashSet<String>) -> Vec<i32> {
    if usernames_lower.is_empty() {
        return Vec::new();
    }

    let mut stmt = match conn.prepare("SELECT Id, Name FROM Players") {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt
        .query_map([], |row| {
            Ok((row.get::<_, i32>(0)?, row.get::<_, Option<String>>(1)?))
        })
    {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };

    let mut candidates: Vec<i32> = Vec::new();
    let mut seen: HashSet<i32> = HashSet::new();
    for row in rows {
        let Ok((pid, name_opt)) = row else {
            continue;
        };
        let Some(name_raw) = name_opt else {
            continue;
        };
        let name = name_raw.trim();
        if name.is_empty() {
            continue;
        }

        let lower = name.to_lowercase();
        let stripped = strip_account_key(name).trim().to_lowercase();
        if (usernames_lower.contains(&lower) || usernames_lower.contains(&stripped)) && seen.insert(pid) {
            candidates.push(pid);
        }
    }

    if candidates.is_empty() {
        return Vec::new();
    }
    if candidates.len() == 1 {
        return candidates;
    }

    // Keep a stable order: more active account ids first.
    let mut scored: Vec<(i32, i64)> = Vec::with_capacity(candidates.len());
    for pid in candidates.into_iter() {
        let games_count = conn
            .query_row(
                "SELECT COUNT(*) FROM Games WHERE WhiteId = ?1 OR BlackId = ?1",
                [pid],
                |row| row.get(0),
            )
            .unwrap_or(0);
        scored.push((pid, games_count));
    }
    scored.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    scored.into_iter().map(|(pid, _)| pid).collect()
}

#[tauri::command]
#[specta::specta]
pub async fn dashboard_get_games_history_rows(
    app: AppHandle,
    state: State<'_, AppState>,
    req: GamesHistoryRequest,
) -> Result<GamesHistoryResponse> {
    let include_base_pgn = req.include_base_pgn.unwrap_or(true);
    let include_analyzed_pgn = req.include_analyzed_pgn.unwrap_or(true);
    let include_analysis_stats = req.include_analysis_stats.unwrap_or(true);
    let profile_id = req.profile_id.trim().to_string();
    if profile_id.is_empty() {
        return Ok(GamesHistoryResponse {
            rows: vec![],
            total_count: 0,
        });
    }

    let usernames_lower = usernames_lower_set(&req.profile_usernames);

    let base_limit = req.game_history_limit.max(0);
    let has_opponent_text_filter = req
        .opponent_contains
        .as_ref()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    // When filtering by opponent, widen the source scan window so matches are not
    // lost just because they are older than the visible dashboard limit.
    // Keep an upper bound to avoid expensive full-history scans on every keystroke.
    let source_limit = if base_limit <= 0 {
        0
    } else if req.selected_opponent_id.is_some() || has_opponent_text_filter {
        base_limit.max(1000).min(5000)
    } else {
        base_limit
    };

    // 1) Load local games.
    let local_limit = source_limit as usize;
    let local_games = load_local_games(&app, &profile_id, local_limit)?;

    // 2) Load online games (single query; later we split by platform).
    let db_path = parse_profile_db_path(&app, &profile_id)?;
    let profile_player_ids: HashSet<i32> = match Connection::open(&db_path) {
        Ok(conn) => {
            let from_usernames = find_profile_player_ids_by_usernames(&conn, &usernames_lower);
            let resolved = if !usernames_lower.is_empty() {
                // If profile usernames are known, never fallback to inferred ProfilePlayerId.
                // A stale/inaccurate inferred id can include games from a different player and inflate counts.
                from_usernames
            } else if from_usernames.is_empty() {
                ensure_profile_player_id(&conn).map(|pid| vec![pid]).unwrap_or_default()
            } else {
                from_usernames
            };
            resolved.into_iter().collect()
        }
        Err(_) => HashSet::new(),
    };
    let profile_player_id_single = if profile_player_ids.len() == 1 {
        profile_player_ids.iter().copied().next()
    } else {
        None
    };

    let mut q = GameQueryJs::default();
    q.options = Some(QueryOptions {
        skip_count: true,
        page: Some(1),
        page_size: Some(source_limit as i32),
        sort: GameSort::Date,
        direction: SortDirection::Desc,
    });
    q.tournament_id = req.event_filter_id;
    q.time_control_category = req.time_control_category.clone();

    if let Some(profile_pid) = profile_player_id_single {
        q.player1 = Some(profile_pid);
        q.sides = Some(Sides::Any);
        if let Some(opponent_pid) = req.selected_opponent_id {
            q.player2 = Some(opponent_pid);
        }
    } else if let Some(opponent_pid) = req.selected_opponent_id {
        q.player1 = Some(opponent_pid);
        q.sides = Some(Sides::Any);
    }

    let online = get_games(db_path, q, state).await?.data;
    let profile_db_conn = Connection::open(parse_profile_db_path(&app, &profile_id)?).ok();

    // 3) Build raw rows (without analysis enrichment).
    let mut rows: Vec<GamesHistoryRow> = Vec::new();

    for g in local_games {
        let is_user_white = g.white.side_type == "human";
        let user_color = if is_user_white { "white" } else { "black" };
        let opponent_side = if is_user_white { &g.black } else { &g.white };
        let opponent = opponent_side
            .name
            .clone()
            .or_else(|| opponent_side.engine.clone().map(|e| format!("Engine ({})", e)))
            .unwrap_or_else(|| "?".to_string());

        let outcome = outcome_from_result(user_color, &g.result);
        let stats = g.stats;
        let tc = g.time_control.clone().unwrap_or_default();
        let tc_cat = if tc.trim().is_empty() {
            None
        } else {
            time_control_category(GamesHistoryKind::Local, &tc)
        };

        rows.push(GamesHistoryRow {
            kind: GamesHistoryKind::Local,
            analysis_game_id: g.id.clone(),
            game_key: g.id,
            external_url: None,
            opponent,
            color: user_color.to_string(),
            outcome,
            pgn: g.pgn,
            initial_fen: g.initial_fen,
            accuracy: stats.as_ref().map(|s| s.accuracy),
            acpl: stats.as_ref().map(|s| s.acpl),
            estimated_elo: stats.as_ref().and_then(|s| s.estimated_elo),
            resistance: stats.as_ref().and_then(|s| s.resistance),
            elo_estimated_balanced: stats.as_ref().and_then(|s| s.elo_estimated_balanced),
            moves: g.moves.len().saturating_div(2).max(1) as i32,
            time_control: if tc.trim().is_empty() { None } else { Some(tc) },
            time_control_category: tc_cat,
            timestamp_ms: g.timestamp,
            event_id: None,
            event_name: None,
            is_analyzed: false,
        });
    }

    for g in online {
            // Identify platform and extract external key.
            let site_tag = parse_site_tag(&g.moves);
            let link_tag = parse_link_tag(&g.moves);
            let mut kind: Option<GamesHistoryKind> = None;
            let mut external_key = g.id.to_string();
            let mut external_url: Option<String> = None;
            let chesscom_url_from_link = link_tag.as_deref().and_then(extract_chesscom_url);

            if let Some(site) = site_tag.as_deref() {
                let site_lower = site.to_lowercase();
                if site_lower.trim() == "local" {
                    kind = Some(GamesHistoryKind::Local);
                    external_key = g.id.to_string();
                    external_url = None;
                } else if site_lower.contains("lichess.org/broadcast/") {
                    kind = Some(GamesHistoryKind::Lichess);
                    // Not a Lichess *game* URL; keep internal key and use the broadcast URL for "open".
                    external_key = g.id.to_string();
                    external_url = normalize_https_url(site);
                } else if let Some(id) = extract_lichess_id_from_site(site) {
                    kind = Some(GamesHistoryKind::Lichess);
                    external_key = id.clone();
                    external_url = Some(format!("https://lichess.org/{}", id));
                } else if let Some(url) = extract_chesscom_url(site).or_else(|| chesscom_url_from_link.clone()) {
                    kind = Some(GamesHistoryKind::Chesscom);
                    external_key = url.clone();
                    external_url = Some(url);
                } else if site_lower.contains("chess.com") {
                    // Keep as Chess.com but do not fabricate URLs from internal DB ids.
                    kind = Some(GamesHistoryKind::Chesscom);
                    external_key = g.id.to_string();
                    external_url = None;
                } else if site_lower.contains("chessbase.com") {
                    kind = Some(GamesHistoryKind::Chessbase);
                    external_key = g.id.to_string();
                    external_url = None;
                }
            }

            if kind.is_none() {
                let site_lower = g.site.to_lowercase();
                if site_lower.trim() == "local" {
                    kind = Some(GamesHistoryKind::Local);
                    external_key = g.id.to_string();
                    external_url = None;
                } else if site_lower.contains("lichess.org") {
                    kind = Some(GamesHistoryKind::Lichess);
                    // If `Sites.Name` stores a URL, try to extract id; else keep numeric.
                    if let Some(id) = extract_lichess_id_from_site(&g.site) {
                        external_key = id.clone();
                        external_url = Some(format!("https://lichess.org/{}", id));
                    } else {
                        external_url = normalize_https_url(&g.site);
                    }
                } else if site_lower.contains("chess.com") {
                    kind = Some(GamesHistoryKind::Chesscom);
                    if let Some(url) = extract_chesscom_url(&g.site).or_else(|| chesscom_url_from_link.clone()) {
                        external_key = url.clone();
                        external_url = Some(url);
                    } else {
                        // Keep as Chess.com row, but avoid fake links.
                        external_key = g.id.to_string();
                        external_url = None;
                    }
                } else if site_lower.contains("chessbase.com") {
                    kind = Some(GamesHistoryKind::Chessbase);
                    external_key = g.id.to_string();
                    external_url = None;
                }
            }

        // If we still couldn't identify a specific online platform, treat this as a
        // profile-local (imported) game. These come from arbitrary `Sites.Name` values
        // like "Mexico City", "Chihuahua City", etc., and should still show up in the
        // profile dashboard.
        if kind.is_none() {
            kind = Some(GamesHistoryKind::Chessbase);
            external_key = g.id.to_string();
            external_url = None;
        }

        let Some(kind) = kind else {
            continue;
        };

        let white_raw = g.white.clone();
        let black_raw = g.black.clone();
        let white_name = strip_account_key(&white_raw).to_string();
        let black_name = strip_account_key(&black_raw).to_string();
        let (user_is_white, is_profile_game) = if !profile_player_ids.is_empty() {
            let white_matches = profile_player_ids.contains(&g.white_id);
            let black_matches = profile_player_ids.contains(&g.black_id);
            if white_matches && !black_matches {
                (true, true)
            } else if black_matches && !white_matches {
                (false, true)
            } else if white_matches && black_matches {
                // Game between two profile-owned accounts.
                (true, true)
            } else {
                let is_user_white = usernames_lower.contains(&white_raw.to_lowercase())
                    || usernames_lower.contains(&white_name.to_lowercase());
                let is_user_black = usernames_lower.contains(&black_raw.to_lowercase())
                    || usernames_lower.contains(&black_name.to_lowercase());
                if is_user_white {
                    (true, true)
                } else if is_user_black {
                    (false, true)
                } else {
                    (false, false)
                }
            }
        } else {
            let is_user_white =
                usernames_lower.contains(&white_raw.to_lowercase()) || usernames_lower.contains(&white_name.to_lowercase());
            let is_user_black =
                usernames_lower.contains(&black_raw.to_lowercase()) || usernames_lower.contains(&black_name.to_lowercase());
            if is_user_white {
                (true, true)
            } else if is_user_black {
                (false, true)
            } else {
                (false, false)
            }
        };
        if !is_profile_game {
            continue;
        }
        let user_color = if user_is_white { "white" } else { "black" };
        let opponent = if user_is_white { black_name.clone() } else { white_name.clone() };
        let needs_minimal_pgn = matches!(kind, GamesHistoryKind::Chessbase | GamesHistoryKind::Local);

        let result_str = g.result.to_string();
        let outcome = outcome_from_result(user_color, &result_str);
        let timestamp_ms = parse_timestamp_ms(g.date.as_deref(), g.time.as_deref());
        let ply = g.ply_count.unwrap_or(0);
        let full_moves = ((ply as f64) / 2.0).ceil().max(1.0) as i32;
        let tc = g.time_control.clone().unwrap_or_default();
        let tc_cat = if tc.trim().is_empty() {
            None
        } else {
            time_control_category(kind.clone(), &tc)
        };

        let raw_moves_text = g.moves.clone();
        let maybe_decoded_movetext = if include_base_pgn {
            if has_any_pgn_tag(&raw_moves_text) {
                None
            } else {
                profile_db_conn
                    .as_ref()
                    .and_then(|conn| decode_san_movetext_from_blob(conn, g.id, Some(g.fen.as_str())))
            }
        } else {
            None
        };
        let moves_for_pgn = maybe_decoded_movetext.unwrap_or_else(|| raw_moves_text.clone());

        rows.push(GamesHistoryRow {
            kind,
            analysis_game_id: g.id.to_string(),
            game_key: external_key,
            external_url,
            opponent: if opponent.trim().is_empty() { "?".to_string() } else { opponent },
            color: user_color.to_string(),
            outcome,
            pgn: if include_base_pgn {
                if moves_for_pgn.trim().is_empty() {
                    None
                } else if needs_minimal_pgn {
                    Some(build_minimal_pgn_from_db_game(
                        &white_name,
                        &black_name,
                        &g.event,
                        &g.site,
                        g.date.as_deref(),
                        g.time.as_deref(),
                        g.time_control.as_deref(),
                        Some(g.fen.as_str()),
                        &result_str,
                        &moves_for_pgn,
                    ))
                } else {
                    Some(moves_for_pgn)
                }
            } else {
                None
            },
            initial_fen: {
                let fen = g.fen.trim().to_string();
                if fen.is_empty() {
                    None
                } else {
                    Some(fen)
                }
            },
            accuracy: None,
            acpl: None,
            estimated_elo: None,
            resistance: None,
            elo_estimated_balanced: None,
            moves: full_moves,
            time_control: if tc.trim().is_empty() { None } else { Some(tc) },
            time_control_category: tc_cat,
            timestamp_ms,
            event_id: Some(g.event_id),
            event_name: Some(g.event),
            is_analyzed: false,
        });
    }

    // 4) Apply filters that depend on computed meta.
    if let Some(event_id) = req.event_filter_id {
        rows.retain(|r| r.event_id == Some(event_id));
    }
    if let Some(ref q) = req.opponent_contains {
        let q = q.trim().to_lowercase();
        if !q.is_empty() {
            rows.retain(|r| r.opponent.to_lowercase().contains(&q));
        }
    }
    if let Some(ref want) = req.result_filter {
        let want = want.trim().to_lowercase();
        if want == "win" || want == "loss" || want == "draw" {
            rows.retain(|r| r.outcome == want);
        }
    }
    if let Some(ref want_tc) = req.time_control_category {
        let want_tc = want_tc.trim().to_lowercase();
        if !want_tc.is_empty() {
            rows.retain(|r| r.time_control_category.as_deref().unwrap_or("") == want_tc);
        }
    }
    if let Some(ref want_color) = req.player_color {
        let want_color = want_color.trim().to_lowercase();
        if want_color == "white" || want_color == "black" {
            rows.retain(|r| r.color == want_color);
        }
    }
    if let Some(min_moves) = req.min_moves {
        if min_moves > 0 {
            rows.retain(|r| r.moves >= min_moves);
        }
    }

    // 5) Enrich with analysis.db3 (bulk).
    // Primary key is (profile_id, analysis_game_id), but some older/client paths may
    // still persist with external game keys (URL / lichess id). Query both keys and
    // prefer internal `analysis_game_id` when both exist.
    let mut lookup_keys: Vec<String> = Vec::new();
    let mut seen_lookup_keys: HashSet<String> = HashSet::new();
    for r in rows.iter() {
        if seen_lookup_keys.insert(r.analysis_game_id.clone()) {
            lookup_keys.push(r.analysis_game_id.clone());
        }
        if r.game_key != r.analysis_game_id && seen_lookup_keys.insert(r.game_key.clone()) {
            lookup_keys.push(r.game_key.clone());
        }
    }
    if !lookup_keys.is_empty() {
        let analyzed_map: HashMap<String, String> = if include_analyzed_pgn {
            analysis_db_get_analyzed_games_bulk(app.clone(), lookup_keys.clone(), Some(profile_id.clone()))?
                .into_iter()
                .map(|e| (e.game_id, e.analyzed_pgn))
                .collect()
        } else {
            HashMap::new()
        };
        let stats_map: HashMap<String, (f64, f64, Option<i64>, Option<f64>, Option<i64>)> =
            if include_analysis_stats {
                analysis_db_get_game_stats_bulk(app.clone(), lookup_keys.clone(), Some(profile_id.clone()))?
                    .into_iter()
                    .map(|e| {
                        (
                            e.game_id,
                            (
                                e.accuracy,
                                e.acpl,
                                e.estimated_elo,
                                e.resistance,
                                e.elo_estimated_balanced,
                            ),
                        )
                    })
                    .collect()
            } else {
                HashMap::new()
            };

        for r in rows.iter_mut() {
            if include_analyzed_pgn {
                if let Some(pgn) = analyzed_map
                    .get(&r.analysis_game_id)
                    .or_else(|| analyzed_map.get(&r.game_key))
                {
                    r.pgn = Some(pgn.clone());
                    r.is_analyzed = true;
                }
            }
            if include_analysis_stats {
                if let Some((acc, acpl, elo, resistance, elo_balanced)) = stats_map
                    .get(&r.analysis_game_id)
                    .or_else(|| stats_map.get(&r.game_key))
                {
                    r.accuracy = Some(*acc);
                    r.acpl = Some(*acpl);
                    r.estimated_elo = *elo;
                    r.resistance = *resistance;
                    r.elo_estimated_balanced = *elo_balanced;
                    r.is_analyzed = true;
                }
            }
            if include_analyzed_pgn && !r.is_analyzed {
                if let Some(ref pgn) = r.pgn {
                    if has_analysis_markers(pgn) {
                        r.is_analyzed = true;
                    }
                }
            }
        }
    }

    // 6) Sort.
    let sort_by = req.sort_by.clone().unwrap_or_else(|| "date".to_string());
    let sort_dir = req.sort_direction.clone().unwrap_or_else(|| "desc".to_string());
    if sort_by == "elo" {
        rows.sort_by(|a, b| {
            let ea = a.estimated_elo.unwrap_or(0);
            let eb = b.estimated_elo.unwrap_or(0);
            ea.cmp(&eb)
        });
    } else {
        rows.sort_by(|a, b| a.timestamp_ms.cmp(&b.timestamp_ms));
    }
    if sort_dir != "asc" {
        rows.reverse();
    }

    // 7) Pagination.
    let total = rows.len() as i32;
    let page = req.page.max(1) as usize;
    let page_size = req.page_size.max(1) as usize;
    let start = (page - 1) * page_size;
    let end = (start + page_size).min(rows.len());
    let page_rows = if start >= rows.len() {
        vec![]
    } else {
        rows[start..end].to_vec()
    };

    Ok(GamesHistoryResponse {
        rows: page_rows,
        total_count: total,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn dashboard_get_overview_metrics(
    app: AppHandle,
    state: State<'_, AppState>,
    req: DashboardOverviewRequest,
) -> Result<DashboardOverviewResponse> {
    let now_ms = Utc::now().timestamp_millis();
    let sample_size = req
        .sample_size
        .unwrap_or(DASHBOARD_OVERVIEW_DEFAULT_SAMPLE_SIZE)
        .clamp(1, 1000);
    let trend_weeks = req
        .trend_weeks
        .unwrap_or(DASHBOARD_OVERVIEW_DEFAULT_TREND_WEEKS)
        .clamp(2, 12) as usize;

    let profile_id = req.profile_id.trim();
    if profile_id.is_empty() {
        let mut empty = empty_dashboard_overview(now_ms, sample_size, trend_weeks);
        empty.puzzle_variants_color_coverage = load_puzzle_variants_color_coverage(&app);
        return Ok(empty);
    }

    let source_limit = if req.game_history_limit <= 0 {
        DASHBOARD_OVERVIEW_MAX_LIMIT
    } else {
        req.game_history_limit.min(DASHBOARD_OVERVIEW_MAX_LIMIT)
    };
    let profile_usernames = req.profile_usernames.clone();
    let rows_req = GamesHistoryRequest {
        profile_id: profile_id.to_string(),
        game_history_limit: source_limit,
        page: 1,
        page_size: source_limit,
        event_filter_id: None,
        selected_opponent_id: None,
        opponent_contains: None,
        time_control_category: None,
        result_filter: None,
        player_color: None,
        min_moves: None,
        sort_by: Some("date".to_string()),
        sort_direction: Some("desc".to_string()),
        profile_usernames: profile_usernames.clone(),
        include_base_pgn: Some(false),
        include_analyzed_pgn: Some(false),
        include_analysis_stats: Some(true),
    };

    let mut rows = dashboard_get_games_history_rows(app.clone(), state.clone(), rows_req).await?.rows;
    if rows.is_empty() {
        let mut empty = empty_dashboard_overview(now_ms, sample_size, trend_weeks);
        empty.puzzle_variants_color_coverage = load_puzzle_variants_color_coverage(&app);
        return Ok(empty);
    }

    rows.retain(|row| row.timestamp_ms > 0);
    if rows.is_empty() {
        let mut empty = empty_dashboard_overview(now_ms, sample_size, trend_weeks);
        empty.puzzle_variants_color_coverage = load_puzzle_variants_color_coverage(&app);
        return Ok(empty);
    }
    rows.sort_by(|a, b| b.timestamp_ms.cmp(&a.timestamp_ms));

    let week_start_ms = get_start_of_week_sunday_ms(now_ms);
    let sample_rows = rows
        .iter()
        .take(sample_size as usize)
        .collect::<Vec<&GamesHistoryRow>>();
    let week_rows = rows
        .iter()
        .filter(|row| row.timestamp_ms >= week_start_ms && row.timestamp_ms <= now_ms)
        .collect::<Vec<&GamesHistoryRow>>();
    let previous_week_start_ms = week_start_ms - WEEK_MS;
    let previous_week_end_exclusive_ms = week_start_ms;
    let previous_week_rows = rows
        .iter()
        .filter(|row| {
            row.timestamp_ms >= previous_week_start_ms && row.timestamp_ms < previous_week_end_exclusive_ms
        })
        .collect::<Vec<&GamesHistoryRow>>();

    let mut week_acpl_by_time_control_acc = AcplByTimeControlAcc::default();
    let mut week_accuracy_by_color_acc = AccuracyByColorAcc::default();
    for row in week_rows.iter().copied() {
        if let Some(acpl) = row.acpl {
            if acpl.is_finite() && acpl > 0.0 {
                match row
                    .time_control_category
                    .as_deref()
                    .map(|v| v.trim().to_ascii_lowercase())
                    .as_deref()
                {
                    Some("classical") => {
                        week_acpl_by_time_control_acc.classical.sum += acpl;
                        week_acpl_by_time_control_acc.classical.count += 1;
                    }
                    Some("rapid") => {
                        week_acpl_by_time_control_acc.rapid.sum += acpl;
                        week_acpl_by_time_control_acc.rapid.count += 1;
                    }
                    Some("blitz") => {
                        week_acpl_by_time_control_acc.blitz.sum += acpl;
                        week_acpl_by_time_control_acc.blitz.count += 1;
                    }
                    Some("bullet") | Some("ultra_bullet") => {
                        week_acpl_by_time_control_acc.bullet.sum += acpl;
                        week_acpl_by_time_control_acc.bullet.count += 1;
                    }
                    _ => {}
                }
            }
        }

        if let Some(accuracy) = row.accuracy {
            if accuracy.is_finite() && accuracy > 0.0 {
                match row.color.trim().to_ascii_lowercase().as_str() {
                    "white" => {
                        week_accuracy_by_color_acc.white.sum += accuracy;
                        week_accuracy_by_color_acc.white.count += 1;
                    }
                    "black" => {
                        week_accuracy_by_color_acc.black.sum += accuracy;
                        week_accuracy_by_color_acc.black.count += 1;
                    }
                    _ => {}
                }
            }
        }
    }

    let mut week_wins = 0i64;
    let mut week_losses = 0i64;
    let mut week_draws = 0i64;
    for row in week_rows.iter().copied() {
        match row.outcome.as_str() {
            "win" => week_wins += 1,
            "loss" => week_losses += 1,
            "draw" => week_draws += 1,
            _ => {}
        }
    }
    let week_outcome_count = week_wins + week_losses + week_draws;
    let week_win_rate = if week_outcome_count > 0 {
        ((week_wins as f64 / week_outcome_count as f64) * 100.0).round() as i32
    } else {
        0
    };
    let mut previous_week_wins = 0i64;
    let mut previous_week_losses = 0i64;
    let mut previous_week_draws = 0i64;
    for row in previous_week_rows.iter().copied() {
        match row.outcome.as_str() {
            "win" => previous_week_wins += 1,
            "loss" => previous_week_losses += 1,
            "draw" => previous_week_draws += 1,
            _ => {}
        }
    }
    let previous_week_outcome_count = previous_week_wins + previous_week_losses + previous_week_draws;
    let previous_week_win_rate = if previous_week_outcome_count > 0 {
        ((previous_week_wins as f64 / previous_week_outcome_count as f64) * 100.0).round() as i32
    } else {
        0
    };

    let sample_elo_values = sample_rows
        .iter()
        .filter_map(|row| extract_row_estimated_elo(row))
        .collect::<Vec<i64>>();
    let week_elo_values = week_rows
        .iter()
        .filter_map(|row| extract_row_estimated_elo(row))
        .collect::<Vec<i64>>();
    let previous_week_elo_values = previous_week_rows
        .iter()
        .filter_map(|row| extract_row_estimated_elo(row))
        .collect::<Vec<i64>>();

    let tracked_week_starts = (0..trend_weeks)
        .map(|index| week_start_ms - (index as i64 * WEEK_MS))
        .collect::<Vec<i64>>();
    let oldest_tracked_week_start = tracked_week_starts
        .last()
        .copied()
        .unwrap_or(week_start_ms);
    let needs_annotation_scan = rows
        .iter()
        .any(|row| row.is_analyzed && row.timestamp_ms >= oldest_tracked_week_start && row.timestamp_ms <= now_ms);
    let mut analyzed_pgn_by_key: HashMap<String, (String, Option<String>)> = HashMap::new();
    if needs_annotation_scan {
        let analyzed_rows_req = GamesHistoryRequest {
            profile_id: profile_id.to_string(),
            game_history_limit: source_limit,
            page: 1,
            page_size: source_limit,
            event_filter_id: None,
            selected_opponent_id: None,
            opponent_contains: None,
            time_control_category: None,
            result_filter: None,
            player_color: None,
            min_moves: None,
            sort_by: Some("date".to_string()),
            sort_direction: Some("desc".to_string()),
            profile_usernames: profile_usernames.clone(),
            include_base_pgn: Some(true),
            include_analyzed_pgn: Some(true),
            include_analysis_stats: Some(false),
        };
        let analyzed_rows = dashboard_get_games_history_rows(app.clone(), state, analyzed_rows_req).await?.rows;
        for row in analyzed_rows {
            if !row.is_analyzed {
                continue;
            }
            let Some(pgn) = row.pgn else {
                continue;
            };
            analyzed_pgn_by_key.insert(row.analysis_game_id.clone(), (pgn.clone(), row.initial_fen.clone()));
            if row.game_key != row.analysis_game_id {
                analyzed_pgn_by_key.insert(row.game_key, (pgn, row.initial_fen));
            }
        }
    }
    let mut tracked_weeks: HashMap<i64, WeeklyQualityBucket> = tracked_week_starts
        .iter()
        .map(|week_start| (*week_start, WeeklyQualityBucket::default()))
        .collect();

    for row in rows.iter() {
        if row.timestamp_ms < oldest_tracked_week_start {
            break;
        }
        let bucket_key = get_start_of_week_sunday_ms(row.timestamp_ms);
        let Some(bucket) = tracked_weeks.get_mut(&bucket_key) else {
            continue;
        };

        if let Some(accuracy) = row.accuracy {
            if accuracy.is_finite() && accuracy > 0.0 {
                bucket.accuracy_sum += accuracy;
                bucket.accuracy_count += 1;
            }
        }
        if let Some(acpl) = row.acpl {
            if acpl.is_finite() && acpl > 0.0 {
                bucket.acpl_sum += acpl;
                bucket.acpl_count += 1;
            }
        }

        if !row.is_analyzed {
            continue;
        }
        let maybe_pgn_with_fen = analyzed_pgn_by_key
            .get(&row.analysis_game_id)
            .or_else(|| analyzed_pgn_by_key.get(&row.game_key));
        let Some((pgn, initial_fen)) = maybe_pgn_with_fen else {
            continue;
        };
        let pgn = pgn.trim();
        if pgn.is_empty() {
            continue;
        }

        let color = row.color.trim().to_ascii_lowercase();
        if color != "white" && color != "black" {
            continue;
        }

        let annotations = collect_player_annotation_summary(pgn, initial_fen.as_deref(), color.as_str());
        if annotations.annotated_moves <= 0 {
            continue;
        }

        bucket.analyzed_games += 1;
        bucket.annotated_moves += annotations.annotated_moves;
        bucket.brilliants += annotations.brilliants;
        bucket.blunders += annotations.blunders;
        bucket.mistakes += annotations.mistakes;
        bucket.inaccuracies += annotations.inaccuracies;
    }

    let current_bucket = tracked_weeks
        .get(&week_start_ms)
        .cloned()
        .unwrap_or_default();
    let previous_bucket = tracked_weeks
        .get(&(week_start_ms - WEEK_MS))
        .cloned()
        .unwrap_or_default();

    let week_blunder_rate = to_rate_percent(current_bucket.blunders, current_bucket.annotated_moves);
    let previous_week_blunder_rate = to_rate_percent(previous_bucket.blunders, previous_bucket.annotated_moves);
    let week_brilliant_rate = to_rate_percent(current_bucket.brilliants, current_bucket.annotated_moves);
    let previous_week_brilliant_rate = to_rate_percent(previous_bucket.brilliants, previous_bucket.annotated_moves);
    let week_mistake_rate = to_rate_percent(current_bucket.mistakes, current_bucket.annotated_moves);
    let previous_week_mistake_rate = to_rate_percent(previous_bucket.mistakes, previous_bucket.annotated_moves);
    let week_inaccuracy_rate = to_rate_percent(current_bucket.inaccuracies, current_bucket.annotated_moves);
    let previous_week_inaccuracy_rate =
        to_rate_percent(previous_bucket.inaccuracies, previous_bucket.annotated_moves);
    let week_accuracy = to_average(current_bucket.accuracy_sum, current_bucket.accuracy_count);
    let previous_week_accuracy = to_average(previous_bucket.accuracy_sum, previous_bucket.accuracy_count);
    let week_acpl = to_average(current_bucket.acpl_sum, current_bucket.acpl_count);
    let previous_week_acpl = to_average(previous_bucket.acpl_sum, previous_bucket.acpl_count);
    let blunder_rate_trend = tracked_week_starts
        .iter()
        .map(|week_start| {
            tracked_weeks
                .get(week_start)
                .and_then(|bucket| to_rate_percent(bucket.blunders, bucket.annotated_moves))
        })
        .collect::<Vec<Option<f64>>>();
    let week_acpl_by_time_control = acpl_by_time_control_from_acc(week_acpl_by_time_control_acc);
    let week_accuracy_by_color = accuracy_by_color_from_acc(week_accuracy_by_color_acc);
    let puzzle_variants_color_coverage = load_puzzle_variants_color_coverage(&app);

    Ok(DashboardOverviewResponse {
        week_start_ms,
        week_end_ms: now_ms,
        week_games_count: i64_to_i32_saturating(week_rows.len() as i64),
        week_wins: i64_to_i32_saturating(week_wins),
        week_losses: i64_to_i32_saturating(week_losses),
        week_draws: i64_to_i32_saturating(week_draws),
        week_outcome_count: i64_to_i32_saturating(week_outcome_count),
        week_win_rate,
        previous_week_games_count: i64_to_i32_saturating(previous_week_rows.len() as i64),
        previous_week_wins: i64_to_i32_saturating(previous_week_wins),
        previous_week_losses: i64_to_i32_saturating(previous_week_losses),
        previous_week_draws: i64_to_i32_saturating(previous_week_draws),
        previous_week_outcome_count: i64_to_i32_saturating(previous_week_outcome_count),
        previous_week_win_rate,
        sample_games_count: i64_to_i32_saturating(sample_rows.len() as i64),
        sample_size,
        sample_avg_estimated_elo: average_elo(&sample_elo_values),
        week_avg_estimated_elo: average_elo(&week_elo_values),
        previous_week_avg_estimated_elo: average_elo(&previous_week_elo_values),
        week_blunder_rate,
        previous_week_blunder_rate,
        blunder_delta_pp: to_delta(week_blunder_rate, previous_week_blunder_rate),
        week_brilliant_rate,
        previous_week_brilliant_rate,
        brilliant_delta_pp: to_delta(week_brilliant_rate, previous_week_brilliant_rate),
        week_mistake_rate,
        previous_week_mistake_rate,
        mistake_delta_pp: to_delta(week_mistake_rate, previous_week_mistake_rate),
        week_inaccuracy_rate,
        previous_week_inaccuracy_rate,
        inaccuracy_delta_pp: to_delta(week_inaccuracy_rate, previous_week_inaccuracy_rate),
        week_accuracy,
        previous_week_accuracy,
        accuracy_delta: to_delta(week_accuracy, previous_week_accuracy),
        week_acpl,
        previous_week_acpl,
        acpl_delta: to_delta(week_acpl, previous_week_acpl),
        week_analyzed_games: i64_to_i32_saturating(current_bucket.analyzed_games),
        previous_week_analyzed_games: i64_to_i32_saturating(previous_bucket.analyzed_games),
        blunder_rate_trend,
        week_acpl_by_time_control,
        week_accuracy_by_color,
        puzzle_variants_color_coverage,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn dashboard_get_games_history_filter_meta(
    app: AppHandle,
    state: State<'_, AppState>,
    req: GamesHistoryFilterMetaRequest,
) -> Result<GamesHistoryFilterMetaResponse> {
    let rows_req = GamesHistoryRequest {
        profile_id: req.profile_id,
        // Scan a broader window than the visible table page so filter options are not
        // constrained to the current pagination slice.
        game_history_limit: req.game_history_limit.max(5000),
        page: 1,
        page_size: req.game_history_limit.max(5000),
        event_filter_id: req.event_filter_id,
        selected_opponent_id: req.selected_opponent_id,
        opponent_contains: req.opponent_contains,
        // Important: this metadata query should not self-filter by time control.
        time_control_category: None,
        result_filter: req.result_filter,
        player_color: req.player_color,
        min_moves: req.min_moves,
        sort_by: Some("date".to_string()),
        sort_direction: Some("desc".to_string()),
        profile_usernames: req.profile_usernames,
        include_base_pgn: None,
        include_analyzed_pgn: None,
        include_analysis_stats: None,
    };

    let rows = dashboard_get_games_history_rows(app, state, rows_req).await?.rows;
    let mut seen: HashSet<String> = HashSet::new();
    for row in rows.iter() {
        if let Some(cat) = row.time_control_category.as_deref() {
            let trimmed = cat.trim().to_lowercase();
            if !trimmed.is_empty() {
                seen.insert(trimmed);
            }
        }
    }

    let ordered = [
        "ultra_bullet",
        "bullet",
        "blitz",
        "rapid",
        "classical",
        "correspondence",
        "daily",
    ];
    let available_time_control_categories = ordered
        .iter()
        .filter_map(|value| {
            if seen.contains(*value) {
                Some((*value).to_string())
            } else {
                None
            }
        })
        .collect();

    Ok(GamesHistoryFilterMetaResponse {
        available_time_control_categories,
    })
}

fn empty_analyze_all_counts() -> AnalyzeAllCountsResponse {
    AnalyzeAllCountsResponse {
        total: 0,
        analyzed: 0,
        unanalyzed: 0,
    }
}

fn row_matches_target(row: &GamesHistoryRow, target: &AnalyzeAllTarget) -> bool {
    match target {
        AnalyzeAllTarget::All => true,
        AnalyzeAllTarget::Local => matches!(row.kind, GamesHistoryKind::Local),
        AnalyzeAllTarget::Chesscom => matches!(row.kind, GamesHistoryKind::Chesscom),
        AnalyzeAllTarget::Lichess => matches!(row.kind, GamesHistoryKind::Lichess),
        AnalyzeAllTarget::Chessbase => matches!(row.kind, GamesHistoryKind::Chessbase),
    }
}

fn compute_analyze_all_counts(rows: &[GamesHistoryRow], target: AnalyzeAllTarget) -> AnalyzeAllCountsResponse {
    let mut total = 0i32;
    let mut analyzed = 0i32;

    for row in rows.iter() {
        if !row_matches_target(row, &target) {
            continue;
        }
        total += 1;
        if row.is_analyzed {
            analyzed += 1;
        }
    }

    AnalyzeAllCountsResponse {
        total,
        analyzed,
        unanalyzed: (total - analyzed).max(0),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn dashboard_get_analyze_all_counts_bulk(
    app: AppHandle,
    state: State<'_, AppState>,
    req: AnalyzeAllCountsBulkRequest,
) -> Result<AnalyzeAllCountsBulkResponse> {
    let profile_id = req.profile_id.trim().to_string();
    if profile_id.is_empty() || req.game_history_limit <= 0 {
        let zero = empty_analyze_all_counts();
        return Ok(AnalyzeAllCountsBulkResponse {
            all: zero.clone(),
            local: zero.clone(),
            chesscom: zero.clone(),
            lichess: zero.clone(),
            chessbase: zero,
        });
    }

    // Keep counts aligned with the same source used by the dashboard table.
    let rows_req = GamesHistoryRequest {
        profile_id,
        game_history_limit: req.game_history_limit,
        page: 1,
        page_size: req.game_history_limit,
        event_filter_id: req.event_filter_id,
        selected_opponent_id: req.selected_opponent_id,
        opponent_contains: None,
        time_control_category: req.time_control_category,
        result_filter: None,
        player_color: req.player_color,
        min_moves: req.min_moves,
        sort_by: Some("date".to_string()),
        sort_direction: Some("desc".to_string()),
        profile_usernames: req.profile_usernames,
        include_base_pgn: None,
        include_analyzed_pgn: None,
        include_analysis_stats: None,
    };
    let mut rows = dashboard_get_games_history_rows(app, state, rows_req).await?.rows;

    // Analyze-all only processes games with enough move content.
    let analyze_min_moves = req.min_moves.unwrap_or(0).max(5);
    rows.retain(|r| r.moves >= analyze_min_moves);

    Ok(AnalyzeAllCountsBulkResponse {
        all: compute_analyze_all_counts(&rows, AnalyzeAllTarget::All),
        local: compute_analyze_all_counts(&rows, AnalyzeAllTarget::Local),
        chesscom: compute_analyze_all_counts(&rows, AnalyzeAllTarget::Chesscom),
        lichess: compute_analyze_all_counts(&rows, AnalyzeAllTarget::Lichess),
        chessbase: compute_analyze_all_counts(&rows, AnalyzeAllTarget::Chessbase),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn dashboard_get_analyze_all_counts(
    app: AppHandle,
    state: State<'_, AppState>,
    req: AnalyzeAllCountsRequest,
) -> Result<AnalyzeAllCountsResponse> {
    let bulk = dashboard_get_analyze_all_counts_bulk(
        app,
        state,
        AnalyzeAllCountsBulkRequest {
            profile_id: req.profile_id,
            game_history_limit: req.game_history_limit,
            event_filter_id: req.event_filter_id,
            selected_opponent_id: req.selected_opponent_id,
            time_control_category: req.time_control_category,
            player_color: req.player_color,
            min_moves: req.min_moves,
            profile_usernames: req.profile_usernames,
        },
    )
    .await?;

    Ok(match req.target {
        AnalyzeAllTarget::All => bulk.all,
        AnalyzeAllTarget::Local => bulk.local,
        AnalyzeAllTarget::Chesscom => bulk.chesscom,
        AnalyzeAllTarget::Lichess => bulk.lichess,
        AnalyzeAllTarget::Chessbase => bulk.chessbase,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn dashboard_search_profile_opponents(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    query: String,
    profile_usernames: Vec<String>,
) -> Result<Vec<String>> {
    let profile_id = profile_id.trim().to_string();
    let q = query.trim().to_string();
    if profile_id.is_empty() || q.len() < 3 {
        return Ok(vec![]);
    }

    let q_lower = q.to_lowercase();
    let usernames_lower = usernames_lower_set(&profile_usernames);
    let db_path = parse_profile_db_path(&app, &profile_id)?;
    let profile_player_ids: Vec<i32> = match Connection::open(&db_path) {
        Ok(conn) => {
            let from_usernames = find_profile_player_ids_by_usernames(&conn, &usernames_lower);
            if !usernames_lower.is_empty() {
                from_usernames
            } else if from_usernames.is_empty() {
                ensure_profile_player_id(&conn).map(|pid| vec![pid]).unwrap_or_default()
            } else {
                from_usernames
            }
        }
        Err(_) => Vec::new(),
    };

    let mut out: Vec<String> = Vec::new();
    let mut seen_stripped_lower: HashSet<String> = HashSet::new();
    let mut maybe_push = |name_raw: &str| {
        let raw = name_raw.trim();
        if raw.is_empty() {
            return;
        }
        let raw_lower = raw.to_lowercase();
        let stripped = strip_account_key(raw).trim();
        if stripped.is_empty() {
            return;
        }
        let stripped_lower = stripped.to_lowercase();

        if usernames_lower.contains(&raw_lower) || usernames_lower.contains(&stripped_lower) {
            return;
        }
        if !raw_lower.contains(&q_lower) && !stripped_lower.contains(&q_lower) {
            return;
        }
        if seen_stripped_lower.insert(stripped_lower) {
            out.push(stripped.to_string());
        }
    };

    if !profile_player_ids.is_empty() {
        let conn = Connection::open(&db_path)?;
        let mut stmt = conn.prepare(
            r#"
            SELECT p.Name, COUNT(*) AS games_count
            FROM Games g
            JOIN Players p
              ON p.ID = CASE WHEN g.WhiteID = ?1 THEN g.BlackID ELSE g.WhiteID END
            WHERE (g.WhiteID = ?1 OR g.BlackID = ?1)
              AND p.Name IS NOT NULL
              AND trim(p.Name) <> ''
              AND (
                lower(trim(p.Name)) LIKE '%' || ?2 || '%'
                OR replace(replace(lower(trim(p.Name)), 'lichess:', ''), 'chesscom:', '') LIKE '%' || ?2 || '%'
              )
            GROUP BY p.ID, p.Name
            ORDER BY games_count DESC, p.Name COLLATE NOCASE ASC
            LIMIT 200
            "#,
        )?;

        for profile_pid in profile_player_ids.iter().copied() {
            let rows = stmt.query_map(params![profile_pid, q_lower.as_str()], |row| {
                Ok(row.get::<_, Option<String>>(0)?)
            })?;

            for row in rows {
                let Ok(name_opt) = row else {
                    continue;
                };
                let Some(name) = name_opt else {
                    continue;
                };
                maybe_push(&name);
            }
        }
    } else {
        let pq = PlayerQuery {
            options: QueryOptions {
                skip_count: true,
                page: Some(1),
                page_size: Some(200),
                sort: PlayerSort::Name,
                direction: SortDirection::Asc,
            },
            name: Some(q.clone()),
            range: None,
        };
        let res = get_players(db_path.clone(), pq, state).await?;
        for p in res.data {
            let Some(name_raw) = p.name else {
                continue;
            };
            maybe_push(&name_raw);
        }
    }

    // Release mutable borrows captured by the helper closure before exact-match fallback.
    drop(maybe_push);

    // Ensure exact matches are included even if they were outside the first page/ranking window.
    if !seen_stripped_lower.contains(&q_lower) {
        let conn = Connection::open(&db_path)?;
        let exact_name: Option<String> = if !profile_player_ids.is_empty() {
            let mut found: Option<String> = None;
            for profile_pid in profile_player_ids.iter().copied() {
                let candidate: Option<String> = conn
                    .query_row(
                        r#"
                        SELECT p.Name
                        FROM Players p
                        WHERE p.Name IS NOT NULL
                          AND trim(p.Name) <> ''
                          AND (
                            lower(trim(p.Name)) = ?1
                            OR replace(replace(lower(trim(p.Name)), 'lichess:', ''), 'chesscom:', '') = ?1
                          )
                          AND EXISTS (
                            SELECT 1
                            FROM Games g
                            WHERE (g.WhiteID = ?2 AND g.BlackID = p.ID)
                               OR (g.BlackID = ?2 AND g.WhiteID = p.ID)
                          )
                        LIMIT 1
                        "#,
                        params![q_lower.as_str(), profile_pid],
                        |row| row.get(0),
                    )
                    .optional()?;
                if candidate.is_some() {
                    found = candidate;
                    break;
                }
            }
            found
        } else {
            conn.query_row(
                r#"
                SELECT p.Name
                FROM Players p
                WHERE p.Name IS NOT NULL
                  AND trim(p.Name) <> ''
                  AND (
                    lower(trim(p.Name)) = ?1
                    OR replace(replace(lower(trim(p.Name)), 'lichess:', ''), 'chesscom:', '') = ?1
                  )
                LIMIT 1
                "#,
                params![q_lower.as_str()],
                |row| row.get(0),
            )
            .optional()?
        };

        if let Some(name_raw) = exact_name {
            let raw = name_raw.trim();
            if !raw.is_empty() {
                let raw_lower = raw.to_lowercase();
                let stripped = strip_account_key(raw).trim().to_string();
                let stripped_lower = stripped.to_lowercase();
                if !stripped.is_empty()
                    && (raw_lower.contains(&q_lower) || stripped_lower.contains(&q_lower))
                    && !usernames_lower.contains(&raw_lower)
                    && !usernames_lower.contains(&stripped_lower)
                    && seen_stripped_lower.insert(stripped_lower)
                {
                    out.insert(0, stripped);
                }
            }
        }
    }

    if out.len() > 200 {
        out.truncate(200);
    }
    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub fn dashboard_resolve_profile_db_game_id(
    app: AppHandle,
    profile_id: String,
    kind: GamesHistoryKind,
    game_key: String,
) -> Result<Option<String>> {
    let profile_id = profile_id.trim().to_string();
    if profile_id.is_empty() {
        return Ok(None);
    }
    let game_key = game_key.trim().to_string();
    if game_key.is_empty() {
        return Ok(None);
    }

    let db_path = parse_profile_db_path(&app, &profile_id)?;
    let conn = Connection::open(db_path)?;

    // Resolve the internal Games.ID by searching for the external identifier.
    //
    // Notes about schema:
    // - `Games.Moves` is a BLOB containing UTF-8 PGN text (tags + moves) in practice.
    // - Site name is stored in `Sites.Name` via `Games.SiteID`.
    let key_lower = game_key.to_lowercase();
    let (like_moves_1, like_moves_2, like_site_1, like_site_2) = match kind {
        GamesHistoryKind::Lichess => {
            // Most common: [Site "https://lichess.org/<id>"] inside PGN tags.
            let needle_full = format!("lichess.org/{}", key_lower);
            // Sometimes stored as just the id in a tag.
            let needle_quoted = format!("\"{}\"", key_lower);
            (
                format!("%{}%", needle_full),
                format!("%{}%", needle_quoted),
                format!("%{}%", needle_full),
                format!("%{}%", key_lower),
            )
        }
        GamesHistoryKind::Chesscom => (
            format!("%{}%", key_lower),
            // Extra tolerance: some sources store only the numeric game id, but game_key here is usually full URL.
            format!("%{}%", key_lower),
            format!("%{}%", key_lower),
            format!("%{}%", key_lower),
        ),
        GamesHistoryKind::Chessbase => {
            // ChessBase imports use the internal Games.ID as game_key.
            return Ok(Some(game_key));
        }
        GamesHistoryKind::Local => {
            // Not a profile DB game.
            return Ok(None);
        }
    };

    let mut stmt = conn.prepare(
        "SELECT g.ID
         FROM Games g
         LEFT JOIN Sites s ON s.ID = g.SiteID
         WHERE lower(CAST(g.Moves AS TEXT)) LIKE ?1
            OR lower(CAST(g.Moves AS TEXT)) LIKE ?2
            OR lower(COALESCE(s.Name, '')) LIKE ?3
            OR lower(COALESCE(s.Name, '')) LIKE ?4
         LIMIT 1",
    )?;

    let id: Option<i64> = stmt
        .query_row([like_moves_1, like_moves_2, like_site_1, like_site_2], |row| row.get::<_, i64>(0))
        .optional()?;

    Ok(id.map(|v| v.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn dashboard_decode_profile_game_blob_moves(
    app: AppHandle,
    profile_id: String,
    game_id: i32,
) -> Result<Option<DecodedGameMovesResponse>> {
    let profile_id = profile_id.trim().to_string();
    if profile_id.is_empty() || game_id <= 0 {
        return Ok(None);
    }

    let db_path = parse_profile_db_path(&app, &profile_id)?;
    let conn = Connection::open(db_path)?;

    let row: Option<(Option<String>, Vec<u8>)> = conn
        .query_row(
            "SELECT FEN, Moves FROM Games WHERE ID = ?1 LIMIT 1",
            [game_id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Vec<u8>>(1)?)),
        )
        .optional()?;

    let Some((fen_opt, moves_blob)) = row else {
        return Ok(None);
    };
    if moves_blob.is_empty() {
        return Ok(None);
    }

    let Some((initial_fen, moves)) = decode_uci_moves_from_blob(&moves_blob, fen_opt.as_deref()) else {
        return Ok(None);
    };

    Ok(Some(DecodedGameMovesResponse { initial_fen, moves }))
}

#[tauri::command]
#[specta::specta]
pub fn dashboard_resolve_chesscom_game_url(
    app: AppHandle,
    profile_id: String,
    game_id: i32,
) -> Result<Option<String>> {
    let profile_id = profile_id.trim().to_string();
    if profile_id.is_empty() || game_id <= 0 {
        return Ok(None);
    }

    let db_path = parse_profile_db_path(&app, &profile_id)?;
    let conn = Connection::open(&db_path)?;

    let row = conn
        .query_row(
            "SELECT g.Date, g.UTCTime, pw.Name, pb.Name
             FROM Games g
             LEFT JOIN Players pw ON pw.ID = g.WhiteID
             LEFT JOIN Players pb ON pb.ID = g.BlackID
             WHERE g.ID = ?1
             LIMIT 1",
            [game_id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;

    let Some((date_opt, time_opt, white_opt, black_opt)) = row else {
        return Ok(None);
    };
    let (Some(date), Some(time), Some(white), Some(black)) = (date_opt, time_opt, white_opt, black_opt) else {
        return Ok(None);
    };

    let db_dir = db_path.parent().map(|p| p.to_path_buf()).ok_or_else(|| {
        Error::PackageManager("Failed to resolve profile db directory".to_string())
    })?;
    let mut found: Option<String> = None;
    for entry in std::fs::read_dir(db_dir)? {
        let entry = match entry {
            Ok(v) => v,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.starts_with(&format!("profile_{}_chesscom_", profile_id)) || !name.ends_with(".pgn") {
            continue;
        }
        if let Some(link) = find_chesscom_link_in_pgn_export(&path, &date, &time, &white, &black) {
            found = Some(link);
            break;
        }
    }

    Ok(found)
}
