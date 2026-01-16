use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{path::BaseDirectory, AppHandle, Manager};

use crate::error::{Error, Result};

const DB_FILENAME: &str = "analysis.db3";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AnalyzedGameEntry {
    pub profile_id: String,
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
    pub profile_id: String,
    pub game_id: String,
    pub accuracy: f64,
    pub acpl: f64,
    pub estimated_elo: Option<i64>,
}

fn normalize_game_id(game_id: &str) -> Option<&str> {
    let gid = game_id.trim();
    if gid.is_empty() {
        None
    } else {
        Some(gid)
    }
}

fn normalize_profile_id(profile_id: Option<String>) -> String {
    profile_id.unwrap_or_default().trim().to_string()
}

fn resolve_analysis_db_path(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .resolve(DB_FILENAME, BaseDirectory::AppData)
        .map_err(|e| Error::PackageManager(format!("Failed to resolve analysis DB path: {}", e)))
}

fn get_analysis_db(app: &AppHandle) -> Result<Connection> {
    let db_path = resolve_analysis_db_path(app)?;
    get_analysis_db_at_path(&db_path)
}

/// Internal helper to make DB creation/testable without needing AppHandle.
fn get_analysis_db_at_path(db_path: &Path) -> Result<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to create analysis DB directory: {}", e),
            ))
        })?;
    }

    let conn = Connection::open(db_path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<()> {
    // analysis.db3 is shared across profiles, so key analysis by (profile_id, game_id).
    //
    // Legacy note:
    // - Old schema used `game_id TEXT PRIMARY KEY` where game_id was an external identifier
    //   (Chess.com URL or Lichess game id). We migrate legacy rows into v2 under profile_id = ''
    //   and keep the old key in `legacy_game_key` for best-effort backwards compatibility.

    // Detect whether `game_analysis` already exists and whether it's legacy.
    let mut has_table = false;
    let mut has_profile_id = false;
    {
        let mut stmt = conn.prepare("PRAGMA table_info(game_analysis)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        for r in rows {
            has_table = true;
            let name = r?;
            if name.eq_ignore_ascii_case("profile_id") {
                has_profile_id = true;
            }
        }
    }

    if !has_table {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS game_analysis (
                profile_id TEXT NOT NULL,
                game_id TEXT NOT NULL,
                legacy_game_key TEXT,
                analyzed_pgn TEXT,
                accuracy REAL,
                acpl REAL,
                estimated_elo INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (profile_id, game_id)
            );

            CREATE INDEX IF NOT EXISTS idx_game_analysis_profile_estimated_elo
                ON game_analysis(profile_id, estimated_elo);

            CREATE INDEX IF NOT EXISTS idx_game_analysis_legacy_key
                ON game_analysis(legacy_game_key);
            "#,
        )?;
        return Ok(());
    }

    if !has_profile_id {
        // Legacy table exists: rebuild & migrate.
        conn.execute_batch(
            r#"
            BEGIN;
            ALTER TABLE game_analysis RENAME TO game_analysis_old;

            CREATE TABLE game_analysis (
                profile_id TEXT NOT NULL,
                game_id TEXT NOT NULL,
                legacy_game_key TEXT,
                analyzed_pgn TEXT,
                accuracy REAL,
                acpl REAL,
                estimated_elo INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (profile_id, game_id)
            );

            INSERT INTO game_analysis (
                profile_id, game_id, legacy_game_key, analyzed_pgn, accuracy, acpl, estimated_elo, created_at, updated_at
            )
            SELECT
                '', game_id, game_id, analyzed_pgn, accuracy, acpl, estimated_elo, created_at, updated_at
            FROM game_analysis_old;

            DROP TABLE game_analysis_old;

            CREATE INDEX IF NOT EXISTS idx_game_analysis_profile_estimated_elo
                ON game_analysis(profile_id, estimated_elo);

            CREATE INDEX IF NOT EXISTS idx_game_analysis_legacy_key
                ON game_analysis(legacy_game_key);

            COMMIT;
            "#,
        )?;
    } else {
        // Ensure indexes exist.
        conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_game_analysis_profile_estimated_elo
                ON game_analysis(profile_id, estimated_elo);
            CREATE INDEX IF NOT EXISTS idx_game_analysis_legacy_key
                ON game_analysis(legacy_game_key);
            "#,
        )?;
    }
    Ok(())
}

// -----------------------------
// Pure DB operations (testable)
// -----------------------------

