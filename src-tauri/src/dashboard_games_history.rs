use crate::db::{
    encoding::extract_main_line_moves,
    get_players,
    pgn::{GameTree, GameTreeNode, Importer},
    PlayerQuery, PlayerSort, QueryOptions, SortDirection,
};
use crate::error::{Error, Result};
use crate::opening::{get_opening_from_setup, normalize_opening_family_name};
use crate::AppState;
use chrono::{
    DateTime, Datelike, Duration, Local, LocalResult, NaiveDate, NaiveDateTime, NaiveTime,
    TimeZone, Utc,
};
use pgn_reader::BufferedReader;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, CastlingMode, Chess, EnPassantMode, Move, Position};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Duration as StdDuration;
use tauri::{path::BaseDirectory, AppHandle, Manager, State};

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
    pub available_sources: Vec<String>,
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
    pub result_filter: Option<String>,  // win/loss/draw
    pub source_filter: Option<String>,  // local/chesscom/lichess/chessbase
    pub player_color: Option<String>,   // white/black
    pub min_moves: Option<i32>,         // minimum full moves
    pub sort_by: Option<String>,        // "elo" | "date"
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
    pub source_filter: Option<String>,
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

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DashboardOpeningAccuracyTopRequest {
    pub profile_id: String,
    pub game_history_limit: i32,
    pub profile_usernames: Vec<String>,
    #[serde(default)]
    pub time_control_categories: Vec<String>,
    pub sort_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DashboardOpeningAccuracyTopItem {
    pub family: String,
    pub games: i32,
    pub avg_accuracy: f64,
    pub win_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DashboardOpeningAccuracyTopResponse {
    pub white: Vec<DashboardOpeningAccuracyTopItem>,
    pub black: Vec<DashboardOpeningAccuracyTopItem>,
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
    pub opponent_contains: Option<String>,
    pub time_control_category: Option<String>,
    pub result_filter: Option<String>,
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
    pub opponent_contains: Option<String>,
    pub time_control_category: Option<String>,
    pub result_filter: Option<String>,
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

const DASHBOARD_OVERVIEW_DEFAULT_SAMPLE_SIZE: i32 = 100;
const DASHBOARD_OVERVIEW_DEFAULT_TREND_WEEKS: i32 = 4;
const DASHBOARD_OVERVIEW_MAX_LIMIT: i32 = 5000;
const DASHBOARD_OPENING_ACCURACY_MIN_SHARE: f64 = 0.05;
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

    let finalize_game =
        |headers: &mut HashMap<String, String>, in_movetext: &mut bool| -> Option<String> {
            if headers.is_empty() {
                *in_movetext = false;
                return None;
            }
            let date_ok = headers
                .get("UTCDate")
                .or_else(|| headers.get("Date"))
                .map(|v| v.trim())
                == Some(target_date);
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
    let site_lower = site.to_lowercase();
    if !site_lower.contains("lichess.org") {
        return None;
    }
    // lichess.org/{id} or lichess.org/game/{id}
    let idx = site_lower.find("lichess.org")?;
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

fn open_profile_db_connection(path: impl AsRef<Path>) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(StdDuration::from_secs(30))?;
    Ok(conn)
}

fn resolve_analysis_db_path(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .resolve("analysis.db3", BaseDirectory::AppData)
        .map_err(|e| Error::PackageManager(format!("Failed to resolve analysis DB path: {}", e)))
}

fn attach_analysis_db(conn: &Connection, analysis_db_path: &Path) -> Result<()> {
    if let Some(parent) = analysis_db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to create analysis DB directory: {}", e),
            ))
        })?;
    }

    let path = analysis_db_path.to_string_lossy().to_string();
    conn.execute("ATTACH DATABASE ?1 AS analysis_db", [path])?;
    init_attached_analysis_schema(conn)?;
    Ok(())
}

fn attached_analysis_columns(conn: &Connection) -> Result<HashSet<String>> {
    let mut columns = HashSet::new();
    let mut stmt = conn.prepare("PRAGMA analysis_db.table_info(game_analysis)")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        columns.insert(row?.to_lowercase());
    }
    Ok(columns)
}

fn create_attached_analysis_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS analysis_db.game_analysis (
            profile_id TEXT NOT NULL,
            game_id TEXT NOT NULL,
            legacy_game_key TEXT,
            analyzed_pgn TEXT,
            accuracy REAL,
            acpl REAL,
            estimated_elo INTEGER,
            resistance REAL,
            elo_estimated_balanced INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (profile_id, game_id)
        );
        CREATE INDEX IF NOT EXISTS analysis_db.idx_game_analysis_profile_estimated_elo
            ON game_analysis(profile_id, estimated_elo);
        "#,
    )?;
    Ok(())
}

fn init_attached_analysis_schema(conn: &Connection) -> Result<()> {
    let columns = attached_analysis_columns(conn)?;
    if columns.is_empty() {
        create_attached_analysis_schema(conn)?;
        return Ok(());
    }

    if !columns.contains("profile_id") {
        conn.execute_batch(
            r#"
            BEGIN;
            ALTER TABLE analysis_db.game_analysis RENAME TO game_analysis_old;

            CREATE TABLE analysis_db.game_analysis (
                profile_id TEXT NOT NULL,
                game_id TEXT NOT NULL,
                legacy_game_key TEXT,
                analyzed_pgn TEXT,
                accuracy REAL,
                acpl REAL,
                estimated_elo INTEGER,
                resistance REAL,
                elo_estimated_balanced INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (profile_id, game_id)
            );

            INSERT INTO analysis_db.game_analysis (
                profile_id, game_id, legacy_game_key, analyzed_pgn, accuracy, acpl, estimated_elo,
                resistance, elo_estimated_balanced, created_at, updated_at
            )
            SELECT
                '', game_id, game_id, analyzed_pgn, accuracy, acpl, estimated_elo,
                NULL, NULL, created_at, updated_at
            FROM analysis_db.game_analysis_old;

            DROP TABLE analysis_db.game_analysis_old;
            COMMIT;
            "#,
        )?;
    } else {
        if !columns.contains("resistance") {
            conn.execute_batch(
                "ALTER TABLE analysis_db.game_analysis ADD COLUMN resistance REAL;",
            )?;
        }
        if !columns.contains("elo_estimated_balanced") {
            conn.execute_batch(
                "ALTER TABLE analysis_db.game_analysis ADD COLUMN elo_estimated_balanced INTEGER;",
            )?;
        }
    }

    conn.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS analysis_db.idx_game_analysis_profile_estimated_elo
            ON game_analysis(profile_id, estimated_elo);
        "#,
    )?;
    Ok(())
}

fn pgn_movetext_from_blob(moves_blob: &[u8], initial_fen: Option<&str>) -> String {
    let text = String::from_utf8_lossy(moves_blob).to_string();
    if has_any_pgn_tag(&text) {
        return text;
    }

    let start_pos = initial_fen
        .and_then(|f| Fen::from_ascii(f.trim().as_bytes()).ok())
        .and_then(|f| f.into_position(CastlingMode::Chess960).ok());
    if let Ok(tree) = GameTree::from_bytes(moves_blob, start_pos) {
        let movetext = tree.to_string();
        if !movetext.trim().is_empty() && movetext != "Invalid game tree" {
            return movetext;
        }
    }

    text
}

fn sql_placeholders(count: usize) -> String {
    std::iter::repeat("?")
        .take(count)
        .collect::<Vec<_>>()
        .join(",")
}

fn push_text_param(params: &mut Vec<rusqlite::types::Value>, value: impl Into<String>) {
    params.push(rusqlite::types::Value::from(value.into()));
}

fn push_i64_param(params: &mut Vec<rusqlite::types::Value>, value: i64) {
    params.push(rusqlite::types::Value::from(value));
}

struct DashboardGameSqlRow {
    id: i32,
    white_name: String,
    black_name: String,
    event_name: String,
    event_id: i32,
    site_name: String,
    date: Option<String>,
    time: Option<String>,
    time_control: Option<String>,
    fen: Option<String>,
    result: String,
    moves_blob: Vec<u8>,
    ply_count: Option<i32>,
    kind_key: String,
    user_is_white: bool,
    total_count: i32,
    analyzed_pgn: Option<String>,
    accuracy: Option<f64>,
    acpl: Option<f64>,
    estimated_elo: Option<i64>,
    resistance: Option<f64>,
    elo_estimated_balanced: Option<i64>,
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
        if tag.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return true;
        }
    }
    false
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

fn source_key_from_kind(kind: &GamesHistoryKind) -> &'static str {
    match kind {
        GamesHistoryKind::Local => "local",
        GamesHistoryKind::Chesscom => "chesscom",
        GamesHistoryKind::Lichess => "lichess",
        GamesHistoryKind::Chessbase => "chessbase",
    }
}

