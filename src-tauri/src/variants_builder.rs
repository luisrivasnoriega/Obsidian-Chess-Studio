use crate::chess::types::{BestMoves, EngineOption, EngineOptions, GoMode, ScoreValue};
use crate::db::{GameQueryJs, PositionQueryJs, PositionStats};
use crate::error::{Error, Result};
use crate::variant_positions;
use crate::AppState;
use chrono::{DateTime, Datelike, FixedOffset};
use log;
use once_cell::sync::Lazy;
use reqwest::{Client, StatusCode};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::time::{sleep, Duration};

use shakmaty::fen::Fen;
use shakmaty::san::{San, SanPlus};
use shakmaty::uci::UciMove;
use shakmaty::{CastlingMode, Chess, EnPassantMode, Position};

static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .user_agent("ObsidianChessStudio/variants_builder")
        // Avoid hanging forever on a bad connection.
        .timeout(std::time::Duration::from_secs(30))
        .pool_max_idle_per_host(8)
        .build()
        .expect("Failed to build HTTP client")
});

const SMART_MIN_SOURCE_GAMES: u32 = 1_000;

/// Coarse global throttle for Lichess explorer endpoints to avoid 429 bursts.
/// This is global across invocations (best-effort).
#[derive(Debug, Clone)]
struct LichessRateLimit {
    last_request: Instant,
    next_allowed: Instant,
}

static LICHESS_RL: Lazy<tokio::sync::Mutex<LichessRateLimit>> = Lazy::new(|| {
    let past = Instant::now()
        .checked_sub(Duration::from_secs(60))
        .unwrap_or_else(Instant::now);
    tokio::sync::Mutex::new(LichessRateLimit {
        last_request: past,
        next_allowed: past,
    })
});

async fn throttle_lichess() {
    // Very conservative: ~1 req/sec max to avoid 429 bursts (lichess.ovh is strict).
    const MIN_INTERVAL: Duration = Duration::from_millis(1000);
    let mut guard = LICHESS_RL.lock().await;
    let now = Instant::now();
    let min_next = guard.last_request + MIN_INTERVAL;
    let target = if guard.next_allowed > min_next {
        guard.next_allowed
    } else {
        min_next
    };
    if now < target {
        sleep(target - now).await;
    }
    guard.last_request = Instant::now();
}

async fn lichess_set_next_allowed(delay: Duration) {
    let mut guard = LICHESS_RL.lock().await;
    let candidate = Instant::now() + delay;
    if candidate > guard.next_allowed {
        guard.next_allowed = candidate;
    }
}

fn retry_after_delay(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get("retry-after")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .map(Duration::from_secs)
}

pub(crate) async fn fetch_explorer(
    url: reqwest::Url,
    lichess_token: Option<&str>,
) -> Result<ExplorerPositionData> {
    // Retry/backoff on 429 and transient 5xx.
    const MAX_RETRIES: usize = 8;
    let mut backoff = Duration::from_millis(1000);
    let auth_token = lichess_token.map(str::trim).filter(|s| !s.is_empty());

    for attempt in 0..=MAX_RETRIES {
        throttle_lichess().await;
        log::debug!("Lichess explorer request start: {}", url);

        let mut request = HTTP_CLIENT
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(token) = auth_token {
            request = request.bearer_auth(token);
        }

        let res = match request.send().await {
            Ok(r) => r,
            Err(e) => {
                if attempt < MAX_RETRIES {
                    sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(15));
                    continue;
                }
                return Err(Error::FenError(format!(
                    "Network error fetching Lichess explorer: {e}"
                )));
            }
        };

        if res.status() == StatusCode::TOO_MANY_REQUESTS {
            let wait = retry_after_delay(res.headers()).unwrap_or(backoff);
            log::warn!(
                "Lichess 429 (attempt {}/{}), waiting {:?} | url={}",
                attempt + 1,
                MAX_RETRIES + 1,
                wait,
                url
            );
            // Important: apply the server hint globally so we don't keep hammering on subsequent calls.
            lichess_set_next_allowed(wait).await;
            sleep(wait).await;
            backoff = (backoff * 2).min(Duration::from_secs(15));
            continue;
        }

        if res.status().is_client_error() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            let body_preview = body.trim().chars().take(160).collect::<String>();
            return Err(Error::FenError(format!(
                "Lichess explorer client error {}: {}",
                status, body_preview
            )));
        }

        if res.status().is_server_error() {
            log::warn!(
                "Lichess server error {} (attempt {}/{}), backing off {:?}",
                res.status(),
                attempt + 1,
                MAX_RETRIES + 1,
                backoff
            );
            // Also space out subsequent calls globally.
            lichess_set_next_allowed(backoff).await;
            sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(15));
            continue;
        }

        match res.error_for_status() {
            Ok(r) => match r.json::<ExplorerPositionData>().await {
                Ok(data) => return Ok(data),
                Err(e) => {
                    if attempt < MAX_RETRIES {
                        log::warn!(
                            "Failed to parse Lichess response (attempt {}/{}): {}",
                            attempt + 1,
                            MAX_RETRIES + 1,
                            e
                        );
                        lichess_set_next_allowed(backoff).await;
                        sleep(backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(15));
                        continue;
                    }
                    return Err(Error::FenError(format!(
                        "Failed to parse Lichess explorer response: {e}"
                    )));
                }
            },
            Err(e) => {
                if attempt < MAX_RETRIES {
                    log::warn!(
                        "HTTP error {} (attempt {}/{}), backing off {:?}",
                        e,
                        attempt + 1,
                        MAX_RETRIES + 1,
                        backoff
                    );
                    lichess_set_next_allowed(backoff).await;
                    sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(15));
                    continue;
                }
                return Err(Error::FenError(format!("Lichess explorer HTTP error: {e}")));
            }
        }
    }

    // If we exhausted retries, return empty moves instead of failing completely.
    log::warn!(
        "Lichess explorer exhausted retries for {}, returning empty moves",
        url
    );
    Ok(ExplorerPositionData {
        moves: vec![],
        opening: None,
    })
}