fn set_analyzed_game_conn(
    conn: &Connection,
    profile_id: &str,
    game_id: &str,
    analyzed_pgn: &str,
) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO game_analysis (profile_id, game_id, analyzed_pgn, created_at, updated_at)
        VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(profile_id, game_id) DO UPDATE SET
            analyzed_pgn = excluded.analyzed_pgn,
            updated_at = CURRENT_TIMESTAMP
        "#,
        params![profile_id, game_id, analyzed_pgn],
    )?;
    Ok(())
}

fn get_analyzed_game_conn(conn: &Connection, profile_id: &str, game_id: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT analyzed_pgn FROM game_analysis WHERE profile_id = ?1 AND game_id = ?2 AND analyzed_pgn IS NOT NULL",
    )?;
    let res = stmt
        .query_row(params![profile_id, game_id], |row| row.get::<_, String>(0))
        .optional()?;
    Ok(res)
}

fn get_all_analyzed_games_conn(conn: &Connection, profile_id: &str) -> Result<Vec<AnalyzedGameEntry>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT profile_id, game_id, analyzed_pgn
        FROM game_analysis
        WHERE profile_id = ?1 AND analyzed_pgn IS NOT NULL
        "#,
    )?;
    let rows = stmt
        .query_map(params![profile_id], |row| {
            Ok(AnalyzedGameEntry {
                profile_id: row.get(0)?,
                game_id: row.get(1)?,
                analyzed_pgn: row.get(2)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn set_game_stats_conn(
    conn: &Connection,
    profile_id: &str,
    game_id: &str,
    stats: &StoredGameStats,
) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO game_analysis (profile_id, game_id, accuracy, acpl, estimated_elo, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(profile_id, game_id) DO UPDATE SET
            accuracy = excluded.accuracy,
            acpl = excluded.acpl,
            estimated_elo = excluded.estimated_elo,
            updated_at = CURRENT_TIMESTAMP
        "#,
        params![
            profile_id,
            game_id,
            stats.accuracy,
            stats.acpl,
            stats.estimated_elo
        ],
    )?;
    Ok(())
}

fn get_game_stats_conn(
    conn: &Connection,
    profile_id: &str,
    game_id: &str,
) -> Result<Option<StoredGameStats>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT accuracy, acpl, estimated_elo
        FROM game_analysis
        WHERE profile_id = ?1 AND game_id = ?2 AND accuracy IS NOT NULL AND acpl IS NOT NULL
        "#,
    )?;
    let res = stmt
        .query_row(params![profile_id, game_id], |row| {
            Ok(StoredGameStats {
                accuracy: row.get(0)?,
                acpl: row.get(1)?,
                estimated_elo: row.get(2)?,
            })
        })
        .optional()?;
    Ok(res)
}

fn get_game_stats_bulk_conn(
    conn: &Connection,
    profile_id: &str,
    game_ids: &[String],
) -> Result<Vec<GameStatsEntry>> {
    if game_ids.is_empty() {
        return Ok(vec![]);
    }

    // SQLite has a limit for bound variables; batch conservatively.
    const BATCH_SIZE: usize = 900;
    let mut out: Vec<GameStatsEntry> = Vec::new();

    for chunk in game_ids.chunks(BATCH_SIZE) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            r#"
            SELECT profile_id, game_id, accuracy, acpl, estimated_elo
            FROM game_analysis
            WHERE profile_id = ?1
              AND game_id IN ({})
              AND accuracy IS NOT NULL
              AND acpl IS NOT NULL
            "#,
            placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut params_vec: Vec<rusqlite::types::Value> = Vec::with_capacity(1 + chunk.len());
        params_vec.push(rusqlite::types::Value::from(profile_id.to_string()));
        for gid in chunk {
            params_vec.push(rusqlite::types::Value::from(gid.clone()));
        }
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params_vec.iter()), |row| {
                Ok(GameStatsEntry {
                    profile_id: row.get(0)?,
                    game_id: row.get(1)?,
                    accuracy: row.get(2)?,
                    acpl: row.get(3)?,
                    estimated_elo: row.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        out.extend(rows);
    }

    Ok(out)
}

fn get_analyzed_games_bulk_conn(
    conn: &Connection,
    profile_id: &str,
    game_ids: &[String],
) -> Result<Vec<AnalyzedGameEntry>> {
    if game_ids.is_empty() {
        return Ok(vec![]);
    }

    // analyzed_pgn entries can be large; keep batches smaller.
    const BATCH_SIZE: usize = 200;
    let mut out: Vec<AnalyzedGameEntry> = Vec::new();

    for chunk in game_ids.chunks(BATCH_SIZE) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            r#"
            SELECT profile_id, game_id, analyzed_pgn
            FROM game_analysis
            WHERE profile_id = ?1
              AND game_id IN ({})
              AND analyzed_pgn IS NOT NULL
            "#,
            placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut params_vec: Vec<rusqlite::types::Value> = Vec::with_capacity(1 + chunk.len());
        params_vec.push(rusqlite::types::Value::from(profile_id.to_string()));
        for gid in chunk {
            params_vec.push(rusqlite::types::Value::from(gid.clone()));
        }
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params_vec.iter()), |row| {
                Ok(AnalyzedGameEntry {
                    profile_id: row.get(0)?,
                    game_id: row.get(1)?,
                    analyzed_pgn: row.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        out.extend(rows);
    }

    Ok(out)
}

fn delete_entries_conn(conn: &Connection, profile_id: &str, game_ids: &[String]) -> Result<()> {
    if game_ids.is_empty() {
        return Ok(());
    }

    // SQLite has a limit on the number of variables per query; batch conservatively.
    const BATCH_SIZE: usize = 900;
    for chunk in game_ids.chunks(BATCH_SIZE) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "DELETE FROM game_analysis WHERE profile_id = ?1 AND game_id IN ({})",
            placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut params_vec: Vec<rusqlite::types::Value> = Vec::with_capacity(1 + chunk.len());
        params_vec.push(rusqlite::types::Value::from(profile_id.to_string()));
        for gid in chunk {
            params_vec.push(rusqlite::types::Value::from(gid.clone()));
        }
        stmt.execute(rusqlite::params_from_iter(params_vec.iter()))?;
    }

    Ok(())
}

fn clear_analyzed_pgns_conn(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE game_analysis SET analyzed_pgn = NULL, updated_at = CURRENT_TIMESTAMP",
        [],
    )?;
    Ok(())
}

// -----------------------------
// Tauri commands (thin wrappers)
// -----------------------------

#[tauri::command]
#[specta::specta]
pub fn analysis_db_set_analyzed_game(
    app: AppHandle,
    game_id: String,
    analyzed_pgn: String,
    profile_id: Option<String>,
) -> Result<()> {
    let Some(gid) = normalize_game_id(&game_id) else {
        return Ok(());
    };
    let pid = normalize_profile_id(profile_id);
    let conn = get_analysis_db(&app)?;
    set_analyzed_game_conn(&conn, &pid, gid, &analyzed_pgn)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_get_analyzed_game(
    app: AppHandle,
    game_id: String,
    profile_id: Option<String>,
) -> Result<Option<String>> {
    let Some(gid) = normalize_game_id(&game_id) else {
        return Ok(None);
    };
    let pid = normalize_profile_id(profile_id);
    let conn = get_analysis_db(&app)?;
    // Exact match first.
    if let Some(pgn) = get_analyzed_game_conn(&conn, &pid, gid)? {
        return Ok(Some(pgn));
    }
    // Backwards compatibility: allow looking up legacy entries stored under the empty profile id.
    if !pid.is_empty() {
        return get_analyzed_game_conn(&conn, "", gid);
    }
    Ok(None)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_get_all_analyzed_games(
    app: AppHandle,
    profile_id: Option<String>,
) -> Result<Vec<AnalyzedGameEntry>> {
    let pid = normalize_profile_id(profile_id);
    let conn = get_analysis_db(&app)?;
    get_all_analyzed_games_conn(&conn, &pid)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_set_game_stats(
    app: AppHandle,
    game_id: String,
    stats: StoredGameStats,
    profile_id: Option<String>,
) -> Result<()> {
    let Some(gid) = normalize_game_id(&game_id) else {
        return Ok(());
    };
    let pid = normalize_profile_id(profile_id);
    let conn = get_analysis_db(&app)?;
    set_game_stats_conn(&conn, &pid, gid, &stats)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_get_game_stats(
    app: AppHandle,
    game_id: String,
    profile_id: Option<String>,
) -> Result<Option<StoredGameStats>> {
    let Some(gid) = normalize_game_id(&game_id) else {
        return Ok(None);
    };
    let pid = normalize_profile_id(profile_id);
    let conn = get_analysis_db(&app)?;
    get_game_stats_conn(&conn, &pid, gid)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_get_game_stats_bulk(
    app: AppHandle,
    game_ids: Vec<String>,
    profile_id: Option<String>,
) -> Result<Vec<GameStatsEntry>> {
    if game_ids.is_empty() {
        return Ok(vec![]);
    }
    let pid = normalize_profile_id(profile_id);
    let conn = get_analysis_db(&app)?;
    get_game_stats_bulk_conn(&conn, &pid, &game_ids)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_get_analyzed_games_bulk(
    app: AppHandle,
    game_ids: Vec<String>,
    profile_id: Option<String>,
) -> Result<Vec<AnalyzedGameEntry>> {
    if game_ids.is_empty() {
        return Ok(vec![]);
    }
    let pid = normalize_profile_id(profile_id);
    let conn = get_analysis_db(&app)?;
    get_analyzed_games_bulk_conn(&conn, &pid, &game_ids)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_delete_entries(
    app: AppHandle,
    game_ids: Vec<String>,
    profile_id: Option<String>,
) -> Result<()> {
    if game_ids.is_empty() {
        return Ok(());
    }
    let pid = normalize_profile_id(profile_id);
    let conn = get_analysis_db(&app)?;
    delete_entries_conn(&conn, &pid, &game_ids)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_db_clear_analyzed_pgns(app: AppHandle) -> Result<()> {
    let conn = get_analysis_db(&app)?;
    clear_analyzed_pgns_conn(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_suffix() -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{}_{}", std::process::id(), nanos)
    }

    fn temp_db_path(test_name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("ocs_{}_{}_{}.db3", test_name, unique_suffix(), "analysis"));
        // best-effort cleanup if exists
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_file(p.with_extension("db3-wal"));
        let _ = std::fs::remove_file(p.with_extension("db3-shm"));
        p
    }

    fn cleanup_db_files(path: &Path) {
        let _ = std::fs::remove_file(path);
        // if WAL ever gets enabled elsewhere, remove those too
        let mut wal = path.to_path_buf();
        wal.set_extension(format!(
            "{}-wal",
            path.extension().and_then(|x| x.to_str()).unwrap_or("db3")
        ));
        let mut shm = path.to_path_buf();
        shm.set_extension(format!(
            "{}-shm",
            path.extension().and_then(|x| x.to_str()).unwrap_or("db3")
        ));
        let _ = std::fs::remove_file(wal);
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn schema_is_created() -> Result<()> {
        let path = temp_db_path("schema_is_created");
        let conn = get_analysis_db_at_path(&path)?;

        // Table exists
        let table_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='game_analysis'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(table_count, 1);

        // Indexes exist
        let idx_profile_stats: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_game_analysis_profile_estimated_elo'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(idx_profile_stats, 1);

        let idx_legacy_key: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_game_analysis_legacy_key'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(idx_legacy_key, 1);

        drop(conn);
        cleanup_db_files(&path);
        Ok(())
    }

    #[test]
    fn set_get_analyzed_game_roundtrip() -> Result<()> {
        let path = temp_db_path("set_get_analyzed_game_roundtrip");
        let conn = get_analysis_db_at_path(&path)?;

        set_analyzed_game_conn(&conn, "", "g1", "PGN_1")?;
        let res = get_analyzed_game_conn(&conn, "", "g1")?;
        assert_eq!(res.as_deref(), Some("PGN_1"));

        drop(conn);
        cleanup_db_files(&path);
        Ok(())
    }

    #[test]
    fn analyzed_game_upsert_updates_value() -> Result<()> {
        let path = temp_db_path("analyzed_game_upsert_updates_value");
        let conn = get_analysis_db_at_path(&path)?;

        set_analyzed_game_conn(&conn, "", "g1", "PGN_1")?;
        set_analyzed_game_conn(&conn, "", "g1", "PGN_2")?;
        let res = get_analyzed_game_conn(&conn, "", "g1")?;
        assert_eq!(res.as_deref(), Some("PGN_2"));

        drop(conn);
        cleanup_db_files(&path);
        Ok(())
    }

    #[test]
    fn normalize_game_id_works() {
        assert_eq!(normalize_game_id("  abc  "), Some("abc"));
        assert_eq!(normalize_game_id(""), None);
        assert_eq!(normalize_game_id("   "), None);
    }

    #[test]
    fn set_get_game_stats_roundtrip_some_and_none() -> Result<()> {
        let path = temp_db_path("set_get_game_stats_roundtrip_some_and_none");
        let conn = get_analysis_db_at_path(&path)?;

        let s1 = StoredGameStats {
            accuracy: 91.2,
            acpl: 23.0,
            estimated_elo: Some(1850),
        };
        set_game_stats_conn(&conn, "", "g1", &s1)?;
        let got1 = get_game_stats_conn(&conn, "", "g1")?.unwrap();
        assert!((got1.accuracy - 91.2).abs() < 1e-9);
        assert!((got1.acpl - 23.0).abs() < 1e-9);
        assert_eq!(got1.estimated_elo, Some(1850));

        let s2 = StoredGameStats {
            accuracy: 77.7,
            acpl: 45.0,
            estimated_elo: None,
        };
        set_game_stats_conn(&conn, "", "g2", &s2)?;
        let got2 = get_game_stats_conn(&conn, "", "g2")?.unwrap();
        assert!((got2.accuracy - 77.7).abs() < 1e-9);
        assert!((got2.acpl - 45.0).abs() < 1e-9);
        assert_eq!(got2.estimated_elo, None);

        drop(conn);
        cleanup_db_files(&path);
        Ok(())
    }

    #[test]
    fn set_stats_preserves_existing_analyzed_pgn() -> Result<()> {
        let path = temp_db_path("set_stats_preserves_existing_analyzed_pgn");
        let conn = get_analysis_db_at_path(&path)?;

        set_analyzed_game_conn(&conn, "", "g1", "PGN_KEEP")?;
        let stats = StoredGameStats {
            accuracy: 99.0,
            acpl: 5.0,
            estimated_elo: Some(2400),
        };
        set_game_stats_conn(&conn, "", "g1", &stats)?;

        let pgn = get_analyzed_game_conn(&conn, "", "g1")?;
        assert_eq!(pgn.as_deref(), Some("PGN_KEEP"));

        drop(conn);
        cleanup_db_files(&path);
        Ok(())
    }

    #[test]
    fn get_all_analyzed_games_only_returns_non_null() -> Result<()> {
        let path = temp_db_path("get_all_analyzed_games_only_returns_non_null");
        let conn = get_analysis_db_at_path(&path)?;

        set_analyzed_game_conn(&conn, "", "g1", "PGN_1")?;
        // insert stats only, analyzed_pgn stays NULL
        let stats = StoredGameStats {
            accuracy: 50.0,
            acpl: 100.0,
            estimated_elo: None,
        };
        set_game_stats_conn(&conn, "", "g2", &stats)?;

        let all = get_all_analyzed_games_conn(&conn, "")?;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].game_id, "g1");
        assert_eq!(all[0].analyzed_pgn, "PGN_1");

        drop(conn);
        cleanup_db_files(&path);
        Ok(())
    }

    #[test]
    fn bulk_stats_works_across_batch_boundary() -> Result<()> {
        let path = temp_db_path("bulk_stats_works_across_batch_boundary");
        let conn = get_analysis_db_at_path(&path)?;

        // Force batching (BATCH_SIZE=900)
        let total = 901usize;
        let mut ids: Vec<String> = Vec::with_capacity(total);

        for i in 0..total {
            let id = format!("g{}", i);
            ids.push(id.clone());
            let s = StoredGameStats {
                accuracy: i as f64,
                acpl: (i as f64) + 0.5,
                estimated_elo: if i % 2 == 0 { Some(i as i64) } else { None },
            };
            set_game_stats_conn(&conn, "", &id, &s)?;
        }

        let rows = get_game_stats_bulk_conn(&conn, "", &ids)?;
        assert_eq!(rows.len(), total);

        // Convert to map for easy assertions (order not guaranteed)
        let map: HashMap<String, GameStatsEntry> =
            rows.into_iter().map(|e| (e.game_id.clone(), e)).collect();

        let e0 = map.get("g0").unwrap();
        assert!((e0.accuracy - 0.0).abs() < 1e-9);
        assert!((e0.acpl - 0.5).abs() < 1e-9);
        assert_eq!(e0.estimated_elo, Some(0));

        let e900 = map.get("g900").unwrap();
        assert!((e900.accuracy - 900.0).abs() < 1e-9);
        assert!((e900.acpl - 900.5).abs() < 1e-9);
        assert_eq!(e900.estimated_elo, Some(900));

        let e1 = map.get("g1").unwrap();
        assert_eq!(e1.estimated_elo, None);

        drop(conn);
        cleanup_db_files(&path);
        Ok(())
    }

    #[test]
    fn bulk_analyzed_games_works_across_batch_boundary() -> Result<()> {
        let path = temp_db_path("bulk_analyzed_games_works_across_batch_boundary");
        let conn = get_analysis_db_at_path(&path)?;

        // Force batching (BATCH_SIZE=200)
        let total = 201usize;
        let mut ids: Vec<String> = Vec::with_capacity(total);

        for i in 0..total {
            let id = format!("g{}", i);
            ids.push(id.clone());
            set_analyzed_game_conn(&conn, "", &id, &format!("PGN_{}", i))?;
        }

        let rows = get_analyzed_games_bulk_conn(&conn, "", &ids)?;
        assert_eq!(rows.len(), total);

        let map: HashMap<String, String> = rows
            .into_iter()
            .map(|e| (e.game_id, e.analyzed_pgn))
            .collect();

        assert_eq!(map.get("g0").map(|s| s.as_str()), Some("PGN_0"));
        assert_eq!(map.get("g200").map(|s| s.as_str()), Some("PGN_200"));

        drop(conn);
        cleanup_db_files(&path);
        Ok(())
    }

    #[test]
    fn delete_entries_works_across_batch_boundary() -> Result<()> {
        let path = temp_db_path("delete_entries_works_across_batch_boundary");
        let conn = get_analysis_db_at_path(&path)?;

        // Create 901 entries (BATCH_SIZE=900)
        let total = 901usize;
        let mut ids: Vec<String> = Vec::with_capacity(total);
        for i in 0..total {
            let id = format!("g{}", i);
            ids.push(id.clone());
            set_analyzed_game_conn(&conn, "", &id, "PGN")?;
        }

        let before: i64 = conn.query_row("SELECT COUNT(*) FROM game_analysis", [], |r| r.get(0))?;
        assert_eq!(before as usize, total);

        delete_entries_conn(&conn, "", &ids)?;

        let after: i64 = conn.query_row("SELECT COUNT(*) FROM game_analysis", [], |r| r.get(0))?;
        assert_eq!(after, 0);

        drop(conn);
        cleanup_db_files(&path);
        Ok(())
    }

    #[test]
    fn clear_analyzed_pgns_sets_only_pgn_to_null() -> Result<()> {
        let path = temp_db_path("clear_analyzed_pgns_sets_only_pgn_to_null");
        let conn = get_analysis_db_at_path(&path)?;

        set_analyzed_game_conn(&conn, "", "g1", "PGN_1")?;
        set_analyzed_game_conn(&conn, "", "g2", "PGN_2")?;
        let stats = StoredGameStats {
            accuracy: 88.8,
            acpl: 12.3,
            estimated_elo: Some(2000),
        };
        set_game_stats_conn(&conn, "", "g1", &stats)?;

        clear_analyzed_pgns_conn(&conn)?;

        // analyzed_pgn is cleared
        assert_eq!(get_analyzed_game_conn(&conn, "", "g1")?, None);
        assert_eq!(get_analyzed_game_conn(&conn, "", "g2")?, None);

        // stats remain
        let got = get_game_stats_conn(&conn, "", "g1")?.unwrap();
        assert!((got.accuracy - 88.8).abs() < 1e-9);
        assert!((got.acpl - 12.3).abs() < 1e-9);
        assert_eq!(got.estimated_elo, Some(2000));

        // all analyzed list now empty
        let all = get_all_analyzed_games_conn(&conn, "")?;
        assert!(all.is_empty());

        drop(conn);
        cleanup_db_files(&path);
        Ok(())
    }

    #[test]
    fn get_game_stats_returns_none_when_missing_or_partial() -> Result<()> {
        let path = temp_db_path("get_game_stats_returns_none_when_missing_or_partial");
        let conn = get_analysis_db_at_path(&path)?;

        // Missing
        assert!(get_game_stats_conn(&conn, "", "missing")?.is_none());

        // Only analyzed_pgn, no stats
        set_analyzed_game_conn(&conn, "", "g1", "PGN")?;
        assert!(get_game_stats_conn(&conn, "", "g1")?.is_none());

        drop(conn);
        cleanup_db_files(&path);
        Ok(())
    }
}
