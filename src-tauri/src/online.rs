use std::{collections::HashSet, time::Duration};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use crate::error::{Error, Result};

async fn reqwest_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(5_000))
        .timeout(Duration::from_secs(60))
        .user_agent("Obsidian Chess Studio")
        .build()?)
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
pub async fn create_lichess_tournament(
    input: LichessTournamentCreateRequest,
) -> Result<String> {
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

            let event_type = parsed.get("type").and_then(Value::as_str).unwrap_or_default();
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
pub async fn lichess_challenge_ai(input: LichessAiChallengeInput) -> Result<LichessAiChallengeResponse> {
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

    if let Some(variant) = input.variant.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        form.push(("variant".to_string(), variant.to_string()));
    }

    if let Some(fen) = input.fen.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
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
pub async fn lichess_get_board_game_state(token: String, game_id: String) -> Result<LichessBoardGameSnapshot> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(5_000))
        .timeout(Duration::from_secs(20))
        .user_agent("Obsidian Chess Studio")
        .build()?;

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
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| {
        Error::PackageManager(format!(
            "Lichess board stream first line is not valid JSON: {e}"
        ))
    })?;

    let type_name = parsed.get("type").and_then(Value::as_str).unwrap_or_default();

    let (initial_fen, white_name, black_name, state_value) = if type_name == "gameFull" {
        (
            parsed.get("initialFen").and_then(Value::as_str).map(ToString::to_string),
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
        )
    } else if type_name == "gameState" {
        (None, None, None, Some(&parsed))
    } else {
        return Err(Error::PackageManager(format!(
            "Unexpected Lichess board stream event type: {type_name}"
        )));
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
    let wtime = state_value.and_then(|v| v.get("wtime")).and_then(Value::as_i64);
    let btime = state_value.and_then(|v| v.get("btime")).and_then(Value::as_i64);

    let turn = if status == "started" {
        Some(infer_turn(initial_fen.as_deref(), moves.len()))
    } else {
        None
    };

    Ok(LichessBoardGameSnapshot {
        game_id,
        initial_fen,
        white_name,
        black_name,
        moves,
        status,
        winner,
        turn,
        wtime,
        btime,
        raw,
    })
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
        .post(format!("https://lichess.org/api/board/game/{game_id}/resign"))
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

