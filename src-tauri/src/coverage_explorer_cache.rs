use crate::error::{Error, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, CastlingMode, Chess, EnPassantMode};
use specta::Type;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{path::BaseDirectory, AppHandle, Manager};

const COVERAGE_CACHE_DB_PATH: &str = "db/coverage_explorer_cache.db3";
const COVERAGE_CACHE_TTL_MS: i64 = 30_i64 * 24 * 60 * 60 * 1000; // 30 days

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CoverageCacheMoveDto {
    pub san: String,
    pub games: i64,
    #[serde(default)]
    pub white: i64,
    #[serde(default)]
    pub black: i64,
    #[serde(default)]
    pub draw: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CoverageCacheEntryDto {
    pub source_signature: String,
    pub config_json: Option<String>,
    pub fen: String,
    pub total_games: i64,
    pub moves: Vec<CoverageCacheMoveDto>,
    pub fetched_at_ms: i64,
    pub expires_at_ms: i64,
}

fn now_ms() -> Result<i64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as i64)
}

fn canonicalize_fen_key(fen: &str) -> Result<String> {
    let parsed = Fen::from_ascii(fen.trim().as_bytes())?;
    let pos: Chess = parsed.into_position(CastlingMode::Chess960)?;
    Ok(Fen::from_position(pos, EnPassantMode::Legal).to_string())
}

fn get_cache_db_path(app: &AppHandle) -> Result<PathBuf> {
    let path = app
        .path()
        .resolve(COVERAGE_CACHE_DB_PATH, BaseDirectory::AppData)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(path)
}

fn get_cache_connection(app: &AppHandle) -> Result<Connection> {
    let db_path = get_cache_db_path(app)?;
    let conn = Connection::open(db_path)?;
    conn.busy_timeout(Duration::from_secs(30))?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;

        CREATE TABLE IF NOT EXISTS coverage_explorer_cache (
            source_signature TEXT NOT NULL,
            fen_key TEXT NOT NULL,
            config_json TEXT,
            fen TEXT NOT NULL,
            total_games INTEGER NOT NULL,
            moves_json TEXT NOT NULL,
            fetched_at_ms INTEGER NOT NULL,
            expires_at_ms INTEGER NOT NULL,
            PRIMARY KEY (source_signature, fen_key)
        );

        CREATE INDEX IF NOT EXISTS idx_coverage_explorer_cache_expires
            ON coverage_explorer_cache(expires_at_ms);
        "#,
    )?;
    if let Err(err) = conn.execute(
        "ALTER TABLE coverage_explorer_cache ADD COLUMN config_json TEXT",
        [],
    ) {
        let msg = err.to_string();
        if !msg.contains("duplicate column name") {
            return Err(err.into());
        }
    }
    Ok(conn)
}

#[tauri::command]
#[specta::specta]
pub fn coverage_cache_get(
    app: AppHandle,
    source_signature: String,
    fen: String,
) -> Result<Option<CoverageCacheEntryDto>> {
    let signature = source_signature.trim();
    let fen_raw = fen.trim();
    if signature.is_empty() || fen_raw.is_empty() {
        return Ok(None);
    }

    let fen_key = canonicalize_fen_key(fen_raw)?;
    let conn = get_cache_connection(&app)?;
    let current_ms = now_ms()?;

    let row: Option<(Option<String>, String, i64, String, i64, i64)> = conn
        .query_row(
            r#"
            SELECT config_json, fen, total_games, moves_json, fetched_at_ms, expires_at_ms
            FROM coverage_explorer_cache
            WHERE source_signature = ?1 AND fen_key = ?2
            "#,
            params![signature, fen_key],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .optional()?;

    let Some((config_json, cached_fen, total_games, moves_json, fetched_at_ms, expires_at_ms)) =
        row
    else {
        return Ok(None);
    };

    if expires_at_ms <= current_ms {
        let _ = conn.execute(
            "DELETE FROM coverage_explorer_cache WHERE source_signature = ?1 AND fen_key = ?2",
            params![signature, fen_key],
        );
        return Ok(None);
    }

    let moves: Vec<CoverageCacheMoveDto> = match serde_json::from_str(&moves_json) {
        Ok(parsed) => parsed,
        Err(_) => {
            let _ = conn.execute(
                "DELETE FROM coverage_explorer_cache WHERE source_signature = ?1 AND fen_key = ?2",
                params![signature, fen_key],
            );
            return Ok(None);
        }
    };

    Ok(Some(CoverageCacheEntryDto {
        source_signature: signature.to_string(),
        config_json,
        fen: cached_fen,
        total_games,
        moves,
        fetched_at_ms,
        expires_at_ms,
    }))
}

#[tauri::command]
#[specta::specta]
pub fn coverage_cache_set(
    app: AppHandle,
    source_signature: String,
    fen: String,
    moves: Vec<CoverageCacheMoveDto>,
    config_json: Option<String>,
) -> Result<()> {
    let signature = source_signature.trim();
    let fen_raw = fen.trim();
    if signature.is_empty() {
        return Err(Error::InvalidInput(
            "coverage_cache_set: source_signature is empty".to_string(),
        ));
    }
    if fen_raw.is_empty() {
        return Err(Error::InvalidInput(
            "coverage_cache_set: fen is empty".to_string(),
        ));
    }

    let cleaned_moves: Vec<CoverageCacheMoveDto> = moves
        .into_iter()
        .filter_map(|m| {
            let san = m.san.trim().to_string();
            if san.is_empty() {
                return None;
            }
            Some(CoverageCacheMoveDto {
                san,
                games: m.games.max(0),
                white: m.white.max(0),
                black: m.black.max(0),
                draw: m.draw.max(0),
            })
        })
        .collect();

    let fen_key = canonicalize_fen_key(fen_raw)?;
    let total_games: i64 = cleaned_moves.iter().map(|m| m.games).sum();
    let moves_json = serde_json::to_string(&cleaned_moves).map_err(|e| {
        Error::InvalidInput(format!("coverage_cache_set: invalid moves payload: {e}"))
    })?;
    let config_json = config_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let fetched_at_ms = now_ms()?;
    let expires_at_ms = fetched_at_ms + COVERAGE_CACHE_TTL_MS;

    let conn = get_cache_connection(&app)?;
    conn.execute(
        r#"
        INSERT INTO coverage_explorer_cache (
            source_signature, fen_key, config_json, fen, total_games, moves_json, fetched_at_ms, expires_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(source_signature, fen_key) DO UPDATE SET
            config_json = excluded.config_json,
            fen = excluded.fen,
            total_games = excluded.total_games,
            moves_json = excluded.moves_json,
            fetched_at_ms = excluded.fetched_at_ms,
            expires_at_ms = excluded.expires_at_ms
        "#,
        params![
            signature,
            fen_key,
            config_json,
            fen_raw,
            total_games,
            moves_json,
            fetched_at_ms,
            expires_at_ms
        ],
    )?;

    Ok(())
}
