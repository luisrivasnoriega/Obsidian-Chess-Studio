use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;
use tauri::{path::BaseDirectory, AppHandle, Manager};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct VariantPosition {
    pub fen: String,
    pub engine: String,
    pub recommended_move: String,
    pub engine_advantage: Option<String>,
    pub ms: i64,
}

/// Open + init DB at an explicit path (test-friendly).
fn open_variant_positions_db_at_path(db_path: &Path) -> Result<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to create VariantPositions directory: {}", e),
            ))
        })?;
    }

    let conn = Connection::open(db_path)?;
    init_variant_positions_schema(&conn)?;
    Ok(conn)
}

fn get_variant_positions_db(app: &AppHandle) -> Result<Connection> {
    let db_path = app
        .path()
        .resolve("VariantPositions.db3", BaseDirectory::AppData)
        .map_err(|e| {
            Error::PackageManager(format!("Failed to resolve VariantPositions DB path: {}", e))
        })?;

    open_variant_positions_db_at_path(&db_path)
}

fn init_variant_positions_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS variant_positions (
            fen TEXT NOT NULL,
            fen_key TEXT,
            engine TEXT NOT NULL,
            recommended_move TEXT NOT NULL,
            engine_advantage TEXT,
            ms INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (fen, engine)
        );
        "#,
    )?;

    // Migration: older databases may not have fen_key.
    // SQLite does not support "ADD COLUMN IF NOT EXISTS", so we ignore the duplicate-column error.
    if let Err(err) = conn.execute("ALTER TABLE variant_positions ADD COLUMN fen_key TEXT", []) {
        let msg = err.to_string();
        if !msg.contains("duplicate column name") {
            return Err(err.into());
        }
    }
    if let Err(err) = conn.execute("ALTER TABLE variant_positions ADD COLUMN engine_advantage TEXT", []) {
        let msg = err.to_string();
        if !msg.contains("duplicate column name") {
            return Err(err.into());
        }
    }

    conn.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_variant_positions_fen_key
            ON variant_positions(fen_key);

        CREATE UNIQUE INDEX IF NOT EXISTS uniq_variant_positions_fen_key_engine
            ON variant_positions(fen_key, engine);

        CREATE INDEX IF NOT EXISTS idx_variant_positions_engine
            ON variant_positions(engine);
        "#,
    )?;

    // Backfill fen_key for older rows (if any).
    let mut stmt =
        conn.prepare("SELECT fen, engine FROM variant_positions WHERE fen_key IS NULL")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<(String, String)>, _>>()?;

    for (fen, engine) in rows {
        if let Some(key) = fen_identity_key(&fen) {
            conn.execute(
                "UPDATE variant_positions SET fen_key = ?1 WHERE fen = ?2 AND engine = ?3",
                params![key, fen, engine],
            )?;
        }
    }

    Ok(())
}

fn fen_identity_key(fen: &str) -> Option<String> {
    let parts: Vec<&str> = fen.split_whitespace().collect();
    if parts.len() < 4 {
        return None;
    }
    Some(parts[..4].join(" "))
}

/// Conn-based fetch (test-friendly, covers query logic without Tauri).
fn fetch_variant_position_conn(
    conn: &Connection,
    fen: &str,
    engine: &str,
) -> Result<Option<VariantPosition>> {
    let fen_key = match fen_identity_key(fen) {
        Some(key) => key,
        None => return Ok(None),
    };

    let mut stmt = conn.prepare(
        r#"
        SELECT fen, engine, recommended_move, engine_advantage, ms
        FROM variant_positions
        WHERE engine = ?1 AND fen_key = ?2
        ORDER BY ms DESC
        LIMIT 1
        "#,
    )?;

    let entry = stmt
        .query_row(params![engine, fen_key], |row| {
            Ok(VariantPosition {
                fen: row.get(0)?,
                engine: row.get(1)?,
                recommended_move: row.get(2)?,
                engine_advantage: row.get(3)?,
                ms: row.get(4)?,
            })
        })
        .optional()?;

    Ok(entry)
}

pub(crate) fn fetch_variant_position(
    app: &AppHandle,
    fen: &str,
    engine: &str,
) -> Result<Option<VariantPosition>> {
    let conn = get_variant_positions_db(app)?;
    fetch_variant_position_conn(&conn, fen, engine)
}

