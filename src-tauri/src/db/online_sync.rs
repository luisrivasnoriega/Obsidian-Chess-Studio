use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Write},
    path::PathBuf,
    time::Duration,
};

use chrono::{DateTime, TimeZone, Utc};
use diesel::connection::SimpleConnection;
use diesel::sql_query;
use diesel::RunQueryDsl;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{path::BaseDirectory, AppHandle, Manager, State};
use tauri_specta::Event;
use tokio::io::{AsyncWriteExt, BufWriter as TokioBufWriter};
use tokio::sync::Mutex;

use crate::{
    error::{Error, Result},
    AppState,
};

use super::{
    convert_pgn_impl, delete_duplicated_games, get_account_sync_state,
    list_account_sync_completed_batches, mark_account_sync_batch_complete, upsert_account_sync_state,
    ConnectionOptions, JournalMode, ADDITIONAL_INDEXES_SQL, PRAGMA_PERFORMANCE,
};

static GLOBAL_PROFILE_SYNC_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

const LICHESS_MAX_PER_BATCH: i64 = 500;

/// Default token used ONLY for Lichess game downloads when the profile/session doesn't provide one.
/// User requested: hardcoded fallback (no env vars).
const DEFAULT_LICHESS_DOWNLOAD_TOKEN: &str = "lip_sgpY5HeSSnLJtFs9DSF2";

// Retry tuning
const MAX_RETRIES_NETWORK: u32 = 8; // for timeouts, 5xx, connection issues
const MAX_RETRIES_429: u32 = 60; // allow longer cooling if user has huge history
const MAX_PROBE_RETRIES: u32 = 6;

#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct AccountSyncProgress {
    pub profile_id: String,
    pub account_key: String,
    pub platform: String,
    pub total_batches: i64,
    pub completed_batches: i64,
    pub current_batch: i64,
    pub batch_label: String,
    #[specta(optional)]
    pub cooldown_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AccountImportStats {
    #[specta(optional)]
    pub last_game_utc_ms: Option<i64>,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AccountSyncResult {
    /// Number of new games imported during this sync session.
    /// Computed as (post_count - pre_count) for the account.
    pub imported_games: i64,
}

fn account_key(platform: &str, username: &str) -> String {
    format!("{platform}:{username}")
}

fn sanitize_segment(value: &str) -> String {
    let trimmed = value.trim();
    let mut out = String::with_capacity(trimmed.len());
    let mut prev_underscore = false;
    for ch in trimmed.chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.';
        if ok {
            out.push(ch);
            prev_underscore = false;
        } else if !prev_underscore {
            out.push('_');
            prev_underscore = true;
        }
    }
    out.trim_matches('_').trim().to_string()
}

fn account_pgn_filename(profile_id: &str, platform: &str, username: &str) -> String {
    let username = sanitize_segment(username);
    let username = if username.is_empty() {
        "account".to_string()
    } else {
        username
    };
    let profile_id = sanitize_segment(profile_id);
    format!("profile_{profile_id}_{platform}_{username}.pgn")
}

fn parse_utc_ms(date: Option<&str>, time: Option<&str>) -> Option<i64> {
    let date = date?;
    let time = time?;

    let mut date_it = date.split('.');
    let year: i32 = date_it.next()?.parse().ok()?;
    let month: u32 = date_it.next()?.parse().ok()?;
    let day: u32 = date_it.next()?.parse().ok()?;

    let mut time_it = time.split(':');
    let hour: u32 = time_it.next()?.parse().ok()?;
    let minute: u32 = time_it.next()?.parse().ok()?;
    let second: u32 = time_it.next()?.parse().ok()?;

    chrono::Utc
        .with_ymd_and_hms(year, month, day, hour, minute, second)
        .single()
        .map(|dt| dt.timestamp_millis())
}

/// Fast-ish PGN header scanner: reads the file line-by-line, tracks time tags and rewrites
/// White/Black tags that match `username` (case-insensitive) to `account_key`.
///
/// Returns: (oldest_ms, newest_ms, game_count)
///
/// Important: Handles files that do NOT end with a blank line (otherwise last game is missed).
///
/// NOTE: This is still used for Chess.com (multi-PGN), but Lichess now uses NDJSON and does not need scanning.
fn rewrite_tags_and_scan_pgn_in_place(
    file_path: &PathBuf,
    platform: &str,
    username: &str,
) -> Result<(Option<i64>, Option<i64>, i64)> {
    let username_lc = username.to_ascii_lowercase();
    let account_key = account_key(platform, username);

    let tmp_path = file_path.with_extension("pgn.tmp");

    let input = fs::File::open(file_path)?;
    let mut reader = BufReader::new(input);

    let output = fs::File::create(&tmp_path)?;
    let mut writer = BufWriter::new(output);

    let mut buf = String::new();
    let mut current_date: Option<String> = None;
    let mut current_time: Option<String> = None;

    let mut oldest: Option<i64> = None;
    let mut newest: Option<i64> = None;
    let mut game_count: i64 = 0;

    let mut saw_time_pair = false;

    let finalize_game = |current_date: &mut Option<String>,
                         current_time: &mut Option<String>,
                         saw_time_pair: &mut bool,
                         oldest: &mut Option<i64>,
                         newest: &mut Option<i64>,
                         game_count: &mut i64| {
        if *saw_time_pair {
            let ms = parse_utc_ms(current_date.as_deref(), current_time.as_deref());
            if let Some(ms) = ms {
                *game_count += 1;
                *oldest = Some(oldest.map(|o| o.min(ms)).unwrap_or(ms));
                *newest = Some(newest.map(|n| n.max(ms)).unwrap_or(ms));
            }
        }
        *current_date = None;
        *current_time = None;
        *saw_time_pair = false;
    };

    while reader.read_line(&mut buf)? > 0 {
        let line = buf.as_str();

        // Track date/time tags (prefer UTC*, fallback to common tags)
        if let Some(rest) = line
            .strip_prefix("[UTCDate \"")
            .or_else(|| line.strip_prefix("[Date \""))
        {
            if let Some(end) = rest.find("\"]") {
                current_date = Some(rest[..end].to_string());
            }
        } else if let Some(rest) = line
            .strip_prefix("[UTCTime \"")
            .or_else(|| line.strip_prefix("[Time \""))
            .or_else(|| line.strip_prefix("[StartTime \""))
            .or_else(|| line.strip_prefix("[EndTime \""))
        {
            if let Some(end) = rest.find("\"]") {
                current_time = Some(rest[..end].to_string());
                if current_date.is_some() {
                    saw_time_pair = true;
                }
            }
        }

        // Rewrite [White "..."] / [Black "..."] if matches username
        if let Some(rest) = line.strip_prefix("[White \"") {
            if let Some(end) = rest.find("\"]") {
                let name = &rest[..end];
                if name.to_ascii_lowercase() == username_lc {
                    let rewritten = format!("[White \"{account_key}\"]\n");
                    writer.write_all(rewritten.as_bytes())?;
                    buf.clear();
                    continue;
                }
            }
        } else if let Some(rest) = line.strip_prefix("[Black \"") {
            if let Some(end) = rest.find("\"]") {
                let name = &rest[..end];
                if name.to_ascii_lowercase() == username_lc {
                    let rewritten = format!("[Black \"{account_key}\"]\n");
                    writer.write_all(rewritten.as_bytes())?;
                    buf.clear();
                    continue;
                }
            }
        }

        // End of headers: blank line
        if line == "\n" || line == "\r\n" {
            finalize_game(
                &mut current_date,
                &mut current_time,
                &mut saw_time_pair,
                &mut oldest,
                &mut newest,
                &mut game_count,
            );
        }

        writer.write_all(line.as_bytes())?;
        buf.clear();
    }

    // Finalize last game if file doesn't end with a blank line
    finalize_game(
        &mut current_date,
        &mut current_time,
        &mut saw_time_pair,
        &mut oldest,
        &mut newest,
        &mut game_count,
    );

    writer.flush()?;
    drop(writer);
    drop(reader);

    let _ = fs::remove_file(file_path);
    fs::rename(tmp_path, file_path)?;
    Ok((oldest, newest, game_count))
}

