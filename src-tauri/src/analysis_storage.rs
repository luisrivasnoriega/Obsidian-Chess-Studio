use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{path::BaseDirectory, AppHandle, Manager};

use crate::error::{Error, Result};

const DB_FILENAME: &str = "analysis.db3";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AnalyzedGameEntry {
    pub game_id: String,
    pub analyzed_pgn: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StoredGameStats {
    pub accuracy: f64,
    pub acpl: f64,
    pub estimated_elo: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GameStatsEntry {
    pub game_id: String,
    pub accuracy: f64,
    pub acpl: f64,
    pub estimated_elo: Option<i64>,
}

fn get_analysis_db(app: &AppHandle) -> Result<Connection> {
    let db_path = app
        .path()
        .resolve(DB_FILENAME, BaseDirectory::AppData)
        .map_err(|e| Error::PackageManager(format!("Failed to resolve analysis DB path: {}", e)))?;

    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to create analysis DB directory: {}", e),
            ))
        })?;
    }

    let conn = Connection::open(&db_path)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS game_analysis (
            game_id TEXT PRIMARY KEY,
            analyzed_pgn TEXT,
            accuracy REAL,
            acpl REAL,
            estimated_elo INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_game_analysis_estimated_elo
            ON game_analysis(estimated_elo);
        "#,
    )?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_set_analyzed_game(app: AppHandle, game_id: String, analyzed_pgn: String) -> Result<()> {
    let game_id = game_id.trim();
    if game_id.is_empty() {
        return Ok(());
    }
    let conn = get_analysis_db(&app)?;
    conn.execute(
        r#"
        INSERT INTO game_analysis (game_id, analyzed_pgn, created_at, updated_at)
        VALUES (?1, ?2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(game_id) DO UPDATE SET
            analyzed_pgn = excluded.analyzed_pgn,
            updated_at = CURRENT_TIMESTAMP
        "#,
        params![game_id, analyzed_pgn],
    )?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_get_analyzed_game(app: AppHandle, game_id: String) -> Result<Option<String>> {
    let game_id = game_id.trim();
    if game_id.is_empty() {
        return Ok(None);
    }
    let conn = get_analysis_db(&app)?;
    let mut stmt = conn.prepare("SELECT analyzed_pgn FROM game_analysis WHERE game_id = ?1 AND analyzed_pgn IS NOT NULL")?;
    let res = stmt
        .query_row(params![game_id], |row| row.get::<_, String>(0))
        .optional()?;
    Ok(res)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_get_all_analyzed_games(app: AppHandle) -> Result<Vec<AnalyzedGameEntry>> {
    let conn = get_analysis_db(&app)?;
    let mut stmt = conn.prepare(
        r#"
        SELECT game_id, analyzed_pgn
        FROM game_analysis
        WHERE analyzed_pgn IS NOT NULL
        "#,
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(AnalyzedGameEntry {
                game_id: row.get(0)?,
                analyzed_pgn: row.get(1)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_set_game_stats(app: AppHandle, game_id: String, stats: StoredGameStats) -> Result<()> {
    let game_id = game_id.trim();
    if game_id.is_empty() {
        return Ok(());
    }
    let conn = get_analysis_db(&app)?;
    conn.execute(
        r#"
        INSERT INTO game_analysis (game_id, accuracy, acpl, estimated_elo, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(game_id) DO UPDATE SET
            accuracy = excluded.accuracy,
            acpl = excluded.acpl,
            estimated_elo = excluded.estimated_elo,
            updated_at = CURRENT_TIMESTAMP
        "#,
        params![game_id, stats.accuracy, stats.acpl, stats.estimated_elo],
    )?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_get_game_stats(app: AppHandle, game_id: String) -> Result<Option<StoredGameStats>> {
    let game_id = game_id.trim();
    if game_id.is_empty() {
        return Ok(None);
    }
    let conn = get_analysis_db(&app)?;
    let mut stmt = conn.prepare(
        r#"
        SELECT accuracy, acpl, estimated_elo
        FROM game_analysis
        WHERE game_id = ?1 AND accuracy IS NOT NULL AND acpl IS NOT NULL
        "#,
    )?;
    let res = stmt
        .query_row(params![game_id], |row| {
            Ok(StoredGameStats {
                accuracy: row.get(0)?,
                acpl: row.get(1)?,
                estimated_elo: row.get(2)?,
            })
        })
        .optional()?;
    Ok(res)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_get_game_stats_bulk(app: AppHandle, game_ids: Vec<String>) -> Result<Vec<GameStatsEntry>> {
    if game_ids.is_empty() {
        return Ok(vec![]);
    }
    let conn = get_analysis_db(&app)?;

    const BATCH_SIZE: usize = 900;
    let mut out: Vec<GameStatsEntry> = Vec::new();

    for chunk in game_ids.chunks(BATCH_SIZE) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            r#"
            SELECT game_id, accuracy, acpl, estimated_elo
            FROM game_analysis
            WHERE game_id IN ({})
              AND accuracy IS NOT NULL
              AND acpl IS NOT NULL
            "#,
            placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
                Ok(GameStatsEntry {
                    game_id: row.get(0)?,
                    accuracy: row.get(1)?,
                    acpl: row.get(2)?,
                    estimated_elo: row.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        out.extend(rows);
    }

    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_get_analyzed_games_bulk(app: AppHandle, game_ids: Vec<String>) -> Result<Vec<AnalyzedGameEntry>> {
    if game_ids.is_empty() {
        return Ok(vec![]);
    }
    let conn = get_analysis_db(&app)?;

    const BATCH_SIZE: usize = 200;
    let mut out: Vec<AnalyzedGameEntry> = Vec::new();

    for chunk in game_ids.chunks(BATCH_SIZE) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            r#"
            SELECT game_id, analyzed_pgn
            FROM game_analysis
            WHERE game_id IN ({})
              AND analyzed_pgn IS NOT NULL
            "#,
            placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
                Ok(AnalyzedGameEntry {
                    game_id: row.get(0)?,
                    analyzed_pgn: row.get(1)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        out.extend(rows);
    }

    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_delete_entries(app: AppHandle, game_ids: Vec<String>) -> Result<()> {
    if game_ids.is_empty() {
        return Ok(());
    }
    let conn = get_analysis_db(&app)?;

    // SQLite has a limit on the number of variables per query; batch conservatively.
    const BATCH_SIZE: usize = 900;
    for chunk in game_ids.chunks(BATCH_SIZE) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("DELETE FROM game_analysis WHERE game_id IN ({})", placeholders);
        let mut stmt = conn.prepare(&sql)?;
        stmt.execute(rusqlite::params_from_iter(chunk.iter()))?;
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_clear_analyzed_pgns(app: AppHandle) -> Result<()> {
    let conn = get_analysis_db(&app)?;
    conn.execute("UPDATE game_analysis SET analyzed_pgn = NULL, updated_at = CURRENT_TIMESTAMP", [])?;
    Ok(())
}
