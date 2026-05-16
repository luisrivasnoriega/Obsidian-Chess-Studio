use std::{path::PathBuf, time::Duration};

use diesel::connection::SimpleConnection;
use diesel::sql_query;
use diesel::RunQueryDsl;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::error::Error;
use crate::AppState;

use super::{get_db_or_create, ConnectionOptions, JournalMode};

const SYNC_STATE_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS account_sync_state (
  account_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  cursor_until_ms INTEGER,
  since_ms INTEGER,
  mode TEXT NOT NULL DEFAULT 'incremental',
  total_batches INTEGER NOT NULL DEFAULT 0,
  completed_batches INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(account_key, platform)
);

CREATE TABLE IF NOT EXISTS account_sync_batches (
  account_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  completed_at_ms INTEGER NOT NULL,
  PRIMARY KEY(account_key, platform, batch_id)
);
"#;

fn ensure_sync_schema(db: &mut diesel::SqliteConnection) -> Result<(), Error> {
    db.batch_execute(SYNC_STATE_SCHEMA)?;
    // Backwards-compatible schema upgrade for existing databases.
    // Ignore errors (e.g., "duplicate column name") when the column already exists.
    let _ = sql_query("ALTER TABLE account_sync_state ADD COLUMN since_ms INTEGER").execute(db);
    let _ = sql_query(
        "ALTER TABLE account_sync_state ADD COLUMN mode TEXT NOT NULL DEFAULT 'incremental'",
    )
    .execute(db);
    Ok(())
}

fn default_mode() -> String {
    "incremental".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct AccountSyncState {
    pub account_key: String,
    pub platform: String,
    pub cursor_until_ms: Option<i64>,
    #[serde(default)]
    pub since_ms: Option<i64>,
    #[serde(default = "default_mode")]
    pub mode: String,
    pub total_batches: i64,
    pub completed_batches: i64,
    pub running: bool,
    pub updated_at_ms: i64,
}

#[derive(diesel::QueryableByName)]
struct AccountSyncStateRow {
    #[diesel(sql_type = diesel::sql_types::Text, column_name = "account_key")]
    account_key: String,
    #[diesel(sql_type = diesel::sql_types::Text, column_name = "platform")]
    platform: String,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::BigInt>, column_name = "cursor_until_ms")]
    cursor_until_ms: Option<i64>,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::BigInt>, column_name = "since_ms")]
    since_ms: Option<i64>,
    #[diesel(sql_type = diesel::sql_types::Text, column_name = "mode")]
    mode: String,
    #[diesel(sql_type = diesel::sql_types::BigInt, column_name = "total_batches")]
    total_batches: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt, column_name = "completed_batches")]
    completed_batches: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt, column_name = "running")]
    running: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt, column_name = "updated_at_ms")]
    updated_at_ms: i64,
}