fn profile_db_path(app: &AppHandle, profile_id: &str) -> Result<PathBuf> {
    Ok(app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?)
}

#[tauri::command]
#[specta::specta]
pub async fn get_account_import_stats(
    profile_id: String,
    platform: String,
    username: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<AccountImportStats> {
    let db_path = profile_db_path(&app, &profile_id)?;
    let account_key = account_key(&platform, &username);

    let db = &mut super::get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions {
            enable_foreign_keys: false,
            busy_timeout: Some(Duration::from_secs(30)),
            journal_mode: JournalMode::Off,
        },
    )?;

    // Ensure database is initialized before querying
    super::ensure_db_initialized(db)?;

    #[derive(diesel::QueryableByName)]
    struct PlayerRow {
        #[diesel(sql_type = diesel::sql_types::Integer, column_name = "ID")]
        id: i32,
    }

    let rows: Vec<PlayerRow> =
        sql_query("SELECT ID FROM Players WHERE lower(Name) = lower(?1) LIMIT 1")
            .bind::<diesel::sql_types::Text, _>(account_key.clone())
            .load(db)?;

    let player_id = rows.first().map(|r| r.id);
    let Some(player_id) = player_id else {
        return Ok(AccountImportStats {
            last_game_utc_ms: None,
            count: 0,
        });
    };

    #[derive(diesel::QueryableByName)]
    struct CountRow {
        #[diesel(sql_type = diesel::sql_types::BigInt, column_name = "c")]
        c: i64,
    }

    let count_row: CountRow =
        sql_query("SELECT COUNT(*) as c FROM Games WHERE WhiteID = ?1 OR BlackID = ?1")
            .bind::<diesel::sql_types::Integer, _>(player_id)
            .get_result(db)?;

    #[derive(diesel::QueryableByName)]
    struct LastRow {
        #[diesel(
            sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>,
            column_name = "Date"
        )]
        date: Option<String>,
        #[diesel(
            sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>,
            column_name = "UTCTime"
        )]
        time: Option<String>,
    }

    let last: Option<LastRow> = sql_query(
        "SELECT Date, UTCTime FROM Games WHERE WhiteID = ?1 OR BlackID = ?1 ORDER BY Date DESC, UTCTime DESC LIMIT 1",
    )
    .bind::<diesel::sql_types::Integer, _>(player_id)
    .load::<LastRow>(db)?
    .into_iter()
    .next();

    Ok(AccountImportStats {
        last_game_utc_ms: parse_utc_ms(
            last.as_ref().and_then(|r| r.date.as_deref()),
            last.as_ref().and_then(|r| r.time.as_deref()),
        ),
        count: count_row.c,
    })
}

async fn reqwest_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(5_000))
        .timeout(Duration::from_secs(120))
        .user_agent("Obsidian Chess Studio")
        .build()?)
}

async fn reqwest_client_lichess() -> Result<reqwest::Client> {
    // Lichess NDJSON downloads were observed to spend ~99% of time awaiting
    // tiny HTTP/2 chunks (see debug logs). Forcing HTTP/1.1 is a targeted
    // experiment to improve throughput.
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(5_000))
        .timeout(Duration::from_secs(120))
        .user_agent("Obsidian Chess Studio")
        .http1_only()
        .build()?)
}

/// Retry-After can be seconds or an HTTP-date.
/// This returns a positive wait (>= 1) if possible.
fn retry_after_seconds(headers: &reqwest::header::HeaderMap) -> Option<i64> {
    let v = headers.get("Retry-After")?.to_str().ok()?;

    if let Ok(parsed) = v.parse::<i64>() {
        return Some(parsed.max(1));
    }

    // HTTP-date (e.g. "Wed, 21 Oct 2015 07:28:00 GMT")
    if let Ok(dt) = DateTime::parse_from_rfc2822(v) {
        let dt_utc = dt.with_timezone(&Utc);
        let now = Utc::now();
        let secs = (dt_utc - now).num_seconds();
        return Some(secs.max(1));
    }

    None
}

fn retry_delay_seconds(attempt: u32) -> i64 {
    // Exponential backoff with a cap, plus deterministic jitter to avoid thundering herd.
    // 2, 4, 8, 16, 32, 60, 60...
    let exp = 2_i64.saturating_mul(2_i64.saturating_pow(attempt.saturating_sub(1).min(10)));
    let base = exp.min(60);
    let jitter = ((attempt as i64 * 7) % 5) - 2; // [-2..+2]
    (base + jitter).max(1)
}

fn is_transient_error(err: &Error) -> bool {
    let s = format!("{err}").to_ascii_lowercase();

    if s.contains("rate_limit:") || s.contains("429") {
        return true;
    }

    // 5xx and common transient HTTP failures
    if s.contains("500")
        || s.contains("502")
        || s.contains("503")
        || s.contains("504")
        || s.contains("server error")
        || s.contains("bad gateway")
        || s.contains("service unavailable")
        || s.contains("gateway timeout")
    {
        return true;
    }

    // Network/timeouts
    if s.contains("timeout")
        || s.contains("timed out")
        || s.contains("error sending request")
        || s.contains("connection reset")
        || s.contains("connection refused")
        || s.contains("connection aborted")
        || s.contains("dns")
        || s.contains("tcp")
        || s.contains("tls")
        || s.contains("broken pipe")
        || s.contains("unexpected eof")
        || s.contains("os error")
    {
        return true;
    }

    false
}

