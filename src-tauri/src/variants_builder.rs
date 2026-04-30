use crate::chess::types::{EngineOption, EngineOptions, GoMode};
use crate::db::{GameQueryJs, PositionStats, PositionQueryJs};
use crate::error::{Error, Result};
use crate::variant_positions;
use crate::AppState;
use chrono::{Datelike, DateTime, FixedOffset};
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

async fn fetch_explorer(url: reqwest::Url, lichess_token: Option<&str>) -> Result<ExplorerPositionData> {
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
                status,
                body_preview
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

    pub mode: String, // "engine" | "winrate"
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
    /// "db" | "engine"
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
    moves: Vec<MoveSpecDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    segment_id: Option<String>,
}

fn emit_variants_builder_progress(app: &AppHandle, start_path: &[u32], moves: &[MoveSpecDto]) {
    let _ = app.emit(
        "variants_builder_progress",
        VariantsBuilderProgressPayload {
            start_path: start_path.to_vec(),
            moves: moves.to_vec(),
            segment_id: None,
        },
    );
}

// -----------------------------------------------------------------------------
// Explorer (lichess.ovh) response subset
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExplorerMove {
    uci: String,
    san: String,
    white: u32,
    black: u32,
    draws: u32,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct ExplorerOpening {
    #[serde(default)]
    eco: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct ExplorerPositionData {
    #[serde(default)]
    moves: Vec<ExplorerMove>,
    #[serde(default)]
    opening: Option<ExplorerOpening>,
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
                if let Some(san) = child.san.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
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
        return Err(Error::FenError(format!("Invalid FEN (missing turn): {fen}")));
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
    let dt: DateTime<FixedOffset> = DateTime::parse_from_rfc3339(s).ok()?;
    Some(format!("{}-{}", dt.year(), dt.month()))
}

fn parse_date_to_year(s: &str) -> Option<String> {
    let dt: DateTime<FixedOffset> = DateTime::parse_from_rfc3339(s).ok()?;
    Some(dt.year().to_string())
}

fn lichess_query_pairs(fen: &str, opt: &LichessGamesOptionsDto) -> Vec<(String, String)> {
    let mut parts: Vec<(String, String)> = Vec::new();
    parts.push(("fen".to_string(), fen.to_string()));

    if let Some(player) = opt.player.as_ref().map(|p| p.trim()).filter(|p| !p.is_empty()) {
        parts.push(("player".to_string(), player.to_string()));
        parts.push(("color".to_string(), opt.color.clone()));
    }
    if let Some(v) = opt.variant.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()) {
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

fn lichess_explorer_url(fen: &str, opt: &LichessGamesOptionsDto) -> Result<reqwest::Url> {
    let base = "https://explorer.lichess.ovh";
    let is_player = opt.player.as_ref().map(|p| !p.trim().is_empty()).unwrap_or(false);
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

fn masters_explorer_url(fen: &str, opt: &MasterGamesOptionsDto) -> Result<reqwest::Url> {
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

fn select_coverage_moves(moves: &[ExplorerMove], coverage: u32, min_moves: u32) -> Vec<ExplorerMove> {
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

fn winrate_score(m: &ExplorerMove, side: Side) -> Option<f64> {
    let total = (m.white + m.black + m.draws) as f64;
    if total <= 0.0 {
        return None;
    }
    let wins = match side {
        Side::White => m.white as f64,
        Side::Black => m.black as f64,
    };
    Some((wins + (m.draws as f64) * 0.5) / total)
}

fn rank_moves_by_winrate(moves: &[ExplorerMove], side: Side) -> Vec<ExplorerMove> {
    let mut indexed: Vec<(usize, ExplorerMove, f64, u32)> = moves
        .iter()
        .cloned()
        .enumerate()
        .map(|(idx, m)| {
            let score = winrate_score(&m, side).unwrap_or(-1.0);
            let total = m.white + m.black + m.draws;
            (idx, m, score, total)
        })
        .collect();

    indexed.sort_by(|a, b| {
        b.2.partial_cmp(&a.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.3.cmp(&a.3))
            .then_with(|| a.0.cmp(&b.0))
    });

    indexed.into_iter().map(|(_, m, _, _)| m).collect()
}

fn pick_best_winrate_move(moves: &[ExplorerMove], side: Side) -> Option<ExplorerMove> {
    rank_moves_by_winrate(moves, side).into_iter().next()
}

fn pick_best_winrate_move_with_engine_constraint(
    current_fen: &str,
    moves: &[ExplorerMove],
    side: Side,
    engine_top_uci_moves: &[String],
    is960: bool,
) -> Option<ExplorerMove> {
    let ranked = rank_moves_by_winrate(moves, side);
    let fallback = pick_best_winrate_move(moves, side)?;

    if engine_top_uci_moves.is_empty() {
        return Some(fallback);
    }

    let mut allowed_next_positions: HashSet<String> = HashSet::new();
    for uci in engine_top_uci_moves {
        if let Ok(next_fen) = apply_move_to_fen(current_fen, uci, is960) {
            allowed_next_positions.insert(fen_identity_key(&next_fen));
        }
    }

    if allowed_next_positions.is_empty() {
        return Some(fallback);
    }

    for candidate in ranked {
        let candidate_value = move_value_db(&candidate);
        if let Ok(next_fen) = apply_move_to_fen(current_fen, &candidate_value, is960) {
            if allowed_next_positions.contains(&fen_identity_key(&next_fen)) {
                return Some(candidate);
            }
        }
    }

    Some(fallback)
}

/// Convert an engine UCI move into SAN for the given FEN.
/// If conversion fails, caller can fall back to original UCI string.
fn uci_to_san(fen: &str, uci: &str, is960: bool) -> Result<String> {
    let castling = if is960 { CastlingMode::Chess960 } else { CastlingMode::Standard };
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
    // Existing tree moves do not include reliable counts for winrate/coverage.
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
                        log::warn!("Failed to fetch Lichess All explorer for FEN {}: {}", fen, e);
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
                        log::warn!("Failed to fetch Lichess Masters explorer for FEN {}: {}", fen, e);
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
                requested_ms_i64,
            )
        })
        .await;

        Ok(Some(picked))
    } else {
        Ok(None)
    }
}

async fn get_engine_top_moves(
    fen: &str,
    req: &BuildVariantsTreeRequest,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    min_lines: usize,
) -> Result<Vec<String>> {
    let engine = match req.engine.as_ref() {
        None => return Ok(vec![]),
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

    let mut last_top_moves: Vec<String> = Vec::new();

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
                let mut top: Vec<String> = Vec::new();
                for line in sorted {
                    if let Some(first) = line
                        .uci_moves
                        .get(0)
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                        .map(ToString::to_string)
                    {
                        if !top.iter().any(|m| m == &first) {
                            top.push(first);
                        }
                        if top.len() >= required_multipv as usize {
                            break;
                        }
                    }
                }
                if !top.is_empty() {
                    last_top_moves = top;
                }
            }

            if progress >= 99.9 && !last_top_moves.is_empty() && started_at.elapsed() >= min_wait {
                break;
            }
        }

        if started_at.elapsed() >= max_wait {
            break;
        }

        sleep(Duration::from_millis(50)).await;
    }

    Ok(last_top_moves)
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
            segments[segment_idx].lines.push(LineDto { moves: tail_moves });
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
            if warnings.is_empty() { None } else { Some(warnings) },
        );
    }

    (
        if parent_lines.is_empty() {
            lines.to_vec()
        } else {
            parent_lines
        },
        Some(non_empty_segments),
        if warnings.is_empty() { None } else { Some(warnings) },
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
    // Hard cap for external requests per run to avoid runaway branching saturating explorer.lichess.ovh.
    let mut lichess_requests_left: u32 = 80;

    let mut lines: Vec<LineDto> = Vec::new();

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
        lichess_requests_left: &mut u32,
        current_fen: String,
        current_line: &mut Vec<MoveSpecDto>,
        my_moves_left: u32,
        lines: &mut Vec<LineDto>,
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
            fen_owners.entry(key).or_insert_with(|| "generated".to_string());

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
                let picked: Option<MoveSpecDto> = if req.mode == "engine" {
                    get_engine_best_move(&current_fen, req, app.clone(), state.clone())
                        .await?
                        .map(move_spec_from_engine)
                } else {
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
                    let engine_top_moves = match get_engine_top_moves(
                        &current_fen,
                        req,
                        app.clone(),
                        state.clone(),
                        3,
                    )
                    .await
                    {
                        Ok(v) => v,
                        Err(e) => {
                            log::warn!(
                                "winrate+engine validation failed for fen_key={} error={}",
                                fen_identity_key(&current_fen),
                                e
                            );
                            vec![]
                        }
                    };
                    pick_best_winrate_move_with_engine_constraint(
                        &current_fen,
                        &opening_moves,
                        my_side,
                        &engine_top_moves,
                        req.is960,
                    )
                    .map(|m| move_spec_from_db(&m))
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
                    lichess_requests_left,
                    next_fen,
                    current_line,
                    my_moves_left.saturating_sub(1),
                    lines,
                ))
                .await?;
                current_line.pop();
            } else {
                // OPPONENT TURN: expand DB replies based on coverage/minMoves.
                // To avoid runaway branching + huge external request volume, we hard-cap branching.
                const MAX_OPPONENT_BRANCHES: usize = 6;
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
                let mut selected = select_coverage_moves(&opening_moves, req.coverage, req.min_moves);
                if selected.len() > MAX_OPPONENT_BRANCHES {
                    selected.truncate(MAX_OPPONENT_BRANCHES);
                }

                if selected.is_empty() {
                    // If the selected DB is unavailable (e.g. 429 / empty), allow an engine fallback
                    // so we still make progress and the UI can move pieces.
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
                            lichess_requests_left,
                            next_fen,
                            current_line,
                            my_moves_left,
                            lines,
                        ))
                        .await?;
                        current_line.pop();
                        return Ok(());
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
                        lichess_requests_left,
                        next_fen,
                        current_line,
                        my_moves_left,
                        lines,
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
        app,
        state,
        &req.start_path,
        my_side,
        &mut fen_owners,
        &mut path_stack,
        &mut explorer_cache,
        &existing_moves_by_fen,
        &mut lichess_requests_left,
        start_fen.to_string(),
        &mut line_buf,
        std::cmp::max(1, req.depth),
        &mut lines,
    )
    .await?;

    let (parent_lines, segments, warnings) = build_segmented_response(req, start_fen, &lines);

    Ok(BuildVariantsTreeResponse {
        lines: parent_lines,
        segments,
        warnings,
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
    fn pick_best_winrate_prefers_higher_score() {
        let moves = vec![
            ExplorerMove {
                uci: "".into(),
                san: "a".into(),
                white: 10,
                black: 10,
                draws: 0,
            },
            ExplorerMove {
                uci: "".into(),
                san: "b".into(),
                white: 9,
                black: 0,
                draws: 10,
            },
        ];
        let best = pick_best_winrate_move(&moves, Side::White).unwrap();
        assert_eq!(best.san, "b");
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
    fn pick_best_winrate_falls_back_to_first_when_counts_are_missing() {
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
        ];
        let best = pick_best_winrate_move(&moves, Side::White).unwrap();
        assert_eq!(best.san, "a");
    }

    #[test]
    fn winrate_with_engine_constraint_prefers_top_winrate_if_in_engine_top3() {
        let moves = vec![
            ExplorerMove {
                uci: "e2e4".into(),
                san: "e4".into(),
                white: 60,
                black: 30,
                draws: 10,
            },
            ExplorerMove {
                uci: "d2d4".into(),
                san: "d4".into(),
                white: 55,
                black: 35,
                draws: 10,
            },
        ];
        let engine_top = vec!["e2e4".to_string(), "c2c4".to_string(), "g1f3".to_string()];
        let picked = pick_best_winrate_move_with_engine_constraint(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &moves,
            Side::White,
            &engine_top,
            false,
        )
        .unwrap();
        assert_eq!(picked.san, "e4");
    }

    #[test]
    fn winrate_with_engine_constraint_falls_to_next_when_top_not_in_engine_top3() {
        let moves = vec![
            ExplorerMove {
                uci: "e2e4".into(),
                san: "e4".into(),
                white: 60,
                black: 30,
                draws: 10,
            },
            ExplorerMove {
                uci: "d2d4".into(),
                san: "d4".into(),
                white: 58,
                black: 32,
                draws: 10,
            },
            ExplorerMove {
                uci: "g1f3".into(),
                san: "Nf3".into(),
                white: 57,
                black: 33,
                draws: 10,
            },
        ];
        let engine_top = vec!["d2d4".to_string(), "g1f3".to_string(), "c2c4".to_string()];
        let picked = pick_best_winrate_move_with_engine_constraint(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &moves,
            Side::White,
            &engine_top,
            false,
        )
        .unwrap();
        assert_eq!(picked.san, "d4");
    }
}
