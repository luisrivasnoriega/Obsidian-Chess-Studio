use crate::analysis_storage::{analysis_db_get_analyzed_games_bulk, analysis_db_get_game_stats_bulk};
use crate::db::{
    get_games, get_players, GameQueryJs, GameSort, PlayerQuery, PlayerSort, QueryOptions,
    SortDirection, Sides,
};
use crate::error::{Error, Result};
use crate::AppState;
use chrono::{NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use rusqlite::{Connection, OptionalExtension};

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
    pub accuracy: Option<f64>,
    pub acpl: Option<f64>,
    pub estimated_elo: Option<i64>,
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
    pub sort_by: Option<String>,       // "elo" | "date"
    pub sort_direction: Option<String>, // "asc" | "desc"
    pub profile_usernames: Vec<String>,
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
    pub profile_usernames: Vec<String>,
    pub target: AnalyzeAllTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeAllCountsResponse {
    pub total: i32,
    pub analyzed: i32,
    pub unanalyzed: i32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalGameStats {
    accuracy: f64,
    acpl: f64,
    estimated_elo: Option<i64>,
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
    if site.contains("chess.com") && (site.starts_with("http://") || site.starts_with("https://")) {
        Some(site.to_string())
    } else {
        None
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
    // Mirrors the lightweight checks used in the UI.
    let lower = pgn.to_lowercase();
    lower.contains("[%eval")
        || lower.contains("[%clk")
        || lower.contains("!!")
        || lower.contains("?!")
        || lower.contains("!?")
        || lower.contains("$")
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

#[tauri::command]
#[specta::specta]
pub async fn dashboard_get_games_history_rows(
    app: AppHandle,
    state: State<'_, AppState>,
    req: GamesHistoryRequest,
) -> Result<GamesHistoryResponse> {
    let profile_id = req.profile_id.trim().to_string();
    if profile_id.is_empty() {
        return Ok(GamesHistoryResponse {
            rows: vec![],
            total_count: 0,
        });
    }

    let usernames_lower = usernames_lower_set(&req.profile_usernames);

    // 1) Load local games.
    let local_limit = req.game_history_limit.max(0) as usize;
    let local_games = load_local_games(&app, &profile_id, local_limit)?;

    // 2) Load online games (single query; later we split by platform).
    let db_path = parse_profile_db_path(&app, &profile_id)?;
    let profile_player_id: Option<i32> = (|| {
        let conn = Connection::open(&db_path).ok()?;
        ensure_profile_player_id(&conn)
    })();

    let mut q = GameQueryJs::default();
    q.options = Some(QueryOptions {
        skip_count: true,
        page: Some(1),
        page_size: Some(req.game_history_limit.max(0) as i32),
        sort: GameSort::Date,
        direction: SortDirection::Desc,
    });
    q.tournament_id = req.event_filter_id;
    q.time_control_category = req.time_control_category.clone();

    if let Some(pid) = req.selected_opponent_id {
        q.player1 = Some(pid);
        q.sides = Some(Sides::Any);
    }

    let online = get_games(db_path, q, state).await?.data;

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
            accuracy: stats.as_ref().map(|s| s.accuracy),
            acpl: stats.as_ref().map(|s| s.acpl),
            estimated_elo: stats.and_then(|s| s.estimated_elo),
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
            let mut kind: Option<GamesHistoryKind> = None;
            let mut external_key = g.id.to_string();
            let mut external_url: Option<String> = None;

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
                } else if let Some(url) = extract_chesscom_url(site) {
                    kind = Some(GamesHistoryKind::Chesscom);
                    external_key = url.clone();
                    external_url = Some(url);
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
                if let Some(url) = extract_chesscom_url(&g.site) {
                    external_key = url.clone();
                    external_url = Some(url);
                } else {
                    external_key = format!("https://www.chess.com/game/live/{}", g.id);
                    external_url = Some(external_key.clone());
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
        let user_is_white = if let Some(pid) = profile_player_id {
            if g.white_id == pid {
                true
            } else if g.black_id == pid {
                false
            } else {
                let is_user_white = usernames_lower.contains(&white_raw.to_lowercase())
                    || usernames_lower.contains(&white_name.to_lowercase());
                let is_user_black = usernames_lower.contains(&black_raw.to_lowercase())
                    || usernames_lower.contains(&black_name.to_lowercase());
                is_user_white || (!is_user_black)
            }
        } else {
            let is_user_white =
                usernames_lower.contains(&white_raw.to_lowercase()) || usernames_lower.contains(&white_name.to_lowercase());
            let is_user_black =
                usernames_lower.contains(&black_raw.to_lowercase()) || usernames_lower.contains(&black_name.to_lowercase());
            is_user_white || (!is_user_black)
        };
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

        rows.push(GamesHistoryRow {
            kind,
            analysis_game_id: g.id.to_string(),
            game_key: external_key,
            external_url,
            opponent: if opponent.trim().is_empty() { "?".to_string() } else { opponent },
            color: user_color.to_string(),
            outcome,
            pgn: if g.moves.trim().is_empty() {
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
                    &g.moves,
                ))
            } else {
                Some(g.moves)
            },
            accuracy: None,
            acpl: None,
            estimated_elo: None,
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

    // 5) Enrich with analysis.db3 (bulk).
    // LEFT JOIN to analysis.db3 uses (profile_id, analysis_game_id).
    let ids: Vec<String> = rows.iter().map(|r| r.analysis_game_id.clone()).collect();
    if !ids.is_empty() {
        let analyzed = analysis_db_get_analyzed_games_bulk(app.clone(), ids.clone(), Some(profile_id.clone()))?;
        let stats = analysis_db_get_game_stats_bulk(app.clone(), ids.clone(), Some(profile_id.clone()))?;

        let analyzed_map: HashMap<String, String> = analyzed
            .into_iter()
            .map(|e| (e.game_id, e.analyzed_pgn))
            .collect();
        let stats_map: HashMap<String, (f64, f64, Option<i64>)> = stats
            .into_iter()
            .map(|e| (e.game_id, (e.accuracy, e.acpl, e.estimated_elo)))
            .collect();

        for r in rows.iter_mut() {
            if let Some(pgn) = analyzed_map.get(&r.analysis_game_id) {
                r.pgn = Some(pgn.clone());
                r.is_analyzed = true;
            }
            if let Some((acc, acpl, elo)) = stats_map.get(&r.analysis_game_id) {
                r.accuracy = Some(*acc);
                r.acpl = Some(*acpl);
                r.estimated_elo = *elo;
            }
            if !r.is_analyzed {
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
pub async fn dashboard_get_analyze_all_counts(
    app: AppHandle,
    state: State<'_, AppState>,
    req: AnalyzeAllCountsRequest,
) -> Result<AnalyzeAllCountsResponse> {
    let profile_id = req.profile_id.trim().to_string();
    if profile_id.is_empty() {
        return Ok(AnalyzeAllCountsResponse {
            total: 0,
            analyzed: 0,
            unanalyzed: 0,
        });
    }

    let usernames_lower = usernames_lower_set(&req.profile_usernames);

    // 1) Load local games if needed.
    let mut rows: Vec<GamesHistoryRow> = Vec::new();
    let local_limit = req.game_history_limit.max(0) as usize;
    let include_local = matches!(req.target, AnalyzeAllTarget::Local | AnalyzeAllTarget::All);
    if include_local {
        let local_games = load_local_games(&app, &profile_id, local_limit)?;
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
                pgn: None,
                accuracy: None,
                acpl: None,
                estimated_elo: None,
                moves: g.moves.len().saturating_div(2).max(1) as i32,
                time_control: if tc.trim().is_empty() { None } else { Some(tc) },
                time_control_category: tc_cat,
                timestamp_ms: g.timestamp,
                event_id: None,
                event_name: None,
                is_analyzed: false,
            });
        }
    }

    // 2) Load online games if needed (single query; later split by platform).
    let include_online = matches!(
        req.target,
        AnalyzeAllTarget::Local
            | AnalyzeAllTarget::Chesscom
            | AnalyzeAllTarget::Lichess
            | AnalyzeAllTarget::Chessbase
            | AnalyzeAllTarget::All
    );
    if include_online {
        let db_path = parse_profile_db_path(&app, &profile_id)?;
        let mut q = GameQueryJs::default();
        q.options = Some(QueryOptions {
            skip_count: true,
            page: Some(1),
            page_size: Some(req.game_history_limit.max(0) as i32),
            sort: GameSort::Date,
            direction: SortDirection::Desc,
        });
        q.tournament_id = req.event_filter_id;
        q.time_control_category = req.time_control_category.clone();
        if let Some(pid) = req.selected_opponent_id {
            q.player1 = Some(pid);
            q.sides = Some(Sides::Any);
        }

        let online = get_games(db_path, q, state).await?.data;
        for g in online {
            // Identify platform and extract external key (same as dashboard_get_games_history_rows).
            let site_tag = parse_site_tag(&g.moves);
            let mut kind: Option<GamesHistoryKind> = None;
            let mut external_key = g.id.to_string();
            let mut external_url: Option<String> = None;

            if let Some(site) = site_tag.as_deref() {
                let site_lower = site.to_lowercase();
                if site_lower.trim() == "local" {
                    kind = Some(GamesHistoryKind::Local);
                    external_key = g.id.to_string();
                    external_url = None;
                } else if site_lower.contains("lichess.org/broadcast/") {
                    kind = Some(GamesHistoryKind::Lichess);
                    external_key = g.id.to_string();
                    external_url = normalize_https_url(site);
                } else if let Some(id) = extract_lichess_id_from_site(site) {
                    kind = Some(GamesHistoryKind::Lichess);
                    external_key = id.clone();
                    external_url = Some(format!("https://lichess.org/{}", id));
                } else if let Some(url) = extract_chesscom_url(site) {
                    kind = Some(GamesHistoryKind::Chesscom);
                    external_key = url.clone();
                    external_url = Some(url);
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
                    if let Some(id) = extract_lichess_id_from_site(&g.site) {
                        external_key = id.clone();
                        external_url = Some(format!("https://lichess.org/{}", id));
                    } else {
                        external_url = Some(format!("https://lichess.org/{}", external_key));
                    }
                } else if site_lower.contains("chess.com") {
                    kind = Some(GamesHistoryKind::Chesscom);
                    if let Some(url) = extract_chesscom_url(&g.site) {
                        external_key = url.clone();
                        external_url = Some(url);
                    } else {
                        external_key = format!("https://www.chess.com/game/live/{}", g.id);
                        external_url = Some(external_key.clone());
                    }
                } else if site_lower.contains("chessbase.com") {
                    kind = Some(GamesHistoryKind::Chessbase);
                    external_key = g.id.to_string();
                    external_url = None;
                }
            }

            let Some(kind) = kind else {
                continue;
            };

            let white_raw = g.white.clone();
            let black_raw = g.black.clone();
            let white_name = strip_account_key(&white_raw).to_string();
            let black_name = strip_account_key(&black_raw).to_string();
            let is_user_white = usernames_lower.contains(&white_raw.to_lowercase())
                || usernames_lower.contains(&white_name.to_lowercase());
            let is_user_black = usernames_lower.contains(&black_raw.to_lowercase())
                || usernames_lower.contains(&black_name.to_lowercase());
            let user_is_white = is_user_white || (!is_user_black);
            let user_color = if user_is_white { "white" } else { "black" };
            let opponent = if user_is_white { black_name } else { white_name };

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

            rows.push(GamesHistoryRow {
                kind,
                analysis_game_id: g.id.to_string(),
                game_key: external_key,
                external_url,
            opponent: if opponent.trim().is_empty() { "?".to_string() } else { opponent },
                color: user_color.to_string(),
                outcome,
                pgn: None,
                accuracy: None,
                acpl: None,
                estimated_elo: None,
                moves: full_moves,
                time_control: if tc.trim().is_empty() { None } else { Some(tc) },
                time_control_category: tc_cat,
                timestamp_ms,
                event_id: Some(g.event_id),
                event_name: Some(g.event),
                is_analyzed: false,
            });
        }
    }

    // 3) Apply filters + target selection + minimum move threshold.
    if let Some(event_id) = req.event_filter_id {
        rows.retain(|r| r.event_id == Some(event_id));
    }
    if let Some(ref want_tc) = req.time_control_category {
        let want_tc = want_tc.trim().to_lowercase();
        if !want_tc.is_empty() {
            rows.retain(|r| r.time_control_category.as_deref().unwrap_or("") == want_tc);
        }
    }

    rows.retain(|r| r.moves >= 5);

    rows.retain(|r| match req.target {
        AnalyzeAllTarget::All => true,
        AnalyzeAllTarget::Local => matches!(r.kind, GamesHistoryKind::Local),
        AnalyzeAllTarget::Chesscom => matches!(r.kind, GamesHistoryKind::Chesscom),
        AnalyzeAllTarget::Lichess => matches!(r.kind, GamesHistoryKind::Lichess),
        AnalyzeAllTarget::Chessbase => matches!(r.kind, GamesHistoryKind::Chessbase),
    });

    let total = rows.len() as i32;
    if total == 0 {
        return Ok(AnalyzeAllCountsResponse {
            total: 0,
            analyzed: 0,
            unanalyzed: 0,
        });
    }

    // 4) Count analyzed strictly from analysis.db3 (profile-aware).
    let ids: Vec<String> = rows.iter().map(|r| r.analysis_game_id.clone()).collect();
    let analyzed_rows = analysis_db_get_analyzed_games_bulk(app.clone(), ids, Some(profile_id.clone()))?;
    let analyzed = analyzed_rows.len() as i32;
    let unanalyzed = (total - analyzed).max(0);

    Ok(AnalyzeAllCountsResponse {
        total,
        analyzed,
        unanalyzed,
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

    let usernames_lower = usernames_lower_set(&profile_usernames);
    let db_path = parse_profile_db_path(&app, &profile_id)?;
    let profile_player_id: Option<i32> = (|| {
        let conn = Connection::open(&db_path).ok()?;
        ensure_profile_player_id(&conn)
    })();

    let pq = PlayerQuery {
        options: QueryOptions {
            skip_count: true,
            page: Some(1),
            page_size: Some(25),
            sort: PlayerSort::Name,
            direction: SortDirection::Asc,
        },
        name: Some(q),
        range: None,
    };

    let res = get_players(db_path, pq, state).await?;
    let mut out: Vec<String> = Vec::new();
    for p in res.data {
        if profile_player_id.map(|pid| p.id == pid).unwrap_or(false) {
            continue;
        }
        let Some(name_raw) = p.name else {
            continue;
        };
        let name = name_raw.trim().to_string();
        if name.is_empty() {
            continue;
        }
        if usernames_lower.contains(&name.to_lowercase()) {
            continue;
        }
        out.push(name);
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