async fn download_response_to_file(mut res: reqwest::Response, dest: &PathBuf) -> Result<()> {
    // Write atomically: download to a .part file first, then rename.
    let part = dest.with_extension("part");
    let _ = tokio::fs::remove_file(&part).await;
    let mut file = tokio::fs::File::create(&part).await?;

    // Stream chunks to disk (no buffering the whole body in memory)
    while let Some(chunk) = res.chunk().await? {
        file.write_all(&chunk).await?;
    }
    file.flush().await?;

    // Windows does not allow renaming over existing files.
    let _ = tokio::fs::remove_file(dest).await;
    tokio::fs::rename(&part, dest).await?;

    Ok(())
}

fn append_file(dest: &PathBuf, src: &PathBuf) -> Result<()> {
    let mut in_f = BufReader::new(fs::File::open(src)?);
    let mut out_f = BufWriter::new(OpenOptions::new().create(true).append(true).open(dest)?);
    std::io::copy(&mut in_f, &mut out_f)?;
    out_f.flush()?;
    Ok(())
}

async fn lichess_get_user_total_games(
    client: &reqwest::Client,
    username: &str,
    token: Option<&str>,
) -> Result<Option<i64>> {
    #[derive(Deserialize)]
    struct LichessCount {
        all: i64,
    }
    #[derive(Deserialize)]
    struct LichessUser {
        count: Option<LichessCount>,
    }

    let url = format!("https://lichess.org/api/user/{username}");
    let mut req = client.get(url);
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }

    let res = req.send().await?;
    if !res.status().is_success() {
        return Ok(None);
    }

    let user: LichessUser = res.json().await?;
    Ok(user.count.map(|c| c.all))
}

#[derive(Debug, Deserialize)]
struct LichessNdjsonGame {
    #[serde(default)]
    createdAt: Option<i64>,
    #[serde(default)]
    pgn: Option<String>,
}

fn normalize_pgn_line(line: &str, username_lc: &str, account_key: &str) -> Option<String> {
    if let Some(rest) = line.strip_prefix("[White \"") {
        if let Some(end) = rest.find("\"]") {
            let name = &rest[..end];
            if name.to_ascii_lowercase() == username_lc {
                return Some(format!("[White \"{account_key}\"]"));
            }
        }
    } else if let Some(rest) = line.strip_prefix("[Black \"") {
        if let Some(end) = rest.find("\"]") {
            let name = &rest[..end];
            if name.to_ascii_lowercase() == username_lc {
                return Some(format!("[Black \"{account_key}\"]"));
            }
        }
    }
    None
}

async fn write_normalized_pgn_async(
    writer: &mut TokioBufWriter<tokio::fs::File>,
    pgn: &str,
    platform: &str,
    username: &str,
) -> Result<()> {
    let username_lc = username.to_ascii_lowercase();
    let key = account_key(platform, username);

    for line in pgn.lines() {
        if let Some(rewritten) = normalize_pgn_line(line, &username_lc, &key) {
            writer.write_all(rewritten.as_bytes()).await?;
            writer.write_all(b"\n").await?;
        } else {
            writer.write_all(line.as_bytes()).await?;
            writer.write_all(b"\n").await?;
        }
    }

    // Ensure a blank line between games.
    writer.write_all(b"\n").await?;
    Ok(())
}

/// Lichess PGN batch download:
/// - Accept: application/x-chess-pgn
/// - Uses `max` + `since` + `until` pagination.
/// - Streams to `dest` (atomic via `.part`) and normalizes player tags (White/Black).
/// - Returns (oldest_ms, newest_ms, game_count) using `UTCDate`/`UTCTime` tags while streaming.
async fn lichess_download_batch_pgn_to_pgn_file(
    client: &reqwest::Client,
    username: &str,
    token: Option<&str>,
    since_ms: Option<i64>,
    until_ms: i64,
    dest: &PathBuf,
) -> Result<(Option<i64>, Option<i64>, i64)> {
    let mut url = format!(
        "https://lichess.org/api/games/user/{username}?max={max}&until={until_ms}\
&clocks=true&moves=true&tags=true&opening=true&finished=true",
        max = LICHESS_MAX_PER_BATCH
    );
    if let Some(since) = since_ms {
        url.push_str(&format!("&since={since}"));
    }

    let mut req = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/x-chess-pgn")
        // Ask explicitly; server may omit compression otherwise.
        .header(reqwest::header::ACCEPT_ENCODING, "gzip");

    // Use profile/session token if provided; otherwise fallback to default download token.
    // IMPORTANT: never log tokens.
    let auth_token = token.unwrap_or(DEFAULT_LICHESS_DOWNLOAD_TOKEN);
    req = req.bearer_auth(auth_token);

    let res = req.send().await?;

    if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let wait = retry_after_seconds(res.headers()).unwrap_or(30);
        return Err(Error::PackageManager(format!("RATE_LIMIT:{wait}")));
    }

    if res.status().as_u16() >= 500 {
        return Err(Error::PackageManager(format!(
            "RETRYABLE_HTTP:{}",
            res.status().as_u16()
        )));
    }

    if !res.status().is_success() {
        return Err(Error::PackageManager(format!(
            "Lichess NDJSON request failed ({})",
            res.status()
        )));
    }

    let part = dest.with_extension("part");
    let _ = tokio::fs::remove_file(&part).await;
    let file = tokio::fs::File::create(&part).await?;
    let mut writer = TokioBufWriter::new(file);

    let mut oldest: Option<i64> = None;
    let mut newest: Option<i64> = None;
    let mut game_count: i64 = 0;

    // Stream PGN and normalize line-by-line using a rolling buffer (no extra crates).
    let mut buffer: Vec<u8> = Vec::with_capacity(128 * 1024);
    let mut response = res;

    let username_lc = username.to_ascii_lowercase();
    let key = account_key("lichess", username);
    let mut pending_utc_date: Option<String> = None;
    let mut pending_utc_time: Option<String> = None;

    loop {
        let maybe_chunk = response.chunk().await?;

        let Some(chunk) = maybe_chunk else { break; };

        buffer.extend_from_slice(&chunk);

        let mut start = 0usize;
        for i in 0..buffer.len() {
            if buffer[i] == b'\n' {
                let line = &buffer[start..i];
                start = i + 1;

                let line = trim_ascii_whitespace(line);
                if line.is_empty() {
                    continue;
                }
                let s = std::str::from_utf8(line).unwrap_or("");
                // Track game count and timestamps via tags.
                if s.starts_with("[Event \"") {
                    game_count += 1;
                } else if let Some(rest) = s.strip_prefix("[UTCDate \"") {
                    if let Some(end) = rest.find("\"]") {
                        pending_utc_date = Some(rest[..end].to_string());
                    }
                } else if let Some(rest) = s.strip_prefix("[UTCTime \"") {
                    if let Some(end) = rest.find("\"]") {
                        pending_utc_time = Some(rest[..end].to_string());
                    }
                }
                if let (Some(d), Some(t)) = (pending_utc_date.as_deref(), pending_utc_time.as_deref())
                {
                    if let (Some(date), Some(time)) = (d.split_once('.'), t.split_once(':')) {
                        // Very small parser: YYYY.MM.DD + HH:MM:SS -> millis UTC
                        let y = date.0.parse::<i32>().ok();
                        let m = date.1[..2].parse::<u32>().ok();
                        let day = date.1[3..].parse::<u32>().ok();
                        let hh = time.0.parse::<u32>().ok();
                        let mm = time.1[..2].parse::<u32>().ok();
                        let ss = time.1[3..].parse::<u32>().ok();
                        if let (Some(y), Some(m), Some(day), Some(hh), Some(mm), Some(ss)) =
                            (y, m, day, hh, mm, ss)
                        {
                            if let Some(dt) = chrono::Utc
                                .with_ymd_and_hms(y, m, day, hh, mm, ss)
                                .single()
                            {
                                let ts = dt.timestamp_millis();
                                oldest = Some(oldest.map(|o| o.min(ts)).unwrap_or(ts));
                                newest = Some(newest.map(|n| n.max(ts)).unwrap_or(ts));
                                pending_utc_date = None;
                                pending_utc_time = None;
                            }
                        }
                    }
                }

                // Normalize White/Black to account key and stream out.
                if let Some(rewritten) = normalize_pgn_line(s, &username_lc, &key) {
                    writer.write_all(rewritten.as_bytes()).await?;
                    writer.write_all(b"\n").await?;
                } else {
                    writer.write_all(s.as_bytes()).await?;
                    writer.write_all(b"\n").await?;
                }
            }
        }

        if start > 0 {
            buffer.drain(0..start);
        }

    }

    // Process trailing line without newline
    let tail = trim_ascii_whitespace(&buffer);
    if !tail.is_empty() {
        let s = std::str::from_utf8(tail).unwrap_or("");
        if s.starts_with("[Event \"") {
            game_count += 1;
        }
        if let Some(rewritten) = normalize_pgn_line(s, &username_lc, &key) {
            writer.write_all(rewritten.as_bytes()).await?;
            writer.write_all(b"\n").await?;
        } else {
            writer.write_all(s.as_bytes()).await?;
            writer.write_all(b"\n").await?;
        }
    }

    // Ensure a blank line between games (matches prior behavior).
    writer.write_all(b"\n").await?;

    writer.flush().await?;
    drop(writer);

    let _ = tokio::fs::remove_file(dest).await;
    tokio::fs::rename(&part, dest).await?;

    Ok((oldest, newest, game_count))
}