impl From<AccountSyncStateRow> for AccountSyncState {
    fn from(row: AccountSyncStateRow) -> Self {
        Self {
            account_key: row.account_key,
            platform: row.platform,
            cursor_until_ms: row.cursor_until_ms,
            since_ms: row.since_ms,
            mode: row.mode,
            total_batches: row.total_batches,
            completed_batches: row.completed_batches,
            running: row.running != 0,
            updated_at_ms: row.updated_at_ms,
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_account_sync_state(
    db_path: PathBuf,
    account_key: String,
    platform: String,
    state: State<'_, AppState>,
) -> Result<Option<AccountSyncState>, Error> {
    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions {
            enable_foreign_keys: false,
            busy_timeout: Some(Duration::from_secs(30)),
            journal_mode: JournalMode::Preserve,
        },
    )?;
    ensure_sync_schema(db)?;

    let rows: Vec<AccountSyncStateRow> = sql_query(
        "SELECT account_key, platform, cursor_until_ms, since_ms, mode, total_batches, completed_batches, running, updated_at_ms \
         FROM account_sync_state WHERE account_key = ?1 AND platform = ?2",
    )
    .bind::<diesel::sql_types::Text, _>(account_key)
    .bind::<diesel::sql_types::Text, _>(platform)
    .load(db)?;

    Ok(rows.into_iter().next().map(Into::into))
}

#[tauri::command]
#[specta::specta]
pub async fn upsert_account_sync_state(
    db_path: PathBuf,
    sync_state: AccountSyncState,
    state: State<'_, AppState>,
) -> Result<(), Error> {
    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions {
            enable_foreign_keys: false,
            busy_timeout: Some(Duration::from_secs(30)),
            journal_mode: JournalMode::Preserve,
        },
    )?;
    ensure_sync_schema(db)?;

    let running_val: i64 = if sync_state.running { 1 } else { 0 };

    // SQLite upsert by composite primary key.
    sql_query(
        "INSERT INTO account_sync_state (account_key, platform, cursor_until_ms, since_ms, mode, total_batches, completed_batches, running, updated_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
         ON CONFLICT(account_key, platform) DO UPDATE SET \
           cursor_until_ms=excluded.cursor_until_ms, \
           since_ms=excluded.since_ms, \
           mode=excluded.mode, \
           total_batches=excluded.total_batches, \
           completed_batches=excluded.completed_batches, \
           running=excluded.running, \
           updated_at_ms=excluded.updated_at_ms",
    )
    .bind::<diesel::sql_types::Text, _>(sync_state.account_key)
    .bind::<diesel::sql_types::Text, _>(sync_state.platform)
    .bind::<diesel::sql_types::Nullable<diesel::sql_types::BigInt>, _>(sync_state.cursor_until_ms)
    .bind::<diesel::sql_types::Nullable<diesel::sql_types::BigInt>, _>(sync_state.since_ms)
    .bind::<diesel::sql_types::Text, _>(sync_state.mode)
    .bind::<diesel::sql_types::BigInt, _>(sync_state.total_batches)
    .bind::<diesel::sql_types::BigInt, _>(sync_state.completed_batches)
    .bind::<diesel::sql_types::BigInt, _>(running_val)
    .bind::<diesel::sql_types::BigInt, _>(sync_state.updated_at_ms)
    .execute(db)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn mark_account_sync_batch_complete(
    db_path: PathBuf,
    account_key: String,
    platform: String,
    batch_id: String,
    completed_at_ms: i64,
    state: State<'_, AppState>,
) -> Result<(), Error> {
    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions {
            enable_foreign_keys: false,
            busy_timeout: Some(Duration::from_secs(30)),
            journal_mode: JournalMode::Preserve,
        },
    )?;
    ensure_sync_schema(db)?;

    sql_query(
        "INSERT OR IGNORE INTO account_sync_batches (account_key, platform, batch_id, completed_at_ms) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind::<diesel::sql_types::Text, _>(account_key)
    .bind::<diesel::sql_types::Text, _>(platform)
    .bind::<diesel::sql_types::Text, _>(batch_id)
    .bind::<diesel::sql_types::BigInt, _>(completed_at_ms)
    .execute(db)?;

    Ok(())
}

#[derive(diesel::QueryableByName)]
struct BatchRow {
    #[diesel(sql_type = diesel::sql_types::Text, column_name = "batch_id")]
    batch_id: String,
}

#[tauri::command]
#[specta::specta]
pub async fn list_account_sync_completed_batches(
    db_path: PathBuf,
    account_key: String,
    platform: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, Error> {
    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions {
            enable_foreign_keys: false,
            busy_timeout: Some(Duration::from_secs(30)),
            journal_mode: JournalMode::Preserve,
        },
    )?;
    ensure_sync_schema(db)?;

    let rows: Vec<BatchRow> = sql_query(
        "SELECT batch_id FROM account_sync_batches WHERE account_key = ?1 AND platform = ?2",
    )
    .bind::<diesel::sql_types::Text, _>(account_key)
    .bind::<diesel::sql_types::Text, _>(platform)
    .load(db)?;

    Ok(rows.into_iter().map(|r| r.batch_id).collect())
}