/// Conn-based upsert (test-friendly, covers conflict logic without Tauri).
fn upsert_variant_position_conn(
    conn: &Connection,
    fen: &str,
    engine: &str,
    recommended_move: &str,
    engine_advantage: Option<&str>,
    ms: i64,
) -> Result<()> {
    let fen_key = match fen_identity_key(fen) {
        Some(key) => key,
        None => return Ok(()),
    };
    let safe_ms = ms.max(0);
    let advantage = engine_advantage
        .map(str::trim)
        .filter(|value| !value.is_empty());

    conn.execute(
        r#"
        INSERT INTO variant_positions (fen, fen_key, engine, recommended_move, engine_advantage, ms, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(fen_key, engine) DO UPDATE SET
            fen = excluded.fen,
            recommended_move = CASE
                WHEN excluded.ms >= variant_positions.ms THEN excluded.recommended_move
                ELSE variant_positions.recommended_move
            END,
            engine_advantage = COALESCE(NULLIF(excluded.engine_advantage, ''), variant_positions.engine_advantage),
            ms = CASE
                WHEN excluded.ms > variant_positions.ms THEN excluded.ms
                ELSE variant_positions.ms
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE excluded.ms > variant_positions.ms
           OR (
                NULLIF(excluded.engine_advantage, '') IS NOT NULL
                AND (
                    variant_positions.engine_advantage IS NULL
                    OR TRIM(variant_positions.engine_advantage) = ''
                )
           )
        "#,
        params![fen, fen_key, engine, recommended_move, advantage, safe_ms],
    )?;

    Ok(())
}

pub(crate) fn upsert_variant_position_entry(
    app: &AppHandle,
    fen: &str,
    engine: &str,
    recommended_move: &str,
    engine_advantage: Option<&str>,
    ms: i64,
) -> Result<()> {
    let conn = get_variant_positions_db(app)?;
    upsert_variant_position_conn(&conn, fen, engine, recommended_move, engine_advantage, ms)
}

#[tauri::command]
#[specta::specta]
pub fn get_variant_position(
    app: AppHandle,
    fen: String,
    engine: String,
) -> Result<Option<VariantPosition>> {
    let fen = fen.trim();
    let engine = engine.trim();
    if fen.is_empty() || engine.is_empty() {
        return Ok(None);
    }
    fetch_variant_position(&app, fen, engine)
}

#[tauri::command]
#[specta::specta]
pub fn upsert_variant_position(
    app: AppHandle,
    fen: String,
    engine: String,
    recommended_move: String,
    ms: u32,
) -> Result<()> {
    let fen = fen.trim();
    let engine = engine.trim();
    let recommended_move = recommended_move.trim();
    if fen.is_empty() || engine.is_empty() || recommended_move.is_empty() {
        return Ok(());
    }
    upsert_variant_position_entry(&app, fen, engine, recommended_move, None, i64::from(ms))
}

#[tauri::command]
#[specta::specta]
pub fn get_variant_position_engine_eval(
    app: AppHandle,
    fen: String,
    engine: String,
) -> Result<Option<VariantPosition>> {
    get_variant_position(app, fen, engine)
}

#[tauri::command]
#[specta::specta]
pub fn upsert_variant_position_engine_eval(
    app: AppHandle,
    fen: String,
    engine: String,
    recommended_move: String,
    engine_advantage: String,
    ms: u32,
) -> Result<()> {
    let fen = fen.trim();
    let engine = engine.trim();
    let recommended_move = recommended_move.trim();
    let engine_advantage = engine_advantage.trim();
    if fen.is_empty() || engine.is_empty() || recommended_move.is_empty() || engine_advantage.is_empty() {
        return Ok(());
    }
    upsert_variant_position_entry(
        &app,
        fen,
        engine,
        recommended_move,
        Some(engine_advantage),
        i64::from(ms),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn temp_db_path() -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("VariantPositions.db3");
        (dir, path)
    }

    fn open_temp_conn() -> (TempDir, Connection) {
        let (dir, path) = temp_db_path();
        let conn = open_variant_positions_db_at_path(&path).unwrap();
        (dir, conn)
    }

    fn read_row(conn: &Connection, fen_key: &str, engine: &str) -> Option<(String, String, i64)> {
        conn.query_row(
            "SELECT fen, recommended_move, ms FROM variant_positions WHERE fen_key = ?1 AND engine = ?2",
            params![fen_key, engine],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .unwrap()
    }

    // -------------------------------------------------------------------------
    // fen_identity_key coverage
    // -------------------------------------------------------------------------

    #[test]
    fn test_fen_identity_key() {
        let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let key = fen_identity_key(fen);

        assert_eq!(
            key,
            Some("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -".to_string())
        );
    }

    #[test]
    fn test_fen_identity_key_short() {
        let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w";
        let key = fen_identity_key(fen);
        assert_eq!(key, None);
    }

    #[test]
    fn test_fen_identity_key_ignores_move_counters() {
        // Same first 4 fields, different counters => same key
        let fen1 = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let fen2 = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 12 34";
        assert_eq!(fen_identity_key(fen1), fen_identity_key(fen2));
    }

    #[test]
    fn test_fen_identity_key_various_formats() {
        let fen1 = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let key1 = fen_identity_key(fen1);
        assert!(key1.is_some());

        let fen2 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
        let key2 = fen_identity_key(fen2);
        assert!(key2.is_some());

        assert_ne!(key1, key2);
    }

    // -------------------------------------------------------------------------
    // Schema / migration / indices / backfill coverage
    // -------------------------------------------------------------------------

    #[test]
    fn test_init_schema_creates_table_and_indexes() {
        let (_dir, conn) = open_temp_conn();

        // Table exists?
        let table: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='variant_positions'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(table.as_deref(), Some("variant_positions"));

        // Indices exist?
        let idx1: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_variant_positions_fen_key'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(idx1.as_deref(), Some("idx_variant_positions_fen_key"));

        let idx2: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='uniq_variant_positions_fen_key_engine'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(idx2.as_deref(), Some("uniq_variant_positions_fen_key_engine"));

        let idx3: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_variant_positions_engine'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(idx3.as_deref(), Some("idx_variant_positions_engine"));
    }

    #[test]
    fn test_migration_adds_fen_key_and_backfills_existing_rows() {
        let (dir, path) = temp_db_path();
        let conn = Connection::open(&path).unwrap();

        // Simulate an older DB without fen_key.
        conn.execute_batch(
            r#"
            CREATE TABLE variant_positions (
                fen TEXT NOT NULL,
                engine TEXT NOT NULL,
                recommended_move TEXT NOT NULL,
                ms INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (fen, engine)
            );
            "#,
        )
        .unwrap();

        let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        conn.execute(
            "INSERT INTO variant_positions (fen, engine, recommended_move, ms) VALUES (?1, ?2, ?3, ?4)",
            params![fen, "e1", "e2e4", 123i64],
        )
        .unwrap();

        // Now run init -> should add fen_key + indexes + backfill.
        init_variant_positions_schema(&conn).unwrap();

        // Column exists?
        let mut stmt = conn.prepare("PRAGMA table_info(variant_positions)").unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|x| x.unwrap())
            .collect();
        assert!(cols.iter().any(|c| c == "fen_key"));

        // Backfilled?
        let expected_key =
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -".to_string();
        let stored_key: Option<String> = conn
            .query_row(
                "SELECT fen_key FROM variant_positions WHERE engine=?1",
                params!["e1"],
                |r| r.get(0),
            )
            .optional()
            .unwrap();

        assert_eq!(stored_key, Some(expected_key));

        drop(dir);
    }

    // -------------------------------------------------------------------------
    // Upsert / fetch behavior coverage (core logic)
    // -------------------------------------------------------------------------

    #[test]
    fn test_fetch_returns_none_for_bad_fen() {
        let (_dir, conn) = open_temp_conn();

        // FEN with <4 fields => no key => Ok(None)
        let result = fetch_variant_position_conn(&conn, "invalid", "stockfish").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_fetch_returns_none_when_no_rows() {
        let (_dir, conn) = open_temp_conn();

        let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let result = fetch_variant_position_conn(&conn, fen, "stockfish").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_upsert_inserts_and_fetches() {
        let (_dir, conn) = open_temp_conn();

        let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        upsert_variant_position_conn(&conn, fen, "sf", "e2e4", None, 1000).unwrap();

        let got = fetch_variant_position_conn(&conn, fen, "sf").unwrap().unwrap();
        assert_eq!(got.engine, "sf");
        assert_eq!(got.recommended_move, "e2e4");
        assert_eq!(got.ms, 1000);
        assert_eq!(got.fen, fen);
    }

    #[test]
    fn test_upsert_clamps_negative_ms_to_zero() {
        let (_dir, conn) = open_temp_conn();

        let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        upsert_variant_position_conn(&conn, fen, "sf", "e2e4", None, -50).unwrap();

        let got = fetch_variant_position_conn(&conn, fen, "sf").unwrap().unwrap();
        assert_eq!(got.ms, 0);
    }

    #[test]
    fn test_upsert_conflict_does_not_replace_when_ms_is_lower_or_equal() {
        let (_dir, conn) = open_temp_conn();

        let fen_a = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let fen_b = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 99"; // same key

        let key = fen_identity_key(fen_a).unwrap();

        upsert_variant_position_conn(&conn, fen_a, "sf", "e2e4", None, 1000).unwrap();

        // Lower ms => should NOT overwrite
        upsert_variant_position_conn(&conn, fen_b, "sf", "d2d4", None, 900).unwrap();

        let row = read_row(&conn, &key, "sf").unwrap();
        assert_eq!(row.0, fen_a); // fen should remain old
        assert_eq!(row.1, "e2e4");
        assert_eq!(row.2, 1000);

        // Equal ms => should NOT overwrite (strict >)
        upsert_variant_position_conn(&conn, fen_b, "sf", "c2c4", None, 1000).unwrap();

        let row2 = read_row(&conn, &key, "sf").unwrap();
        assert_eq!(row2.0, fen_a);
        assert_eq!(row2.1, "e2e4");
        assert_eq!(row2.2, 1000);
    }

    #[test]
    fn test_upsert_conflict_replaces_when_ms_is_higher_and_updates_fen() {
        let (_dir, conn) = open_temp_conn();

        let fen_a = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let fen_b = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 99"; // same key
        let key = fen_identity_key(fen_a).unwrap();

        upsert_variant_position_conn(&conn, fen_a, "sf", "e2e4", None, 1000).unwrap();
        upsert_variant_position_conn(&conn, fen_b, "sf", "d2d4", None, 1500).unwrap();

        let row = read_row(&conn, &key, "sf").unwrap();
        assert_eq!(row.0, fen_b, "fen should be updated to the latest (best ms) entry");
        assert_eq!(row.1, "d2d4");
        assert_eq!(row.2, 1500);

        let got = fetch_variant_position_conn(&conn, fen_a, "sf").unwrap().unwrap();
        assert_eq!(got.fen, fen_b);
        assert_eq!(got.recommended_move, "d2d4");
        assert_eq!(got.ms, 1500);
    }

    #[test]
    fn test_upsert_separates_by_engine() {
        let (_dir, conn) = open_temp_conn();

        let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

        upsert_variant_position_conn(&conn, fen, "sf", "e2e4", None, 1000).unwrap();
        upsert_variant_position_conn(&conn, fen, "lc0", "d2d4", None, 2000).unwrap();

        let a = fetch_variant_position_conn(&conn, fen, "sf").unwrap().unwrap();
        let b = fetch_variant_position_conn(&conn, fen, "lc0").unwrap().unwrap();

        assert_eq!(a.recommended_move, "e2e4");
        assert_eq!(b.recommended_move, "d2d4");
    }

    // -------------------------------------------------------------------------
    // Struct & serialization coverage
    // -------------------------------------------------------------------------

    #[test]
    fn test_variant_position_struct() {
        let pos = VariantPosition {
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string(),
            engine: "test_engine".to_string(),
            recommended_move: "e2e4".to_string(),
            engine_advantage: None,
            ms: 1000i64,
        };

        assert_eq!(pos.ms, 1000);
        assert_eq!(pos.recommended_move, "e2e4");
        assert_eq!(pos.engine, "test_engine");
    }

    #[test]
    fn test_variant_position_with_large_ms() {
        let pos = VariantPosition {
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string(),
            engine: "test_engine".to_string(),
            recommended_move: "e2e4".to_string(),
            engine_advantage: None,
            ms: i64::MAX,
        };

        assert_eq!(pos.ms, i64::MAX);
    }

    #[test]
    fn test_variant_position_serialization_roundtrip() {
        let pos = VariantPosition {
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string(),
            engine: "test_engine".to_string(),
            recommended_move: "e2e4".to_string(),
            engine_advantage: Some("+0.34 (e4)".to_string()),
            ms: 1000i64,
        };

        let json = serde_json::to_string(&pos).unwrap();
        assert!(json.contains("\"ms\":1000"));

        let deserialized: VariantPosition = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.ms, 1000);
        assert_eq!(deserialized.fen, pos.fen);
        assert_eq!(deserialized.engine, pos.engine);
        assert_eq!(deserialized.recommended_move, pos.recommended_move);
        assert_eq!(deserialized.engine_advantage, pos.engine_advantage);
    }
}