fn trim_ascii_whitespace(mut s: &[u8]) -> &[u8] {
    while let Some((&b, rest)) = s.split_first() {
        if b.is_ascii_whitespace() {
            s = rest;
        } else {
            break;
        }
    }
    while let Some((&b, rest)) = s.split_last() {
        if b.is_ascii_whitespace() {
            s = rest;
        } else {
            break;
        }
    }
    s
}

/// NDJSON probe: request max=1 and check if body is empty.
/// Much cheaper than PGN parsing, and aligns with the NDJSON sync.
async fn lichess_probe_has_new_games(
    client: &reqwest::Client,
    username: &str,
    token: Option<&str>,
    since_ms: i64,
) -> Result<bool> {
    let until_ms = chrono::Utc::now().timestamp_millis();
    let url = format!(
        "https://lichess.org/api/games/user/{username}?max=1&since={since_ms}&until={until_ms}\
&finished=true",
    );

    let mut req = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/x-ndjson");
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }

    let res = req.send().await?;

    if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let wait = retry_after_seconds(res.headers()).unwrap_or(30);
        return Err(Error::PackageManager(format!("RATE_LIMIT:{wait}")));
    }
    if res.status().as_u16() >= 500 {
        return Err(Error::PackageManager(format!(
            "RETRYABLE_HTTP:{}",
            res.status().as_u16()
        )));
    }
    if !res.status().is_success() {
        return Ok(true);
    }

    let text = res.text().await.unwrap_or_default();
    Ok(!text.trim().is_empty())
}

async fn chesscom_get_archives(client: &reqwest::Client, username: &str) -> Result<Vec<String>> {
    #[derive(Deserialize)]
    struct ArchivesResp {
        archives: Vec<String>,
    }

    let url = format!(
        "https://api.chess.com/pub/player/{}/games/archives",
        username.to_ascii_lowercase()
    );
    let res = client.get(url).send().await?;

    if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let wait = retry_after_seconds(res.headers()).unwrap_or(60);
        return Err(Error::PackageManager(format!("RATE_LIMIT:{wait}")));
    }
    if res.status().as_u16() >= 500 {
        return Err(Error::PackageManager(format!(
            "RETRYABLE_HTTP:{}",
            res.status().as_u16()
        )));
    }
    if !res.status().is_success() {
        return Err(Error::PackageManager(format!(
            "Chess.com archives request failed ({})",
            res.status()
        )));
    }

    let parsed: ArchivesResp = res.json().await?;
    Ok(parsed.archives)
}

fn chesscom_archive_to_pgn_url(archive_url: &str) -> String {
    // archive_url format: .../games/YYYY/MM
    // pgn format: .../games/YYYY/MM/pgn
    format!("{archive_url}/pgn")
}

async fn chesscom_download_archive_pgn_to_file(
    client: &reqwest::Client,
    archive_url: &str,
    dest: &PathBuf,
) -> Result<()> {
    let url = chesscom_archive_to_pgn_url(archive_url);

    let res = client
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/x-chess-pgn")
        .send()
        .await?;

    if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let wait = retry_after_seconds(res.headers()).unwrap_or(60);
        return Err(Error::PackageManager(format!("RATE_LIMIT:{wait}")));
    }

    if res.status().as_u16() >= 500 {
        return Err(Error::PackageManager(format!(
            "RETRYABLE_HTTP:{}",
            res.status().as_u16()
        )));
    }

    if !res.status().is_success() {
        return Err(Error::PackageManager(format!(
            "Chess.com archive PGN request failed ({})",
            res.status()
        )));
    }

    download_response_to_file(res, dest).await?;
    Ok(())
}

fn ensure_db_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().resolve("db", BaseDirectory::AppData)?;
    if !dir.exists() {
        fs::create_dir_all(&dir)?;
    }
    Ok(dir)
}

