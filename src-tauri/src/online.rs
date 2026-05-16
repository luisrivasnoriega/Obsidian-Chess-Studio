use std::{collections::HashMap, collections::HashSet, time::Duration};

use chrono::{DateTime, Datelike, FixedOffset, Utc};
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::Emitter;
use tokio::sync::Mutex;

use crate::error::{Error, Result};
use crate::opening::{get_opening_from_fen, get_opening_info_from_fen};

const ORION_RESPONSES_ENDPOINT: &str =
    "https://luis-4944-resource.services.ai.azure.com/api/projects/luis-4944/openai/v1/responses";
const ORION_MODELS_ENDPOINT: &str =
    "https://luis-4944-resource.services.ai.azure.com/api/projects/luis-4944/openai/v1/models";

static ONLINE_HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(5_000))
        .timeout(Duration::from_secs(60))
        .pool_max_idle_per_host(8)
        .tcp_nodelay(true)
        .user_agent("Obsidian Chess Studio")
        .build()
        .expect("Failed to build online HTTP client")
});

static LICHESS_BOARD_STREAM_TASKS: Lazy<
    Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
> = Lazy::new(|| Mutex::new(HashMap::new()));

const LICHESS_BOARD_STREAM_EVENT: &str = "lichess-board-stream-snapshot";