// -----------------------------------------------------------------------------
// Request/response DTOs (frontend -> backend)
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[specta(rename = "VariantsTreeNodeDto")]
#[serde(rename_all = "camelCase")]
pub struct TreeNodeDto {
    pub fen: String,
    #[serde(default)]
    pub san: Option<String>,
    #[serde(default)]
    pub children: Vec<TreeNodeDto>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LichessGamesOptionsDto {
    #[serde(default)]
    pub variant: Option<String>,
    #[serde(default)]
    pub speeds: Option<Vec<String>>,
    #[serde(default)]
    pub ratings: Option<Vec<u32>>,
    /// Serialized from JS Date as ISO string (or omitted).
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub moves: Option<u32>,
    #[serde(default)]
    pub top_games: Option<u32>,
    #[serde(default)]
    pub recent_games: Option<u32>,
    #[serde(default)]
    pub player: Option<String>,
    pub color: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MasterGamesOptionsDto {
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub moves: Option<u32>,
    #[serde(default)]
    pub top_games: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineRequestDto {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub extra_options: Vec<EngineOption>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum BuildVariantsMode {
    Engine,
    Smart,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SmartConfigDto {
    #[serde(default)]
    pub candidate_multi_pv: Option<u32>,
    #[serde(default)]
    pub validation_full_moves: Option<u32>,
    #[serde(default)]
    pub validation_plies: Option<u32>,
    #[serde(default)]
    pub playable_threshold_cp: Option<i32>,
    #[serde(default)]
    pub max_validation_opponent_branches: Option<u32>,
    #[serde(default)]
    pub validation_beam_width: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SplitConfigDto {
    pub enabled: bool,
    pub mode: String, // "none" | "manual" | "auto"
    #[serde(default)]
    pub split_at_ply: Option<u32>,
    #[serde(default)]
    pub max_segments: Option<u32>,
    #[serde(default)]
    pub max_lines_per_segment: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BuildVariantsTreeRequest {
    pub root: TreeNodeDto,
    pub start_path: Vec<u32>,
    pub orientation: String, // "white" | "black"
    pub is960: bool,

    pub db_type: String, // "local" | "lch_all" | "lch_master"
    #[serde(default)]
    pub local_db_path: Option<String>,
    #[serde(default)]
    pub lichess_options: Option<LichessGamesOptionsDto>,
    #[serde(default)]
    pub master_options: Option<MasterGamesOptionsDto>,
    #[serde(default)]
    pub lichess_token: Option<String>,

    pub mode: BuildVariantsMode,
    #[serde(default)]
    pub smart_config: Option<SmartConfigDto>,
    #[serde(default)]
    pub engine: Option<EngineRequestDto>,
    pub engine_ms: u32,

    pub coverage: u32,
    pub min_moves: u32,
    pub depth: u32, // active player moves
    #[serde(default)]
    pub split_config: Option<SplitConfigDto>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MoveSpecDto {
    /// We now prefer SAN for stability with the frontend tree store.
    /// (Frontend still supports SAN or UCI, but SAN is the default here.)
    pub value: String,
    /// "db" | "engine" | "smart"
    #[serde(default)]
    pub source: Option<String>,
    /// Raw DB stats when the move is sourced from a database.
    #[serde(default)]
    pub white: Option<u32>,
    #[serde(default)]
    pub black: Option<u32>,
    #[serde(default)]
    pub draws: Option<u32>,
    #[serde(default)]
    pub total: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LineDto {
    pub moves: Vec<MoveSpecDto>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SegmentStatsDto {
    pub line_count: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SegmentDto {
    pub id: String,
    pub anchor_ply: u32,
    pub anchor_fen: String,
    pub anchor_path: Vec<u32>,
    #[serde(default)]
    pub title: Option<String>,
    pub lines: Vec<LineDto>,
    pub stats: SegmentStatsDto,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BuildVariantsTreeResponse {
    pub lines: Vec<LineDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segments: Option<Vec<SegmentDto>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
}

// -----------------------------------------------------------------------------
// Progress events (backend -> frontend)
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VariantsBuilderProgressPayload {
    start_path: Vec<u32>,
    #[serde(default)]
    moves: Vec<MoveSpecDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    segment_id: Option<String>,
}

fn emit_variants_builder_progress(app: &AppHandle, start_path: &[u32], moves: &[MoveSpecDto]) {
    let _ = app.emit(
        "variants_builder_progress",
        VariantsBuilderProgressPayload {
            start_path: start_path.to_vec(),
            moves: moves.to_vec(),
            phase: Some("applying".to_string()),
            segment_id: None,
        },
    );
}

fn emit_variants_builder_phase(
    app: &AppHandle,
    start_path: &[u32],
    moves: &[MoveSpecDto],
    phase: &str,
) {
    let _ = app.emit(
        "variants_builder_progress",
        VariantsBuilderProgressPayload {
            start_path: start_path.to_vec(),
            moves: moves.to_vec(),
            phase: Some(phase.to_string()),
            segment_id: None,
        },
    );
}

// -----------------------------------------------------------------------------
// Explorer (lichess.ovh) response subset
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExplorerMove {
    pub(crate) uci: String,
    pub(crate) san: String,
    pub(crate) white: u32,
    pub(crate) black: u32,
    pub(crate) draws: u32,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(crate) struct ExplorerOpening {
    #[serde(default)]
    pub(crate) eco: Option<String>,
    #[serde(default)]
    pub(crate) name: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(crate) struct ExplorerPositionData {
    #[serde(default)]
    pub(crate) moves: Vec<ExplorerMove>,
    #[serde(default)]
    pub(crate) opening: Option<ExplorerOpening>,
}

// -----------------------------------------------------------------------------
// Existing tree reuse (avoid DB/external calls when we already have moves)
// -----------------------------------------------------------------------------

fn build_existing_moves_by_fen(root: &TreeNodeDto) -> HashMap<String, Vec<ExplorerMove>> {
    let mut map: HashMap<String, Vec<ExplorerMove>> = HashMap::new();
    let mut stack: Vec<&TreeNodeDto> = vec![root];
    while let Some(node) = stack.pop() {
        let key = fen_identity_key(&node.fen);
        if !map.contains_key(&key) {
            let mut moves: Vec<ExplorerMove> = Vec::new();
            for child in &node.children {
                if let Some(san) = child
                    .san
                    .as_ref()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                {
                    moves.push(ExplorerMove {
                        uci: String::new(),
                        san: san.to_string(),
                        white: 0,
                        black: 0,
                        draws: 0,
                    });
                }
            }
            if !moves.is_empty() {
                map.insert(key, moves);
            }
        }
        for child in &node.children {
            stack.push(child);
        }
    }
    map
}

fn move_spec_from_existing_target_child(child: &TreeNodeDto) -> Option<MoveSpecDto> {
    child
        .san
        .as_ref()
        .map(|san| san.trim())
        .filter(|san| !san.is_empty())
        .map(|san| MoveSpecDto {
            value: san.to_string(),
            source: Some("smart".to_string()),
            white: None,
            black: None,
            draws: None,
            total: None,
        })
}

fn build_existing_target_moves_by_fen(
    root: &TreeNodeDto,
    target_side: Side,
) -> HashMap<String, MoveSpecDto> {
    let mut map: HashMap<String, MoveSpecDto> = HashMap::new();
    let mut stack: Vec<&TreeNodeDto> = vec![root];
    while let Some(node) = stack.pop() {
        if fen_turn(&node.fen).ok() == Some(target_side) {
            if let Some(step) = node
                .children
                .first()
                .and_then(move_spec_from_existing_target_child)
            {
                map.entry(fen_identity_key(&node.fen)).or_insert(step);
            }
        }
        for child in &node.children {
            stack.push(child);
        }
    }
    map
}

// -----------------------------------------------------------------------------
// Helpers: fen parsing + identity key
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    White,
    Black,
}

impl Side {
    fn from_str(s: &str) -> Result<Self> {
        match s.trim().to_lowercase().as_str() {
            "white" => Ok(Side::White),
            "black" => Ok(Side::Black),
            other => Err(Error::FenError(format!(
                "Invalid orientation: {other} (expected 'white' or 'black')"
            ))),
        }
    }
}

fn fen_turn(fen: &str) -> Result<Side> {
    let parts: Vec<&str> = fen.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return Err(Error::FenError(format!(
            "Invalid FEN (missing turn): {fen}"
        )));
    }
    match parts[1] {
        "w" => Ok(Side::White),
        "b" => Ok(Side::Black),
        other => Err(Error::FenError(format!("Invalid FEN turn: {other}"))),
    }
}

fn fen_identity_key(fen: &str) -> String {
    let parts: Vec<&str> = fen.trim().split_whitespace().collect();
    if parts.len() >= 4 {
        parts[..4].join(" ")
    } else {
        fen.trim().to_string()
    }
}

fn path_key(path: &[u32]) -> String {
    path.iter()
        .map(|x| x.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn seed_fen_owners(root: &TreeNodeDto) -> HashMap<String, String> {
    let mut owners: HashMap<String, String> = HashMap::new();
    let mut stack: Vec<(&TreeNodeDto, Vec<u32>)> = vec![(root, vec![])];
    while let Some((node, path)) = stack.pop() {
        let key = fen_identity_key(&node.fen);
        owners.entry(key).or_insert_with(|| path_key(&path));
        for (idx, child) in node.children.iter().enumerate() {
            let mut child_path = path.clone();
            child_path.push(idx as u32);
            stack.push((child, child_path));
        }
    }
    owners
}

fn node_at_path<'a>(root: &'a TreeNodeDto, path: &[u32]) -> Option<&'a TreeNodeDto> {
    let mut cur = root;
    for &i in path {
        let idx = i as usize;
        cur = cur.children.get(idx)?;
    }
    Some(cur)
}

fn parse_date_to_year_month(s: &str) -> Option<String> {
    if let Some((year, month)) = parse_year_month_text(s) {
        return Some(format!("{year}-{month}"));
    }
    let dt: DateTime<FixedOffset> = DateTime::parse_from_rfc3339(s).ok()?;
    Some(format!("{}-{}", dt.year(), dt.month()))
}

fn parse_date_to_year(s: &str) -> Option<String> {
    if let Some((year, _)) = parse_year_month_text(s) {
        return Some(year);
    }
    let dt: DateTime<FixedOffset> = DateTime::parse_from_rfc3339(s).ok()?;
    Some(dt.year().to_string())
}

fn parse_year_month_text(s: &str) -> Option<(String, String)> {
    let value = s.trim();
    let mut parts = value.split(['-', '.', '/']);
    let year = parts.next()?.trim();
    let month = parts.next()?.trim();
    if year.len() != 4 || !year.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let month_num = month.parse::<u32>().ok()?;
    if !(1..=12).contains(&month_num) {
        return None;
    }
    Some((year.to_string(), month_num.to_string()))
}

fn lichess_query_pairs(fen: &str, opt: &LichessGamesOptionsDto) -> Vec<(String, String)> {
    let mut parts: Vec<(String, String)> = Vec::new();
    parts.push(("fen".to_string(), fen.to_string()));

    if let Some(player) = opt
        .player
        .as_ref()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
    {
        parts.push(("player".to_string(), player.to_string()));
        parts.push(("color".to_string(), opt.color.clone()));
    }
    if let Some(v) = opt
        .variant
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        parts.push(("variant".to_string(), v.to_string()));
    }
    if let Some(speeds) = &opt.speeds {
        if !speeds.is_empty() {
            parts.push(("speeds".to_string(), speeds.join(",")));
        }
    }
    if let Some(ratings) = &opt.ratings {
        if !ratings.is_empty() {
            parts.push((
                "ratings".to_string(),
                ratings
                    .iter()
                    .map(|r| r.to_string())
                    .collect::<Vec<_>>()
                    .join(","),
            ));
        }
    }
    if let Some(since) = opt.since.as_deref().and_then(parse_date_to_year_month) {
        parts.push(("since".to_string(), since));
    }
    if let Some(until) = opt.until.as_deref().and_then(parse_date_to_year_month) {
        parts.push(("until".to_string(), until));
    }
    // IMPORTANT: explorer treats moves=0 as "return no moves"
    if let Some(m) = opt.moves {
        if m > 0 {
            parts.push(("moves".to_string(), m.to_string()));
        }
    }
    if let Some(tg) = opt.top_games {
        if tg > 0 {
            parts.push(("topGames".to_string(), tg.min(15).to_string()));
        }
    }
    if let Some(rg) = opt.recent_games {
        if rg > 0 {
            parts.push(("recentGames".to_string(), rg.min(15).to_string()));
        }
    }

    parts
}

fn masters_query_pairs(fen: &str, opt: &MasterGamesOptionsDto) -> Vec<(String, String)> {
    let mut parts: Vec<(String, String)> = Vec::new();
    parts.push(("fen".to_string(), fen.to_string()));
    if let Some(since) = opt.since.as_deref().and_then(parse_date_to_year) {
        parts.push(("since".to_string(), since));
    }
    if let Some(until) = opt.until.as_deref().and_then(parse_date_to_year) {
        parts.push(("until".to_string(), until));
    }
    if let Some(m) = opt.moves {
        if m > 0 {
            parts.push(("moves".to_string(), m.to_string()));
        }
    }
    if let Some(tg) = opt.top_games {
        if tg > 0 {
            parts.push(("topGames".to_string(), tg.min(15).to_string()));
        }
    }
    parts
}

pub(crate) fn lichess_explorer_url(
    fen: &str,
    opt: &LichessGamesOptionsDto,
) -> Result<reqwest::Url> {
    let base = "https://explorer.lichess.ovh";
    let is_player = opt
        .player
        .as_ref()
        .map(|p| !p.trim().is_empty())
        .unwrap_or(false);
    let path = if is_player { "player" } else { "lichess" };

    let mut url = reqwest::Url::parse(&format!("{base}/{path}"))
        .map_err(|e| Error::FenError(format!("Invalid explorer URL: {e}")))?;

    {
        let mut qp = url.query_pairs_mut();
        for (k, v) in lichess_query_pairs(fen, opt) {
            qp.append_pair(&k, &v);
        }
    }
    Ok(url)
}

pub(crate) fn masters_explorer_url(fen: &str, opt: &MasterGamesOptionsDto) -> Result<reqwest::Url> {
    let base = "https://explorer.lichess.ovh";
    let mut url = reqwest::Url::parse(&format!("{base}/masters"))
        .map_err(|e| Error::FenError(format!("Invalid masters URL: {e}")))?;

    {
        let mut qp = url.query_pairs_mut();
        for (k, v) in masters_query_pairs(fen, opt) {
            qp.append_pair(&k, &v);
        }
    }
    Ok(url)
}

fn select_coverage_moves(
    moves: &[ExplorerMove],
    coverage: u32,
    min_moves: u32,
) -> Vec<ExplorerMove> {
    let target_min = std::cmp::max(1, min_moves) as usize;
    let total: u32 = moves.iter().map(|m| m.white + m.black + m.draws).sum();
    if total == 0 {
        // Fallback for sources without counts (e.g. existing tree moves):
        // return up to `min_moves` entries so the builder can still progress.
        let mut selected: Vec<ExplorerMove> = Vec::new();
        for m in moves {
            if selected.iter().any(|x| x.san == m.san) {
                continue;
            }
            selected.push(m.clone());
            if selected.len() >= target_min {
                break;
            }
        }
        return selected;
    }

    let mut sorted = moves.to_vec();
    sorted.sort_by_key(|m| std::cmp::Reverse(m.white + m.black + m.draws));

    let target_coverage = coverage.min(100) as f64;
    let mut selected: Vec<ExplorerMove> = Vec::new();
    let mut cumulative = 0f64;

    for m in &sorted {
        let count = (m.white + m.black + m.draws) as f64;
        if count <= 0.0 {
            continue;
        }
        cumulative += (count / (total as f64)) * 100.0;
        selected.push(m.clone());
        if cumulative >= target_coverage && selected.len() >= target_min {
            break;
        }
    }

    if selected.len() < target_min {
        for m in &sorted {
            if selected.iter().any(|x| x.san == m.san) {
                continue;
            }
            selected.push(m.clone());
            if selected.len() >= target_min {
                break;
            }
        }
    }

    selected
}

fn explorer_move_total(m: &ExplorerMove) -> u32 {
    m.white.saturating_add(m.black).saturating_add(m.draws)
}

fn source_total_games(moves: &[ExplorerMove]) -> u32 {
    moves
        .iter()
        .map(explorer_move_total)
        .fold(0u32, u32::saturating_add)
}

fn smart_source_has_enough_games(moves: &[ExplorerMove]) -> bool {
    source_total_games(moves) >= SMART_MIN_SOURCE_GAMES
}

fn visible_lichess_request_budget(req: &BuildVariantsTreeRequest) -> u32 {
    if req.db_type == "local" {
        return 0;
    }

    const MAX_VISIBLE_OPPONENT_BRANCHES: u32 = 6;
    const MIN_VISIBLE_LICHESS_REQUEST_BUDGET: u32 = 80;
    const MAX_VISIBLE_LICHESS_REQUEST_BUDGET: u32 = 600;

    let depth = req.depth.clamp(1, 5);
    let mut budget = 0u32;
    let mut frontier = 1u32;
    for _ in 0..depth {
        budget = budget.saturating_add(frontier);
        frontier = frontier.saturating_mul(MAX_VISIBLE_OPPONENT_BRANCHES);
    }

    budget.clamp(
        MIN_VISIBLE_LICHESS_REQUEST_BUDGET,
        MAX_VISIBLE_LICHESS_REQUEST_BUDGET,
    )
}

/// Convert an engine UCI move into SAN for the given FEN.
/// If conversion fails, caller can fall back to original UCI string.
fn uci_to_san(fen: &str, uci: &str, is960: bool) -> Result<String> {
    let castling = if is960 {
        CastlingMode::Chess960
    } else {
        CastlingMode::Standard
    };
    let pos: Chess = Fen::from_ascii(fen.as_bytes())?.into_position(castling)?;
    let uci_mv = UciMove::from_ascii(uci.as_bytes())?;
    let m = uci_mv.to_move(&pos)?;
    let san = SanPlus::from_move(pos, &m);
    Ok(san.to_string())
}

/// Prefer SAN for database moves (more stable for frontend tree stores).
fn move_value_db(m: &ExplorerMove) -> String {
    let san = m.san.trim();
    if !san.is_empty() {
        san.to_string()
    } else {
        m.uci.clone()
    }
}

fn move_spec_from_db(m: &ExplorerMove) -> MoveSpecDto {
    let total = m.white + m.black + m.draws;
    MoveSpecDto {
        value: move_value_db(m),
        source: Some("db".to_string()),
        white: Some(m.white),
        black: Some(m.black),
        draws: Some(m.draws),
        total: Some(total),
    }
}

fn move_spec_from_engine(value: String) -> MoveSpecDto {
    MoveSpecDto {
        value,
        source: Some("engine".to_string()),
        white: None,
        black: None,
        draws: None,
        total: None,
    }
}

fn move_spec_from_smart(value: String) -> MoveSpecDto {
    MoveSpecDto {
        value,
        source: Some("smart".to_string()),
        white: None,
        black: None,
        draws: None,
        total: None,
    }
}

fn openings_from_local_stats(stats: &[PositionStats]) -> Vec<ExplorerMove> {
    stats
        .iter()
        .map(|s| ExplorerMove {
            uci: String::new(),
            san: s.move_.clone(),
            white: s.white as u32,
            black: s.black as u32,
            draws: s.draw as u32,
        })
        .collect()
}

async fn get_opening_moves(
    fen: &str,
    req: &BuildVariantsTreeRequest,
    existing_moves_by_fen: &HashMap<String, Vec<ExplorerMove>>,
    requests_left: &mut u32,
    app: &AppHandle,
    state: tauri::State<'_, AppState>,
    explorer_cache: &mut HashMap<String, Vec<ExplorerMove>>,
) -> Result<Vec<ExplorerMove>> {
    // Keep existing-tree moves as fallback, but prefer fresh DB/explorer data.
    // Existing tree moves do not include reliable counts for practical scoring or coverage.
    let k = fen_identity_key(fen);
    let existing_fallback = existing_moves_by_fen.get(&k).cloned();

    let fetched = match req.db_type.as_str() {
        "lch_all" => {
            let opt = req
                .lichess_options
                .as_ref()
                .ok_or_else(|| Error::FenError("Missing lichessOptions".to_string()))?;
            let url = lichess_explorer_url(fen, opt)?;
            let key = url.to_string();
            if let Some(v) = explorer_cache.get(&key) {
                log::debug!(
                    "get_opening_moves: cache hit ({} moves) for {} (budget_left={})",
                    v.len(),
                    key,
                    *requests_left
                );
                return Ok(v.clone());
            }
            if *requests_left == 0 {
                log::warn!("Lichess request budget exhausted for this run; returning empty moves");
                vec![]
            } else {
                *requests_left = requests_left.saturating_sub(1);
                log::debug!(
                    "get_opening_moves: cache miss, fetching {} (budget_left={})",
                    key,
                    *requests_left
                );
                match fetch_explorer(url, req.lichess_token.as_deref()).await {
                    Ok(data) => {
                        explorer_cache.insert(key, data.moves.clone());
                        data.moves
                    }
                    Err(e) => {
                        log::warn!(
                            "Failed to fetch Lichess All explorer for FEN {}: {}",
                            fen,
                            e
                        );
                        vec![]
                    }
                }
            }
        }
        "lch_master" => {
            let opt = req
                .master_options
                .as_ref()
                .ok_or_else(|| Error::FenError("Missing masterOptions".to_string()))?;
            let url = masters_explorer_url(fen, opt)?;
            let key = url.to_string();
            if let Some(v) = explorer_cache.get(&key) {
                log::debug!(
                    "get_opening_moves: cache hit ({} moves) for {} (budget_left={})",
                    v.len(),
                    key,
                    *requests_left
                );
                return Ok(v.clone());
            }
            if *requests_left == 0 {
                log::warn!("Lichess request budget exhausted for this run; returning empty moves");
                vec![]
            } else {
                *requests_left = requests_left.saturating_sub(1);
                log::debug!(
                    "get_opening_moves: cache miss, fetching {} (budget_left={})",
                    key,
                    *requests_left
                );
                match fetch_explorer(url, req.lichess_token.as_deref()).await {
                    Ok(data) => {
                        explorer_cache.insert(key, data.moves.clone());
                        data.moves
                    }
                    Err(e) => {
                        log::warn!(
                            "Failed to fetch Lichess Masters explorer for FEN {}: {}",
                            fen,
                            e
                        );
                        vec![]
                    }
                }
            }
        }
        "local" => {
            let path = req
                .local_db_path
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .ok_or(Error::MissingReferenceDatabase)?;
            let file = PathBuf::from(path);
            let query = GameQueryJs::default().position(PositionQueryJs {
                fen: fen.to_string(),
                type_: "exact".to_string(),
            });
            // Use a stable tab id so local DB caching can work.
            let (stats, _games) = crate::db::search_position(
                file,
                query,
                app.clone(),
                "variants_builder".to_string(),
                state,
            )
            .await?;
            openings_from_local_stats(&stats)
        }
        other => return Err(Error::FenError(format!("Unknown db_type: {other}"))),
    };

    if fetched.is_empty() {
        if let Some(existing) = existing_fallback {
            log::debug!(
                "get_opening_moves: DB/explorer empty, falling back to existing tree moves ({} moves) for fen_key={}",
                existing.len(),
                k
            );
            return Ok(existing);
        }
    }

    Ok(fetched)
}

async fn get_engine_best_move(
    fen: &str,
    req: &BuildVariantsTreeRequest,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>> {
    let engine = match req.engine.as_ref() {
        None => return Ok(None),
        Some(e) => e,
    };

    let tab = "variants-builder-backend".to_string();
    let requested_ms_u32 = std::cmp::max(1, req.engine_ms);
    let requested_ms_i64 = requested_ms_u32 as i64;
    let go_mode = GoMode::Time(requested_ms_u32);

    let mut extra = engine.extra_options.clone();
    if req.is960 && !extra.iter().any(|o| o.name == "UCI_Chess960") {
        extra.push(EngineOption {
            name: "UCI_Chess960".to_string(),
            value: "true".to_string(),
        });
    }

    // ---------------------------------------------------------------------
    // Engine cache: VariantPositions.db3 (SQLite)
    //
    // Rules:
    // - If cached ms >= requested ms: use cached move (no engine call).
    // - If cached ms < requested ms: compute, store, and return new move.
    // - If no cache row: compute, store, and return.
    // ---------------------------------------------------------------------

    let mut extra_sig = extra.clone();
    extra_sig.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.value.cmp(&b.value)));
    let extra_sig_s = extra_sig
        .iter()
        .map(|o| format!("{}={}", o.name.trim(), o.value.trim()))
        .collect::<Vec<_>>()
        .join(";");

    let engine_sig = format!(
        "{}|{}|is960={}|{}",
        engine.name.trim(),
        engine.path.trim(),
        req.is960,
        extra_sig_s
    );

    let fen_owned = fen.to_string();
    let engine_sig_owned = engine_sig.clone();
    let app_for_cache = app.clone();

    let cached = tokio::task::spawn_blocking(move || {
        variant_positions::get_variant_position(app_for_cache, fen_owned, engine_sig_owned)
    })
    .await
    .ok()
    .and_then(|r| r.ok())
    .flatten();

    if let Some(entry) = cached {
        if entry.ms >= requested_ms_i64 && !entry.recommended_move.trim().is_empty() {
            log::debug!(
                "variants_builder engine cache hit: fen_key={} engine={} cached_ms={} requested_ms={}",
                fen_identity_key(fen),
                engine_sig,
                entry.ms,
                requested_ms_i64
            );
            return Ok(Some(entry.recommended_move));
        }
    }

    let options = EngineOptions {
        fen: fen.to_string(),
        moves: vec![],
        extra_options: extra,
    };

    // `get_best_moves` can return None when (re)starting analysis; poll until we have progress or timeout.
    let started_at = Instant::now();
    let min_wait = Duration::from_millis(requested_ms_u32 as u64);
    let max_wait = Duration::from_millis(req.engine_ms.saturating_add(3000) as u64);

    let mut last_best_uci: Option<String> = None;

    loop {
        let result = crate::chess::get_best_moves(
            engine.name.clone(),
            engine.path.clone(),
            tab.clone(),
            go_mode.clone(),
            options.clone(),
            app.clone(),
            state.clone(),
        )
        .await?;

        if let Some((progress, lines)) = result {
            if let Some(best_uci) = lines
                .iter()
                .min_by_key(|bm| bm.multipv)
                .and_then(|bm| bm.uci_moves.get(0).cloned())
                .filter(|s| !s.trim().is_empty())
            {
                last_best_uci = Some(best_uci);
            }

            if progress >= 99.9 && last_best_uci.is_some() && started_at.elapsed() >= min_wait {
                break;
            }
        }

        if started_at.elapsed() >= max_wait {
            break;
        }

        sleep(Duration::from_millis(50)).await;
    }

    // Convert engine UCI to SAN for stability with frontend tree stores.
    if let Some(uci) = last_best_uci {
        let picked = match uci_to_san(fen, &uci, req.is960) {
            Ok(san) => san,
            Err(_) => uci, // fallback to UCI
        };

        // Best-effort upsert: only overwrites if ms is higher (handled in SQL).
        let app_for_write = app.clone();
        let fen_for_write = fen.to_string();
        let engine_for_write = engine_sig.clone();
        let mv_for_write = picked.clone();
        let _ = tokio::task::spawn_blocking(move || {
            variant_positions::upsert_variant_position(
                app_for_write,
                fen_for_write,
                engine_for_write,
                mv_for_write,
                requested_ms_u32,
            )
        })
        .await;

        Ok(Some(picked))
    } else {
        Ok(None)
    }
}

async fn get_engine_candidate_lines(
    fen: &str,
    req: &BuildVariantsTreeRequest,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    min_lines: usize,
) -> Result<Vec<BestMoves>> {
    let engine = match req.engine.as_ref() {
        None => return Ok(Vec::new()),
        Some(e) => e,
    };

    let tab = "variants-builder-backend".to_string();
    let requested_ms_u32 = std::cmp::max(1, req.engine_ms);
    let go_mode = GoMode::Time(requested_ms_u32);

    let mut extra = engine.extra_options.clone();
    if req.is960 && !extra.iter().any(|o| o.name == "UCI_Chess960") {
        extra.push(EngineOption {
            name: "UCI_Chess960".to_string(),
            value: "true".to_string(),
        });
    }

    let required_multipv = std::cmp::max(1, min_lines) as u32;
    let mut has_multipv = false;
    for opt in &mut extra {
        if opt.name == "MultiPV" {
            has_multipv = true;
            let current = opt.value.parse::<u32>().unwrap_or(1);
            if current < required_multipv {
                opt.value = required_multipv.to_string();
            }
        }
    }
    if !has_multipv {
        extra.push(EngineOption {
            name: "MultiPV".to_string(),
            value: required_multipv.to_string(),
        });
    }

    let options = EngineOptions {
        fen: fen.to_string(),
        moves: vec![],
        extra_options: extra,
    };

    let started_at = Instant::now();
    let min_wait = Duration::from_millis(requested_ms_u32 as u64);
    let max_wait = Duration::from_millis(req.engine_ms.saturating_add(3000) as u64);

    let mut last_lines: Vec<BestMoves> = Vec::new();

    loop {
        let result = crate::chess::get_best_moves(
            engine.name.clone(),
            engine.path.clone(),
            tab.clone(),
            go_mode.clone(),
            options.clone(),
            app.clone(),
            state.clone(),
        )
        .await?;

        if let Some((progress, lines)) = result {
            if !lines.is_empty() {
                let mut sorted = lines;
                sorted.sort_by_key(|bm| bm.multipv);
                let mut seen_first_moves: HashSet<String> = HashSet::new();
                let mut top: Vec<BestMoves> = Vec::new();
                for line in sorted {
                    if let Some(first) = line
                        .uci_moves
                        .get(0)
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                        .map(ToString::to_string)
                    {
                        if seen_first_moves.insert(first) {
                            top.push(line);
                        }
                        if top.len() >= required_multipv as usize {
                            break;
                        }
                    }
                }
                if !top.is_empty() {
                    last_lines = top;
                }
            }

            if progress >= 99.9 && !last_lines.is_empty() && started_at.elapsed() >= min_wait {
                break;
            }
        }

        if started_at.elapsed() >= max_wait {
            break;
        }

        sleep(Duration::from_millis(50)).await;
    }

    Ok(last_lines)
}

fn apply_move_to_fen(fen: &str, mv: &str, is960: bool) -> Result<String> {
    let castling = if is960 {
        CastlingMode::Chess960
    } else {
        CastlingMode::Standard
    };

    let mut pos: Chess = Fen::from_ascii(fen.as_bytes())?.into_position(castling)?;

    // Try UCI first, then SAN.
    if let Ok(uci) = UciMove::from_ascii(mv.as_bytes()) {
        let m = uci.to_move(&pos)?;
        pos.play_unchecked(&m);
    } else {
        let san = San::from_ascii(mv.as_bytes())?;
        let m = san.to_move(&pos)?;
        pos.play_unchecked(&m);
    }

    Ok(Fen::from_position(pos, EnPassantMode::Legal).to_string())
}

fn move_line_key(moves: &[MoveSpecDto]) -> String {
    moves
        .iter()
        .map(|m| m.value.trim())
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

fn push_unique_line(lines: &mut Vec<LineDto>, seen: &mut HashSet<String>, line: LineDto) {
    let key = move_line_key(&line.moves);
    if seen.insert(key) {
        lines.push(line);
    }
}

mod smart {
    use super::*;

    const MATE_CP: i32 = 100_000;
    const DEFAULT_VALIDATION_FULL_MOVES: u32 = 8;
    const MIN_VALIDATION_PLIES: u32 = DEFAULT_VALIDATION_FULL_MOVES * 2;
    const RELIABILITY_SAMPLE_SIZE: f64 = 120.0;
    const PRACTICAL_WEIGHT: f64 = 0.60;
    const SAFETY_WEIGHT: f64 = 0.18;
    const ENGINE_QUALITY_WEIGHT: f64 = 0.14;
    const RELIABILITY_WEIGHT: f64 = 0.05;
    const VALIDATION_COMPLETENESS_WEIGHT: f64 = 0.03;
    const EXPECTED_SCORE_WEIGHT: f64 = 0.25;
    const MAINLINE_SCORE_WEIGHT: f64 = 0.30;
    const WORST_BRANCH_SCORE_WEIGHT: f64 = 0.25;
    const TERMINAL_SCORE_WEIGHT: f64 = 0.20;
    const CURRENT_BRANCH_WEIGHT: f64 = 0.30;
    const FUTURE_BRANCH_WEIGHT: f64 = 0.70;
    const INCOMPLETE_VALIDATION_SCORE: f64 = 0.46;
    const SMART_VALIDATION_LICHESS_REQUEST_BUDGET: u32 = 32;

    #[derive(Debug, Clone, Copy)]
    pub(super) struct SmartConfig {
        pub candidate_multi_pv: usize,
        pub validation_full_moves: u32,
        pub validation_plies: u32,
        pub playable_threshold_cp: i32,
        pub max_validation_opponent_branches: usize,
        pub validation_beam_width: usize,
    }

    impl SmartConfig {
        pub(super) fn from_request(req: &BuildVariantsTreeRequest) -> Self {
            let dto = req.smart_config.as_ref();
            let validation_full_moves = dto
                .and_then(|cfg| cfg.validation_full_moves)
                .unwrap_or(DEFAULT_VALIDATION_FULL_MOVES)
                .clamp(DEFAULT_VALIDATION_FULL_MOVES, 20);
            let requested_validation_plies = dto
                .and_then(|cfg| cfg.validation_plies)
                .unwrap_or(validation_full_moves.saturating_mul(2))
                .clamp(1, 60);
            let minimum_validation_plies = validation_full_moves
                .saturating_mul(2)
                .max(MIN_VALIDATION_PLIES);
            let validation_plies = requested_validation_plies
                .max(minimum_validation_plies)
                .clamp(MIN_VALIDATION_PLIES, 60);

            Self {
                candidate_multi_pv: dto
                    .and_then(|cfg| cfg.candidate_multi_pv)
                    .unwrap_or(5)
                    .clamp(1, 16) as usize,
                validation_full_moves,
                validation_plies,
                playable_threshold_cp: dto
                    .and_then(|cfg| cfg.playable_threshold_cp)
                    .unwrap_or(-100),
                max_validation_opponent_branches: dto
                    .and_then(|cfg| cfg.max_validation_opponent_branches)
                    .unwrap_or(4)
                    .clamp(1, 12) as usize,
                validation_beam_width: dto
                    .and_then(|cfg| cfg.validation_beam_width)
                    .unwrap_or(24)
                    .clamp(1, 256) as usize,
            }
        }
    }

    #[derive(Debug, Clone)]
    pub(super) struct SmartPick {
        pub san: String,
        pub used_fallback: bool,
    }

    #[derive(Debug, Clone)]
    struct EngineCandidate {
        uci: String,
        san: String,
        engine_rank: usize,
        target_eval_cp: i32,
    }

    #[derive(Debug, Clone, Copy)]
    struct SmartOutcome {
        valid: bool,
        practical_score: f64,
        mainline_score: f64,
        worst_branch_score: f64,
        terminal_score: f64,
        sample_reliability: f64,
        min_target_eval_cp: i32,
        validation_complete: bool,
    }

    impl SmartOutcome {
        fn neutral() -> Self {
            Self {
                valid: true,
                practical_score: 0.5,
                mainline_score: 0.5,
                worst_branch_score: 0.5,
                terminal_score: 0.5,
                sample_reliability: 0.0,
                min_target_eval_cp: MATE_CP,
                validation_complete: true,
            }
        }

        fn incomplete() -> Self {
            Self {
                valid: true,
                practical_score: INCOMPLETE_VALIDATION_SCORE,
                mainline_score: INCOMPLETE_VALIDATION_SCORE,
                worst_branch_score: INCOMPLETE_VALIDATION_SCORE,
                terminal_score: INCOMPLETE_VALIDATION_SCORE,
                sample_reliability: 0.0,
                min_target_eval_cp: MATE_CP,
                validation_complete: false,
            }
        }

        fn invalid() -> Self {
            Self {
                valid: false,
                practical_score: 0.0,
                mainline_score: 0.0,
                worst_branch_score: 0.0,
                terminal_score: 0.0,
                sample_reliability: 0.0,
                min_target_eval_cp: -MATE_CP,
                validation_complete: false,
            }
        }
    }

    #[derive(Debug, Clone, Copy)]
    struct CandidateScoreInput {
        target_eval_cp: i32,
        best_target_eval_cp: i32,
        practical_score: f64,
        mainline_score: f64,
        worst_branch_score: f64,
        terminal_score: f64,
        sample_reliability: f64,
        validation_complete: bool,
        hidden_valid: bool,
    }

    #[derive(Debug, Clone)]
    struct CandidateEvaluation {
        candidate: EngineCandidate,
        outcome: SmartOutcome,
        final_score: f64,
    }

    pub(super) fn score_value_to_white_cp(value: &ScoreValue) -> i32 {
        match value {
            ScoreValue::Cp(cp) => *cp,
            ScoreValue::Mate(mate) => {
                let distance_penalty = ((*mate).unsigned_abs().min(999) as i32) * 10;
                if *mate > 0 {
                    MATE_CP.saturating_sub(distance_penalty)
                } else if *mate < 0 {
                    -MATE_CP.saturating_add(distance_penalty)
                } else {
                    0
                }
            }
        }
    }

    fn target_eval_cp_from_line(line: &BestMoves, target_side: Side) -> i32 {
        let white_cp = score_value_to_white_cp(&line.score.value);
        match target_side {
            Side::White => white_cp,
            Side::Black => -white_cp,
        }
    }

    fn sample_reliability(total: u32) -> f64 {
        let total = total as f64;
        if total <= 0.0 {
            return 0.0;
        }
        (total / (total + RELIABILITY_SAMPLE_SIZE)).clamp(0.0, 1.0)
    }

    fn target_expected_score(m: &ExplorerMove, target_side: Side) -> Option<f64> {
        let total = m.white + m.black + m.draws;
        if total == 0 {
            return None;
        }
        let wins = match target_side {
            Side::White => m.white,
            Side::Black => m.black,
        };
        Some((wins as f64 + (m.draws as f64 * 0.5)) / total as f64)
    }

    fn shrink_practical_score(raw_score: f64, reliability: f64) -> f64 {
        0.5 + (raw_score - 0.5) * reliability
    }

    fn blend_future_value(current: f64, future: f64) -> f64 {
        (current * CURRENT_BRANCH_WEIGHT + future * FUTURE_BRANCH_WEIGHT).clamp(0.0, 1.0)
    }

    fn validation_lichess_request_budget() -> u32 {
        SMART_VALIDATION_LICHESS_REQUEST_BUDGET
    }

    fn score_candidate_input(input: CandidateScoreInput, cfg: SmartConfig) -> Option<f64> {
        if !input.hidden_valid || input.target_eval_cp < cfg.playable_threshold_cp {
            return None;
        }

        let safety_margin =
            ((input.target_eval_cp - cfg.playable_threshold_cp) as f64 / 300.0).clamp(0.0, 1.0);
        let engine_drop = (input.best_target_eval_cp - input.target_eval_cp).max(0);
        let engine_quality = (1.0 - (engine_drop as f64 / 220.0)).clamp(0.0, 1.0);
        let practical_score = input.practical_score.clamp(0.0, 1.0);
        let mainline_score = input.mainline_score.clamp(0.0, 1.0);
        let worst_branch_score = input.worst_branch_score.clamp(0.0, 1.0);
        let terminal_score = input.terminal_score.clamp(0.0, 1.0);
        let practical_composite = practical_score * EXPECTED_SCORE_WEIGHT
            + mainline_score * MAINLINE_SCORE_WEIGHT
            + worst_branch_score * WORST_BRANCH_SCORE_WEIGHT
            + terminal_score * TERMINAL_SCORE_WEIGHT;
        let completeness = if input.validation_complete { 1.0 } else { 0.0 };

        Some(
            practical_composite * PRACTICAL_WEIGHT
                + safety_margin * SAFETY_WEIGHT
                + engine_quality * ENGINE_QUALITY_WEIGHT
                + input.sample_reliability.clamp(0.0, 1.0) * RELIABILITY_WEIGHT
                + completeness * VALIDATION_COMPLETENESS_WEIGHT,
        )
    }

    fn choose_candidate(
        candidates: &[CandidateEvaluation],
        engine_candidates: &[EngineCandidate],
    ) -> Option<SmartPick> {
        let best_scored = candidates.iter().max_by(|a, b| {
            a.final_score
                .partial_cmp(&b.final_score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    a.outcome
                        .min_target_eval_cp
                        .cmp(&b.outcome.min_target_eval_cp)
                })
                .then_with(|| b.candidate.engine_rank.cmp(&a.candidate.engine_rank))
        });

        if let Some(best) = best_scored {
            return Some(SmartPick {
                san: best.candidate.san.clone(),
                used_fallback: false,
            });
        }

        engine_candidates
            .iter()
            .min_by_key(|candidate| candidate.engine_rank)
            .map(|candidate| SmartPick {
                san: candidate.san.clone(),
                used_fallback: true,
            })
    }

    struct SmartRuntime<'a> {
        req: &'a BuildVariantsTreeRequest,
        app: AppHandle,
        state: tauri::State<'a, AppState>,
        target_side: Side,
        cfg: SmartConfig,
        existing_moves_by_fen: &'a HashMap<String, Vec<ExplorerMove>>,
        explorer_cache: &'a mut HashMap<String, Vec<ExplorerMove>>,
        lichess_requests_left: &'a mut u32,
        engine_cache: HashMap<String, Vec<EngineCandidate>>,
        memo: HashMap<String, SmartOutcome>,
    }

    impl<'a> SmartRuntime<'a> {
        async fn engine_candidates(&mut self, fen: &str) -> Result<Vec<EngineCandidate>> {
            let cache_key = format!(
                "{}|multipv={}",
                fen_identity_key(fen),
                self.cfg.candidate_multi_pv
            );
            if let Some(cached) = self.engine_cache.get(&cache_key) {
                return Ok(cached.clone());
            }

            let lines = get_engine_candidate_lines(
                fen,
                self.req,
                self.app.clone(),
                self.state.clone(),
                self.cfg.candidate_multi_pv,
            )
            .await?;

            let mut candidates: Vec<EngineCandidate> = Vec::new();
            let mut seen_uci: HashSet<String> = HashSet::new();

            for line in lines {
                let Some(first_uci) = line
                    .uci_moves
                    .first()
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                else {
                    continue;
                };
                if !seen_uci.insert(first_uci.clone()) {
                    continue;
                }

                let san = line
                    .san_moves
                    .first()
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .or_else(|| uci_to_san(fen, &first_uci, self.req.is960).ok())
                    .unwrap_or_else(|| first_uci.clone());

                candidates.push(EngineCandidate {
                    uci: first_uci,
                    san,
                    engine_rank: line.multipv.saturating_sub(1) as usize,
                    target_eval_cp: target_eval_cp_from_line(&line, self.target_side),
                });
            }

            candidates.sort_by(|a, b| {
                a.engine_rank
                    .cmp(&b.engine_rank)
                    .then_with(|| b.target_eval_cp.cmp(&a.target_eval_cp))
            });
            self.engine_cache.insert(cache_key, candidates.clone());
            Ok(candidates)
        }

        async fn opening_moves(&mut self, fen: &str) -> Result<Vec<ExplorerMove>> {
            get_opening_moves(
                fen,
                self.req,
                self.existing_moves_by_fen,
                self.lichess_requests_left,
                &self.app,
                self.state.clone(),
                self.explorer_cache,
            )
            .await
        }

        async fn pick_root(&mut self, fen: &str) -> Result<Option<SmartPick>> {
            let engine_candidates = self.engine_candidates(fen).await?;
            if engine_candidates.is_empty() {
                return Ok(None);
            }
            let best_target_eval_cp = engine_candidates
                .iter()
                .map(|candidate| candidate.target_eval_cp)
                .max()
                .unwrap_or(-MATE_CP);

            let mut scored: Vec<CandidateEvaluation> = Vec::new();
            for candidate in engine_candidates.clone() {
                let mut nodes_left = self.cfg.validation_beam_width;
                *self.lichess_requests_left = validation_lichess_request_budget();
                if let Some(evaluation) = Box::pin(self.score_candidate(
                    fen.to_string(),
                    candidate,
                    best_target_eval_cp,
                    self.cfg.validation_plies,
                    &mut nodes_left,
                ))
                .await?
                {
                    log::debug!(
                        "SMART candidate scored: fen_key={} move={} rank={} eval_cp={} expected={:.3} mainline={:.3} worst={:.3} terminal={:.3} reliability={:.3} complete={} final={:.3}",
                        fen_identity_key(fen),
                        evaluation.candidate.san,
                        evaluation.candidate.engine_rank + 1,
                        evaluation.candidate.target_eval_cp,
                        evaluation.outcome.practical_score,
                        evaluation.outcome.mainline_score,
                        evaluation.outcome.worst_branch_score,
                        evaluation.outcome.terminal_score,
                        evaluation.outcome.sample_reliability,
                        evaluation.outcome.validation_complete,
                        evaluation.final_score
                    );
                    scored.push(evaluation);
                }
            }

            Ok(choose_candidate(&scored, &engine_candidates))
        }

        async fn evaluate_position(
            &mut self,
            fen: String,
            plies_left: u32,
            nodes_left: &mut usize,
        ) -> Result<SmartOutcome> {
            if plies_left == 0 {
                return Ok(SmartOutcome::neutral());
            }
            if *nodes_left == 0 {
                return Ok(SmartOutcome::incomplete());
            }

            let memo_key = format!("{}|plies={}", fen_identity_key(&fen), plies_left);
            if let Some(cached) = self.memo.get(&memo_key) {
                return Ok(*cached);
            }

            let castling = if self.req.is960 {
                CastlingMode::Chess960
            } else {
                CastlingMode::Standard
            };
            let pos: Chess = Fen::from_ascii(fen.as_bytes())?.into_position(castling)?;
            if pos.is_game_over() {
                return Ok(SmartOutcome::neutral());
            }

            let outcome = if fen_turn(&fen)? == self.target_side {
                Box::pin(self.evaluate_target_turn(fen.clone(), plies_left, nodes_left)).await?
            } else {
                Box::pin(self.evaluate_opponent_turn(fen.clone(), plies_left, nodes_left)).await?
            };

            if outcome.validation_complete {
                self.memo.insert(memo_key, outcome);
            }
            Ok(outcome)
        }

        async fn evaluate_target_turn(
            &mut self,
            fen: String,
            plies_left: u32,
            nodes_left: &mut usize,
        ) -> Result<SmartOutcome> {
            let engine_candidates = self.engine_candidates(&fen).await?;
            if engine_candidates.is_empty() {
                return Ok(SmartOutcome::invalid());
            }
            let best_target_eval_cp = engine_candidates
                .iter()
                .map(|candidate| candidate.target_eval_cp)
                .max()
                .unwrap_or(-MATE_CP);

            let mut best: Option<CandidateEvaluation> = None;
            for candidate in engine_candidates {
                if *nodes_left == 0 {
                    break;
                }
                let Some(evaluation) = Box::pin(self.score_candidate(
                    fen.clone(),
                    candidate,
                    best_target_eval_cp,
                    plies_left,
                    nodes_left,
                ))
                .await?
                else {
                    continue;
                };
                if best
                    .as_ref()
                    .map(|current| evaluation.final_score > current.final_score)
                    .unwrap_or(true)
                {
                    best = Some(evaluation);
                }
            }

            Ok(best
                .map(|evaluation| evaluation.outcome)
                .unwrap_or_else(SmartOutcome::invalid))
        }

        async fn score_candidate(
            &mut self,
            fen: String,
            candidate: EngineCandidate,
            best_target_eval_cp: i32,
            plies_left: u32,
            nodes_left: &mut usize,
        ) -> Result<Option<CandidateEvaluation>> {
            if candidate.target_eval_cp < self.cfg.playable_threshold_cp {
                return Ok(None);
            }
            if *nodes_left == 0 {
                return Ok(None);
            }
            *nodes_left = nodes_left.saturating_sub(1);

            let next_fen = match apply_move_to_fen(&fen, &candidate.uci, self.req.is960) {
                Ok(value) => value,
                Err(err) => {
                    log::warn!(
                        "SMART failed to apply engine candidate {} from fen_key={}: {}",
                        candidate.uci,
                        fen_identity_key(&fen),
                        err
                    );
                    return Ok(None);
                }
            };

            let child = if plies_left <= 1 {
                SmartOutcome::neutral()
            } else {
                Box::pin(self.evaluate_position(next_fen, plies_left.saturating_sub(1), nodes_left))
                    .await?
            };

            if !child.valid || child.min_target_eval_cp < self.cfg.playable_threshold_cp {
                return Ok(None);
            }

            let min_target_eval_cp = candidate.target_eval_cp.min(child.min_target_eval_cp);
            let outcome = SmartOutcome {
                valid: true,
                practical_score: child.practical_score,
                mainline_score: child.mainline_score,
                worst_branch_score: child.worst_branch_score,
                terminal_score: child.terminal_score,
                sample_reliability: child.sample_reliability,
                min_target_eval_cp,
                validation_complete: child.validation_complete,
            };
            let input = CandidateScoreInput {
                target_eval_cp: candidate.target_eval_cp,
                best_target_eval_cp,
                practical_score: outcome.practical_score,
                mainline_score: outcome.mainline_score,
                worst_branch_score: outcome.worst_branch_score,
                terminal_score: outcome.terminal_score,
                sample_reliability: outcome.sample_reliability,
                validation_complete: outcome.validation_complete,
                hidden_valid: outcome.valid && min_target_eval_cp >= self.cfg.playable_threshold_cp,
            };
            let Some(final_score) = score_candidate_input(input, self.cfg) else {
                return Ok(None);
            };

            Ok(Some(CandidateEvaluation {
                candidate,
                outcome,
                final_score,
            }))
        }

        async fn evaluate_opponent_turn(
            &mut self,
            fen: String,
            plies_left: u32,
            nodes_left: &mut usize,
        ) -> Result<SmartOutcome> {
            let opening_moves = self.opening_moves(&fen).await?;
            if !smart_source_has_enough_games(&opening_moves) {
                return Ok(SmartOutcome::incomplete());
            }

            let mut selected =
                select_coverage_moves(&opening_moves, self.req.coverage, self.req.min_moves);
            if selected.len() > self.cfg.max_validation_opponent_branches {
                selected.truncate(self.cfg.max_validation_opponent_branches);
            }
            if selected.is_empty() {
                return Ok(SmartOutcome::incomplete());
            }

            let total_counts: u32 = selected.iter().map(|m| m.white + m.black + m.draws).sum();
            let equal_weight = 1.0 / selected.len() as f64;
            let mut weighted_practical = 0.0;
            let mut weighted_reliability = 0.0;
            let mut weighted_terminal = 0.0;
            let mut mainline_score: Option<f64> = None;
            let mut worst_branch_score = 1.0;
            let mut min_target_eval_cp = MATE_CP;
            let mut applied_any = false;
            let mut validation_complete = true;

            for (idx, m) in selected.into_iter().enumerate() {
                let total = m.white + m.black + m.draws;
                let weight = if total_counts > 0 {
                    total as f64 / total_counts as f64
                } else {
                    equal_weight
                };
                let reliability = sample_reliability(total);
                let raw_practical = target_expected_score(&m, self.target_side).unwrap_or(0.5);
                let practical_now = shrink_practical_score(raw_practical, reliability);
                let next_fen = match apply_move_to_fen(&fen, &move_value_db(&m), self.req.is960) {
                    Ok(value) => value,
                    Err(_) => continue,
                };

                let child = if plies_left <= 1 {
                    SmartOutcome::neutral()
                } else {
                    Box::pin(self.evaluate_position(
                        next_fen,
                        plies_left.saturating_sub(1),
                        nodes_left,
                    ))
                    .await?
                };

                if !child.valid || child.min_target_eval_cp < self.cfg.playable_threshold_cp {
                    return Ok(SmartOutcome::invalid());
                }
                validation_complete = validation_complete && child.validation_complete;

                let branch_practical = if plies_left <= 1 {
                    practical_now
                } else {
                    blend_future_value(practical_now, child.practical_score)
                };
                let branch_mainline = if plies_left <= 1 {
                    practical_now
                } else {
                    practical_now.min(child.mainline_score)
                };
                let branch_worst = if plies_left <= 1 {
                    practical_now
                } else {
                    practical_now.min(child.worst_branch_score)
                };
                let branch_terminal = if plies_left <= 1 {
                    practical_now
                } else {
                    child.terminal_score
                };
                let branch_reliability = if plies_left <= 1 {
                    reliability
                } else {
                    blend_future_value(reliability, child.sample_reliability)
                };

                weighted_practical += branch_practical * weight;
                weighted_terminal += branch_terminal * weight;
                weighted_reliability += branch_reliability * weight;
                if idx == 0 {
                    mainline_score = Some(branch_mainline);
                }
                worst_branch_score = f64::min(worst_branch_score, branch_worst);
                min_target_eval_cp = min_target_eval_cp.min(child.min_target_eval_cp);
                applied_any = true;
            }

            if !applied_any {
                return Ok(SmartOutcome::incomplete());
            }

            Ok(SmartOutcome {
                valid: true,
                practical_score: weighted_practical.clamp(0.0, 1.0),
                mainline_score: mainline_score
                    .unwrap_or(INCOMPLETE_VALIDATION_SCORE)
                    .clamp(0.0, 1.0),
                worst_branch_score: worst_branch_score.clamp(0.0, 1.0),
                terminal_score: weighted_terminal.clamp(0.0, 1.0),
                sample_reliability: weighted_reliability.clamp(0.0, 1.0),
                min_target_eval_cp,
                validation_complete,
            })
        }
    }

    pub(super) async fn pick_smart_move(
        req: &BuildVariantsTreeRequest,
        app: AppHandle,
        state: tauri::State<'_, AppState>,
        target_side: Side,
        fen: &str,
        existing_moves_by_fen: &HashMap<String, Vec<ExplorerMove>>,
        explorer_cache: &mut HashMap<String, Vec<ExplorerMove>>,
        _visible_lichess_requests_left: &mut u32,
    ) -> Result<Option<SmartPick>> {
        let cfg = SmartConfig::from_request(req);
        let mut validation_lichess_requests_left = validation_lichess_request_budget();
        log::debug!(
            "SMART build candidate selection: fen_key={} multipv={} validation_full_moves={} validation_plies={} threshold_cp={} opponent_branches={} beam={} validation_lichess_budget={}",
            fen_identity_key(fen),
            cfg.candidate_multi_pv,
            cfg.validation_full_moves,
            cfg.validation_plies,
            cfg.playable_threshold_cp,
            cfg.max_validation_opponent_branches,
            cfg.validation_beam_width,
            validation_lichess_requests_left
        );
        let mut runtime = SmartRuntime {
            req,
            app,
            state,
            target_side,
            cfg,
            existing_moves_by_fen,
            explorer_cache,
            lichess_requests_left: &mut validation_lichess_requests_left,
            engine_cache: HashMap::new(),
            memo: HashMap::new(),
        };
        runtime.pick_root(fen).await
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn cfg() -> SmartConfig {
            SmartConfig {
                candidate_multi_pv: 5,
                validation_full_moves: 8,
                validation_plies: 16,
                playable_threshold_cp: -100,
                max_validation_opponent_branches: 4,
                validation_beam_width: 24,
            }
        }

        fn request_with_smart_config(
            smart_config: Option<SmartConfigDto>,
        ) -> BuildVariantsTreeRequest {
            BuildVariantsTreeRequest {
                root: TreeNodeDto {
                    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string(),
                    san: None,
                    children: Vec::new(),
                },
                start_path: Vec::new(),
                orientation: "white".to_string(),
                is960: false,
                db_type: "local".to_string(),
                local_db_path: Some("test.db".to_string()),
                lichess_options: None,
                master_options: None,
                lichess_token: None,
                mode: BuildVariantsMode::Smart,
                smart_config,
                engine: None,
                engine_ms: 800,
                coverage: 90,
                min_moves: 2,
                depth: 2,
                split_config: None,
            }
        }

        #[test]
        fn config_defaults_to_hidden_eight_full_move_validation() {
            let req = request_with_smart_config(None);
            let config = SmartConfig::from_request(&req);
            assert_eq!(config.validation_full_moves, 8);
            assert_eq!(config.validation_plies, 16);
        }

        #[test]
        fn config_does_not_allow_shallow_hidden_validation() {
            let req = request_with_smart_config(Some(SmartConfigDto {
                candidate_multi_pv: Some(0),
                validation_full_moves: Some(1),
                validation_plies: Some(1),
                playable_threshold_cp: Some(-100),
                max_validation_opponent_branches: Some(0),
                validation_beam_width: Some(0),
            }));
            let config = SmartConfig::from_request(&req);
            assert_eq!(config.candidate_multi_pv, 1);
            assert_eq!(config.validation_full_moves, 8);
            assert_eq!(config.validation_plies, 16);
            assert_eq!(config.max_validation_opponent_branches, 1);
            assert_eq!(config.validation_beam_width, 1);
        }

        #[test]
        fn config_uses_full_moves_to_raise_validation_plies() {
            let req = request_with_smart_config(Some(SmartConfigDto {
                candidate_multi_pv: Some(5),
                validation_full_moves: Some(12),
                validation_plies: Some(16),
                playable_threshold_cp: Some(-100),
                max_validation_opponent_branches: Some(4),
                validation_beam_width: Some(24),
            }));
            let config = SmartConfig::from_request(&req);
            assert_eq!(config.validation_full_moves, 12);
            assert_eq!(config.validation_plies, 24);
        }

        #[test]
        fn target_eval_conversion_uses_target_side_perspective() {
            let mut line = BestMoves::default();
            line.score.value = ScoreValue::Cp(80);
            assert_eq!(target_eval_cp_from_line(&line, Side::White), 80);
            assert_eq!(target_eval_cp_from_line(&line, Side::Black), -80);
        }

        #[test]
        fn mate_scores_convert_without_overflow_or_zero_bias() {
            assert!(score_value_to_white_cp(&ScoreValue::Mate(3)) > 90_000);
            assert!(score_value_to_white_cp(&ScoreValue::Mate(-3)) < -90_000);
            assert_eq!(score_value_to_white_cp(&ScoreValue::Mate(0)), 0);
            assert!(score_value_to_white_cp(&ScoreValue::Mate(i32::MIN)) < -90_000);
        }

        #[test]
        fn score_rejects_candidates_below_playable_threshold() {
            let input = CandidateScoreInput {
                target_eval_cp: -101,
                best_target_eval_cp: 20,
                practical_score: 0.8,
                mainline_score: 0.8,
                worst_branch_score: 0.8,
                terminal_score: 0.8,
                sample_reliability: 0.9,
                validation_complete: true,
                hidden_valid: true,
            };
            assert!(score_candidate_input(input, cfg()).is_none());
        }

        #[test]
        fn score_allows_non_best_engine_move_with_better_practical_score() {
            let config = cfg();
            let engine_best = score_candidate_input(
                CandidateScoreInput {
                    target_eval_cp: 35,
                    best_target_eval_cp: 35,
                    practical_score: 0.50,
                    mainline_score: 0.50,
                    worst_branch_score: 0.50,
                    terminal_score: 0.50,
                    sample_reliability: 0.8,
                    validation_complete: true,
                    hidden_valid: true,
                },
                config,
            )
            .unwrap();
            let practical_alt = score_candidate_input(
                CandidateScoreInput {
                    target_eval_cp: 0,
                    best_target_eval_cp: 35,
                    practical_score: 0.72,
                    mainline_score: 0.72,
                    worst_branch_score: 0.72,
                    terminal_score: 0.72,
                    sample_reliability: 0.8,
                    validation_complete: true,
                    hidden_valid: true,
                },
                config,
            )
            .unwrap();
            assert!(practical_alt > engine_best);
        }

        #[test]
        fn low_sample_scores_are_shrunk_toward_neutral() {
            let low = shrink_practical_score(0.9, sample_reliability(5));
            let high = shrink_practical_score(0.9, sample_reliability(500));
            assert!(low > 0.5);
            assert!(low < high);
            assert!(high < 0.9);
        }

        #[test]
        fn future_blend_keeps_terminal_signal_material() {
            let blended = blend_future_value(0.0, 1.0);
            assert!(blended > 0.5);
            assert!(blended < 1.0);
        }

        #[test]
        fn validation_budget_is_dedicated_to_hidden_smart_search() {
            assert_eq!(validation_lichess_request_budget(), 32);
        }

        #[test]
        fn score_rejects_hidden_validation_failures() {
            let input = CandidateScoreInput {
                target_eval_cp: 30,
                best_target_eval_cp: 30,
                practical_score: 0.9,
                mainline_score: 0.9,
                worst_branch_score: 0.9,
                terminal_score: 0.9,
                sample_reliability: 1.0,
                validation_complete: true,
                hidden_valid: false,
            };
            assert!(score_candidate_input(input, cfg()).is_none());
        }

        #[test]
        fn score_prefers_future_terminal_and_mainline_over_shallow_average() {
            let config = cfg();
            let shallow_good_terminal_bad = score_candidate_input(
                CandidateScoreInput {
                    target_eval_cp: 58,
                    best_target_eval_cp: 58,
                    practical_score: 0.508,
                    mainline_score: 0.385,
                    worst_branch_score: 0.25,
                    terminal_score: 0.0,
                    sample_reliability: 0.9,
                    validation_complete: true,
                    hidden_valid: true,
                },
                config,
            )
            .unwrap();
            let slightly_lower_immediate_better_future = score_candidate_input(
                CandidateScoreInput {
                    target_eval_cp: 53,
                    best_target_eval_cp: 58,
                    practical_score: 0.477,
                    mainline_score: 0.431,
                    worst_branch_score: 0.375,
                    terminal_score: 0.554,
                    sample_reliability: 0.9,
                    validation_complete: true,
                    hidden_valid: true,
                },
                config,
            )
            .unwrap();

            assert!(slightly_lower_immediate_better_future > shallow_good_terminal_bad);
        }

        #[test]
        fn score_penalizes_bad_mainline_even_when_global_average_is_high() {
            let config = cfg();
            let high_average_bad_mainline = score_candidate_input(
                CandidateScoreInput {
                    target_eval_cp: 40,
                    best_target_eval_cp: 40,
                    practical_score: 0.62,
                    mainline_score: 0.35,
                    worst_branch_score: 0.35,
                    terminal_score: 0.42,
                    sample_reliability: 0.9,
                    validation_complete: true,
                    hidden_valid: true,
                },
                config,
            )
            .unwrap();
            let lower_average_healthy_mainline = score_candidate_input(
                CandidateScoreInput {
                    target_eval_cp: 35,
                    best_target_eval_cp: 40,
                    practical_score: 0.55,
                    mainline_score: 0.53,
                    worst_branch_score: 0.49,
                    terminal_score: 0.52,
                    sample_reliability: 0.9,
                    validation_complete: true,
                    hidden_valid: true,
                },
                config,
            )
            .unwrap();

            assert!(lower_average_healthy_mainline > high_average_bad_mainline);
        }

        #[test]
        fn score_penalizes_incomplete_hidden_validation() {
            let config = cfg();
            let complete = score_candidate_input(
                CandidateScoreInput {
                    target_eval_cp: 30,
                    best_target_eval_cp: 30,
                    practical_score: 0.55,
                    mainline_score: 0.55,
                    worst_branch_score: 0.55,
                    terminal_score: 0.55,
                    sample_reliability: 0.7,
                    validation_complete: true,
                    hidden_valid: true,
                },
                config,
            )
            .unwrap();
            let incomplete = score_candidate_input(
                CandidateScoreInput {
                    target_eval_cp: 30,
                    best_target_eval_cp: 30,
                    practical_score: 0.55,
                    mainline_score: 0.55,
                    worst_branch_score: 0.55,
                    terminal_score: 0.55,
                    sample_reliability: 0.7,
                    validation_complete: false,
                    hidden_valid: true,
                },
                config,
            )
            .unwrap();

            assert!(complete > incomplete);
        }

        #[test]
        fn choose_candidate_falls_back_to_engine_best_when_all_scored_fail() {
            let engine_candidates = vec![
                EngineCandidate {
                    uci: "e2e4".to_string(),
                    san: "e4".to_string(),
                    engine_rank: 0,
                    target_eval_cp: -120,
                },
                EngineCandidate {
                    uci: "d2d4".to_string(),
                    san: "d4".to_string(),
                    engine_rank: 1,
                    target_eval_cp: -140,
                },
            ];
            let pick = choose_candidate(&[], &engine_candidates).unwrap();
            assert!(pick.used_fallback);
            assert_eq!(pick.san, "e4");
        }

        #[test]
        fn choose_candidate_prefers_engine_rank_when_scores_tie() {
            let engine_candidates = vec![
                EngineCandidate {
                    uci: "e2e4".to_string(),
                    san: "e4".to_string(),
                    engine_rank: 0,
                    target_eval_cp: 30,
                },
                EngineCandidate {
                    uci: "d2d4".to_string(),
                    san: "d4".to_string(),
                    engine_rank: 1,
                    target_eval_cp: 30,
                },
            ];
            let scored = vec![
                CandidateEvaluation {
                    candidate: engine_candidates[1].clone(),
                    outcome: SmartOutcome {
                        valid: true,
                        practical_score: 0.6,
                        mainline_score: 0.6,
                        worst_branch_score: 0.6,
                        terminal_score: 0.6,
                        sample_reliability: 0.8,
                        min_target_eval_cp: 30,
                        validation_complete: true,
                    },
                    final_score: 0.7,
                },
                CandidateEvaluation {
                    candidate: engine_candidates[0].clone(),
                    outcome: SmartOutcome {
                        valid: true,
                        practical_score: 0.6,
                        mainline_score: 0.6,
                        worst_branch_score: 0.6,
                        terminal_score: 0.6,
                        sample_reliability: 0.8,
                        min_target_eval_cp: 30,
                        validation_complete: true,
                    },
                    final_score: 0.7,
                },
            ];
            let pick = choose_candidate(&scored, &engine_candidates).unwrap();
            assert!(!pick.used_fallback);
            assert_eq!(pick.san, "e4");
        }

        #[test]
        fn build_mode_rejects_removed_highest_win_rate_mode() {
            let parsed: std::result::Result<BuildVariantsMode, _> =
                serde_json::from_value(serde_json::json!("highest_win_rate"));
            assert!(parsed.is_err());
        }
    }
}

fn build_segmented_response(
    req: &BuildVariantsTreeRequest,
    start_fen: &str,
    lines: &[LineDto],
) -> (Vec<LineDto>, Option<Vec<SegmentDto>>, Option<Vec<String>>) {
    let Some(split_cfg) = req.split_config.as_ref() else {
        return (lines.to_vec(), None, None);
    };

    if !split_cfg.enabled || !split_cfg.mode.eq_ignore_ascii_case("auto") {
        return (lines.to_vec(), None, None);
    }

    let split_at = split_cfg.split_at_ply.unwrap_or(0) as usize;
    if split_at == 0 {
        return (
            lines.to_vec(),
            None,
            Some(vec![
                "splitConfig.enabled=true requires splitAtPly > 0 for auto mode".to_string(),
            ]),
        );
    }

    let max_segments = std::cmp::max(1, split_cfg.max_segments.unwrap_or(64)) as usize;
    let max_lines_per_segment =
        std::cmp::max(1, split_cfg.max_lines_per_segment.unwrap_or(200)) as usize;

    let mut warnings: Vec<String> = Vec::new();
    let mut warning_seen: HashSet<String> = HashSet::new();
    let mut parent_lines: Vec<LineDto> = Vec::new();
    let mut parent_seen: HashSet<String> = HashSet::new();
    let mut segments: Vec<SegmentDto> = Vec::new();
    let mut segment_idx_by_key: HashMap<String, usize> = HashMap::new();
    let mut segment_line_seen: HashMap<String, HashSet<String>> = HashMap::new();

    let mut warn_once = |msg: String| {
        if warning_seen.insert(msg.clone()) {
            warnings.push(msg);
        }
    };

    for line in lines {
        if line.moves.is_empty() {
            continue;
        }

        if line.moves.len() <= split_at {
            push_unique_line(&mut parent_lines, &mut parent_seen, line.clone());
            continue;
        }

        let prefix_moves = line.moves[..split_at].to_vec();
        let tail_moves = line.moves[split_at..].to_vec();
        if prefix_moves.is_empty() || tail_moves.is_empty() {
            push_unique_line(&mut parent_lines, &mut parent_seen, line.clone());
            continue;
        }

        let mut anchor_fen = start_fen.to_string();
        let mut anchor_ok = true;
        for step in &prefix_moves {
            match apply_move_to_fen(&anchor_fen, &step.value, req.is960) {
                Ok(next) => anchor_fen = next,
                Err(err) => {
                    anchor_ok = false;
                    warn_once(format!(
                        "auto split: failed to compute anchor FEN at splitAtPly={} for line starting '{}': {}",
                        split_at, line.moves[0].value, err
                    ));
                    break;
                }
            }
        }

        if !anchor_ok {
            push_unique_line(&mut parent_lines, &mut parent_seen, line.clone());
            continue;
        }

        push_unique_line(
            &mut parent_lines,
            &mut parent_seen,
            LineDto {
                moves: prefix_moves.clone(),
            },
        );

        let first_tail = tail_moves[0].value.trim().to_string();
        if first_tail.is_empty() {
            continue;
        }

        let segment_key = format!(
            "{}|{}|{}",
            split_at,
            fen_identity_key(&anchor_fen),
            first_tail.to_lowercase()
        );

        let segment_idx = if let Some(idx) = segment_idx_by_key.get(&segment_key) {
            *idx
        } else {
            if segments.len() >= max_segments {
                warn_once(format!(
                    "auto split: maxSegments={} reached; keeping extra branches in parent tree",
                    max_segments
                ));
                // Preserve full detail in parent when segment budget is exhausted.
                push_unique_line(&mut parent_lines, &mut parent_seen, line.clone());
                continue;
            }

            let next_idx = segments.len();
            let id = format!("segment-{}", next_idx + 1);
            segments.push(SegmentDto {
                id: id.clone(),
                anchor_ply: split_at as u32,
                anchor_fen: anchor_fen.clone(),
                anchor_path: req.start_path.clone(),
                title: Some(format!("After {} plies: {}", split_at, first_tail)),
                lines: Vec::new(),
                stats: SegmentStatsDto { line_count: 0 },
            });
            segment_idx_by_key.insert(segment_key, next_idx);
            next_idx
        };

        if segments[segment_idx].lines.len() >= max_lines_per_segment {
            warn_once(format!(
                "auto split: segment '{}' reached maxLinesPerSegment={}; keeping overflow in parent tree",
                segments[segment_idx].id, max_lines_per_segment
            ));
            // Preserve full detail in parent when segment line budget is exhausted.
            push_unique_line(&mut parent_lines, &mut parent_seen, line.clone());
            continue;
        }

        let segment_id = segments[segment_idx].id.clone();
        let key = move_line_key(&tail_moves);
        let seen = segment_line_seen
            .entry(segment_id.clone())
            .or_insert_with(HashSet::new);
        if seen.insert(key) {
            segments[segment_idx]
                .lines
                .push(LineDto { moves: tail_moves });
        }
    }

    let mut non_empty_segments: Vec<SegmentDto> = Vec::new();
    for mut seg in segments {
        if seg.lines.is_empty() {
            continue;
        }
        seg.stats.line_count = seg.lines.len() as u32;
        non_empty_segments.push(seg);
    }

    if non_empty_segments.is_empty() {
        return (
            lines.to_vec(),
            None,
            if warnings.is_empty() {
                None
            } else {
                Some(warnings)
            },
        );
    }

    (
        if parent_lines.is_empty() {
            lines.to_vec()
        } else {
            parent_lines
        },
        Some(non_empty_segments),
        if warnings.is_empty() {
            None
        } else {
            Some(warnings)
        },
    )
}

async fn build_variants_tree_impl(
    req: &BuildVariantsTreeRequest,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<BuildVariantsTreeResponse> {
    let my_side = Side::from_str(&req.orientation)?;
    let start_node = node_at_path(&req.root, &req.start_path)
        .ok_or_else(|| Error::FenError("Invalid startPath".to_string()))?;
    let start_fen = start_node.fen.trim();
    if start_fen.is_empty() {
        return Err(Error::FenError("Missing start FEN".to_string()));
    }

    // Avoid cycles within a single generated line (path-local).
    let mut fen_owners = seed_fen_owners(&req.root);
    let mut path_stack: Vec<String> = Vec::new();
    let mut explorer_cache: HashMap<String, Vec<ExplorerMove>> = HashMap::new();
    let existing_moves_by_fen = build_existing_moves_by_fen(&req.root);
    let mut smart_target_moves_by_fen = build_existing_target_moves_by_fen(&req.root, my_side);
    // Bound external requests by visible depth so deep visible branches are not starved by a flat cap.
    let mut lichess_requests_left = visible_lichess_request_budget(req);

    let mut lines: Vec<LineDto> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    emit_variants_builder_phase(&app, &req.start_path, &[], "starting");

    async fn rec(
        req: &BuildVariantsTreeRequest,
        app: AppHandle,
        state: tauri::State<'_, AppState>,
        start_path: &[u32],
        my_side: Side,
        fen_owners: &mut HashMap<String, String>,
        path_stack: &mut Vec<String>,
        explorer_cache: &mut HashMap<String, Vec<ExplorerMove>>,
        existing_moves_by_fen: &HashMap<String, Vec<ExplorerMove>>,
        smart_target_moves_by_fen: &mut HashMap<String, MoveSpecDto>,
        lichess_requests_left: &mut u32,
        current_fen: String,
        current_line: &mut Vec<MoveSpecDto>,
        my_moves_left: u32,
        lines: &mut Vec<LineDto>,
        warnings: &mut Vec<String>,
    ) -> Result<()> {
        if my_moves_left == 0 {
            if !current_line.is_empty() {
                lines.push(LineDto {
                    moves: current_line.clone(),
                });
            }
            return Ok(());
        }

        let key = fen_identity_key(&current_fen);
        if path_stack.iter().any(|k| k == &key) {
            if !current_line.is_empty() {
                lines.push(LineDto {
                    moves: current_line.clone(),
                });
            }
            return Ok(());
        }
        path_stack.push(key.clone());

        let res: Result<()> = async {
            fen_owners
                .entry(key.clone())
                .or_insert_with(|| "generated".to_string());

            let castling = if req.is960 {
                CastlingMode::Chess960
            } else {
                CastlingMode::Standard
            };
            let pos: Chess = Fen::from_ascii(current_fen.as_bytes())?.into_position(castling)?;
            if pos.is_game_over() {
                if !current_line.is_empty() {
                    lines.push(LineDto {
                        moves: current_line.clone(),
                    });
                }
                return Ok(());
            }

            let turn = fen_turn(&current_fen)?;
            let is_my_turn = turn == my_side;

            if is_my_turn {
                // MY TURN: choose exactly one move.
                emit_variants_builder_phase(
                    &app,
                    start_path,
                    current_line,
                    match req.mode {
                        BuildVariantsMode::Engine => "engine",
                        BuildVariantsMode::Smart => "smart",
                    },
                );

                if matches!(req.mode, BuildVariantsMode::Smart) && !current_line.is_empty() {
                    if let Some(reused_step) = smart_target_moves_by_fen.get(&key).cloned() {
                        if apply_move_to_fen(&current_fen, &reused_step.value, req.is960).is_ok() {
                            current_line.push(reused_step);
                            emit_variants_builder_progress(&app, start_path, current_line);
                            lines.push(LineDto {
                                moves: current_line.clone(),
                            });
                            current_line.pop();
                            return Ok(());
                        }
                    }
                }

                let picked: Option<MoveSpecDto> = match req.mode {
                    BuildVariantsMode::Engine => get_engine_best_move(&current_fen, req, app.clone(), state.clone())
                        .await?
                        .map(move_spec_from_engine),
                    BuildVariantsMode::Smart => {
                        let smart_pick = smart::pick_smart_move(
                            req,
                            app.clone(),
                            state.clone(),
                            my_side,
                            &current_fen,
                            existing_moves_by_fen,
                            explorer_cache,
                            lichess_requests_left,
                        )
                        .await?;

                        if smart_pick.as_ref().map(|pick| pick.used_fallback).unwrap_or(false) {
                            let warning = "SMART could not find a fully validated move and fell back to the best engine move.".to_string();
                            if !warnings.iter().any(|item| item == &warning) {
                                warnings.push(warning);
                            }
                        }

                        match smart_pick {
                            Some(pick) => Some(move_spec_from_smart(pick.san)),
                            None => {
                                let warning = "SMART could not produce a candidate in at least one visible branch and fell back to the best engine move.".to_string();
                                if !warnings.iter().any(|item| item == &warning) {
                                    warnings.push(warning);
                                }
                                get_engine_best_move(&current_fen, req, app.clone(), state.clone())
                                    .await?
                                    .map(move_spec_from_smart)
                            }
                        }
                    }
                };

                let Some(step) = picked else {
                    if !current_line.is_empty() {
                        lines.push(LineDto {
                            moves: current_line.clone(),
                        });
                    }
                    return Ok(());
                };

                let next_fen = match apply_move_to_fen(&current_fen, &step.value, req.is960) {
                    Ok(f) => f,
                    Err(_) => {
                        if !current_line.is_empty() {
                            lines.push(LineDto {
                                moves: current_line.clone(),
                            });
                        }
                        return Ok(());
                    }
                };

                let stored_target_step = step.clone();
                current_line.push(step);
                if matches!(req.mode, BuildVariantsMode::Smart) {
                    smart_target_moves_by_fen
                        .entry(key.clone())
                        .or_insert(stored_target_step);
                }
                emit_variants_builder_progress(&app, start_path, current_line);
                Box::pin(rec(
                    req,
                    app.clone(),
                    state.clone(),
                    start_path,
                    my_side,
                    fen_owners,
                    path_stack,
                    explorer_cache,
                    existing_moves_by_fen,
                    smart_target_moves_by_fen,
                    lichess_requests_left,
                    next_fen,
                    current_line,
                    my_moves_left.saturating_sub(1),
                    lines,
                    warnings,
                ))
                .await?;
                current_line.pop();
            } else {
                // OPPONENT TURN: expand DB replies based on coverage/minMoves.
                // To avoid runaway branching + huge external request volume, we hard-cap branching.
                const MAX_OPPONENT_BRANCHES: usize = 6;
                emit_variants_builder_phase(&app, start_path, current_line, "database");
                let opening_moves = get_opening_moves(
                    &current_fen,
                    req,
                    existing_moves_by_fen,
                    lichess_requests_left,
                    &app,
                    state.clone(),
                    explorer_cache,
                )
                .await?;

                if matches!(req.mode, BuildVariantsMode::Smart)
                    && !smart_source_has_enough_games(&opening_moves)
                {
                    let warning = format!(
                        "SMART stopped at positions with fewer than {} source games.",
                        SMART_MIN_SOURCE_GAMES
                    );
                    if !warnings.iter().any(|item| item == &warning) {
                        warnings.push(warning);
                    }
                    if !current_line.is_empty() {
                        lines.push(LineDto {
                            moves: current_line.clone(),
                        });
                    }
                    return Ok(());
                }

                let mut selected = select_coverage_moves(&opening_moves, req.coverage, req.min_moves);
                if selected.len() > MAX_OPPONENT_BRANCHES {
                    selected.truncate(MAX_OPPONENT_BRANCHES);
                }

                if selected.is_empty() {
                    if req.db_type != "local" && *lichess_requests_left == 0 {
                        let warning = "Lichess explorer request budget was exhausted before all visible branches reached the requested depth.".to_string();
                        if !warnings.iter().any(|item| item == &warning) {
                            warnings.push(warning);
                        }
                    }
                    // If the selected DB is unavailable (e.g. 429 / empty), allow an engine fallback
                    // for ENGINE mode so existing behavior remains unchanged. SMART must model
                    // opponent replies from human/statistical data only.
                    if matches!(req.mode, BuildVariantsMode::Engine) {
                        if let Some(engine_move) =
                            get_engine_best_move(&current_fen, req, app.clone(), state.clone()).await?
                        {
                            log::warn!(
                                "Opponent DB returned no moves; falling back to engine move for fen_key={}",
                                fen_identity_key(&current_fen)
                            );
                            let step = move_spec_from_engine(engine_move);
                            let next_fen = match apply_move_to_fen(&current_fen, &step.value, req.is960) {
                                Ok(f) => f,
                                Err(_) => {
                                    if !current_line.is_empty() {
                                        lines.push(LineDto {
                                            moves: current_line.clone(),
                                        });
                                    }
                                    return Ok(());
                                }
                            };
                            current_line.push(step);
                            emit_variants_builder_progress(&app, start_path, current_line);
                            Box::pin(rec(
                                req,
                                app.clone(),
                                state.clone(),
                                start_path,
                                my_side,
                                fen_owners,
                                path_stack,
                            explorer_cache,
                            existing_moves_by_fen,
                            smart_target_moves_by_fen,
                            lichess_requests_left,
                                next_fen,
                                current_line,
                                my_moves_left,
                                lines,
                                warnings,
                            ))
                            .await?;
                            current_line.pop();
                            return Ok(());
                        }
                    }
                    if !current_line.is_empty() {
                        lines.push(LineDto {
                            moves: current_line.clone(),
                        });
                    }
                    return Ok(());
                }

                for m in selected {
                    let step = move_spec_from_db(&m);
                    let next_fen = match apply_move_to_fen(&current_fen, &step.value, req.is960) {
                        Ok(f) => f,
                        Err(_) => continue,
                    };

                    current_line.push(step);
                    emit_variants_builder_progress(&app, start_path, current_line);
                    Box::pin(rec(
                        req,
                        app.clone(),
                        state.clone(),
                        start_path,
                        my_side,
                        fen_owners,
                        path_stack,
                    explorer_cache,
                    existing_moves_by_fen,
                    smart_target_moves_by_fen,
                    lichess_requests_left,
                        next_fen,
                        current_line,
                        my_moves_left,
                        lines,
                        warnings,
                    ))
                    .await?;
                    current_line.pop();
                }
            }

            Ok(())
        }
        .await;

        path_stack.pop();
        res
    }

    let mut line_buf: Vec<MoveSpecDto> = Vec::new();
    rec(
        req,
        app.clone(),
        state,
        &req.start_path,
        my_side,
        &mut fen_owners,
        &mut path_stack,
        &mut explorer_cache,
        &existing_moves_by_fen,
        &mut smart_target_moves_by_fen,
        &mut lichess_requests_left,
        start_fen.to_string(),
        &mut line_buf,
        std::cmp::max(1, req.depth),
        &mut lines,
        &mut warnings,
    )
    .await?;
    emit_variants_builder_phase(&app, &req.start_path, &line_buf, "finishing");

    let (parent_lines, segments, split_warnings) = build_segmented_response(req, start_fen, &lines);
    if let Some(split_warnings) = split_warnings {
        for warning in split_warnings {
            if !warnings.iter().any(|item| item == &warning) {
                warnings.push(warning);
            }
        }
    }

    Ok(BuildVariantsTreeResponse {
        lines: parent_lines,
        segments,
        warnings: if warnings.is_empty() {
            None
        } else {
            Some(warnings)
        },
    })
}

#[tauri::command]
#[specta::specta]
pub async fn build_variants_tree(
    request: BuildVariantsTreeRequest,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<BuildVariantsTreeResponse> {
    let result = build_variants_tree_impl(&request, app, state.clone()).await;
    // Ensure backend variants-builder engine instances never outlive this command.
    let _ = crate::chess::kill_engines("variants-builder-backend".to_string(), state).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_coverage_moves_respects_min_moves() {
        let moves = vec![
            ExplorerMove {
                uci: "".into(),
                san: "a".into(),
                white: 50,
                black: 0,
                draws: 0,
            },
            ExplorerMove {
                uci: "".into(),
                san: "b".into(),
                white: 30,
                black: 0,
                draws: 0,
            },
            ExplorerMove {
                uci: "".into(),
                san: "c".into(),
                white: 20,
                black: 0,
                draws: 0,
            },
        ];
        let selected = select_coverage_moves(&moves, 10, 3);
        assert_eq!(selected.len(), 3);
    }

    #[test]
    fn select_coverage_moves_allows_min_moves_1() {
        let moves = vec![
            ExplorerMove {
                uci: "".into(),
                san: "a".into(),
                white: 50,
                black: 0,
                draws: 0,
            },
            ExplorerMove {
                uci: "".into(),
                san: "b".into(),
                white: 30,
                black: 0,
                draws: 0,
            },
            ExplorerMove {
                uci: "".into(),
                san: "c".into(),
                white: 20,
                black: 0,
                draws: 0,
            },
        ];
        let selected = select_coverage_moves(&moves, 1, 1);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].san, "a");
    }

    #[test]
    fn select_coverage_moves_falls_back_when_counts_are_missing() {
        let moves = vec![
            ExplorerMove {
                uci: "".into(),
                san: "a".into(),
                white: 0,
                black: 0,
                draws: 0,
            },
            ExplorerMove {
                uci: "".into(),
                san: "b".into(),
                white: 0,
                black: 0,
                draws: 0,
            },
            ExplorerMove {
                uci: "".into(),
                san: "c".into(),
                white: 0,
                black: 0,
                draws: 0,
            },
        ];
        let selected = select_coverage_moves(&moves, 90, 2);
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].san, "a");
        assert_eq!(selected[1].san, "b");
    }

    #[test]
    fn smart_source_game_threshold_uses_position_total() {
        let low = vec![
            ExplorerMove {
                uci: "".into(),
                san: "a".into(),
                white: 300,
                black: 200,
                draws: 100,
            },
            ExplorerMove {
                uci: "".into(),
                san: "b".into(),
                white: 150,
                black: 100,
                draws: 50,
            },
        ];
        let high = vec![
            ExplorerMove {
                uci: "".into(),
                san: "a".into(),
                white: 300,
                black: 200,
                draws: 100,
            },
            ExplorerMove {
                uci: "".into(),
                san: "b".into(),
                white: 250,
                black: 100,
                draws: 50,
            },
        ];

        assert_eq!(source_total_games(&low), 900);
        assert!(!smart_source_has_enough_games(&low));
        assert_eq!(source_total_games(&high), 1_000);
        assert!(smart_source_has_enough_games(&high));
    }

    #[test]
    fn existing_target_moves_seed_smart_transposition_reuse() {
        let root = TreeNodeDto {
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string(),
            san: None,
            children: vec![TreeNodeDto {
                fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1".to_string(),
                san: Some("e4".to_string()),
                children: Vec::new(),
            }],
        };

        let moves = build_existing_target_moves_by_fen(&root, Side::White);
        let key = fen_identity_key(&root.fen);
        assert_eq!(moves.get(&key).map(|step| step.value.as_str()), Some("e4"));
    }

    fn request_for_budget(db_type: &str, depth: u32) -> BuildVariantsTreeRequest {
        BuildVariantsTreeRequest {
            root: TreeNodeDto {
                fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string(),
                san: None,
                children: Vec::new(),
            },
            start_path: Vec::new(),
            orientation: "white".to_string(),
            is960: false,
            db_type: db_type.to_string(),
            local_db_path: None,
            lichess_options: None,
            master_options: None,
            lichess_token: None,
            mode: BuildVariantsMode::Smart,
            smart_config: None,
            engine: None,
            engine_ms: 800,
            coverage: 90,
            min_moves: 2,
            depth,
            split_config: None,
        }
    }

    #[test]
    fn visible_lichess_budget_scales_with_requested_depth() {
        assert_eq!(
            visible_lichess_request_budget(&request_for_budget("local", 4)),
            0
        );
        assert_eq!(
            visible_lichess_request_budget(&request_for_budget("lch_all", 1)),
            80
        );
        assert_eq!(
            visible_lichess_request_budget(&request_for_budget("lch_all", 4)),
            259
        );
        assert_eq!(
            visible_lichess_request_budget(&request_for_budget("lch_all", 8)),
            600
        );
    }
}