fn row_matches_source_filter(row: &GamesHistoryRow, wanted_source: &str) -> bool {
    source_key_from_kind(&row.kind) == wanted_source
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
        let side = parse_puzzle_side_from_tags(&metadata.tags)
            .or_else(|| parse_puzzle_side_from_pgn_headers(&raw_pgn));
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

fn empty_dashboard_overview(
    now_ms: i64,
    sample_size: i32,
    trend_weeks: usize,
) -> DashboardOverviewResponse {
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

fn normalize_https_url(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if s.starts_with("http://") || s.starts_with("https://") {
        return Some(s.to_string());
    }
    // Handle values like "lichess.org/..." stored in Sites.Name.
    if s.starts_with("lichess.org/")
        || s.starts_with("www.chess.com/")
        || s.starts_with("chess.com/")
    {
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
    value
        .and_then(|v| v.trim().parse::<i32>().ok())
        .filter(|v| *v > 0)
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

fn find_profile_player_ids_by_usernames(
    conn: &Connection,
    usernames_lower: &HashSet<String>,
) -> Vec<i32> {
    if usernames_lower.is_empty() {
        return Vec::new();
    }

    let mut stmt = match conn.prepare("SELECT Id, Name FROM Players") {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map([], |row| {
        Ok((row.get::<_, i32>(0)?, row.get::<_, Option<String>>(1)?))
    }) {
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
        if (usernames_lower.contains(&lower) || usernames_lower.contains(&stripped))
            && seen.insert(pid)
        {
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

fn resolve_profile_player_ids(
    conn: &Connection,
    usernames_lower: &HashSet<String>,
) -> (HashSet<i32>, Option<i32>) {
    let mut resolved: HashSet<i32> = find_profile_player_ids_by_usernames(conn, usernames_lower)
        .into_iter()
        .collect();
    let inferred_profile_player_id = ensure_profile_player_id(conn);

    // Keep the explicit profile player id in scope even when online account usernames
    // are present. This avoids dropping imported OTB/ChessBase games that belong to
    // the same profile but are stored under the canonical player name id.
    if let Some(pid) = inferred_profile_player_id {
        resolved.insert(pid);
    }

    (resolved, inferred_profile_player_id)
}

#[derive(Debug, Clone, Copy, Default)]
struct OpeningAccuracyAccumulator {
    games: i32,
    accuracy_sum: f64,
    wins: i32,
    outcome_games: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpeningAccuracySortMode {
    Accuracy,
    Frequency,
    WinRate,
}

impl OpeningAccuracySortMode {
    fn from_request(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_lowercase).as_deref() {
            Some("frequency") => Self::Frequency,
            Some("win_rate") | Some("winrate") | Some("wr") => Self::WinRate,
            _ => Self::Accuracy,
        }
    }
}

fn extract_dashboard_main_line_moves(moves_blob: &[u8]) -> Option<Vec<Move>> {
    let start = Chess::default();
    if let Ok(moves) = extract_main_line_moves(moves_blob, Some(start.clone())) {
        if !moves.is_empty() {
            return Some(moves);
        }
    }

    let mut reader = BufferedReader::new_cursor(moves_blob);
    let mut importer = Importer::new(None);
    let game = reader.read_game(&mut importer).ok().flatten().flatten()?;
    let mut position = game.position;
    let mut moves = Vec::new();

    for node in game.tree.nodes() {
        if let GameTreeNode::Move(san_plus) = node {
            if let Ok(mv) = san_plus.san.to_move(&position) {
                moves.push(mv.clone());
                position.play_unchecked(&mv);
            }
        }
    }

    if moves.is_empty() {
        None
    } else {
        Some(moves)
    }
}

fn opening_family_from_moves_blob(moves_blob: &[u8]) -> Option<String> {
    let mut setups = Vec::new();
    let mut chess = Chess::default();
    let main_moves = extract_dashboard_main_line_moves(moves_blob)?;

    for (i, mv) in main_moves.iter().enumerate() {
        if i > 54 {
            break;
        }
        chess.play_unchecked(mv);
        setups.push(chess.clone().into_setup(EnPassantMode::Legal));
    }

    setups.reverse();
    setups
        .iter()
        .find_map(|setup| get_opening_from_setup(setup.clone()).ok())
        .and_then(|name| normalize_opening_family_name(&name))
}

fn opening_accuracy_top_items(
    map: HashMap<String, OpeningAccuracyAccumulator>,
    total_games: i32,
    sort_mode: OpeningAccuracySortMode,
) -> Vec<DashboardOpeningAccuracyTopItem> {
    let min_games = ((total_games.max(0) as f64) * DASHBOARD_OPENING_ACCURACY_MIN_SHARE)
        .ceil()
        .max(1.0) as i32;

    let mut rows = map
        .into_iter()
        .filter_map(|(family, acc)| {
            if acc.games < min_games {
                return None;
            }

            let avg_accuracy = acc.accuracy_sum / acc.games as f64;
            if !avg_accuracy.is_finite() {
                return None;
            }
            let win_rate = if acc.outcome_games > 0 {
                (acc.wins as f64 / acc.outcome_games as f64) * 100.0
            } else {
                0.0
            };

            Some(DashboardOpeningAccuracyTopItem {
                family,
                games: acc.games,
                avg_accuracy,
                win_rate,
            })
        })
        .collect::<Vec<_>>();

    match sort_mode {
        OpeningAccuracySortMode::Accuracy => {
            rows.sort_by(|a, b| {
                b.avg_accuracy
                    .partial_cmp(&a.avg_accuracy)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b.games.cmp(&a.games))
                    .then_with(|| a.family.cmp(&b.family))
            });
        }
        OpeningAccuracySortMode::Frequency => {
            rows.sort_by(|a, b| {
                b.games
                    .cmp(&a.games)
                    .then_with(|| {
                        b.avg_accuracy
                            .partial_cmp(&a.avg_accuracy)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .then_with(|| a.family.cmp(&b.family))
            });
        }
        OpeningAccuracySortMode::WinRate => {
            rows.sort_by(|a, b| {
                b.win_rate
                    .partial_cmp(&a.win_rate)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b.games.cmp(&a.games))
                    .then_with(|| {
                        b.avg_accuracy
                            .partial_cmp(&a.avg_accuracy)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .then_with(|| a.family.cmp(&b.family))
            });
        }
    }
    rows.truncate(5);
    rows
}

fn dashboard_get_opening_accuracy_top_for_connection(
    conn: &Connection,
    analysis_db_path: &Path,
    req: &DashboardOpeningAccuracyTopRequest,
) -> Result<DashboardOpeningAccuracyTopResponse> {
    let profile_id = req.profile_id.trim().to_string();
    if profile_id.is_empty() {
        return Ok(DashboardOpeningAccuracyTopResponse {
            white: vec![],
            black: vec![],
        });
    }

    let usernames_lower = usernames_lower_set(&req.profile_usernames);
    let (profile_player_ids, _) = resolve_profile_player_ids(conn, &usernames_lower);
    if profile_player_ids.is_empty() && usernames_lower.is_empty() {
        return Ok(DashboardOpeningAccuracyTopResponse {
            white: vec![],
            black: vec![],
        });
    }

    attach_analysis_db(conn, analysis_db_path)?;

    let source_limit = if req.game_history_limit <= 0 {
        DASHBOARD_OVERVIEW_MAX_LIMIT
    } else {
        req.game_history_limit.min(DASHBOARD_OVERVIEW_MAX_LIMIT)
    };
    let sort_mode = OpeningAccuracySortMode::from_request(req.sort_mode.as_deref());

    let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();
    let make_match_expr = |column: &str,
                           name_column: &str,
                           params_vec: &mut Vec<rusqlite::types::Value>|
     -> String {
        let mut parts: Vec<String> = Vec::new();
        if !profile_player_ids.is_empty() {
            let placeholders = sql_placeholders(profile_player_ids.len());
            parts.push(format!("{column} IN ({placeholders})"));
            for id in profile_player_ids.iter() {
                push_i64_param(params_vec, *id as i64);
            }
        }
        if !usernames_lower.is_empty() {
            let placeholders = sql_placeholders(usernames_lower.len());
            parts.push(format!(
                "(lower(trim({name_column})) IN ({placeholders}) OR replace(replace(lower(trim({name_column})), 'lichess:', ''), 'chesscom:', '') IN ({placeholders}))"
            ));
            for name in usernames_lower.iter() {
                push_text_param(params_vec, name.clone());
            }
            for name in usernames_lower.iter() {
                push_text_param(params_vec, name.clone());
            }
        }
        if parts.is_empty() {
            "0".to_string()
        } else {
            parts.join(" OR ")
        }
    };

    let white_match_expr = make_match_expr("g.WhiteID", "pw.Name", &mut params_vec);
    let black_match_expr = make_match_expr("g.BlackID", "pb.Name", &mut params_vec);
    push_text_param(&mut params_vec, profile_id);
    let mut seen_time_controls = HashSet::new();
    let time_control_filters = req
        .time_control_categories
        .iter()
        .filter_map(|value| {
            let category = value.trim().to_lowercase();
            if matches!(
                category.as_str(),
                "ultra_bullet"
                    | "bullet"
                    | "blitz"
                    | "rapid"
                    | "classical"
                    | "correspondence"
                    | "daily"
            ) && seen_time_controls.insert(category.clone())
            {
                Some(category)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let time_control_where = if time_control_filters.is_empty() {
        String::new()
    } else {
        for category in time_control_filters.iter() {
            push_text_param(&mut params_vec, category.clone());
        }
        format!(
            "AND time_category IN ({})",
            sql_placeholders(time_control_filters.len())
        )
    };
    push_i64_param(&mut params_vec, source_limit as i64);

    let sql = format!(
        r#"
        WITH raw AS (
            SELECT
                g.ID AS id,
                g.Moves AS moves_blob,
                g.FEN AS fen,
                COALESCE(g.Result, '*') AS result,
                g.TimeControl AS time_control,
                COALESCE(g.Date, '') AS date_sort,
                COALESCE(g.UTCTime, '') AS time_sort,
                a.accuracy AS accuracy,
                CASE
                    WHEN lower(CAST(g.Moves AS TEXT)) LIKE '%lichess.org%'
                      OR lower(COALESCE(s.Name, '')) LIKE '%lichess.org%'
                      OR lower(COALESCE(s.Name, '')) LIKE '%lichess%' THEN 'lichess'
                    WHEN lower(CAST(g.Moves AS TEXT)) LIKE '%chess.com%'
                      OR lower(COALESCE(s.Name, '')) LIKE '%chess.com%' THEN 'chesscom'
                    ELSE 'chessbase'
                END AS kind_key,
                CASE WHEN ({white_match_expr}) THEN 1 ELSE 0 END AS white_is_profile,
                CASE WHEN ({black_match_expr}) THEN 1 ELSE 0 END AS black_is_profile
            FROM Games g
            LEFT JOIN Players pw ON pw.ID = g.WhiteID
            LEFT JOIN Players pb ON pb.ID = g.BlackID
            LEFT JOIN Sites s ON s.ID = g.SiteID
            INNER JOIN analysis_db.game_analysis a
                ON a.profile_id = ? AND a.game_id = CAST(g.ID AS TEXT)
        ),
        base AS (
            SELECT
                moves_blob,
                fen,
                result,
                date_sort,
                time_sort,
                id,
                accuracy,
                CASE
                    WHEN white_is_profile = 1 THEN 1
                    WHEN black_is_profile = 1 THEN 0
                    ELSE 1
                END AS user_is_white,
                white_is_profile,
                black_is_profile,
                CASE
                    WHEN lower(trim(COALESCE(time_control, ''))) LIKE '%ultra%' THEN 'ultra_bullet'
                    WHEN lower(trim(COALESCE(time_control, ''))) LIKE '%bullet%' THEN 'bullet'
                    WHEN lower(trim(COALESCE(time_control, ''))) LIKE '%blitz%' THEN 'blitz'
                    WHEN lower(trim(COALESCE(time_control, ''))) LIKE '%rapid%' THEN 'rapid'
                    WHEN lower(trim(COALESCE(time_control, ''))) LIKE '%classical%' THEN 'classical'
                    WHEN lower(trim(COALESCE(time_control, ''))) LIKE '%correspondence%' THEN 'correspondence'
                    WHEN kind_key = 'chesscom' AND trim(COALESCE(time_control, '')) LIKE '1/%' THEN 'daily'
                    WHEN kind_key = 'lichess' AND trim(COALESCE(time_control, '')) = '-' THEN 'correspondence'
                    WHEN (
                        CASE
                            WHEN time_control IS NULL OR trim(time_control) = '' OR trim(time_control) = '-' OR trim(time_control) LIKE '1/%' THEN NULL
                            WHEN instr(time_control, '+') > 0 THEN
                                CAST(substr(time_control, 1, instr(time_control, '+') - 1) AS INTEGER)
                                + CAST(substr(time_control, instr(time_control, '+') + 1) AS INTEGER) * 40
                            ELSE CAST(time_control AS INTEGER)
                        END
                    ) < 30 THEN 'ultra_bullet'
                    WHEN (
                        CASE
                            WHEN time_control IS NULL OR trim(time_control) = '' OR trim(time_control) = '-' OR trim(time_control) LIKE '1/%' THEN NULL
                            WHEN instr(time_control, '+') > 0 THEN
                                CAST(substr(time_control, 1, instr(time_control, '+') - 1) AS INTEGER)
                                + CAST(substr(time_control, instr(time_control, '+') + 1) AS INTEGER) * 40
                            ELSE CAST(time_control AS INTEGER)
                        END
                    ) < 180 THEN 'bullet'
                    WHEN (
                        CASE
                            WHEN time_control IS NULL OR trim(time_control) = '' OR trim(time_control) = '-' OR trim(time_control) LIKE '1/%' THEN NULL
                            WHEN instr(time_control, '+') > 0 THEN
                                CAST(substr(time_control, 1, instr(time_control, '+') - 1) AS INTEGER)
                                + CAST(substr(time_control, instr(time_control, '+') + 1) AS INTEGER) * 40
                            ELSE CAST(time_control AS INTEGER)
                        END
                    ) < 480 THEN 'blitz'
                    WHEN (
                        CASE
                            WHEN time_control IS NULL OR trim(time_control) = '' OR trim(time_control) = '-' OR trim(time_control) LIKE '1/%' THEN NULL
                            WHEN instr(time_control, '+') > 0 THEN
                                CAST(substr(time_control, 1, instr(time_control, '+') - 1) AS INTEGER)
                                + CAST(substr(time_control, instr(time_control, '+') + 1) AS INTEGER) * 40
                            ELSE CAST(time_control AS INTEGER)
                        END
                    ) < 1500 THEN 'rapid'
                    WHEN (
                        CASE
                            WHEN time_control IS NULL OR trim(time_control) = '' OR trim(time_control) = '-' OR trim(time_control) LIKE '1/%' THEN NULL
                            WHEN instr(time_control, '+') > 0 THEN
                                CAST(substr(time_control, 1, instr(time_control, '+') - 1) AS INTEGER)
                                + CAST(substr(time_control, instr(time_control, '+') + 1) AS INTEGER) * 40
                            ELSE CAST(time_control AS INTEGER)
                        END
                    ) >= 1500 THEN 'classical'
                    ELSE NULL
                END AS time_category
            FROM raw
        ),
        filtered AS (
            SELECT moves_blob, accuracy, user_is_white, result
            FROM base
            WHERE accuracy IS NOT NULL
              AND accuracy > 0
              AND moves_blob IS NOT NULL
              AND (
                  fen IS NULL
                  OR trim(fen) = ''
                  OR trim(fen) = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
              )
              AND (white_is_profile = 1 OR black_is_profile = 1)
              {time_control_where}
            ORDER BY date_sort DESC, time_sort DESC, id DESC
            LIMIT ?
        )
        SELECT moves_blob, accuracy, user_is_white, result
        FROM filtered
        "#
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_vec.iter()), |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, i64>(2)? != 0,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut white = HashMap::<String, OpeningAccuracyAccumulator>::new();
    let mut black = HashMap::<String, OpeningAccuracyAccumulator>::new();
    let mut total_filtered_games = 0;
    for (moves_blob, accuracy, user_is_white, result) in rows {
        if !accuracy.is_finite() || accuracy <= 0.0 {
            continue;
        }
        total_filtered_games += 1;
        let Some(family) = opening_family_from_moves_blob(&moves_blob) else {
            continue;
        };
        let target = if user_is_white {
            &mut white
        } else {
            &mut black
        };
        let entry = target.entry(family).or_default();
        entry.games += 1;
        entry.accuracy_sum += accuracy;
        match result.trim() {
            "1-0" => {
                entry.outcome_games += 1;
                if user_is_white {
                    entry.wins += 1;
                }
            }
            "0-1" => {
                entry.outcome_games += 1;
                if !user_is_white {
                    entry.wins += 1;
                }
            }
            "1/2-1/2" => {
                entry.outcome_games += 1;
            }
            _ => {}
        }
    }

    Ok(DashboardOpeningAccuracyTopResponse {
        white: opening_accuracy_top_items(white, total_filtered_games, sort_mode),
        black: opening_accuracy_top_items(black, total_filtered_games, sort_mode),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn dashboard_get_opening_accuracy_top(
    app: AppHandle,
    _state: State<'_, AppState>,
    req: DashboardOpeningAccuracyTopRequest,
) -> Result<DashboardOpeningAccuracyTopResponse> {
    let profile_id = req.profile_id.trim();
    if profile_id.is_empty() {
        return Ok(DashboardOpeningAccuracyTopResponse {
            white: vec![],
            black: vec![],
        });
    }

    let db_path = parse_profile_db_path(&app, profile_id)?;
    let conn = open_profile_db_connection(&db_path)?;
    let analysis_db_path = resolve_analysis_db_path(&app)?;
    dashboard_get_opening_accuracy_top_for_connection(&conn, &analysis_db_path, &req)
}

#[tauri::command]
#[specta::specta]
pub async fn dashboard_get_games_history_rows(
    app: AppHandle,
    _state: State<'_, AppState>,
    req: GamesHistoryRequest,
) -> Result<GamesHistoryResponse> {
    let profile_id = req.profile_id.trim();
    if profile_id.is_empty() {
        return Ok(GamesHistoryResponse {
            rows: vec![],
            total_count: 0,
        });
    }

    let db_path = parse_profile_db_path(&app, profile_id)?;
    let conn = open_profile_db_connection(&db_path)?;
    let analysis_db_path = resolve_analysis_db_path(&app)?;
    dashboard_get_games_history_rows_for_connection(&conn, &analysis_db_path, &req)
}

fn dashboard_get_games_history_rows_for_connection(
    conn: &Connection,
    analysis_db_path: &Path,
    req: &GamesHistoryRequest,
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
    let (profile_player_ids, _) = resolve_profile_player_ids(conn, &usernames_lower);
    attach_analysis_db(conn, analysis_db_path)?;

    let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();

    let make_match_expr = |column: &str,
                           name_column: &str,
                           params_vec: &mut Vec<rusqlite::types::Value>|
     -> String {
        let mut parts: Vec<String> = Vec::new();
        if !profile_player_ids.is_empty() {
            let placeholders = sql_placeholders(profile_player_ids.len());
            parts.push(format!("{column} IN ({placeholders})"));
            for id in profile_player_ids.iter() {
                push_i64_param(params_vec, *id as i64);
            }
        }
        if !usernames_lower.is_empty() {
            let placeholders = sql_placeholders(usernames_lower.len());
            parts.push(format!(
                "(lower(trim({name_column})) IN ({placeholders}) OR replace(replace(lower(trim({name_column})), 'lichess:', ''), 'chesscom:', '') IN ({placeholders}))"
            ));
            for name in usernames_lower.iter() {
                push_text_param(params_vec, name.clone());
            }
            for name in usernames_lower.iter() {
                push_text_param(params_vec, name.clone());
            }
        }
        if parts.is_empty() {
            "0".to_string()
        } else {
            parts.join(" OR ")
        }
    };

    let white_match_expr = make_match_expr("g.WhiteID", "pw.Name", &mut params_vec);
    let black_match_expr = make_match_expr("g.BlackID", "pb.Name", &mut params_vec);
    push_text_param(&mut params_vec, profile_id.clone());
    let has_explicit_profile_match = !profile_player_ids.is_empty() || !usernames_lower.is_empty();

    let mut where_clauses: Vec<String> = vec![if has_explicit_profile_match {
        "(white_is_profile = 1 OR black_is_profile = 1 OR is_managed_event = 1)".to_string()
    } else {
        "(is_managed_event = 1 OR kind_key = 'chessbase')".to_string()
    }];

    if let Some(event_id) = req.event_filter_id {
        where_clauses.push("event_id = ?".to_string());
        push_i64_param(&mut params_vec, event_id as i64);
    }
    if let Some(opponent_id) = req.selected_opponent_id {
        where_clauses.push(
            "((user_is_white = 1 AND black_id = ?) OR (user_is_white = 0 AND white_id = ?))"
                .to_string(),
        );
        push_i64_param(&mut params_vec, opponent_id as i64);
        push_i64_param(&mut params_vec, opponent_id as i64);
    }
    if let Some(ref q) = req.opponent_contains {
        let q = q.trim().to_lowercase();
        if !q.is_empty() {
            where_clauses.push("lower(opponent) LIKE ?".to_string());
            push_text_param(&mut params_vec, format!("%{}%", q));
        }
    }
    if let Some(ref want) = req.result_filter {
        let want = want.trim().to_lowercase();
        if want == "win" || want == "loss" || want == "draw" {
            where_clauses.push("outcome = ?".to_string());
            push_text_param(&mut params_vec, want);
        }
    }
    if let Some(ref want_source) = req.source_filter {
        let want_source = want_source.trim().to_lowercase();
        if !want_source.is_empty() {
            where_clauses.push("kind_key = ?".to_string());
            push_text_param(&mut params_vec, want_source);
        }
    }
    if let Some(ref want_tc) = req.time_control_category {
        let want_tc = want_tc.trim().to_lowercase();
        if !want_tc.is_empty() {
            where_clauses.push("time_category = ?".to_string());
            push_text_param(&mut params_vec, want_tc);
        }
    }
    if let Some(ref want_color) = req.player_color {
        let want_color = want_color.trim().to_lowercase();
        if want_color == "white" || want_color == "black" {
            where_clauses.push("user_color = ?".to_string());
            push_text_param(&mut params_vec, want_color);
        }
    }
    if let Some(min_moves) = req.min_moves {
        if min_moves > 0 {
            where_clauses.push("full_moves >= ?".to_string());
            push_i64_param(&mut params_vec, min_moves as i64);
        }
    }

    let sort_by = req.sort_by.clone().unwrap_or_else(|| "date".to_string());
    let sort_dir = req
        .sort_direction
        .clone()
        .unwrap_or_else(|| "desc".to_string())
        .to_lowercase();
    let sort_direction = if sort_dir == "asc" { "ASC" } else { "DESC" };
    let order_by = if sort_by == "elo" {
        format!(
            "ORDER BY COALESCE(estimated_elo, 0) {sort_direction}, date_sort {sort_direction}, time_sort {sort_direction}, id {sort_direction}"
        )
    } else {
        format!(
            "ORDER BY date_sort {sort_direction}, time_sort {sort_direction}, id {sort_direction}"
        )
    };

    let page = req.page.max(1);
    let request_limit = if req.game_history_limit > 0 {
        req.game_history_limit
    } else {
        req.page_size
    };
    let page_size = req.page_size.max(1).min(request_limit.max(1));
    let offset = (page - 1) * page_size;
    push_i64_param(&mut params_vec, page_size as i64);
    push_i64_param(&mut params_vec, offset as i64);

    let where_sql = where_clauses.join(" AND ");
    let sql = format!(
        r#"
        WITH raw AS (
            SELECT
                g.ID AS id,
                g.WhiteID AS white_id,
                g.BlackID AS black_id,
                COALESCE(pw.Name, '') AS white_name,
                COALESCE(pb.Name, '') AS black_name,
                COALESCE(e.Name, '') AS event_name,
                e.ID AS event_id,
                COALESCE(s.Name, '') AS site_name,
                g.Date AS date,
                g.UTCTime AS time,
                g.TimeControl AS time_control,
                g.FEN AS fen,
                COALESCE(g.Result, '*') AS result,
                g.Moves AS moves_blob,
                CAST(g.Moves AS TEXT) AS moves_text,
                g.PlyCount AS ply_count,
                CASE
                    WHEN lower(trim(COALESCE(s.Name, ''))) = 'local'
                      OR lower(CAST(g.Moves AS TEXT)) LIKE '%[site "local"]%' THEN 'local'
                    WHEN lower(CAST(g.Moves AS TEXT)) LIKE '%lichess.org%'
                      OR lower(COALESCE(s.Name, '')) LIKE '%lichess.org%'
                      OR lower(COALESCE(s.Name, '')) LIKE '%lichess%' THEN 'lichess'
                    WHEN lower(CAST(g.Moves AS TEXT)) LIKE '%chess.com%'
                      OR lower(COALESCE(s.Name, '')) LIKE '%chess.com%' THEN 'chesscom'
                    WHEN lower(CAST(g.Moves AS TEXT)) LIKE '%chessbase.com%'
                      OR lower(COALESCE(s.Name, '')) LIKE '%chessbase.com%' THEN 'chessbase'
                    ELSE 'chessbase'
                END AS kind_key,
                CASE WHEN ({white_match_expr}) THEN 1 ELSE 0 END AS white_is_profile,
                CASE WHEN ({black_match_expr}) THEN 1 ELSE 0 END AS black_is_profile,
                CASE WHEN e.EventType IS NOT NULL AND trim(e.EventType) <> '' THEN 1 ELSE 0 END AS is_managed_event,
                a.analyzed_pgn AS analyzed_pgn,
                a.accuracy AS accuracy,
                a.acpl AS acpl,
                a.estimated_elo AS estimated_elo,
                a.resistance AS resistance,
                a.elo_estimated_balanced AS elo_estimated_balanced
            FROM Games g
            LEFT JOIN Players pw ON pw.ID = g.WhiteID
            LEFT JOIN Players pb ON pb.ID = g.BlackID
            LEFT JOIN Events e ON e.ID = g.EventID
            LEFT JOIN Sites s ON s.ID = g.SiteID
            LEFT JOIN analysis_db.game_analysis a
                ON a.profile_id = ? AND a.game_id = CAST(g.ID AS TEXT)
        ),
        base AS (
            SELECT
                *,
                CASE
                    WHEN white_is_profile = 1 THEN 1
                    WHEN black_is_profile = 1 THEN 0
                    ELSE 1
                END AS user_is_white,
                CASE
                    WHEN white_is_profile = 1 THEN 'white'
                    WHEN black_is_profile = 1 THEN 'black'
                    ELSE 'white'
                END AS user_color,
                CASE
                    WHEN white_is_profile = 1 THEN black_name
                    WHEN black_is_profile = 1 THEN white_name
                    ELSE black_name
                END AS opponent,
                max(1, (COALESCE(ply_count, 0) + 1) / 2) AS full_moves,
                CASE
                    WHEN lower(trim(COALESCE(time_control, ''))) LIKE '%ultra%' THEN 'ultra_bullet'
                    WHEN lower(trim(COALESCE(time_control, ''))) LIKE '%bullet%' THEN 'bullet'
                    WHEN lower(trim(COALESCE(time_control, ''))) LIKE '%blitz%' THEN 'blitz'
                    WHEN lower(trim(COALESCE(time_control, ''))) LIKE '%rapid%' THEN 'rapid'
                    WHEN lower(trim(COALESCE(time_control, ''))) LIKE '%classical%' THEN 'classical'
                    WHEN lower(trim(COALESCE(time_control, ''))) LIKE '%correspondence%' THEN 'correspondence'
                    WHEN kind_key = 'chesscom' AND trim(COALESCE(time_control, '')) LIKE '1/%' THEN 'daily'
                    WHEN kind_key = 'lichess' AND trim(COALESCE(time_control, '')) = '-' THEN 'correspondence'
                    WHEN (
                        CASE
                            WHEN time_control IS NULL OR trim(time_control) = '' OR trim(time_control) = '-' OR trim(time_control) LIKE '1/%' THEN NULL
                            WHEN instr(time_control, '+') > 0 THEN
                                CAST(substr(time_control, 1, instr(time_control, '+') - 1) AS INTEGER)
                                + CAST(substr(time_control, instr(time_control, '+') + 1) AS INTEGER) * 40
                            ELSE CAST(time_control AS INTEGER)
                        END
                    ) < 30 THEN 'ultra_bullet'
                    WHEN (
                        CASE
                            WHEN time_control IS NULL OR trim(time_control) = '' OR trim(time_control) = '-' OR trim(time_control) LIKE '1/%' THEN NULL
                            WHEN instr(time_control, '+') > 0 THEN
                                CAST(substr(time_control, 1, instr(time_control, '+') - 1) AS INTEGER)
                                + CAST(substr(time_control, instr(time_control, '+') + 1) AS INTEGER) * 40
                            ELSE CAST(time_control AS INTEGER)
                        END
                    ) < 180 THEN 'bullet'
                    WHEN (
                        CASE
                            WHEN time_control IS NULL OR trim(time_control) = '' OR trim(time_control) = '-' OR trim(time_control) LIKE '1/%' THEN NULL
                            WHEN instr(time_control, '+') > 0 THEN
                                CAST(substr(time_control, 1, instr(time_control, '+') - 1) AS INTEGER)
                                + CAST(substr(time_control, instr(time_control, '+') + 1) AS INTEGER) * 40
                            ELSE CAST(time_control AS INTEGER)
                        END
                    ) < 480 THEN 'blitz'
                    WHEN (
                        CASE
                            WHEN time_control IS NULL OR trim(time_control) = '' OR trim(time_control) = '-' OR trim(time_control) LIKE '1/%' THEN NULL
                            WHEN instr(time_control, '+') > 0 THEN
                                CAST(substr(time_control, 1, instr(time_control, '+') - 1) AS INTEGER)
                                + CAST(substr(time_control, instr(time_control, '+') + 1) AS INTEGER) * 40
                            ELSE CAST(time_control AS INTEGER)
                        END
                    ) < 1500 THEN 'rapid'
                    WHEN (
                        CASE
                            WHEN time_control IS NULL OR trim(time_control) = '' OR trim(time_control) = '-' OR trim(time_control) LIKE '1/%' THEN NULL
                            WHEN instr(time_control, '+') > 0 THEN
                                CAST(substr(time_control, 1, instr(time_control, '+') - 1) AS INTEGER)
                                + CAST(substr(time_control, instr(time_control, '+') + 1) AS INTEGER) * 40
                            ELSE CAST(time_control AS INTEGER)
                        END
                    ) >= 1500 THEN 'classical'
                    ELSE NULL
                END AS time_category,
                CASE
                    WHEN result = '1/2-1/2' THEN 'draw'
                    WHEN result = '1-0' AND (CASE WHEN white_is_profile = 1 THEN 1 WHEN black_is_profile = 1 THEN 0 ELSE 1 END) = 1 THEN 'win'
                    WHEN result = '0-1' AND (CASE WHEN white_is_profile = 1 THEN 1 WHEN black_is_profile = 1 THEN 0 ELSE 1 END) = 0 THEN 'win'
                    WHEN result = '1-0' OR result = '0-1' THEN 'loss'
                    ELSE 'unknown'
                END AS outcome,
                COALESCE(date, '') AS date_sort,
                COALESCE(time, '') AS time_sort
            FROM raw
        ),
        filtered AS (
            SELECT *, COUNT(*) OVER() AS total_count
            FROM base
            WHERE {where_sql}
            {order_by}
            LIMIT ? OFFSET ?
        )
        SELECT
            id, white_name, black_name, event_name, event_id, site_name,
            date, time, time_control, fen, result, moves_blob, ply_count, kind_key,
            user_is_white, total_count, analyzed_pgn, accuracy, acpl, estimated_elo,
            resistance, elo_estimated_balanced
        FROM filtered
        "#
    );

    let mut stmt = conn.prepare(&sql)?;
    let sql_rows = stmt
        .query_map(rusqlite::params_from_iter(params_vec.iter()), |row| {
            Ok(DashboardGameSqlRow {
                id: row.get(0)?,
                white_name: row.get(1)?,
                black_name: row.get(2)?,
                event_name: row.get(3)?,
                event_id: row.get(4)?,
                site_name: row.get(5)?,
                date: row.get(6)?,
                time: row.get(7)?,
                time_control: row.get(8)?,
                fen: row.get(9)?,
                result: row.get(10)?,
                moves_blob: row.get(11)?,
                ply_count: row.get(12)?,
                kind_key: row.get(13)?,
                user_is_white: row.get::<_, i64>(14)? != 0,
                total_count: row.get(15)?,
                analyzed_pgn: row.get(16)?,
                accuracy: row.get(17)?,
                acpl: row.get(18)?,
                estimated_elo: row.get(19)?,
                resistance: row.get(20)?,
                elo_estimated_balanced: row.get(21)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let total_count = sql_rows.first().map(|row| row.total_count).unwrap_or(0);
    let mut rows: Vec<GamesHistoryRow> = Vec::with_capacity(sql_rows.len());
    for row in sql_rows {
        let kind = match row.kind_key.as_str() {
            "local" => GamesHistoryKind::Local,
            "chesscom" => GamesHistoryKind::Chesscom,
            "lichess" => GamesHistoryKind::Lichess,
            _ => GamesHistoryKind::Chessbase,
        };
        let moves_for_pgn = pgn_movetext_from_blob(&row.moves_blob, row.fen.as_deref());
        let site_tag = parse_site_tag(&moves_for_pgn);
        let link_tag = parse_link_tag(&moves_for_pgn);
        let chesscom_url_from_link = link_tag.as_deref().and_then(extract_chesscom_url);
        let mut external_key = row.id.to_string();
        let mut external_url = None;

        if matches!(kind, GamesHistoryKind::Lichess) {
            if let Some(site) = site_tag.as_deref() {
                if site.to_lowercase().contains("lichess.org/broadcast/") {
                    external_url = normalize_https_url(site);
                } else if let Some(id) = extract_lichess_id_from_site(site) {
                    external_key = id.clone();
                    external_url = Some(format!("https://lichess.org/{}", id));
                }
            }
            if external_url.is_none() {
                if let Some(id) = extract_lichess_id_from_site(&row.site_name) {
                    external_key = id.clone();
                    external_url = Some(format!("https://lichess.org/{}", id));
                } else {
                    external_url = normalize_https_url(&row.site_name);
                }
            }
        } else if matches!(kind, GamesHistoryKind::Chesscom) {
            if let Some(url) = site_tag
                .as_deref()
                .and_then(extract_chesscom_url)
                .or_else(|| chesscom_url_from_link.clone())
                .or_else(|| extract_chesscom_url(&row.site_name))
            {
                external_key = url.clone();
                external_url = Some(url);
            }
        } else if matches!(kind, GamesHistoryKind::Local | GamesHistoryKind::Chessbase) {
            external_key = row.id.to_string();
            external_url = None;
        }

        let white_name = strip_account_key(&row.white_name).to_string();
        let black_name = strip_account_key(&row.black_name).to_string();
        let opponent = if row.user_is_white {
            black_name.clone()
        } else {
            white_name.clone()
        };
        let opponent = if opponent.trim().is_empty() || opponent.trim() == "?" {
            "?".to_string()
        } else {
            opponent
        };
        let user_color = if row.user_is_white { "white" } else { "black" };
        let full_moves = ((row.ply_count.unwrap_or(0) as f64) / 2.0).ceil().max(1.0) as i32;
        let time_control_category = row
            .time_control
            .as_deref()
            .and_then(|tc| time_control_category(kind.clone(), tc));
        let initial_fen = row
            .fen
            .as_ref()
            .map(|fen| fen.trim().to_string())
            .filter(|fen| !fen.is_empty());
        let base_pgn = if include_base_pgn {
            if moves_for_pgn.trim().is_empty() {
                None
            } else if matches!(kind, GamesHistoryKind::Chessbase | GamesHistoryKind::Local) {
                Some(build_minimal_pgn_from_db_game(
                    &white_name,
                    &black_name,
                    &row.event_name,
                    &row.site_name,
                    row.date.as_deref(),
                    row.time.as_deref(),
                    row.time_control.as_deref(),
                    initial_fen.as_deref(),
                    &row.result,
                    &moves_for_pgn,
                ))
            } else {
                Some(moves_for_pgn.clone())
            }
        } else {
            None
        };
        let analyzed_pgn = row.analyzed_pgn.filter(|pgn| !pgn.trim().is_empty());
        let pgn = if include_analyzed_pgn {
            analyzed_pgn.clone().or(base_pgn)
        } else {
            base_pgn
        };
        let is_analyzed = analyzed_pgn.is_some() || row.accuracy.is_some() || row.acpl.is_some();

        rows.push(GamesHistoryRow {
            kind,
            analysis_game_id: row.id.to_string(),
            game_key: external_key,
            external_url,
            opponent,
            color: user_color.to_string(),
            outcome: outcome_from_result(user_color, &row.result),
            pgn,
            initial_fen,
            accuracy: if include_analysis_stats {
                row.accuracy
            } else {
                None
            },
            acpl: if include_analysis_stats {
                row.acpl
            } else {
                None
            },
            estimated_elo: if include_analysis_stats {
                row.estimated_elo
            } else {
                None
            },
            resistance: if include_analysis_stats {
                row.resistance
            } else {
                None
            },
            elo_estimated_balanced: if include_analysis_stats {
                row.elo_estimated_balanced
            } else {
                None
            },
            moves: full_moves,
            time_control: row.time_control.filter(|tc| !tc.trim().is_empty()),
            time_control_category,
            timestamp_ms: parse_timestamp_ms(row.date.as_deref(), row.time.as_deref()),
            event_id: Some(row.event_id),
            event_name: Some(row.event_name),
            is_analyzed,
        });
    }

    Ok(GamesHistoryResponse { rows, total_count })
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
        source_filter: None,
        player_color: None,
        min_moves: None,
        sort_by: Some("date".to_string()),
        sort_direction: Some("desc".to_string()),
        profile_usernames: profile_usernames.clone(),
        include_base_pgn: Some(false),
        include_analyzed_pgn: Some(false),
        include_analysis_stats: Some(true),
    };

    let mut rows = dashboard_get_games_history_rows(app.clone(), state.clone(), rows_req)
        .await?
        .rows;
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
            row.timestamp_ms >= previous_week_start_ms
                && row.timestamp_ms < previous_week_end_exclusive_ms
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
    let previous_week_outcome_count =
        previous_week_wins + previous_week_losses + previous_week_draws;
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
    let oldest_tracked_week_start = tracked_week_starts.last().copied().unwrap_or(week_start_ms);
    let needs_annotation_scan = rows.iter().any(|row| {
        row.is_analyzed
            && row.timestamp_ms >= oldest_tracked_week_start
            && row.timestamp_ms <= now_ms
    });
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
            source_filter: None,
            player_color: None,
            min_moves: None,
            sort_by: Some("date".to_string()),
            sort_direction: Some("desc".to_string()),
            profile_usernames: profile_usernames.clone(),
            include_base_pgn: Some(true),
            include_analyzed_pgn: Some(true),
            include_analysis_stats: Some(false),
        };
        let analyzed_rows = dashboard_get_games_history_rows(app.clone(), state, analyzed_rows_req)
            .await?
            .rows;
        for row in analyzed_rows {
            if !row.is_analyzed {
                continue;
            }
            let Some(pgn) = row.pgn else {
                continue;
            };
            analyzed_pgn_by_key.insert(
                row.analysis_game_id.clone(),
                (pgn.clone(), row.initial_fen.clone()),
            );
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

        let annotations =
            collect_player_annotation_summary(pgn, initial_fen.as_deref(), color.as_str());
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

    let week_blunder_rate =
        to_rate_percent(current_bucket.blunders, current_bucket.annotated_moves);
    let previous_week_blunder_rate =
        to_rate_percent(previous_bucket.blunders, previous_bucket.annotated_moves);
    let week_brilliant_rate =
        to_rate_percent(current_bucket.brilliants, current_bucket.annotated_moves);
    let previous_week_brilliant_rate =
        to_rate_percent(previous_bucket.brilliants, previous_bucket.annotated_moves);
    let week_mistake_rate =
        to_rate_percent(current_bucket.mistakes, current_bucket.annotated_moves);
    let previous_week_mistake_rate =
        to_rate_percent(previous_bucket.mistakes, previous_bucket.annotated_moves);
    let week_inaccuracy_rate =
        to_rate_percent(current_bucket.inaccuracies, current_bucket.annotated_moves);
    let previous_week_inaccuracy_rate = to_rate_percent(
        previous_bucket.inaccuracies,
        previous_bucket.annotated_moves,
    );
    let week_accuracy = to_average(current_bucket.accuracy_sum, current_bucket.accuracy_count);
    let previous_week_accuracy =
        to_average(previous_bucket.accuracy_sum, previous_bucket.accuracy_count);
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
    let requested_source_filter = req.source_filter.clone();
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
        source_filter: None,
        player_color: req.player_color,
        min_moves: req.min_moves,
        sort_by: Some("date".to_string()),
        sort_direction: Some("desc".to_string()),
        profile_usernames: req.profile_usernames,
        include_base_pgn: Some(false),
        include_analyzed_pgn: Some(false),
        include_analysis_stats: Some(false),
    };

    let rows = dashboard_get_games_history_rows(app, state, rows_req)
        .await?
        .rows;
    let mut seen_sources: HashSet<String> = HashSet::new();
    for row in rows.iter() {
        seen_sources.insert(source_key_from_kind(&row.kind).to_string());
    }

    let source_filtered_rows: Vec<&GamesHistoryRow> =
        if let Some(wanted_source) = requested_source_filter.as_ref() {
            let wanted_source = wanted_source.trim().to_lowercase();
            if wanted_source.is_empty() {
                rows.iter().collect()
            } else {
                rows.iter()
                    .filter(|row| row_matches_source_filter(row, &wanted_source))
                    .collect()
            }
        } else {
            rows.iter().collect()
        };

    let mut seen_time_controls: HashSet<String> = HashSet::new();
    for row in source_filtered_rows {
        if let Some(cat) = row.time_control_category.as_deref() {
            let trimmed = cat.trim().to_lowercase();
            if !trimmed.is_empty() {
                seen_time_controls.insert(trimmed);
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
            if seen_time_controls.contains(*value) {
                Some((*value).to_string())
            } else {
                None
            }
        })
        .collect();

    let ordered_sources = ["local", "chesscom", "lichess", "chessbase"];
    let available_sources = ordered_sources
        .iter()
        .filter_map(|value| {
            if seen_sources.contains(*value) {
                Some((*value).to_string())
            } else {
                None
            }
        })
        .collect();

    Ok(GamesHistoryFilterMetaResponse {
        available_time_control_categories,
        available_sources,
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

fn compute_analyze_all_counts(
    rows: &[GamesHistoryRow],
    target: AnalyzeAllTarget,
) -> AnalyzeAllCountsResponse {
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
    let scoped_limit = req.game_history_limit.max(5000);
    let rows_req = GamesHistoryRequest {
        profile_id,
        game_history_limit: scoped_limit,
        page: 1,
        page_size: scoped_limit,
        event_filter_id: req.event_filter_id,
        selected_opponent_id: req.selected_opponent_id,
        opponent_contains: req.opponent_contains,
        time_control_category: req.time_control_category,
        result_filter: req.result_filter,
        source_filter: None,
        player_color: req.player_color,
        min_moves: req.min_moves,
        sort_by: Some("date".to_string()),
        sort_direction: Some("desc".to_string()),
        profile_usernames: req.profile_usernames,
        include_base_pgn: Some(false),
        include_analyzed_pgn: Some(false),
        include_analysis_stats: Some(false),
    };
    let mut rows = dashboard_get_games_history_rows(app, state, rows_req)
        .await?
        .rows;

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
            opponent_contains: req.opponent_contains,
            time_control_category: req.time_control_category,
            result_filter: req.result_filter,
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
    let profile_player_ids: Vec<i32> = match open_profile_db_connection(&db_path) {
        Ok(conn) => {
            let (resolved_ids, _) = resolve_profile_player_ids(&conn, &usernames_lower);
            let mut ids: Vec<i32> = resolved_ids.into_iter().collect();
            ids.sort_unstable();
            ids
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
        let conn = open_profile_db_connection(&db_path)?;
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
        let conn = open_profile_db_connection(&db_path)?;
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
    let conn = open_profile_db_connection(db_path)?;

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
        .query_row(
            [like_moves_1, like_moves_2, like_site_1, like_site_2],
            |row| row.get::<_, i64>(0),
        )
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
    let conn = open_profile_db_connection(db_path)?;

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

    let Some((initial_fen, moves)) = decode_uci_moves_from_blob(&moves_blob, fen_opt.as_deref())
    else {
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
    let conn = open_profile_db_connection(&db_path)?;

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
    let (Some(date), Some(time), Some(white), Some(black)) =
        (date_opt, time_opt, white_opt, black_opt)
    else {
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
        if !name.starts_with(&format!("profile_{}_chesscom_", profile_id))
            || !name.ends_with(".pgn")
        {
            continue;
        }
        if let Some(link) = find_chesscom_link_in_pgn_export(&path, &date, &time, &white, &black) {
            found = Some(link);
            break;
        }
    }

    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_dashboard_profile_db(conn: &Connection) {
        conn.execute_batch(
            r#"
            CREATE TABLE Info (
                Name TEXT PRIMARY KEY NOT NULL,
                Value TEXT
            );
            CREATE TABLE Events (
                ID INTEGER PRIMARY KEY,
                Name TEXT,
                EventType TEXT,
                Location TEXT,
                StartDate TEXT,
                EndDate TEXT,
                TimeControl TEXT
            );
            CREATE TABLE Sites (
                ID INTEGER PRIMARY KEY,
                Name TEXT
            );
            CREATE TABLE Players (
                ID INTEGER PRIMARY KEY,
                Name TEXT,
                Elo INTEGER
            );
            CREATE TABLE Games (
                ID INTEGER PRIMARY KEY,
                EventID INTEGER,
                SiteID INTEGER,
                Date TEXT,
                UTCTime TEXT,
                Round INTEGER,
                WhiteID INTEGER,
                WhiteElo INTEGER,
                BlackID INTEGER,
                BlackElo INTEGER,
                WhiteMaterial INTEGER,
                BlackMaterial INTEGER,
                Result TEXT,
                Termination TEXT,
                TimeControl TEXT,
                ECO TEXT,
                PlyCount INTEGER,
                FEN TEXT,
                Moves BLOB,
                PawnHome BLOB
            );
            INSERT INTO Info (Name, Value) VALUES ('ProfilePlayerId', '1');
            INSERT INTO Players (ID, Name, Elo) VALUES
                (1, 'currentuser', 2000),
                (2, 'JoseCortes11', 1900),
                (3, 'Ba1r', 1850);
            INSERT INTO Events (ID, Name, EventType) VALUES
                (1, 'Rated Rapid game', ''),
                (2, 'Rated Classical game', '');
            INSERT INTO Sites (ID, Name) VALUES
                (1, 'https://lichess.org/Jose1234'),
                (2, 'https://lichess.org/Ba1r1234');
            "#,
        )
        .unwrap();

        let jose_pgn = r#"[Event "Rated Rapid game"]
[Site "https://lichess.org/Jose1234"]
[Date "2026.05.11"]
[White "currentuser"]
[Black "JoseCortes11"]
[Result "1-0"]

1. e4 c5 1-0"#;
        let bair_pgn = r#"[Event "Rated Classical game"]
[Site "https://lichess.org/Ba1r1234"]
[Date "2026.04.10"]
[White "currentuser"]
[Black "Ba1r"]
[Result "1/2-1/2"]

1. d4 Nf6 1/2-1/2"#;
        conn.execute(
            r#"
            INSERT INTO Games (
                ID, EventID, SiteID, Date, UTCTime, Round, WhiteID, WhiteElo, BlackID, BlackElo,
                Result, TimeControl, PlyCount, FEN, Moves
            )
            VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 2000, ?7, 1900, ?8, '600+0', ?9, NULL, ?10)
            "#,
            params![
                101,
                1,
                1,
                "2026.05.11",
                "10:00:00",
                1,
                2,
                "1-0",
                2,
                jose_pgn.as_bytes()
            ],
        )
        .unwrap();
        conn.execute(
            r#"
            INSERT INTO Games (
                ID, EventID, SiteID, Date, UTCTime, Round, WhiteID, WhiteElo, BlackID, BlackElo,
                Result, TimeControl, PlyCount, FEN, Moves
            )
            VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 2000, ?7, 1850, ?8, '1800+0', ?9, NULL, ?10)
            "#,
            params![
                202,
                2,
                2,
                "2026.04.10",
                "10:00:00",
                1,
                3,
                "1/2-1/2",
                2,
                bair_pgn.as_bytes()
            ],
        )
        .unwrap();
    }

    fn create_analysis_db(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE game_analysis (
                profile_id TEXT NOT NULL,
                game_id TEXT NOT NULL,
                legacy_game_key TEXT,
                analyzed_pgn TEXT,
                accuracy REAL,
                acpl REAL,
                estimated_elo INTEGER,
                resistance REAL,
                elo_estimated_balanced INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (profile_id, game_id)
            );
            "#,
        )
        .unwrap();

        let jose_analyzed_pgn = r#"[Event "Rated Rapid game"]
[Site "https://lichess.org/Jose1234"]
[Date "2026.05.11"]
[White "currentuser"]
[Black "JoseCortes11"]
[Result "1-0"]

1. e4 {[%eval 0.34]} c5 1-0"#;
        let wrong_profile_pgn = r#"[Event "Rated Rapid game"]
[Site "https://lichess.org/Jose1234"]
[Date "2026.05.11"]
[White "SomeoneElse"]
[Black "JoseCortes11"]
[Result "0-1"]

1. d4 Nf6 0-1"#;
        let legacy_pgn = r#"[Event "Rated Classical game"]
[Site "https://lichess.org/Ba1r1234"]
[Date "2026.04.10"]
[White "currentuser"]
[Black "Ba1r"]
[Result "1/2-1/2"]

1. d4 {[%eval -0.20]} Nf6 1/2-1/2"#;
        conn.execute(
            r#"
            INSERT INTO game_analysis (
                profile_id, game_id, analyzed_pgn, accuracy, acpl, estimated_elo
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            params!["profile-a", "101", jose_analyzed_pgn, 90.0, 36.0, 2170],
        )
        .unwrap();
        conn.execute(
            r#"
            INSERT INTO game_analysis (
                profile_id, game_id, analyzed_pgn, accuracy, acpl, estimated_elo
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            params!["other-profile", "101", wrong_profile_pgn, 40.0, 120.0, 1100],
        )
        .unwrap();
        conn.execute(
            r#"
            INSERT INTO game_analysis (
                profile_id, game_id, analyzed_pgn, accuracy, acpl, estimated_elo
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            params!["", "202", legacy_pgn, 99.0, 1.0, 3000],
        )
        .unwrap();
    }

    fn dashboard_request() -> GamesHistoryRequest {
        GamesHistoryRequest {
            profile_id: "profile-a".to_string(),
            game_history_limit: 100,
            page: 1,
            page_size: 25,
            event_filter_id: None,
            selected_opponent_id: None,
            opponent_contains: None,
            time_control_category: None,
            result_filter: None,
            source_filter: None,
            player_color: None,
            min_moves: None,
            sort_by: Some("date".to_string()),
            sort_direction: Some("desc".to_string()),
            profile_usernames: vec!["currentuser".to_string()],
            include_base_pgn: Some(true),
            include_analyzed_pgn: Some(true),
            include_analysis_stats: Some(true),
        }
    }

    #[test]
    fn dashboard_rows_join_analysis_only_by_profile_id_and_game_id() {
        let temp = TempDir::new().unwrap();
        let profile_conn = Connection::open_in_memory().unwrap();
        create_dashboard_profile_db(&profile_conn);
        let analysis_path = temp.path().join("analysis.db3");
        create_analysis_db(&analysis_path);

        let response = dashboard_get_games_history_rows_for_connection(
            &profile_conn,
            &analysis_path,
            &dashboard_request(),
        )
        .unwrap();

        assert_eq!(response.total_count, 2);
        let jose_row = response
            .rows
            .iter()
            .find(|row| row.analysis_game_id == "101")
            .unwrap();
        assert_eq!(jose_row.opponent, "JoseCortes11");
        assert!(jose_row.is_analyzed);
        assert_eq!(jose_row.accuracy, Some(90.0));
        assert!(jose_row.pgn.as_deref().unwrap().contains("JoseCortes11"));
        assert!(jose_row.pgn.as_deref().unwrap().contains("[%eval 0.34]"));
        assert!(!jose_row.pgn.as_deref().unwrap().contains("SomeoneElse"));

        let legacy_row = response
            .rows
            .iter()
            .find(|row| row.analysis_game_id == "202")
            .unwrap();
        assert_eq!(legacy_row.opponent, "Ba1r");
        assert!(!legacy_row.is_analyzed);
        assert_eq!(legacy_row.accuracy, None);
        assert!(legacy_row.pgn.as_deref().unwrap().contains("Ba1r"));
        assert!(!legacy_row.pgn.as_deref().unwrap().contains("[%eval -0.20]"));
    }

    #[test]
    fn dashboard_opening_accuracy_top_groups_analyzed_games_by_family_and_color() {
        let temp = TempDir::new().unwrap();
        let profile_conn = Connection::open_in_memory().unwrap();
        create_dashboard_profile_db(&profile_conn);
        let analysis_path = temp.path().join("analysis.db3");
        create_analysis_db(&analysis_path);

        let black_sicilian_pgn = r#"[Event "Rated Rapid game"]
[Site "https://lichess.org/BlackSicilian"]
[Date "2026.05.12"]
[White "JoseCortes11"]
[Black "currentuser"]
[Result "0-1"]

1. e4 c5 0-1"#;
        profile_conn
            .execute(
                r#"
                INSERT INTO Games (
                    ID, EventID, SiteID, Date, UTCTime, Round, WhiteID, WhiteElo, BlackID, BlackElo,
                    Result, TimeControl, PlyCount, FEN, Moves
                )
                VALUES (?1, 1, 1, ?2, ?3, 1, 2, 1900, 1, 2000, '0-1', '600+0', 2, NULL, ?4)
                "#,
                params![303, "2026.05.12", "10:00:00", black_sicilian_pgn.as_bytes()],
            )
            .unwrap();

        let analysis_conn = Connection::open(&analysis_path).unwrap();
        analysis_conn
            .execute(
                r#"
                INSERT INTO game_analysis (
                    profile_id, game_id, analyzed_pgn, accuracy, acpl, estimated_elo
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params!["profile-a", "303", black_sicilian_pgn, 88.0, 42.0, 2050],
            )
            .unwrap();
        drop(analysis_conn);

        let response = dashboard_get_opening_accuracy_top_for_connection(
            &profile_conn,
            &analysis_path,
            &DashboardOpeningAccuracyTopRequest {
                profile_id: "profile-a".to_string(),
                game_history_limit: 100,
                profile_usernames: vec!["currentuser".to_string()],
                time_control_categories: vec![],
                sort_mode: None,
            },
        )
        .unwrap();

        assert_eq!(response.white.len(), 1);
        assert_eq!(response.white[0].family, "Sicilian");
        assert_eq!(response.white[0].games, 1);
        assert!((response.white[0].avg_accuracy - 90.0).abs() < 1e-9);

        assert_eq!(response.black.len(), 1);
        assert_eq!(response.black[0].family, "Sicilian");
        assert_eq!(response.black[0].games, 1);
        assert!((response.black[0].avg_accuracy - 88.0).abs() < 1e-9);
    }

    #[test]
    fn dashboard_opening_accuracy_top_filters_by_time_control_categories() {
        let temp = TempDir::new().unwrap();
        let profile_conn = Connection::open_in_memory().unwrap();
        create_dashboard_profile_db(&profile_conn);
        let analysis_path = temp.path().join("analysis.db3");
        create_analysis_db(&analysis_path);

        let italian_pgn = r#"[Event "Rated Classical game"]
[Site "https://lichess.org/ItalianClassical"]
[Date "2026.05.13"]
[White "currentuser"]
[Black "JoseCortes11"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 1-0"#;
        profile_conn
            .execute(
                r#"
                INSERT INTO Games (
                    ID, EventID, SiteID, Date, UTCTime, Round, WhiteID, WhiteElo, BlackID, BlackElo,
                    Result, TimeControl, PlyCount, FEN, Moves
                )
                VALUES (?1, 2, 1, ?2, ?3, 1, 1, 2000, 2, 1900, '1-0', '1800+0', 6, NULL, ?4)
                "#,
                params![404, "2026.05.13", "10:00:00", italian_pgn.as_bytes()],
            )
            .unwrap();

        let analysis_conn = Connection::open(&analysis_path).unwrap();
        analysis_conn
            .execute(
                r#"
                INSERT INTO game_analysis (
                    profile_id, game_id, analyzed_pgn, accuracy, acpl, estimated_elo
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params!["profile-a", "404", italian_pgn, 76.0, 64.0, 1880],
            )
            .unwrap();
        drop(analysis_conn);

        let rapid_response = dashboard_get_opening_accuracy_top_for_connection(
            &profile_conn,
            &analysis_path,
            &DashboardOpeningAccuracyTopRequest {
                profile_id: "profile-a".to_string(),
                game_history_limit: 100,
                profile_usernames: vec!["currentuser".to_string()],
                time_control_categories: vec!["rapid".to_string()],
                sort_mode: None,
            },
        )
        .unwrap();

        assert_eq!(rapid_response.white.len(), 1);
        assert_eq!(rapid_response.white[0].family, "Sicilian");
        assert_eq!(rapid_response.white[0].games, 1);

        profile_conn
            .execute_batch("DETACH DATABASE analysis_db")
            .unwrap();

        let classical_response = dashboard_get_opening_accuracy_top_for_connection(
            &profile_conn,
            &analysis_path,
            &DashboardOpeningAccuracyTopRequest {
                profile_id: "profile-a".to_string(),
                game_history_limit: 100,
                profile_usernames: vec!["currentuser".to_string()],
                time_control_categories: vec!["classical".to_string()],
                sort_mode: None,
            },
        )
        .unwrap();

        assert_eq!(classical_response.white.len(), 1);
        assert_eq!(classical_response.white[0].family, "Italian");
        assert_eq!(classical_response.white[0].games, 1);

        profile_conn
            .execute_batch("DETACH DATABASE analysis_db")
            .unwrap();

        let combined_response = dashboard_get_opening_accuracy_top_for_connection(
            &profile_conn,
            &analysis_path,
            &DashboardOpeningAccuracyTopRequest {
                profile_id: "profile-a".to_string(),
                game_history_limit: 100,
                profile_usernames: vec!["currentuser".to_string()],
                time_control_categories: vec!["rapid".to_string(), "classical".to_string()],
                sort_mode: None,
            },
        )
        .unwrap();

        assert_eq!(combined_response.white.len(), 2);
        assert_eq!(combined_response.white[0].family, "Sicilian");
        assert_eq!(combined_response.white[1].family, "Italian");
    }

    #[test]
    fn opening_accuracy_top_items_requires_five_percent_sample() {
        let rows = HashMap::from([
            (
                "Sicilian".to_string(),
                OpeningAccuracyAccumulator {
                    games: 4,
                    accuracy_sum: 380.0,
                    wins: 4,
                    outcome_games: 4,
                },
            ),
            (
                "Italian".to_string(),
                OpeningAccuracyAccumulator {
                    games: 5,
                    accuracy_sum: 450.0,
                    wins: 3,
                    outcome_games: 5,
                },
            ),
            (
                "Ruy Lopez".to_string(),
                OpeningAccuracyAccumulator {
                    games: 6,
                    accuracy_sum: 510.0,
                    wins: 4,
                    outcome_games: 6,
                },
            ),
        ]);

        let ranked = opening_accuracy_top_items(rows, 100, OpeningAccuracySortMode::Accuracy);

        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].family, "Italian");
        assert_eq!(ranked[0].games, 5);
        assert_eq!(ranked[1].family, "Ruy Lopez");
        assert_eq!(ranked[1].games, 6);
    }

    #[test]
    fn opening_accuracy_top_items_uses_combined_filtered_game_total() {
        let rows = HashMap::from([(
            "English".to_string(),
            OpeningAccuracyAccumulator {
                games: 2,
                accuracy_sum: 173.2,
                wins: 2,
                outcome_games: 2,
            },
        )]);

        let ranked = opening_accuracy_top_items(rows, 100, OpeningAccuracySortMode::Accuracy);

        assert!(ranked.is_empty());
    }

    #[test]
    fn opening_accuracy_top_items_can_sort_by_frequency() {
        let rows = HashMap::from([
            (
                "Sicilian".to_string(),
                OpeningAccuracyAccumulator {
                    games: 7,
                    accuracy_sum: 490.0,
                    wins: 3,
                    outcome_games: 7,
                },
            ),
            (
                "Italian".to_string(),
                OpeningAccuracyAccumulator {
                    games: 5,
                    accuracy_sum: 475.0,
                    wins: 5,
                    outcome_games: 5,
                },
            ),
            (
                "Ruy Lopez".to_string(),
                OpeningAccuracyAccumulator {
                    games: 6,
                    accuracy_sum: 510.0,
                    wins: 4,
                    outcome_games: 6,
                },
            ),
        ]);

        let ranked = opening_accuracy_top_items(rows, 100, OpeningAccuracySortMode::Frequency);

        assert_eq!(ranked.len(), 3);
        assert_eq!(ranked[0].family, "Sicilian");
        assert_eq!(ranked[0].games, 7);
        assert_eq!(ranked[1].family, "Ruy Lopez");
        assert_eq!(ranked[1].games, 6);
        assert_eq!(ranked[2].family, "Italian");
        assert_eq!(ranked[2].games, 5);
    }

    #[test]
    fn opening_accuracy_top_items_can_sort_by_win_rate() {
        let rows = HashMap::from([
            (
                "Sicilian".to_string(),
                OpeningAccuracyAccumulator {
                    games: 7,
                    accuracy_sum: 630.0,
                    wins: 3,
                    outcome_games: 7,
                },
            ),
            (
                "Italian".to_string(),
                OpeningAccuracyAccumulator {
                    games: 5,
                    accuracy_sum: 350.0,
                    wins: 5,
                    outcome_games: 5,
                },
            ),
            (
                "Ruy Lopez".to_string(),
                OpeningAccuracyAccumulator {
                    games: 6,
                    accuracy_sum: 540.0,
                    wins: 4,
                    outcome_games: 6,
                },
            ),
        ]);

        let ranked = opening_accuracy_top_items(rows, 100, OpeningAccuracySortMode::WinRate);

        assert_eq!(ranked.len(), 3);
        assert_eq!(ranked[0].family, "Italian");
        assert!((ranked[0].win_rate - 100.0).abs() < 1e-9);
        assert_eq!(ranked[1].family, "Ruy Lopez");
        assert_eq!(ranked[2].family, "Sicilian");
    }

    #[test]
    fn extract_lichess_id_from_site_is_case_insensitive_but_requires_id() {
        assert_eq!(
            extract_lichess_id_from_site("https://Lichess.org/AbCDef12").as_deref(),
            Some("AbCDef12")
        );
        assert_eq!(extract_lichess_id_from_site("Lichess.org"), None);
    }
}