async fn reqwest_client() -> Result<reqwest::Client> {
    Ok(ONLINE_HTTP_CLIENT.clone())
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OrionPlanRequest {
    pub api_key: String,
    pub orientation: String,
    pub context_json: String,
    pub model: Option<String>,
    pub ui_language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OrionPlanAnalysisRequest {
    pub api_key: String,
    pub orientation: String,
    pub model: Option<String>,
    pub ui_language: Option<String>,
    pub premium_user: Option<String>,
    pub root_fen: String,
    pub final_fen: String,
    #[serde(default)]
    pub fen_trail: Vec<String>,
    #[serde(default)]
    pub game_moves_uci: Vec<String>,
    pub engine_name: String,
    pub engine_go_json: String,
    pub engine_settings_json: String,
    pub engine_lines_json: String,
    pub db_type: String,
    pub lichess_options_json: Option<String>,
    pub master_options_json: Option<String>,
    pub lichess_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
struct OrionLichessOptions {
    #[serde(default)]
    variant: Option<String>,
    #[serde(default)]
    speeds: Option<Vec<String>>,
    #[serde(default)]
    ratings: Option<Vec<u32>>,
    #[serde(default)]
    since: Option<String>,
    #[serde(default)]
    until: Option<String>,
    #[serde(default)]
    moves: Option<u32>,
    #[serde(default)]
    top_games: Option<u32>,
    #[serde(default)]
    recent_games: Option<u32>,
    #[serde(default)]
    player: Option<String>,
    #[serde(default)]
    color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
struct OrionMasterOptions {
    #[serde(default)]
    since: Option<String>,
    #[serde(default)]
    until: Option<String>,
    #[serde(default)]
    moves: Option<u32>,
    #[serde(default)]
    top_games: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OrionPlanResponse {
    pub plan: String,
    pub raw: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub payload_json: String,
}

fn collect_orion_text_chunks(value: &Value, chunks: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if let Some(output_text) = map.get("output_text").and_then(Value::as_str) {
                let text = output_text.trim();
                if !text.is_empty() {
                    chunks.push(text.to_string());
                }
            }

            let type_name = map.get("type").and_then(Value::as_str).unwrap_or_default();
            if matches!(type_name, "output_text" | "text") {
                if let Some(text_value) = map.get("text").and_then(Value::as_str) {
                    let text = text_value.trim();
                    if !text.is_empty() {
                        chunks.push(text.to_string());
                    }
                }
            }

            for child in map.values() {
                collect_orion_text_chunks(child, chunks);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_orion_text_chunks(item, chunks);
            }
        }
        _ => {}
    }
}

fn extract_orion_plan_text(value: &Value) -> Option<String> {
    let mut chunks = Vec::new();
    collect_orion_text_chunks(value, &mut chunks);

    if chunks.is_empty() {
        return None;
    }

    let mut unique = HashSet::new();
    let deduped = chunks
        .into_iter()
        .filter(|chunk| unique.insert(chunk.clone()))
        .collect::<Vec<String>>();

    Some(deduped.join("\n\n"))
}

fn build_orion_payload(model: &str, system_prompt: &str, user_prompt: &str) -> Value {
    serde_json::json!({
        "model": model,
        "input": [
            {
                "type": "message",
                "role": "system",
                "content": [
                    { "type": "input_text", "text": system_prompt }
                ]
            },
            {
                "type": "message",
                "role": "user",
                "content": [
                    { "type": "input_text", "text": user_prompt }
                ]
            }
        ]
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrionExplorerMove {
    uci: String,
    san: String,
    #[serde(default)]
    average_rating: Option<u32>,
    white: u32,
    black: u32,
    draws: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrionExplorerPositionData {
    #[serde(default)]
    white: u32,
    #[serde(default)]
    black: u32,
    #[serde(default)]
    draws: u32,
    #[serde(default)]
    moves: Vec<OrionExplorerMove>,
}

fn parse_date_to_year_month(s: &str) -> Option<String> {
    let dt: DateTime<FixedOffset> = DateTime::parse_from_rfc3339(s).ok()?;
    Some(format!("{}-{}", dt.year(), dt.month()))
}

fn parse_date_to_year(s: &str) -> Option<String> {
    let dt: DateTime<FixedOffset> = DateTime::parse_from_rfc3339(s).ok()?;
    Some(dt.year().to_string())
}

fn lichess_query_pairs_for_orion(fen: &str, opt: &OrionLichessOptions) -> Vec<(String, String)> {
    let mut parts: Vec<(String, String)> = Vec::new();
    parts.push(("fen".to_string(), fen.to_string()));

    if let Some(player) = opt
        .player
        .as_ref()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
    {
        parts.push(("player".to_string(), player.to_string()));
        let color = opt
            .color
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .unwrap_or("white");
        parts.push(("color".to_string(), color.to_string()));
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
    if let Some(m) = opt.moves {
        if m > 0 {
            parts.push(("moves".to_string(), m.to_string()));
        }
    }
    if let Some(top_games) = opt.top_games {
        if top_games > 0 {
            parts.push(("topGames".to_string(), top_games.min(15).to_string()));
        }
    }
    if let Some(recent_games) = opt.recent_games {
        if recent_games > 0 {
            parts.push(("recentGames".to_string(), recent_games.min(15).to_string()));
        }
    }

    parts
}

fn masters_query_pairs_for_orion(fen: &str, opt: &OrionMasterOptions) -> Vec<(String, String)> {
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
    if let Some(top_games) = opt.top_games {
        if top_games > 0 {
            parts.push(("topGames".to_string(), top_games.min(15).to_string()));
        }
    }
    parts
}

fn lichess_explorer_url_for_orion(fen: &str, opt: &OrionLichessOptions) -> Result<reqwest::Url> {
    let base = "https://explorer.lichess.ovh";
    let is_player = opt
        .player
        .as_ref()
        .map(|p| !p.trim().is_empty())
        .unwrap_or(false);
    let path = if is_player { "player" } else { "lichess" };

    let mut url = reqwest::Url::parse(&format!("{base}/{path}"))
        .map_err(|e| Error::FenError(format!("Invalid Lichess explorer URL: {e}")))?;

    {
        let mut qp = url.query_pairs_mut();
        for (k, v) in lichess_query_pairs_for_orion(fen, opt) {
            qp.append_pair(&k, &v);
        }
    }
    Ok(url)
}

fn masters_explorer_url_for_orion(fen: &str, opt: &OrionMasterOptions) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse("https://explorer.lichess.ovh/masters")
        .map_err(|e| Error::FenError(format!("Invalid masters explorer URL: {e}")))?;

    {
        let mut qp = url.query_pairs_mut();
        for (k, v) in masters_query_pairs_for_orion(fen, opt) {
            qp.append_pair(&k, &v);
        }
    }
    Ok(url)
}

async fn fetch_explorer_position_data(
    url: reqwest::Url,
    lichess_token: Option<&str>,
) -> Result<OrionExplorerPositionData> {
    let client = reqwest_client().await?;
    let mut req = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, "ObsidianChessStudio/1.0");

    let auth_token = lichess_token.map(str::trim).filter(|s| !s.is_empty());
    if let Some(token) = auth_token {
        req = req.bearer_auth(token);
    }

    let res = req.send().await?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::FenError(format!(
            "Lichess explorer failed ({status}): {}",
            body.trim()
        )));
    }

    serde_json::from_str::<OrionExplorerPositionData>(&body)
        .map_err(|e| Error::FenError(format!("Invalid Lichess explorer JSON: {e}")))
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

fn format_lichess_stats_json(
    source: &str,
    options: &Value,
    data: &OrionExplorerPositionData,
) -> Value {
    let total_games = data.white + data.black + data.draws;
    let moves = data
        .moves
        .iter()
        .map(|mv| {
            let move_total = mv.white + mv.black + mv.draws;
            let white_rate = if move_total > 0 {
                round4((mv.white as f64) / (move_total as f64))
            } else {
                0.0
            };
            let black_rate = if move_total > 0 {
                round4((mv.black as f64) / (move_total as f64))
            } else {
                0.0
            };
            let draw_rate = if move_total > 0 {
                round4((mv.draws as f64) / (move_total as f64))
            } else {
                0.0
            };

            serde_json::json!({
                "uci": mv.uci,
                "san": mv.san,
                "averageRating": mv.average_rating.unwrap_or(0),
                "totalGames": move_total,
                "whiteWins": mv.white,
                "blackWins": mv.black,
                "draws": mv.draws,
                "whiteRate": white_rate,
                "blackRate": black_rate,
                "drawRate": draw_rate,
            })
        })
        .collect::<Vec<Value>>();

    serde_json::json!({
        "source": source,
        "options": options,
        "totals": {
            "totalGames": total_games,
            "whiteWins": data.white,
            "blackWins": data.black,
            "draws": data.draws
        },
        "moves": moves
    })
}

fn total_games_from_lichess_stats(stats: &Value) -> u64 {
    stats
        .get("totals")
        .and_then(|t| t.get("totalGames"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn has_lichess_filters(opt: &OrionLichessOptions) -> bool {
    opt.variant.as_deref().is_some_and(|v| !v.trim().is_empty())
        || opt.speeds.as_ref().is_some_and(|v| !v.is_empty())
        || opt.ratings.as_ref().is_some_and(|v| !v.is_empty())
        || opt.since.as_deref().is_some_and(|v| !v.trim().is_empty())
        || opt.until.as_deref().is_some_and(|v| !v.trim().is_empty())
        || opt.moves.is_some()
        || opt.top_games.is_some()
        || opt.recent_games.is_some()
        || opt.player.as_deref().is_some_and(|v| !v.trim().is_empty())
}

fn has_master_filters(opt: &OrionMasterOptions) -> bool {
    opt.since.as_deref().is_some_and(|v| !v.trim().is_empty())
        || opt.until.as_deref().is_some_and(|v| !v.trim().is_empty())
        || opt.moves.is_some()
        || opt.top_games.is_some()
}

fn parse_orion_lichess_options(json: Option<&str>) -> OrionLichessOptions {
    json.and_then(|s| serde_json::from_str::<OrionLichessOptions>(s).ok())
        .unwrap_or_default()
}

fn parse_orion_master_options(json: Option<&str>) -> OrionMasterOptions {
    json.and_then(|s| serde_json::from_str::<OrionMasterOptions>(s).ok())
        .unwrap_or_default()
}

async fn fetch_lichess_stats_for_orion(
    db_type: &str,
    final_fen: &str,
    lichess_options_json: Option<&str>,
    master_options_json: Option<&str>,
    lichess_token: Option<&str>,
) -> Value {
    if db_type == "lch_master" {
        let configured = parse_orion_master_options(master_options_json);
        let configured_options_json = serde_json::to_value(&configured).unwrap_or(Value::Null);
        let configured_url = match masters_explorer_url_for_orion(final_fen, &configured) {
            Ok(url) => url,
            Err(e) => {
                return serde_json::json!({
                    "source": "lch_master",
                    "options": configured_options_json,
                    "error": e.to_string()
                });
            }
        };

        match fetch_explorer_position_data(configured_url, lichess_token).await {
            Ok(data) => {
                let formatted =
                    format_lichess_stats_json("lch_master", &configured_options_json, &data);
                let total = total_games_from_lichess_stats(&formatted);
                if total > 0 || !has_master_filters(&configured) {
                    return formatted;
                }

                let fallback = OrionMasterOptions::default();
                let fallback_options_json = serde_json::to_value(&fallback).unwrap_or(Value::Null);
                let fallback_url = match masters_explorer_url_for_orion(final_fen, &fallback) {
                    Ok(url) => url,
                    Err(_) => return formatted,
                };

                if let Ok(fallback_data) =
                    fetch_explorer_position_data(fallback_url, lichess_token).await
                {
                    let fallback_formatted = format_lichess_stats_json(
                        "lch_master",
                        &fallback_options_json,
                        &fallback_data,
                    );
                    if total_games_from_lichess_stats(&fallback_formatted) > total {
                        return serde_json::json!({
                            "source": "lch_master",
                            "options": fallback_options_json,
                            "totals": fallback_formatted["totals"].clone(),
                            "moves": fallback_formatted["moves"].clone(),
                            "configuredOptions": configured_options_json,
                            "configuredTotals": formatted["totals"].clone(),
                            "fallbackApplied": true,
                            "fallbackReason": "Configured master filters returned zero games."
                        });
                    }
                }

                formatted
            }
            Err(e) => serde_json::json!({
                "source": "lch_master",
                "options": configured_options_json,
                "error": e.to_string()
            }),
        }
    } else if db_type == "lch_all" {
        let configured = parse_orion_lichess_options(lichess_options_json);
        let configured_options_json = serde_json::to_value(&configured).unwrap_or(Value::Null);
        let configured_url = match lichess_explorer_url_for_orion(final_fen, &configured) {
            Ok(url) => url,
            Err(e) => {
                return serde_json::json!({
                    "source": "lch_all",
                    "options": configured_options_json,
                    "error": e.to_string()
                });
            }
        };

        match fetch_explorer_position_data(configured_url, lichess_token).await {
            Ok(data) => {
                let formatted =
                    format_lichess_stats_json("lch_all", &configured_options_json, &data);
                let total = total_games_from_lichess_stats(&formatted);
                if total > 0 || !has_lichess_filters(&configured) {
                    return formatted;
                }

                let fallback = OrionLichessOptions {
                    color: configured.color.clone(),
                    variant: configured.variant.clone(),
                    moves: configured.moves,
                    top_games: configured.top_games,
                    recent_games: configured.recent_games,
                    ..Default::default()
                };
                let fallback_options_json = serde_json::to_value(&fallback).unwrap_or(Value::Null);
                let fallback_url = match lichess_explorer_url_for_orion(final_fen, &fallback) {
                    Ok(url) => url,
                    Err(_) => return formatted,
                };

                if let Ok(fallback_data) =
                    fetch_explorer_position_data(fallback_url, lichess_token).await
                {
                    let fallback_formatted = format_lichess_stats_json(
                        "lch_all",
                        &fallback_options_json,
                        &fallback_data,
                    );
                    if total_games_from_lichess_stats(&fallback_formatted) > total {
                        return serde_json::json!({
                            "source": "lch_all",
                            "options": fallback_options_json,
                            "totals": fallback_formatted["totals"].clone(),
                            "moves": fallback_formatted["moves"].clone(),
                            "configuredOptions": configured_options_json,
                            "configuredTotals": formatted["totals"].clone(),
                            "fallbackApplied": true,
                            "fallbackReason": "Configured Lichess filters returned zero games."
                        });
                    }
                }

                formatted
            }
            Err(e) => serde_json::json!({
                "source": "lch_all",
                "options": configured_options_json,
                "error": e.to_string()
            }),
        }
    } else {
        serde_json::json!({
            "source": db_type,
            "options": Value::Null,
            "totals": {
                "totalGames": 0,
                "whiteWins": 0,
                "blackWins": 0,
                "draws": 0
            },
            "moves": [],
            "skipped": true,
            "fallbackReason": "Lichess stats are only queried when DB source is lch_all or lch_master."
        })
    }
}

fn parse_opening_label(label: &str) -> (String, String) {
    let trimmed = label.trim();
    if trimmed.is_empty() || trimmed == "Empty Board" || trimmed == "Starting Position" {
        return ("".to_string(), "".to_string());
    }
    if let Some(idx) = trimmed.find(':') {
        (
            trimmed[..idx].trim().to_string(),
            trimmed[idx + 1..].trim().to_string(),
        )
    } else {
        (trimmed.to_string(), "".to_string())
    }
}

fn resolve_opening_context(fen_candidates: &[String]) -> Value {
    for fen in fen_candidates.iter().rev() {
        if let Ok(info) = get_opening_info_from_fen(fen) {
            let eco = info.eco.trim().to_string();
            let name = info.opening.trim().to_string();
            let variation = info.variation.trim().to_string();
            if !eco.is_empty() || !name.is_empty() || !variation.is_empty() {
                return serde_json::json!({
                    "eco": eco,
                    "name": name,
                    "variation": variation
                });
            }
        }

        if let Ok(label) = get_opening_from_fen(fen) {
            let (name, variation) = parse_opening_label(&label);
            if !name.is_empty() || !variation.is_empty() {
                return serde_json::json!({
                    "eco": "",
                    "name": name,
                    "variation": variation
                });
            }
        }
    }

    serde_json::json!({
        "eco": "",
        "name": "",
        "variation": ""
    })
}

fn wdl_tuple_from_counts(white: u64, draws: u64, black: u64) -> Option<[u32; 3]> {
    let total = white + draws + black;
    if total == 0 {
        return None;
    }

    let w = ((white as f64) * 1000.0 / (total as f64)).round() as u32;
    let d = ((draws as f64) * 1000.0 / (total as f64)).round() as u32;
    let b = 1000u32.saturating_sub(w.saturating_add(d));
    Some([w, d, b])
}

fn lichess_position_wdl(stats: &Value) -> Option<[u32; 3]> {
    let totals = stats.get("totals")?;
    let white = totals.get("whiteWins")?.as_u64()?;
    let black = totals.get("blackWins")?.as_u64()?;
    let draws = totals.get("draws")?.as_u64()?;
    wdl_tuple_from_counts(white, draws, black)
}

fn lichess_move_wdl_map(stats: &Value) -> HashMap<String, [u32; 3]> {
    let mut map = HashMap::<String, [u32; 3]>::new();
    let Some(moves) = stats.get("moves").and_then(Value::as_array) else {
        return map;
    };

    for mv in moves {
        let Some(uci) = mv.get("uci").and_then(Value::as_str) else {
            continue;
        };
        let white = mv.get("whiteWins").and_then(Value::as_u64).unwrap_or(0);
        let black = mv.get("blackWins").and_then(Value::as_u64).unwrap_or(0);
        let draws = mv.get("draws").and_then(Value::as_u64).unwrap_or(0);
        if let Some(wdl) = wdl_tuple_from_counts(white, draws, black) {
            map.insert(uci.to_string(), wdl);
        }
    }
    map
}

fn inject_lichess_wdl_into_engine_lines(engine_lines: &mut [Value], lichess_stats: &Value) {
    let position_wdl = lichess_position_wdl(lichess_stats);
    let move_wdl_map = lichess_move_wdl_map(lichess_stats);

    for line in engine_lines.iter_mut() {
        let first_uci = line
            .get("uciMoves")
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(Value::as_str)
            .map(str::to_string);

        let move_wdl = first_uci
            .as_ref()
            .and_then(|uci| move_wdl_map.get(uci))
            .copied();
        let engine_wdl = line
            .get("score")
            .and_then(|score| score.get("wdl"))
            .and_then(Value::as_array)
            .and_then(|arr| {
                if arr.len() != 3 {
                    return None;
                }
                Some([
                    arr.first()?.as_u64()? as u32,
                    arr.get(1)?.as_u64()? as u32,
                    arr.get(2)?.as_u64()? as u32,
                ])
            });

        let selected = move_wdl.or(position_wdl).or(engine_wdl);
        let source = if move_wdl.is_some() {
            "lichess_move"
        } else if position_wdl.is_some() {
            "lichess_position"
        } else if engine_wdl.is_some() {
            "engine"
        } else {
            "none"
        };

        if let Some(obj) = line.as_object_mut() {
            if let Some(score_obj) = obj.get_mut("score").and_then(Value::as_object_mut) {
                score_obj.insert(
                    "wdl".to_string(),
                    selected
                        .map(|v| serde_json::json!([v[0], v[1], v[2]]))
                        .unwrap_or(Value::Null),
                );
            }
            obj.insert(
                "scoreWdlSource".to_string(),
                Value::String(source.to_string()),
            );
        }
    }
}

fn extract_fen_from_context_json(context_json: &str) -> Option<String> {
    fn find_fen(value: &Value) -> Option<String> {
        match value {
            Value::Object(map) => {
                if let Some(fen) = map.get("fen").and_then(Value::as_str) {
                    let trimmed = fen.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }

                for child in map.values() {
                    if let Some(found) = find_fen(child) {
                        return Some(found);
                    }
                }
                None
            }
            Value::Array(items) => {
                for item in items {
                    if let Some(found) = find_fen(item) {
                        return Some(found);
                    }
                }
                None
            }
            _ => None,
        }
    }

    let parsed: Value = serde_json::from_str(context_json).ok()?;
    find_fen(&parsed)
}

fn piece_ground_truth_from_fen(fen: &str) -> Option<String> {
    let board_part = fen.split_whitespace().next()?;
    let ranks: Vec<&str> = board_part.split('/').collect();
    if ranks.len() != 8 {
        return None;
    }

    let mut white_pawns = Vec::<String>::new();
    let mut black_pawns = Vec::<String>::new();
    let mut white_pieces = Vec::<String>::new();
    let mut black_pieces = Vec::<String>::new();

    for (rank_idx, rank_str) in ranks.iter().enumerate() {
        let mut file: u8 = 0;
        for ch in rank_str.chars() {
            if ch.is_ascii_digit() {
                let step = ch.to_digit(10)? as u8;
                file = file.saturating_add(step);
                continue;
            }

            if file > 7 {
                return None;
            }

            let square = format!("{}{}", (b'a' + file) as char, 8 - rank_idx);
            let piece_desc = match ch {
                'P' => {
                    white_pawns.push(square.clone());
                    format!("P@{square}")
                }
                'p' => {
                    black_pawns.push(square.clone());
                    format!("p@{square}")
                }
                'N' | 'B' | 'R' | 'Q' | 'K' => format!("{ch}@{square}"),
                'n' | 'b' | 'r' | 'q' | 'k' => format!("{ch}@{square}"),
                _ => return None,
            };

            if ch.is_ascii_uppercase() {
                white_pieces.push(piece_desc);
            } else {
                black_pieces.push(piece_desc);
            }
            file = file.saturating_add(1);
        }
        if file != 8 {
            return None;
        }
    }

    let wp = if white_pawns.is_empty() {
        "-".to_string()
    } else {
        white_pawns.join(",")
    };
    let bp = if black_pawns.is_empty() {
        "-".to_string()
    } else {
        black_pawns.join(",")
    };
    let w_all = if white_pieces.is_empty() {
        "-".to_string()
    } else {
        white_pieces.join(" ")
    };
    let b_all = if black_pieces.is_empty() {
        "-".to_string()
    } else {
        black_pieces.join(" ")
    };

    Some(format!(
        "FEN piece ground truth:\n- White pawns: {wp}\n- Black pawns: {bp}\n- White pieces: {w_all}\n- Black pieces: {b_all}\nRules: never call a square a pawn-square unless listed above for pawns."
    ))
}

fn normalize_ui_language(ui_language: Option<&str>) -> String {
    let lang = ui_language.unwrap_or("en-US").trim();
    if lang.is_empty() {
        "en-US".to_string()
    } else {
        lang.to_string()
    }
}

fn build_orion_prompts(
    orientation: &str,
    context_json: &str,
    ui_language: Option<&str>,
) -> (String, String) {
    let system_prompt = r#"You are an elite chess coach and strategic interpreter.

TRUTH RULES
1. FEN is the single source of truth for board state and piece placement.
2. If any source conflicts with FEN, trust FEN.
3. Never invent pawns, captures, open files, weak squares, or plans unsupported by FEN.
4. Opening names, engine lines, WDL, and human stats are supporting context only.
5. Every candidate move must be legal in the given FEN position.

TERM PRECISION RULES
- Use "central break" only if the move truly challenges a pawn chain and can produce structural opening/tension, not just a piece attack.
- If a move mainly attacks a piece (for example a pinned piece), describe it as a tactical/positional hit, not as a structural break.
- Before naming any plan trigger, verify the trigger is caused by the actual board geometry from FEN.
- Do not describe files/diagonals as open unless they are already open or become open by the described sequence.

COACHING QUALITY
- Give concrete, position-specific guidance.
- Prioritize plans over move-dumping.
- Explain what to do, what to prevent, and what not to do.
- Use strong strategic concepts (structure, breaks, prophylaxis, restriction, piece improvement, exchanges, conversion plans).

OUTPUT TEMPLATE (STRICT)
Return Markdown only, never JSON.
Use these exact headings in this exact order:
## POSITION_VERDICT
## MAIN_PLAN
## SECONDARY_PLANS
## OPPONENT_COUNTERPLAY
## PLAN_TRIGGERS
## CANDIDATE_MOVES
## CRITICAL_RISKS
## PRACTICAL_ADVICE

FORMAT RULES
- Do not add or remove headings.
- Do not output `{}`, `[]`, or key/value JSON syntax.
- Do not use fenced code blocks.
- Under each heading, write plain prose and/or bullets.
- If a section has nothing relevant, write exactly: `- None`.
- In CANDIDATE_MOVES use bullets exactly like:
  - Move: <move> | Purpose: <purpose> | Fit: <why it serves the main plan>
- For each candidate move, explain the immediate concrete board consequence (1-2 ply), not only a generic strategic label.

FINAL CHECK
Before final output, verify every structural claim and pawn square against FEN."#;

    let ground_truth = extract_fen_from_context_json(context_json)
        .and_then(|fen| piece_ground_truth_from_fen(&fen))
        .unwrap_or_else(|| "FEN piece ground truth: unavailable".to_string());
    let response_language = normalize_ui_language(ui_language);

    let user_prompt = format!(
        "orientationBoard: {orientation}\nresponseLanguage: {response_language}\nWrite the final report in responseLanguage.\nUse the strict heading template exactly as requested.\nUse the full context JSON below exactly as provided.\n\n{ground_truth}\n\nPosition context JSON:\n{context_json}"
    );

    (system_prompt.to_string(), user_prompt)
}

fn normalize_orientation(orientation: &str) -> &'static str {
    match orientation.trim().to_ascii_lowercase().as_str() {
        "black" => "black",
        _ => "white",
    }
}

#[derive(Debug, Deserialize)]
struct FoundryModelItem {
    id: String,
}

#[derive(Debug, Deserialize)]
struct FoundryModelsResponse {
    #[serde(default)]
    data: Vec<FoundryModelItem>,
}

fn is_deployment_not_found_error(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    lower.contains("deploymentnotfound")
        || (lower.contains("deployment") && lower.contains("does not exist"))
}

fn fallback_model_score(model_id: &str) -> i32 {
    let m = model_id.to_ascii_lowercase();
    if m.contains("gpt-5.3-chat") {
        return 565;
    }
    if m.contains("gpt-5.4-mini") {
        return 560;
    }
    if m.contains("gpt-5.4") {
        return 550;
    }
    if m.contains("gpt-4.1-mini") {
        return 420;
    }
    if m.contains("gpt-4.1") {
        return 410;
    }
    if m.contains("gpt-4o-mini") {
        return 320;
    }
    if m.contains("gpt-4o") {
        return 310;
    }
    if m.contains("gpt") {
        return 200;
    }
    0
}

fn choose_fallback_model(requested: &str, available: &[String]) -> Option<String> {
    if available.is_empty() {
        return None;
    }

    if available
        .iter()
        .any(|id| id.eq_ignore_ascii_case(requested))
    {
        return Some(requested.to_string());
    }

    let mut scored = available
        .iter()
        .map(|id| (id, fallback_model_score(id)))
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));

    scored.first().map(|(id, _)| (*id).to_string())
}

async fn fetch_foundry_models(api_key: &str) -> Result<Vec<String>> {
    let client = reqwest_client().await?;
    let res = client
        .get(ORION_MODELS_ENDPOINT)
        .header("api-key", api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .send()
        .await?;

    let status = res.status();
    let raw = res.text().await?;
    if !status.is_success() {
        return Err(Error::PackageManager(format!(
            "Azure Foundry models request failed ({status}): {raw}"
        )));
    }

    let parsed: FoundryModelsResponse = serde_json::from_str(&raw).map_err(|err| {
        Error::PackageManager(format!(
            "Azure Foundry models response is not valid JSON: {err}"
        ))
    })?;

    let models = parsed
        .data
        .into_iter()
        .map(|item| item.id)
        .filter(|id| !id.trim().is_empty())
        .collect::<Vec<String>>();
    Ok(models)
}

async fn send_orion_responses_request(
    client: &reqwest::Client,
    api_key: &str,
    payload: &Value,
) -> Result<(reqwest::StatusCode, String)> {
    let res = client
        .post(ORION_RESPONSES_ENDPOINT)
        .header("api-key", api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(payload)
        .send()
        .await?;
    let status = res.status();
    let raw = res.text().await?;
    Ok((status, raw))
}

async fn consult_orion_plan_with_context_json(
    _app: tauri::AppHandle,
    api_key: &str,
    orientation: &str,
    model: Option<&str>,
    ui_language: Option<&str>,
    context_json: &str,
) -> Result<OrionPlanResponse> {
    let requested_model = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("gpt-5.3-chat");

    let (system_prompt, user_prompt) = build_orion_prompts(orientation, context_json, ui_language);
    let mut selected_model = requested_model.to_string();
    let mut payload = build_orion_payload(&selected_model, &system_prompt, &user_prompt);
    let client = reqwest_client().await?;
    let (mut status, mut raw) = send_orion_responses_request(&client, api_key, &payload).await?;

    if !status.is_success() && is_deployment_not_found_error(&raw) {
        if let Ok(models) = fetch_foundry_models(api_key).await {
            if let Some(fallback_model) = choose_fallback_model(requested_model, &models) {
                if !fallback_model.eq_ignore_ascii_case(requested_model) {
                    selected_model = fallback_model.clone();
                    payload = build_orion_payload(&selected_model, &system_prompt, &user_prompt);
                    (status, raw) =
                        send_orion_responses_request(&client, api_key, &payload).await?;
                }
            }
        }
    }

    if !status.is_success() {
        return Err(Error::PackageManager(format!(
            "Azure Foundry request failed ({status}): {raw}"
        )));
    }

    let parsed: Value = serde_json::from_str(&raw).map_err(|err| {
        Error::PackageManager(format!("Azure Foundry response is not valid JSON: {err}"))
    })?;

    let plan = extract_orion_plan_text(&parsed).unwrap_or_else(|| raw.clone());

    Ok(OrionPlanResponse {
        plan,
        raw,
        system_prompt,
        user_prompt,
        payload_json: payload.to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn consult_orion_plan(
    app: tauri::AppHandle,
    request: OrionPlanRequest,
) -> Result<OrionPlanResponse> {
    let api_key = request.api_key.trim();
    if api_key.is_empty() {
        return Err(Error::InvalidInput("API key cannot be empty".to_string()));
    }

    let context_json = request.context_json.trim();
    if context_json.is_empty() {
        return Err(Error::InvalidInput(
            "Context JSON cannot be empty".to_string(),
        ));
    }

    consult_orion_plan_with_context_json(
        app,
        api_key,
        normalize_orientation(&request.orientation),
        request.model.as_deref(),
        request.ui_language.as_deref(),
        context_json,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn consult_orion_plan_from_analysis(
    app: tauri::AppHandle,
    request: OrionPlanAnalysisRequest,
) -> Result<OrionPlanResponse> {
    let api_key = request.api_key.trim();
    if api_key.is_empty() {
        return Err(Error::InvalidInput("API key cannot be empty".to_string()));
    }

    let final_fen = request.final_fen.trim();
    if final_fen.is_empty() {
        return Err(Error::InvalidInput("Final FEN cannot be empty".to_string()));
    }

    let mut fen_candidates = request
        .fen_trail
        .iter()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect::<Vec<String>>();
    if !fen_candidates.iter().any(|f| f == final_fen) {
        fen_candidates.push(final_fen.to_string());
    }

    let opening = resolve_opening_context(&fen_candidates);
    let lichess_stats = fetch_lichess_stats_for_orion(
        request.db_type.trim(),
        final_fen,
        request.lichess_options_json.as_deref(),
        request.master_options_json.as_deref(),
        request.lichess_token.as_deref(),
    )
    .await;

    let engine_go_value: Value = serde_json::from_str(request.engine_go_json.trim())
        .unwrap_or_else(|_| serde_json::json!({ "raw": request.engine_go_json }));
    let engine_settings_value: Value = serde_json::from_str(request.engine_settings_json.trim())
        .unwrap_or_else(|_| serde_json::json!([]));
    let mut engine_lines_value: Vec<Value> =
        serde_json::from_str(request.engine_lines_json.trim()).unwrap_or_default();
    inject_lichess_wdl_into_engine_lines(&mut engine_lines_value, &lichess_stats);

    let context_payload = serde_json::json!({
        "opening": opening,
        "rootFen": request.root_fen,
        "fen": final_fen,
        "uiLanguage": normalize_ui_language(request.ui_language.as_deref()),
        "orientationBoard": normalize_orientation(&request.orientation),
        "premiumUser": request.premium_user,
        "engine": {
            "name": request.engine_name,
            "goMode": engine_go_value,
            "settings": engine_settings_value
        },
        "gameMovesUci": request.game_moves_uci,
        "engineLines": engine_lines_value,
        "lichess": lichess_stats,
        "generatedAt": Utc::now().to_rfc3339()
    });

    consult_orion_plan_with_context_json(
        app,
        api_key,
        normalize_orientation(&request.orientation),
        request.model.as_deref(),
        request.ui_language.as_deref(),
        &context_payload.to_string(),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn get_lichess_account(
    token: Option<String>,
    username: Option<String>,
) -> Result<Option<String>> {
    let client = reqwest_client().await?;

    let res = if let Some(token) = token.as_deref() {
        match client
            .get("https://lichess.org/api/account")
            .bearer_auth(token)
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => return Ok(None),
        }
    } else {
        let Some(username) = username.as_deref() else {
            return Ok(None);
        };
        match client
            .get(format!("https://lichess.org/api/user/{username}"))
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => return Ok(None),
        }
    };

    if !res.status().is_success() {
        return Ok(None);
    }
    Ok(Some(res.text().await?))
}

#[tauri::command]
#[specta::specta]
pub async fn get_chesscom_account(username: String) -> Result<Option<String>> {
    let client = reqwest_client().await?;
    let url = format!(
        "https://api.chess.com/pub/player/{}/stats",
        username.to_ascii_lowercase()
    );
    let res = match client.get(url).send().await {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    if !res.status().is_success() {
        return Ok(None);
    }
    Ok(Some(res.text().await?))
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LichessTournamentCreateRequest {
    pub token: String,
    /// Form-encoded fields (key/value), same as URLSearchParams in the frontend.
    pub form: Vec<(String, String)>,
}

#[tauri::command]
#[specta::specta]
pub async fn create_lichess_tournament(input: LichessTournamentCreateRequest) -> Result<String> {
    let client = reqwest_client().await?;

    let res = client
        .post("https://lichess.org/api/tournament")
        .bearer_auth(input.token)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&input.form)
        .send()
        .await?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(Error::PackageManager(format!(
            "Lichess tournament create failed ({status}): {text}"
        )));
    }

    Ok(res.text().await?)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LichessAiChallengeInput {
    pub token: String,
    pub level: u8,
    pub clock_limit_seconds: u32,
    pub clock_increment_seconds: u32,
    pub color: String,
    pub variant: Option<String>,
    pub fen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LichessAiChallengeResponse {
    pub id: String,
    pub full_id: Option<String>,
    pub color: Option<String>,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LichessFindHumanGameInput {
    pub token: String,
    pub time_minutes: f64,
    pub increment_seconds: u32,
    pub color: String,
    pub rated: bool,
    pub variant: Option<String>,
    pub timeout_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LichessFindHumanGameResponse {
    pub game_id: String,
    pub color: Option<String>,
    pub source: Option<String>,
    pub full_id: Option<String>,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LichessBoardGameSnapshot {
    pub game_id: String,
    pub initial_fen: Option<String>,
    pub white_name: Option<String>,
    pub black_name: Option<String>,
    pub moves: Vec<String>,
    pub status: String,
    pub winner: Option<String>,
    pub turn: Option<String>,
    pub wtime: Option<i64>,
    pub btime: Option<i64>,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LichessBoardStreamSnapshotEvent {
    pub game_id: String,
    pub snapshot: LichessBoardGameSnapshot,
}

fn normalize_color(color: &str) -> &'static str {
    match color.trim().to_ascii_lowercase().as_str() {
        "white" => "white",
        "black" => "black",
        _ => "random",
    }
}

fn infer_turn(initial_fen: Option<&str>, moves_len: usize) -> String {
    let initial_turn = match initial_fen {
        Some("startpos") => "white",
        Some(fen) => fen
            .split_whitespace()
            .nth(1)
            .map(|s| if s == "b" { "black" } else { "white" })
            .unwrap_or("white"),
        None => "white",
    };

    if moves_len % 2 == 0 {
        initial_turn.to_string()
    } else if initial_turn == "white" {
        "black".to_string()
    } else {
        "white".to_string()
    }
}

fn parse_moves(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|v| v.get("moves"))
        .and_then(|v| v.as_str())
        .map(|s| {
            s.split_whitespace()
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<String>>()
        })
        .unwrap_or_default()
}

async fn read_first_ndjson_line(res: reqwest::Response) -> Result<String> {
    let mut stream = res.bytes_stream();
    let mut buffer: Vec<u8> = Vec::with_capacity(4096);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buffer.extend_from_slice(&chunk);

        loop {
            let Some(pos) = buffer.iter().position(|b| *b == b'\n') else {
                break;
            };

            let line_bytes: Vec<u8> = buffer.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
            if !line.is_empty() {
                return Ok(line);
            }
        }

        // Defensive bound for malformed streams without newlines.
        if buffer.len() > 1_000_000 {
            return Err(Error::PackageManager(
                "Lichess stream line exceeded 1MB without delimiter".to_string(),
            ));
        }
    }

    let trailing = String::from_utf8_lossy(&buffer).trim().to_string();
    if trailing.is_empty() {
        return Err(Error::PackageManager(
            "Lichess stream ended without data".to_string(),
        ));
    }

    Ok(trailing)
}

fn parse_lichess_board_stream_snapshot(
    game_id: &str,
    raw: &str,
) -> Result<Option<LichessBoardGameSnapshot>> {
    let parsed: Value = serde_json::from_str(raw).map_err(|e| {
        Error::PackageManager(format!("Lichess board stream line is not valid JSON: {e}"))
    })?;

    let type_name = parsed
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let (initial_fen, white_name, black_name, state_value) = match type_name {
        "gameFull" => (
            parsed
                .get("initialFen")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            parsed
                .get("white")
                .and_then(|v| v.get("name"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            parsed
                .get("black")
                .and_then(|v| v.get("name"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            parsed.get("state"),
        ),
        "gameState" => (None, None, None, Some(&parsed)),
        _ => return Ok(None),
    };

    let moves = parse_moves(state_value);
    let status = state_value
        .and_then(|v| v.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let winner = state_value
        .and_then(|v| v.get("winner"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let wtime = state_value
        .and_then(|v| v.get("wtime"))
        .and_then(Value::as_i64);
    let btime = state_value
        .and_then(|v| v.get("btime"))
        .and_then(Value::as_i64);

    let turn = if status == "started" {
        Some(infer_turn(initial_fen.as_deref(), moves.len()))
    } else {
        None
    };

    Ok(Some(LichessBoardGameSnapshot {
        game_id: game_id.to_string(),
        initial_fen,
        white_name,
        black_name,
        moves,
        status,
        winner,
        turn,
        wtime,
        btime,
        raw: raw.to_string(),
    }))
}

async fn run_lichess_board_stream(
    app: tauri::AppHandle,
    token: String,
    game_id: String,
) -> Result<()> {
    let client = reqwest_client().await?;
    let url = format!("https://lichess.org/api/board/game/stream/{game_id}");
    let mut reconnect_backoff_ms = 250u64;

    loop {
        let res = match client
            .get(&url)
            .bearer_auth(token.trim())
            .header(reqwest::header::ACCEPT, "application/x-ndjson")
            .send()
            .await
        {
            Ok(res) => res,
            Err(e) => {
                log::warn!("Lichess board stream request failed: {e}");
                tokio::time::sleep(Duration::from_millis(reconnect_backoff_ms)).await;
                reconnect_backoff_ms = (reconnect_backoff_ms * 2).min(5_000);
                continue;
            }
        };

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();

            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
                || status == reqwest::StatusCode::NOT_FOUND
            {
                return Err(Error::PackageManager(format!(
                    "Lichess board game stream failed ({status}): {body}"
                )));
            }

            tokio::time::sleep(Duration::from_millis(reconnect_backoff_ms)).await;
            reconnect_backoff_ms = (reconnect_backoff_ms * 2).min(5_000);
            continue;
        }

        reconnect_backoff_ms = 250;
        let mut stream = res.bytes_stream();
        let mut buffer: Vec<u8> = Vec::with_capacity(4096);

        while let Some(chunk_result) = stream.next().await {
            let chunk = match chunk_result {
                Ok(chunk) => chunk,
                Err(e) => {
                    log::warn!("Lichess board stream chunk failed: {e}");
                    break;
                }
            };
            buffer.extend_from_slice(&chunk);

            loop {
                let Some(pos) = buffer.iter().position(|b| *b == b'\n') else {
                    break;
                };

                let line_bytes: Vec<u8> = buffer.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
                if line.is_empty() {
                    continue;
                }

                let snapshot = match parse_lichess_board_stream_snapshot(&game_id, &line) {
                    Ok(Some(snapshot)) => snapshot,
                    Ok(None) => continue,
                    Err(e) => {
                        log::warn!("Lichess board stream line parse failed: {e}");
                        continue;
                    }
                };

                let payload = LichessBoardStreamSnapshotEvent {
                    game_id: game_id.clone(),
                    snapshot: snapshot.clone(),
                };
                if let Err(e) = app.emit(LICHESS_BOARD_STREAM_EVENT, payload) {
                    return Err(e.into());
                }

                if snapshot.status != "started" && snapshot.status != "created" {
                    return Ok(());
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tauri::command]
#[specta::specta]
pub async fn lichess_start_board_game_stream(
    app: tauri::AppHandle,
    token: String,
    game_id: String,
) -> Result<()> {
    let token = token.trim();
    if token.is_empty() {
        return Err(Error::InvalidInput("Token cannot be empty".to_string()));
    }
    let game_id = game_id.trim();
    if game_id.is_empty() {
        return Err(Error::InvalidInput("Game id cannot be empty".to_string()));
    }

    let mut tasks = LICHESS_BOARD_STREAM_TASKS.lock().await;
    for (_, handle) in tasks.drain() {
        handle.abort();
    }

    let app_clone = app.clone();
    let token_owned = token.to_string();
    let game_id_owned = game_id.to_string();
    let task_game_id = game_id.to_string();
    let handle = tauri::async_runtime::spawn(async move {
        if let Err(e) = run_lichess_board_stream(app_clone, token_owned, game_id_owned).await {
            log::warn!("Lichess board stream stopped: {e}");
        }
    });

    tasks.insert(task_game_id, handle);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn lichess_stop_board_game_stream(game_id: Option<String>) -> Result<()> {
    let mut tasks = LICHESS_BOARD_STREAM_TASKS.lock().await;

    if let Some(game_id) = game_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        if let Some(handle) = tasks.remove(game_id) {
            handle.abort();
        }
        return Ok(());
    }

    for (_, handle) in tasks.drain() {
        handle.abort();
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn lichess_find_human_game(
    input: LichessFindHumanGameInput,
) -> Result<LichessFindHumanGameResponse> {
    let token = input.token.trim();
    if token.is_empty() {
        return Err(Error::InvalidInput("Token cannot be empty".to_string()));
    }

    if !(0.0..=180.0).contains(&input.time_minutes) {
        return Err(Error::InvalidInput(
            "timeMinutes must be between 0 and 180".to_string(),
        ));
    }

    if input.increment_seconds > 180 {
        return Err(Error::InvalidInput(
            "incrementSeconds must be between 0 and 180".to_string(),
        ));
    }

    // Lichess Board API random seek is restricted to rapid/classical time controls.
    // Effective duration formula used by Lichess categories:
    // estimated_minutes = time + 40 * increment / 60
    let estimated_minutes = input.time_minutes + (40.0 * f64::from(input.increment_seconds) / 60.0);
    if estimated_minutes < 8.0 {
        return Err(Error::InvalidInput(
            "Invalid time control for Board API seek. Random matchmaking requires rapid/classical (estimated duration >= 8 minutes)."
                .to_string(),
        ));
    }

    let timeout_seconds = input.timeout_seconds.unwrap_or(180).clamp(10, 900);
    let color = normalize_color(&input.color).to_string();
    let expected_speed = if estimated_minutes >= 25.0 {
        "classical"
    } else {
        "rapid"
    };
    let requested_variant = input
        .variant
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(5_000))
        .timeout(Duration::from_secs(timeout_seconds + 10))
        .user_agent("Obsidian Chess Studio")
        .build()?;

    // Open global event stream first (recommended by Lichess docs), then create seek.
    let event_res = client
        .get("https://lichess.org/api/stream/event")
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/x-ndjson")
        .send()
        .await?;

    if !event_res.status().is_success() {
        let status = event_res.status();
        let body = event_res.text().await.unwrap_or_default();
        return Err(Error::PackageManager(format!(
            "Lichess event stream failed ({status}): {body}"
        )));
    }

    // The Board event stream immediately emits all current games/challenges when opened.
    // Collect those existing game IDs so we can ignore them after creating the new seek.
    let mut event_stream = event_res.bytes_stream();
    let mut event_buffer: Vec<u8> = Vec::with_capacity(4096);
    let mut known_game_ids: HashSet<String> = HashSet::new();
    let bootstrap_deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        let now = tokio::time::Instant::now();
        if now >= bootstrap_deadline {
            break;
        }

        let remaining = (bootstrap_deadline - now).min(Duration::from_millis(250));
        let next = match tokio::time::timeout(remaining, event_stream.next()).await {
            Ok(value) => value,
            Err(_) => break,
        };
        let Some(chunk_result) = next else {
            break;
        };

        let chunk = chunk_result?;
        event_buffer.extend_from_slice(&chunk);

        loop {
            let Some(pos) = event_buffer.iter().position(|b| *b == b'\n') else {
                break;
            };

            let line_bytes: Vec<u8> = event_buffer.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
            if line.is_empty() {
                continue;
            }

            let Ok(parsed) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if parsed.get("type").and_then(Value::as_str) != Some("gameStart") {
                continue;
            }

            let Some(game) = parsed.get("game") else {
                continue;
            };
            let Some(existing_game_id) = game
                .get("id")
                .or_else(|| game.get("gameId"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
            else {
                continue;
            };
            known_game_ids.insert(existing_game_id);
        }
    }

    let mut form: Vec<(String, String)> = vec![
        ("time".to_string(), input.time_minutes.to_string()),
        ("increment".to_string(), input.increment_seconds.to_string()),
        ("color".to_string(), color),
        (
            "rated".to_string(),
            if input.rated { "true" } else { "false" }.to_string(),
        ),
    ];

    if let Some(variant) = requested_variant.as_deref() {
        form.push(("variant".to_string(), variant.to_string()));
    }

    let seek_res = client
        .post("https://lichess.org/api/board/seek")
        .bearer_auth(token)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&form)
        .send()
        .await?;

    if !seek_res.status().is_success() {
        let status = seek_res.status();
        let body = seek_res.text().await.unwrap_or_default();
        return Err(Error::PackageManager(format!(
            "Lichess seek failed ({status}): {body}"
        )));
    }

    // Keep seek connection open while we wait for gameStart on the event stream.
    let mut seek_stream = seek_res.bytes_stream();
    let seek_task = tauri::async_runtime::spawn(async move {
        while let Some(chunk) = seek_stream.next().await {
            if chunk.is_err() {
                break;
            }
        }
    });

    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_seconds);

    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            seek_task.abort();
            return Err(Error::PackageManager(
                "Matchmaking timeout. No opponent accepted the seek in time.".to_string(),
            ));
        }

        let remaining = deadline - now;
        let next = tokio::time::timeout(remaining, event_stream.next())
            .await
            .map_err(|_| {
                Error::PackageManager(
                    "Matchmaking timeout. No opponent accepted the seek in time.".to_string(),
                )
            })?;

        let Some(chunk_result) = next else {
            seek_task.abort();
            return Err(Error::PackageManager(
                "Lichess event stream closed before a game was found.".to_string(),
            ));
        };

        let chunk = chunk_result?;
        event_buffer.extend_from_slice(&chunk);

        loop {
            let Some(pos) = event_buffer.iter().position(|b| *b == b'\n') else {
                break;
            };

            let line_bytes: Vec<u8> = event_buffer.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
            if line.is_empty() {
                continue;
            }

            let Ok(parsed) = serde_json::from_str::<Value>(&line) else {
                continue;
            };

            let event_type = parsed
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if event_type != "gameStart" {
                continue;
            }

            let Some(game) = parsed.get("game") else {
                continue;
            };

            let game_id = game
                .get("id")
                .or_else(|| game.get("gameId"))
                .and_then(Value::as_str)
                .map(ToString::to_string);

            let Some(game_id) = game_id else {
                continue;
            };
            if known_game_ids.contains(&game_id) {
                continue;
            }

            let source = game
                .get("source")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            if source.as_deref() == Some("ai") {
                known_game_ids.insert(game_id);
                continue;
            }

            if let Some(rated) = game.get("rated").and_then(Value::as_bool) {
                if rated != input.rated {
                    known_game_ids.insert(game_id);
                    continue;
                }
            }

            if let Some(speed) = game.get("speed").and_then(Value::as_str) {
                if speed != expected_speed {
                    known_game_ids.insert(game_id);
                    continue;
                }
            }

            if let Some(requested_variant_key) = requested_variant.as_deref() {
                let event_variant_key = game
                    .get("variant")
                    .and_then(|v| v.get("key"))
                    .and_then(Value::as_str);
                if event_variant_key != Some(requested_variant_key) {
                    known_game_ids.insert(game_id);
                    continue;
                }
            }

            let color = game
                .get("color")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let full_id = game
                .get("fullId")
                .and_then(Value::as_str)
                .map(ToString::to_string);

            seek_task.abort();
            return Ok(LichessFindHumanGameResponse {
                game_id,
                color,
                source,
                full_id,
                raw: line,
            });
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn lichess_challenge_ai(
    input: LichessAiChallengeInput,
) -> Result<LichessAiChallengeResponse> {
    let client = reqwest_client().await?;
    let level = input.level.clamp(1, 8);
    let color = normalize_color(&input.color);

    let mut form = vec![
        ("level".to_string(), level.to_string()),
        (
            "clock.limit".to_string(),
            input.clock_limit_seconds.to_string(),
        ),
        (
            "clock.increment".to_string(),
            input.clock_increment_seconds.to_string(),
        ),
        ("color".to_string(), color.to_string()),
    ];

    if let Some(variant) = input
        .variant
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        form.push(("variant".to_string(), variant.to_string()));
    }

    if let Some(fen) = input
        .fen
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        form.push(("fen".to_string(), fen.to_string()));
    }

    let res = client
        .post("https://lichess.org/api/challenge/ai")
        .bearer_auth(input.token.trim())
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&form)
        .send()
        .await?;

    let status = res.status();
    let raw = res.text().await?;

    if !status.is_success() {
        return Err(Error::PackageManager(format!(
            "Lichess AI challenge failed ({status}): {raw}"
        )));
    }

    let parsed: Value = serde_json::from_str(&raw).map_err(|e| {
        Error::PackageManager(format!(
            "Lichess AI challenge response is not valid JSON: {e}"
        ))
    })?;

    let id = parsed
        .get("id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| {
            Error::PackageManager("Lichess AI challenge response is missing game id".to_string())
        })?;

    let full_id = parsed
        .get("fullId")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let color = parsed
        .get("player")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    Ok(LichessAiChallengeResponse {
        id,
        full_id,
        color,
        raw,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn lichess_get_board_game_state(
    token: String,
    game_id: String,
) -> Result<LichessBoardGameSnapshot> {
    let client = reqwest_client().await?;

    let url = format!("https://lichess.org/api/board/game/stream/{game_id}");
    let res = client
        .get(url)
        .bearer_auth(token.trim())
        .header(reqwest::header::ACCEPT, "application/x-ndjson")
        .send()
        .await?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(Error::PackageManager(format!(
            "Lichess board game stream failed ({status}): {body}"
        )));
    }

    let raw = read_first_ndjson_line(res).await?;
    let snapshot = parse_lichess_board_stream_snapshot(&game_id, &raw)?.ok_or_else(|| {
        Error::PackageManager("Unexpected Lichess board stream event type".to_string())
    })?;
    Ok(snapshot)
}

#[tauri::command]
#[specta::specta]
pub async fn lichess_make_board_move(
    token: String,
    game_id: String,
    move_uci: String,
    offering_draw: Option<bool>,
) -> Result<()> {
    let client = reqwest_client().await?;

    let trimmed_move = move_uci.trim();
    if trimmed_move.is_empty() {
        return Err(Error::InvalidInput("Move cannot be empty".to_string()));
    }

    let mut req = client
        .post(format!(
            "https://lichess.org/api/board/game/{game_id}/move/{trimmed_move}"
        ))
        .bearer_auth(token.trim());

    if offering_draw.unwrap_or(false) {
        req = req.query(&[("offeringDraw", "true")]);
    }

    let res = req.send().await?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(Error::PackageManager(format!(
            "Lichess move failed ({status}): {body}"
        )));
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn lichess_resign_board_game(token: String, game_id: String) -> Result<()> {
    let client = reqwest_client().await?;

    let res = client
        .post(format!(
            "https://lichess.org/api/board/game/{game_id}/resign"
        ))
        .bearer_auth(token.trim())
        .send()
        .await?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(Error::PackageManager(format!(
            "Lichess resign failed ({status}): {body}"
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_orion_plan_text_collects_nested_text() {
        let payload = json!({
            "id": "resp_123",
            "output": [
                {
                    "type": "message",
                    "content": [
                        { "type": "output_text", "text": "{\"overview\":\"Plan A\"}" }
                    ]
                }
            ]
        });

        let text = extract_orion_plan_text(&payload).unwrap();
        assert!(text.contains("Plan A"));
    }

    #[test]
    fn extract_orion_plan_text_deduplicates_identical_chunks() {
        let payload = json!({
            "output": [
                { "type": "output_text", "text": "{\"overview\":\"Same\"}" },
                { "type": "output_text", "text": "{\"overview\":\"Same\"}" }
            ]
        });

        let text = extract_orion_plan_text(&payload).unwrap();
        let count = text.matches("Same").count();
        assert_eq!(count, 1);
    }

    #[test]
    fn extract_orion_plan_text_returns_none_without_text() {
        let payload = json!({
            "id": "resp_123",
            "status": "completed",
            "output": []
        });

        assert!(extract_orion_plan_text(&payload).is_none());
    }

    #[test]
    fn build_orion_payload_uses_message_input_items() {
        let payload = build_orion_payload("gpt-4.1", "sys", "usr");
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 2);
        assert_eq!(
            input[0].get("type").and_then(Value::as_str),
            Some("message")
        );
        assert_eq!(
            input[1].get("type").and_then(Value::as_str),
            Some("message")
        );
        assert_eq!(input[0].get("role").and_then(Value::as_str), Some("system"));
        assert_eq!(input[1].get("role").and_then(Value::as_str), Some("user"));
    }

    #[test]
    fn build_orion_prompts_enforces_fen_as_source_of_truth() {
        let (system_prompt, user_prompt) =
            build_orion_prompts("white", "{\"fen\":\"...\"}", Some("es-MX"));
        assert!(system_prompt.contains("FEN is the single source of truth"));
        assert!(system_prompt.contains("Return Markdown only, never JSON"));
        assert!(system_prompt.contains("## POSITION_VERDICT"));
        assert!(user_prompt.contains("orientationBoard: white"));
        assert!(user_prompt.contains("responseLanguage: es-MX"));
    }

    #[test]
    fn extract_fen_from_context_json_reads_nested_fen() {
        let context = json!({
            "meta": { "something": 1 },
            "payload": { "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" }
        });
        let found = extract_fen_from_context_json(&context.to_string()).unwrap();
        assert_eq!(
            found,
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        );
    }

    #[test]
    fn piece_ground_truth_from_fen_handles_c4_e4_and_knight_d4() {
        let fen = "r1bq1rk1/pp2ppbp/2np1np1/8/2PNP3/2N1B3/PP2BPPP/R2QK2R w KQ - 6 9";
        let gt = piece_ground_truth_from_fen(fen).unwrap();
        assert!(gt.contains("White pawns:"));
        assert!(gt.contains("c4"));
        assert!(gt.contains("e4"));
        assert!(!gt.contains("d4,"));
        assert!(gt.contains("N@d4"));
    }
}