/// Optimize profile database after sync completes:
/// - Create additional indexes (TimeControl, ECO, opponent level, etc.)
/// - Run ANALYZE to update query planner statistics
/// - Apply performance pragmas
/// Emits progress events for UI feedback (unless suppress_events is true).
async fn optimize_profile_db_after_sync(
    db_path: PathBuf,
    profile_id: String,
    account_key: String,
    platform: String,
    app: AppHandle,
    state: State<'_, AppState>,
    suppress_events: bool,
) -> Result<()> {
    // Emit optimization start event
    if !suppress_events {
        let _ = AccountSyncProgress {
            profile_id: profile_id.clone(),
            account_key: account_key.clone(),
            platform: platform.clone(),
            total_batches: 0,
            completed_batches: 0,
            current_batch: 0,
            batch_label: "Optimizing database...".to_string(),
            cooldown_seconds: None,
        }
        .emit(&app);
    }

    let db = &mut super::get_db_or_create(
        &state,
        db_path.to_str().unwrap(),
        ConnectionOptions {
            enable_foreign_keys: false,
            busy_timeout: None,
            journal_mode: JournalMode::Delete,
        },
    )?;

    // Step 1: Create additional indexes for TimeControl, ECO, opponent level, etc.
    if let Err(e) = db.batch_execute(ADDITIONAL_INDEXES_SQL) {
        // Log but don't fail - indexes are best-effort
        if !suppress_events {
            let _ = AccountSyncProgress {
                profile_id: profile_id.clone(),
                account_key: account_key.clone(),
                platform: platform.clone(),
                total_batches: 0,
                completed_batches: 0,
                current_batch: 0,
                batch_label: format!("Database optimization warning: {}", e),
                cooldown_seconds: None,
            }
            .emit(&app);
        }
    }

    // Step 2: Update query planner statistics (critical for optimal query performance)
    if let Err(e) = db.batch_execute("ANALYZE Games; ANALYZE Players; ANALYZE Events; ANALYZE Sites;") {
        // Log but don't fail
        if !suppress_events {
            let _ = AccountSyncProgress {
                profile_id: profile_id.clone(),
                account_key: account_key.clone(),
                platform: platform.clone(),
                total_batches: 0,
                completed_batches: 0,
                current_batch: 0,
                batch_label: format!("ANALYZE warning: {}", e),
                cooldown_seconds: None,
            }
            .emit(&app);
        }
    }

    // Apply performance pragmas (cache, mmap, PRAGMA optimize, etc.)
    if let Err(e) = db.batch_execute(PRAGMA_PERFORMANCE) {
        // Log but don't fail
        if !suppress_events {
            let _ = AccountSyncProgress {
                profile_id: profile_id.clone(),
                account_key: account_key.clone(),
                platform: platform.clone(),
                total_batches: 0,
                completed_batches: 0,
                current_batch: 0,
                batch_label: format!("Performance pragmas warning: {}", e),
                cooldown_seconds: None,
            }
            .emit(&app);
        }
    }

    // Emit completion event
    if !suppress_events {
        let _ = AccountSyncProgress {
            profile_id: profile_id.clone(),
            account_key: account_key.clone(),
            platform: platform.clone(),
            total_batches: 0,
            completed_batches: 0,
            current_batch: 0,
            batch_label: "Database optimization complete".to_string(),
            cooldown_seconds: None,
        }
        .emit(&app);
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn sync_account_games_to_profile_db(
    profile_id: String,
    profile_title: String,
    platform: String,
    username: String,
    token: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<AccountSyncResult> {
    // Prevent concurrent sync sessions backend-side.
    let _guard = GLOBAL_PROFILE_SYNC_LOCK.lock().await;

    let db_dir = ensure_db_dir(&app)?;
    let db_path = profile_db_path(&app, &profile_id)?;

    let account_key = account_key(&platform, &username);

    // IMPORTANT (resume): do NOT overwrite persisted cursor/batch state when starting.
    // If the app was closed mid-sync, we must preserve `cursor_until_ms` / `completed_batches`
    // so the next run can resume from the last confirmed batch.
    let existing_state0 = get_account_sync_state(
        db_path.clone(),
        account_key.clone(),
        platform.clone(),
        state.clone(),
    )
    .await
    .ok()
    .flatten();
    // Determine if we should suppress progress events (silent mode) if last update was recent
    // Sync will still execute, but no toasts/notifications will be shown
    let suppress_events = if let Some(state) = existing_state0.as_ref() {
        if !state.running && state.completed_batches > 0 {
            let now_ms = chrono::Utc::now().timestamp_millis();
            let hours_since_update = (now_ms - state.updated_at_ms) / (1000 * 60 * 60);
            hours_since_update < 24
        } else {
            false
        }
    } else {
        false
    };
    
    let _ = upsert_account_sync_state(
        db_path.clone(),
        if let Some(s) = existing_state0.clone() {
            super::AccountSyncState {
                account_key: s.account_key,
                platform: s.platform,
                cursor_until_ms: s.cursor_until_ms,
                since_ms: s.since_ms,
                mode: s.mode,
                total_batches: s.total_batches,
                completed_batches: s.completed_batches,
                running: true,
                updated_at_ms: chrono::Utc::now().timestamp_millis(),
            }
        } else {
            super::AccountSyncState {
                account_key: account_key.clone(),
                platform: platform.clone(),
                cursor_until_ms: None,
                since_ms: None,
                mode: "incremental".to_string(),
                total_batches: 0,
                completed_batches: 0,
                running: true,
                updated_at_ms: chrono::Utc::now().timestamp_millis(),
            }
        },
        state.clone(),
    )
    .await;

    let client = if platform == "lichess" {
        reqwest_client_lichess().await?
    } else {
        reqwest_client().await?
    };

    if platform == "lichess" {
        let existing_state = existing_state0;

        let has_resume_cursor = existing_state
            .as_ref()
            .and_then(|s| s.cursor_until_ms)
            .is_some();

        let stats_before = get_account_import_stats(
            profile_id.clone(),
            platform.clone(),
            username.clone(),
            state.clone(),
            app.clone(),
        )
        .await?;

        let before_count = stats_before.count;
        let last_game_ms = stats_before.last_game_utc_ms;

        let mode = if has_resume_cursor {
            existing_state
                .as_ref()
                .map(|s| s.mode.as_str())
                .unwrap_or("incremental")
                .to_string()
        } else if stats_before.count == 0 || last_game_ms.is_none() {
            "backfill".to_string()
        } else {
            "incremental".to_string()
        };

        let since_ms: Option<i64> = if mode == "incremental" {
            if has_resume_cursor {
                existing_state
                    .as_ref()
                    .and_then(|s| s.since_ms)
                    .or_else(|| last_game_ms.map(|ms| ms + 1))
            } else {
                last_game_ms.map(|ms| ms + 1)
            }
        } else {
            None
        };

        // Fast incremental probe (avoids heavy batch downloads when nothing changed)
        if !has_resume_cursor && mode == "incremental" {
            if let Some(since) = since_ms {
                let mut attempts_429 = 0u32;
                let mut attempts_net = 0u32;

                loop {
                    match lichess_probe_has_new_games(&client, &username, token.as_deref(), since)
                        .await
                    {
                        Ok(false) => {
                            upsert_account_sync_state(
                                db_path.clone(),
                                super::AccountSyncState {
                                    account_key: account_key.clone(),
                                    platform: platform.clone(),
                                    cursor_until_ms: None,
                                    since_ms: None,
                                    mode: "incremental".to_string(),
                                    total_batches: 0,
                                    completed_batches: 0,
                                    running: false,
                                    updated_at_ms: chrono::Utc::now().timestamp_millis(),
                                },
                                state.clone(),
                            )
                            .await
                            .ok();
                            return Ok(AccountSyncResult { imported_games: 0 });
                        }
                        Ok(true) => break,
                        Err(e) => {
                            let msg = format!("{e}");
                            if let Some(rest) = msg.strip_prefix("RATE_LIMIT:") {
                                attempts_429 += 1;
                                if attempts_429 >= MAX_PROBE_RETRIES {
                                    break;
                                }
                                let wait: i64 = rest.parse().unwrap_or(30);
                                if !suppress_events {
                                    let _ = AccountSyncProgress {
                                        profile_id: profile_id.clone(),
                                        account_key: account_key.clone(),
                                        platform: platform.clone(),
                                        total_batches: 1,
                                        completed_batches: 0,
                                        current_batch: 1,
                                        batch_label: "Lichess sync (cooldown)".to_string(),
                                        cooldown_seconds: Some(wait),
                                    }
                                    .emit(&app);
                                }
                                tokio::time::sleep(Duration::from_secs(wait as u64)).await;
                                continue;
                            }

                            if !is_transient_error(&e) {
                                break;
                            }
                            attempts_net += 1;
                            if attempts_net >= MAX_PROBE_RETRIES {
                                break;
                            }
                            let wait = retry_delay_seconds(attempts_net);
                            if !suppress_events {
                                let _ = AccountSyncProgress {
                                    profile_id: profile_id.clone(),
                                    account_key: account_key.clone(),
                                    platform: platform.clone(),
                                    total_batches: 1,
                                    completed_batches: 0,
                                    current_batch: 1,
                                    batch_label: "Lichess sync (network retry)".to_string(),
                                    cooldown_seconds: Some(wait),
                                }
                                .emit(&app);
                            }
                            tokio::time::sleep(Duration::from_secs(wait as u64)).await;
                        }
                    }
                }
            }
        }

        let mut cursor_until_ms: i64 = if has_resume_cursor {
            existing_state
                .as_ref()
                .and_then(|s| s.cursor_until_ms)
                .unwrap_or(chrono::Utc::now().timestamp_millis())
        } else {
            chrono::Utc::now().timestamp_millis()
        };

        let mut completed_batches: i64 = if has_resume_cursor {
            existing_state.as_ref().map(|s| s.completed_batches).unwrap_or(0)
        } else {
            0
        };

        let mut planned_total_batches: i64 = if has_resume_cursor {
            existing_state
                .as_ref()
                .map(|s| s.total_batches)
                .unwrap_or(0)
                .max(1)
        } else if mode == "backfill" {
            let total = lichess_get_user_total_games(&client, &username, token.as_deref())
                .await
                .unwrap_or(None)
                .unwrap_or(0);
            let est = if total > 0 {
                ((total + LICHESS_MAX_PER_BATCH - 1) / LICHESS_MAX_PER_BATCH).max(1)
            } else {
                1
            };
            est
        } else {
            1
        };

        upsert_account_sync_state(
            db_path.clone(),
            super::AccountSyncState {
                account_key: account_key.clone(),
                platform: platform.clone(),
                cursor_until_ms: Some(cursor_until_ms),
                since_ms,
                mode: mode.clone(),
                total_batches: planned_total_batches,
                completed_batches,
                running: true,
                updated_at_ms: chrono::Utc::now().timestamp_millis(),
            },
            state.clone(),
        )
        .await
        .ok();

        let temp_file = db_dir.join(format!(
            "tmp_lichess_{}_{}.pgn",
            profile_id,
            sanitize_segment(&username)
        ));
        let account_pgn_path = db_dir.join(account_pgn_filename(&profile_id, &platform, &username));

        let min_timestamp_seconds: Option<i32> = if mode == "incremental" {
            since_ms.map(|s| ((s - 1).max(0) / 1000) as i32)
        } else {
            None
        };

        let mut sync_error: Option<String> = None;

        while since_ms.map(|s| cursor_until_ms > s).unwrap_or(true) {
            let current_batch = completed_batches + 1;
            if current_batch > planned_total_batches {
                planned_total_batches = current_batch;
            }

            if !suppress_events {
                let _ = AccountSyncProgress {
                    profile_id: profile_id.clone(),
                    account_key: account_key.clone(),
                    platform: platform.clone(),
                    total_batches: planned_total_batches,
                    completed_batches,
                    current_batch,
                    batch_label: format!("Lichess {current_batch}/{planned_total_batches}"),
                    cooldown_seconds: None,
                }
                .emit(&app);
            }

            // PGN batch download returns times and count via tags while streaming.
            let mut attempts_429: u32 = 0;
            let mut attempts_net: u32 = 0;

            let (oldest_ms, newest_ms, game_count) = loop {
                let res = lichess_download_batch_pgn_to_pgn_file(
                    &client,
                    &username,
                    token.as_deref(),
                    since_ms,
                    cursor_until_ms,
                    &temp_file,
                )
                .await;

                match res {
                    Ok(meta) => break meta,
                    Err(e) => {
                        let msg = format!("{e}");

                        if let Some(rest) = msg.strip_prefix("RATE_LIMIT:") {
                            attempts_429 += 1;
                            if attempts_429 >= MAX_RETRIES_429 {
                                sync_error = Some("Too many retries (Lichess 429)".to_string());
                                break (None, None, 0);
                            }
                            let wait: i64 = rest.parse().unwrap_or(30);
                            if !suppress_events {
                                let _ = AccountSyncProgress {
                                    profile_id: profile_id.clone(),
                                    account_key: account_key.clone(),
                                    platform: platform.clone(),
                                    total_batches: planned_total_batches,
                                    completed_batches,
                                    current_batch,
                                    batch_label: format!("Lichess {current_batch}/{planned_total_batches}"),
                                    cooldown_seconds: Some(wait),
                                }
                                .emit(&app);
                            }
                            tokio::time::sleep(Duration::from_secs(wait as u64)).await;
                            continue;
                        }

                        if is_transient_error(&e) {
                            attempts_net += 1;
                            if attempts_net >= MAX_RETRIES_NETWORK {
                                sync_error = Some(format!("{e}"));
                                break (None, None, 0);
                            }
                            let wait = retry_delay_seconds(attempts_net);
                            if !suppress_events {
                                let _ = AccountSyncProgress {
                                    profile_id: profile_id.clone(),
                                    account_key: account_key.clone(),
                                    platform: platform.clone(),
                                    total_batches: planned_total_batches,
                                    completed_batches,
                                    current_batch,
                                    batch_label: format!("Lichess {current_batch}/{planned_total_batches}"),
                                    cooldown_seconds: Some(wait),
                                }
                                .emit(&app);
                            }
                            tokio::time::sleep(Duration::from_secs(wait as u64)).await;
                            continue;
                        }

                        sync_error = Some(format!("{e}"));
                        break (None, None, 0);
                    }
                }
            };

            if sync_error.is_some() {
                break;
            }

            if game_count == 0 || oldest_ms.is_none() {
                break;
            }

            // If incremental and newest isn't newer than since, stop.
            if let (Some(since), Some(newest)) = (since_ms, newest_ms) {
                if newest < since {
                    break;
                }
            }

            // Append to account PGN file (still optional; avoids extra memory)
            let _ = append_file(&account_pgn_path, &temp_file);

            // Import
            convert_pgn_impl(
                temp_file.clone(),
                db_path.clone(),
                min_timestamp_seconds,
                app.clone(),
                profile_title.clone(),
                None,
                &state,
            )?;

            completed_batches += 1;
            cursor_until_ms = oldest_ms.map(|o| (o - 1).max(0)).unwrap_or(0);

            upsert_account_sync_state(
                db_path.clone(),
                super::AccountSyncState {
                    account_key: account_key.clone(),
                    platform: platform.clone(),
                    cursor_until_ms: Some(cursor_until_ms),
                    since_ms,
                    mode: mode.clone(),
                    total_batches: planned_total_batches,
                    completed_batches,
                    running: true,
                    updated_at_ms: chrono::Utc::now().timestamp_millis(),
                },
                state.clone(),
            )
            .await
            .ok();

            if let (Some(since), Some(oldest)) = (since_ms, oldest_ms) {
                if oldest <= since {
                    break;
                }
            }
        }

        let _ = fs::remove_file(&temp_file);

        // Best-effort dedupe once at the end (much faster than per-batch)
        let _ = delete_duplicated_games(db_path.clone(), state.clone()).await;

        let is_complete = sync_error.is_none();
        
        // Optimize database after sync completes (indexes, ANALYZE, VACUUM)
        if is_complete {
            let _ = optimize_profile_db_after_sync(
                db_path.clone(),
                profile_id.clone(),
                account_key.clone(),
                platform.clone(),
                app.clone(),
                state.clone(),
                suppress_events,
            )
            .await;
        }

        upsert_account_sync_state(
            db_path.clone(),
            super::AccountSyncState {
                account_key: account_key.clone(),
                platform: platform.clone(),
                cursor_until_ms: if is_complete { None } else { Some(cursor_until_ms) },
                since_ms: if is_complete { None } else { since_ms },
                mode: if is_complete { "incremental".to_string() } else { mode },
                total_batches: if is_complete { completed_batches } else { planned_total_batches },
                completed_batches,
                running: false,
                updated_at_ms: chrono::Utc::now().timestamp_millis(),
            },
            state.clone(),
        )
        .await
        .ok();

        if let Some(err) = sync_error {
            return Err(Error::PackageManager(err));
        }

        let stats_after = get_account_import_stats(
            profile_id.clone(),
            platform.clone(),
            username.clone(),
            state.clone(),
            app.clone(),
        )
        .await
        .unwrap_or(AccountImportStats {
            last_game_utc_ms: None,
            count: before_count,
        });
        let imported_games = (stats_after.count - before_count).max(0);

        return Ok(AccountSyncResult { imported_games });
    }

    if platform == "chesscom" {
        let stats_before = get_account_import_stats(
            profile_id.clone(),
            platform.clone(),
            username.clone(),
            state.clone(),
            app.clone(),
        )
        .await?;
        let before_count = stats_before.count;

        // Archives list with robust retry, so we don't fail early on transient errors.
        let mut archives_attempt_429 = 0u32;
        let mut archives_attempt_net = 0u32;

        let mut archives = loop {
            match chesscom_get_archives(&client, &username).await {
                Ok(a) => break a,
                Err(e) => {
                    let msg = format!("{e}");
                    if let Some(rest) = msg.strip_prefix("RATE_LIMIT:") {
                        archives_attempt_429 += 1;
                        if archives_attempt_429 >= MAX_RETRIES_429 {
                            return Err(Error::PackageManager(
                                "Too many retries (Chess.com 429)".to_string(),
                            ));
                        }
                        let wait: i64 = rest.parse().unwrap_or(60);
                        if !suppress_events {
                            let _ = AccountSyncProgress {
                                profile_id: profile_id.clone(),
                                account_key: account_key.clone(),
                                platform: platform.clone(),
                                total_batches: 1,
                                completed_batches: 0,
                                current_batch: 1,
                                batch_label: "Chess.com archives (cooldown)".to_string(),
                                cooldown_seconds: Some(wait),
                            }
                            .emit(&app);
                        }
                        tokio::time::sleep(Duration::from_secs(wait as u64)).await;
                        continue;
                    }

                    if is_transient_error(&e) {
                        archives_attempt_net += 1;
                        if archives_attempt_net >= MAX_RETRIES_NETWORK {
                            return Err(e);
                        }
                        let wait = retry_delay_seconds(archives_attempt_net);
                        if !suppress_events {
                            let _ = AccountSyncProgress {
                                profile_id: profile_id.clone(),
                                account_key: account_key.clone(),
                                platform: platform.clone(),
                                total_batches: 1,
                                completed_batches: 0,
                                current_batch: 1,
                                batch_label: "Chess.com archives (network retry)".to_string(),
                                cooldown_seconds: Some(wait),
                            }
                            .emit(&app);
                        }
                        tokio::time::sleep(Duration::from_secs(wait as u64)).await;
                        continue;
                    }

                    return Err(e);
                }
            }
        };

        archives.reverse(); // most recent first

        let completed = list_account_sync_completed_batches(
            db_path.clone(),
            account_key.clone(),
            platform.clone(),
            state.clone(),
        )
        .await
        .unwrap_or_default();
        let completed_set: HashSet<String> = completed.into_iter().collect();

        let archives_to_process: Vec<String> = archives
            .iter()
            .cloned()
            .filter(|a| !completed_set.contains(a))
            .collect();

        let total_batches = archives.len() as i64;
        let mut completed_batches = (archives.len() - archives_to_process.len()) as i64;
        let mode = if completed_batches < total_batches {
            "backfill".to_string()
        } else {
            "incremental".to_string()
        };

        upsert_account_sync_state(
            db_path.clone(),
            super::AccountSyncState {
                account_key: account_key.clone(),
                platform: platform.clone(),
                cursor_until_ms: None,
                since_ms: None,
                mode: mode.clone(),
                total_batches,
                completed_batches,
                running: true,
                updated_at_ms: chrono::Utc::now().timestamp_millis(),
            },
            state.clone(),
        )
        .await
        .ok();

        let temp_file = db_dir.join(format!(
            "tmp_chesscom_{}_{}.pgn",
            profile_id,
            sanitize_segment(&username)
        ));
        let account_pgn_path = db_dir.join(account_pgn_filename(&profile_id, &platform, &username));

        let mut sync_error: Option<String> = None;

        for archive_url in archives_to_process {
            let current_batch = completed_batches + 1;

            if !suppress_events {
                let _ = AccountSyncProgress {
                    profile_id: profile_id.clone(),
                    account_key: account_key.clone(),
                    platform: platform.clone(),
                    total_batches,
                    completed_batches,
                    current_batch,
                    batch_label: format!("Chess.com {current_batch}/{total_batches}"),
                    cooldown_seconds: None,
                }
                .emit(&app);
            }

            // Robust retry loop: 429 + network/5xx
            let mut attempts_429: u32 = 0;
            let mut attempts_net: u32 = 0;

            loop {
                let pgn_res =
                    chesscom_download_archive_pgn_to_file(&client, &archive_url, &temp_file).await;
                match pgn_res {
                    Ok(()) => break,
                    Err(e) => {
                        let msg = format!("{e}");

                        if let Some(rest) = msg.strip_prefix("RATE_LIMIT:") {
                            attempts_429 += 1;
                            if attempts_429 >= MAX_RETRIES_429 {
                                sync_error = Some("Too many retries (Chess.com 429)".to_string());
                                break;
                            }
                            let wait: i64 = rest.parse().unwrap_or(60);
                            if !suppress_events {
                                let _ = AccountSyncProgress {
                                    profile_id: profile_id.clone(),
                                    account_key: account_key.clone(),
                                    platform: platform.clone(),
                                    total_batches,
                                    completed_batches,
                                    current_batch,
                                    batch_label: format!("Chess.com {current_batch}/{total_batches}"),
                                    cooldown_seconds: Some(wait),
                                }
                                .emit(&app);
                            }
                            tokio::time::sleep(Duration::from_secs(wait as u64)).await;
                            continue;
                        }

                        if is_transient_error(&e) {
                            attempts_net += 1;
                            if attempts_net >= MAX_RETRIES_NETWORK {
                                sync_error = Some(format!("{e}"));
                                break;
                            }
                            let wait = retry_delay_seconds(attempts_net);
                            if !suppress_events {
                                let _ = AccountSyncProgress {
                                    profile_id: profile_id.clone(),
                                    account_key: account_key.clone(),
                                    platform: platform.clone(),
                                    total_batches,
                                    completed_batches,
                                    current_batch,
                                    batch_label: format!("Chess.com {current_batch}/{total_batches}"),
                                    cooldown_seconds: Some(wait),
                                }
                                .emit(&app);
                            }
                            tokio::time::sleep(Duration::from_secs(wait as u64)).await;
                            continue;
                        }

                        sync_error = Some(format!("{e}"));
                        break;
                    }
                }
            }

            if sync_error.is_some() {
                break;
            }

            // Normalize tags + scan (symmetric behavior; not used for cursoring)
            let _ = rewrite_tags_and_scan_pgn_in_place(&temp_file, &platform, &username)?;

            // Append to export/debug file without loading into memory
            let _ = append_file(&account_pgn_path, &temp_file);

            // Import
            convert_pgn_impl(
                temp_file.clone(),
                db_path.clone(),
                None,
                app.clone(),
                profile_title.clone(),
                None,
                &state,
            )?;

            mark_account_sync_batch_complete(
                db_path.clone(),
                account_key.clone(),
                platform.clone(),
                archive_url.clone(),
                chrono::Utc::now().timestamp_millis(),
                state.clone(),
            )
            .await
            .ok();

            completed_batches += 1;

            upsert_account_sync_state(
                db_path.clone(),
                super::AccountSyncState {
                    account_key: account_key.clone(),
                    platform: platform.clone(),
                    cursor_until_ms: None,
                    since_ms: None,
                    mode: mode.clone(),
                    total_batches,
                    completed_batches,
                    running: true,
                    updated_at_ms: chrono::Utc::now().timestamp_millis(),
                },
                state.clone(),
            )
            .await
            .ok();
        }

        let _ = fs::remove_file(&temp_file);

        // Best-effort dedupe once at the end
        let _ = delete_duplicated_games(db_path.clone(), state.clone()).await;

        // Optimize database after sync completes (indexes, ANALYZE, VACUUM)
        if completed_batches >= total_batches {
            let _ = optimize_profile_db_after_sync(
                db_path.clone(),
                profile_id.clone(),
                account_key.clone(),
                platform.clone(),
                app.clone(),
                state.clone(),
                suppress_events,
            )
            .await;
        }

        upsert_account_sync_state(
            db_path.clone(),
            super::AccountSyncState {
                account_key: account_key.clone(),
                platform: platform.clone(),
                cursor_until_ms: None,
                since_ms: None,
                mode: if completed_batches >= total_batches {
                    "incremental".to_string()
                } else {
                    mode
                },
                total_batches,
                completed_batches,
                running: false,
                updated_at_ms: chrono::Utc::now().timestamp_millis(),
            },
            state.clone(),
        )
        .await
        .ok();

        if let Some(err) = sync_error {
            return Err(Error::PackageManager(err));
        }

        let stats_after = get_account_import_stats(
            profile_id.clone(),
            platform.clone(),
            username.clone(),
            state.clone(),
            app.clone(),
        )
        .await
        .unwrap_or(AccountImportStats {
            last_game_utc_ms: None,
            count: before_count,
        });
        let imported_games = (stats_after.count - before_count).max(0);

        return Ok(AccountSyncResult { imported_games });
    }

    Err(Error::PackageManager(format!(
        "Unsupported platform: {platform}"
    )))
}
