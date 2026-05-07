mod bulk_insert;
mod analysis_stats;
mod core;
pub(crate) mod encoding;
mod models;
mod ops;
pub mod pgn;
mod player_stats;
mod player_style;
mod position_cache;
mod schema;
mod search;
mod sync_state;
mod online_sync;
mod weakness_model;
pub use sync_state::*;
pub use online_sync::{get_account_import_stats, sync_account_games_to_profile_db, AccountSyncProgress};

use crate::{
    db::{encoding::extract_main_line_moves, models::*, ops::*, schema::*},
    error::{Error, Result},
    opening::get_opening_from_setup,
    AppState,
};
use chrono::{NaiveDate, SecondsFormat, TimeZone, Utc};
use dashmap::DashMap;
use diesel::{
    connection::{DefaultLoadingMode, SimpleConnection},
    insert_into,
    prelude::*,
    r2d2::{ConnectionManager, Pool},
    sql_query,
    sql_types::{Integer, Text},
};
use pgn::{GameTree, Importer, TempGame};
use pgn_reader::BufferedReader;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, Board, CastlingMode, Chess, EnPassantMode, FromSetup, Piece, Position};
use specta::Type;
use std::io::{BufWriter, Seek, Write};
use std::{
    fs::{File, OpenOptions},
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
use tauri::{path::BaseDirectory, Manager};
use tauri::{Emitter, State};
use zip::{write::SimpleFileOptions as ZipFileOptions, CompressionMethod, ZipWriter};

use tauri_specta::Event as _;
use std::time::{SystemTime, UNIX_EPOCH};
use regex::Regex;

#[allow(unused_imports)]
pub use self::models::{NewEvent, NewGame, NewPlayer, NewSite, NormalizedGame, Outcome, Puzzle};
#[allow(unused_imports)]
pub use self::player_stats::{
    aggregate_openings, calculate_elo_buckets, calculate_elo_domain, calculate_earliest_date,
    calculate_rating_timeline, compute_player_sidebar_model, extract_game_stats, fill_missing_months, filter_games,
    get_score_rate, merge_site_stats_data, merge_years, sort_openings,
    DateRange, EloBucket, EloDomain, GameStats, MonthData, OpeningStats, PlatformFilter,
    PlayerSidebarEloBlock, PlayerSidebarEloRow, PlayerSidebarModel, PlayerStatsFilters,
    PlayerStyleLabel, PlatformInfo, RatingDataPoint, RatingTimeline, TimeControlFilter,
};
pub use self::position_cache::{
    clear_position_cache, get_cached_position, is_position_cached, save_position_cache,
};
#[allow(unused_imports)]
pub use self::weakness_model::{
    build_weakness_snapshot_v1, compose_profile_weakness_model, ensure_profile_weakness_tables,
    get_weakness_evidence, get_weakness_signals, replace_weakness_snapshot,
    upsert_weakness_game_features, ProfileWeaknessModel, ProfileWeaknessSignal,
    ProfileWeaknessSignalEvidence, ProfileWeaknessSignalsByColor, WeaknessAggregationInputRow,
    WeaknessEvidenceRow, WeaknessEvidenceUpsert, WeaknessGameFeaturesUpsert,
    WeaknessSignalSnapshotRow, WeaknessSignalSnapshotUpsert, WeaknessSnapshotBuildResult,
};
pub use self::schema::puzzles;
pub use self::search::{
    is_position_in_db, search_position, PositionQuery, PositionQueryJs, PositionStats,
};

pub(crate) const INDEXES_SQL: &str = include_str!("../../../database/queries/indexes/create_indexes.sql");
pub(crate) const ADDITIONAL_INDEXES_SQL: &str = include_str!("../../../database/queries/indexes/create_additional_indexes.sql");
const DELETE_INDEXES_SQL: &str =
    include_str!("../../../database/queries/indexes/delete_indexes.sql");
pub(crate) const DROP_INDEXES_FOR_BULK_SQL: &str =
    include_str!("../../../database/queries/indexes/drop_indexes_for_bulk.sql");

// PRAGMA queries
const PRAGMA_JOURNAL_MODE_DELETE: &str =
    include_str!("../../../database/pragmas/journal_mode_delete.sql");
const PRAGMA_JOURNAL_MODE_OFF: &str =
    include_str!("../../../database/pragmas/journal_mode_off.sql");
pub(crate) const PRAGMA_FOREIGN_KEYS_ON: &str = include_str!("../../../database/pragmas/foreign_keys_on.sql");
const PRAGMA_BUSY_TIMEOUT: &str = include_str!("../../../database/pragmas/busy_timeout.sql");
pub(crate) const PRAGMA_PERFORMANCE: &str = include_str!("../../../database/pragmas/performance_pragmas.sql");
pub(crate) const PRAGMA_BULK_INSERT: &str = include_str!("../../../database/pragmas/bulk_insert_pragmas.sql");

// Games queries
const GAMES_CHECK_INDEXES: &str = include_str!("../../../database/queries/games/check_indexes.sql");
const GAMES_DELETE_DUPLICATES: &str =
    include_str!("../../../database/queries/games/delete_duplicates.sql");
const GAMES_CREATE_DEDUPE_UNIQUE_INDEX: &str =
    include_str!("../../../database/queries/games/create_dedupe_unique_index.sql");

fn ensure_events_columns(conn: &mut SqliteConnection) -> std::result::Result<(), diesel::result::Error> {
    #[derive(QueryableByName)]
    struct ColumnInfo {
        #[diesel(sql_type = Text, column_name = "name")]
        name: String,
    }

    let columns: Vec<ColumnInfo> = match sql_query("PRAGMA table_info('Events')").load(conn) {
        Ok(cols) => cols,
        Err(_) => return Ok(()),
    };

    let has_column = |column_name: &str| -> bool {
        columns
            .iter()
            .any(|c| c.name.eq_ignore_ascii_case(column_name))
    };

    if !has_column("EventType") {
        conn.batch_execute("ALTER TABLE Events ADD COLUMN EventType TEXT")?;
    }
    if !has_column("Location") {
        conn.batch_execute("ALTER TABLE Events ADD COLUMN Location TEXT")?;
    }
    if !has_column("StartDate") {
        conn.batch_execute("ALTER TABLE Events ADD COLUMN StartDate TEXT")?;
    }
    if !has_column("EndDate") {
        conn.batch_execute("ALTER TABLE Events ADD COLUMN EndDate TEXT")?;
    }
    if !has_column("TimeControl") {
        conn.batch_execute("ALTER TABLE Events ADD COLUMN TimeControl TEXT")?;
    }

    Ok(())
}

fn ensure_games_columns(conn: &mut SqliteConnection) -> std::result::Result<(), diesel::result::Error> {
    #[derive(QueryableByName)]
    struct ColumnInfo {
        #[diesel(sql_type = Text, column_name = "name")]
        name: String,
    }

    let columns: Vec<ColumnInfo> = match sql_query("PRAGMA table_info('Games')").load(conn) {
        Ok(cols) => cols,
        Err(_) => return Ok(()),
    };

    let has_column = |column_name: &str| -> bool {
        columns
            .iter()
            .any(|c| c.name.eq_ignore_ascii_case(column_name))
    };

    if !has_column("Termination") {
        conn.batch_execute("ALTER TABLE Games ADD COLUMN Termination TEXT")?;
    }

    Ok(())
}

fn sqlite_table_exists(conn: &mut SqliteConnection, table_name: &str) -> std::result::Result<bool, diesel::result::Error> {
    #[derive(QueryableByName)]
    struct ExistsRow {
        #[diesel(sql_type = Integer, column_name = "exists_flag")]
        exists_flag: i32,
    }

    let escaped = table_name.replace('\'', "''");
    let sql = format!(
        "SELECT CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='{escaped}') THEN 1 ELSE 0 END AS exists_flag"
    );
    let exists = sql_query(sql).get_result::<ExistsRow>(conn)?.exists_flag != 0;
    Ok(exists)
}

const WHITE_PAWN: Piece = Piece {
    color: shakmaty::Color::White,
    role: shakmaty::Role::Pawn,
};

const BLACK_PAWN: Piece = Piece {
    color: shakmaty::Color::Black,
    role: shakmaty::Role::Pawn,
};

/// Returns the bit representation of the pawns on the second and seventh rank
/// of the given board.
pub(crate) fn get_pawn_home(board: &Board) -> u16 {
    let white_pawns = board.by_piece(WHITE_PAWN);
    let black_pawns = board.by_piece(BLACK_PAWN);
    let second_rank_pawns = (white_pawns.0 >> 8) as u8;
    let seventh_rank_pawns = (black_pawns.0 >> 48) as u8;
    (second_rank_pawns as u16) | ((seventh_rank_pawns as u16) << 8)
}

#[derive(Debug)]
pub enum JournalMode {
    Delete,
    Off,
}

#[derive(Debug)]
pub struct ConnectionOptions {
    pub journal_mode: JournalMode,
    pub enable_foreign_keys: bool,
    pub busy_timeout: Option<Duration>,
}

impl Default for ConnectionOptions {
    fn default() -> Self {
        Self {
            journal_mode: JournalMode::Delete,
            enable_foreign_keys: true,
            busy_timeout: Some(Duration::from_secs(60)), // OPTIMIZED: Increased from 30s to 60s for heavy queries
        }
    }
}

impl diesel::r2d2::CustomizeConnection<SqliteConnection, diesel::r2d2::Error>
    for ConnectionOptions
{
    fn on_acquire(
        &self,
        conn: &mut SqliteConnection,
    ) -> std::result::Result<(), diesel::r2d2::Error> {
        (|| {
            // FIXED: Check if tables exist before applying performance pragmas
            // This prevents errors when database is being initialized
            let tables_exist = diesel::sql_query(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='Players' LIMIT 1",
            )
            .execute(conn)
            .is_ok();

            // Only apply performance PRAGMAs if database is already initialized
            if tables_exist {
                let _ = ensure_events_columns(conn);
                let _ = ensure_games_columns(conn);
                conn.batch_execute(PRAGMA_PERFORMANCE)?;
            }

            match self.journal_mode {
                JournalMode::Delete => conn.batch_execute(PRAGMA_JOURNAL_MODE_DELETE)?,
                JournalMode::Off => conn.batch_execute(PRAGMA_JOURNAL_MODE_OFF)?,
            }
            if self.enable_foreign_keys {
                conn.batch_execute(PRAGMA_FOREIGN_KEYS_ON)?;
            }
            if let Some(d) = self.busy_timeout {
                conn.batch_execute(
                    &PRAGMA_BUSY_TIMEOUT.replace("{0}", &d.as_millis().to_string()),
                )?;
            }
            Ok(())
        })()
        .map_err(diesel::r2d2::Error::QueryError)
    }
}

fn get_db_or_create(
    state: &State<AppState>,
    db_path: &str,
    options: ConnectionOptions,
) -> Result<diesel::r2d2::PooledConnection<diesel::r2d2::ConnectionManager<diesel::SqliteConnection>>>
{
    fn is_malformed_sqlite_message(msg: &str) -> bool {
        let m = msg.to_lowercase();
        m.contains("database disk image is malformed") || m.contains("file is not a database")
    }

    if let Some(pool) = state.connection_pool.get(db_path) {
        match pool.clone().get() {
            Ok(conn) => return Ok(conn),
            Err(e) => {
                // If the pool can no longer create connections (corrupted DB, interrupted download, etc),
                // drop it so future calls fail fast without repeatedly retrying for a long time.
                let _ = state.connection_pool.remove(db_path);
                let msg = e.to_string();
                if is_malformed_sqlite_message(&msg) {
                    let _ = std::fs::remove_file(db_path);
                    let _ = std::fs::remove_file(format!("{db_path}.partial"));
                    return Err(Error::PackageManager(
                        "Corrupted database detected and removed".to_string(),
                    ));
                }
                return Err(e.into());
            }
        }
    }

    // Build the pool, but only cache it after we successfully acquire a connection.
    // This prevents "poisoning" the cache with a pool that can't create connections
    // (e.g. partially downloaded / corrupted SQLite files).
    let pool = Pool::builder()
        .max_size(32) // OPTIMIZED: Increased from 16 to 32 for better concurrency
        .min_idle(Some(4)) // OPTIMIZED: Keep minimum connections ready
        .connection_timeout(Duration::from_secs(30))
        .connection_customizer(Box::new(options))
        .build(ConnectionManager::<SqliteConnection>::new(db_path))?;

    let conn = pool.get()?;
    state.connection_pool.insert(db_path.to_string(), pool);
    Ok(conn)
}

pub fn insert_to_db_with_event_override(
    db: &mut SqliteConnection,
    game: &TempGame,
    event_id_override: i32,
    preferred_site_name: Option<&str>,
    preferred_time_control: Option<&str>,
) -> Result<bool> {
    let pawn_home = get_pawn_home(game.position.board());

    let white_id = match game
        .white_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != "?")
    {
        Some(name) => create_player(db, name)?.id,
        None => create_player(db, "Unknown")?.id,
    };

    let black_id = match game
        .black_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != "?")
    {
        Some(name) => create_player(db, name)?.id,
        None => create_player(db, "Unknown")?.id,
    };

    let event_id = if event_id_override > 0 {
        event_id_override
    } else if let Some(name) = game
        .event_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != "?")
    {
        create_event(db, name)?.id
    } else {
        create_event(db, "Unknown")?.id
    };

    let site_id = if let Some(name) = preferred_site_name.map(str::trim).filter(|value| !value.is_empty()) {
        create_site(db, name)?.id
    } else if let Some(name) = &game.site_name {
        let trimmed = name.trim();
        if trimmed.is_empty() || trimmed == "?" {
            create_site(db, "OTB")?.id
        } else {
            create_site(db, trimmed)?.id
        }
    } else {
        create_site(db, "OTB")?.id
    };

    let ply_count = game.tree.count_main_line_moves() as i32;
    let final_material = pgn::get_material_count(game.position.board());
    let minimal_white_material = game.material_count.white.min(final_material.white) as i32;
    let minimal_black_material = game.material_count.black.min(final_material.black) as i32;

    let date = game
        .date
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "?" && !value.contains('?'));
    let round = game
        .round
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "?");
    let result = match game.result.as_deref().map(str::trim) {
        Some("1-0") => Some("1-0"),
        Some("0-1") => Some("0-1"),
        Some("1/2-1/2") => Some("1/2-1/2"),
        Some("*") | Some("?") | Some("") | None => Some("*"),
        // Normalize any unknown/non-standard marker to PGN unknown result.
        Some(_) => Some("*"),
    };
    let time_control = preferred_time_control
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "?")
        .or_else(|| {
            game.time_control
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty() && *value != "?")
        });

    let new_game = NewGame {
        white_id,
        black_id,
        ply_count,
        eco: game.eco.as_deref(),
        round,
        white_elo: game.white_elo,
        black_elo: game.black_elo,
        white_material: minimal_white_material,
        black_material: minimal_black_material,
        date,
        time: game.time.as_deref(),
        time_control,
        site_id,
        event_id,
        fen: game.fen.as_deref(),
        result,
        termination: game.termination.as_deref(),
        moves: game.moves.as_slice(),
        pawn_home: pawn_home as i32,
    };

    core::add_game(db, new_game)
}

fn normalize_pgn_for_import(pgn: &str) -> String {
    let mut normalized = pgn.replace("\r\n", "\n").replace('\r', "\n");

    // Normalize non-standard result headers used by some apps.
    let result_header_re = Regex::new(r#"(?m)^\[Result\s+"(?:\?|\s*)"\s*\]\s*$"#)
        .expect("valid result-header regex");
    normalized = result_header_re
        .replace_all(&normalized, r#"[Result "*"]"#)
        .into_owned();

    // Split into game-like chunks by [Event ...] boundaries when present.
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in normalized.lines() {
        if line.starts_with("[Event ") && !current.trim().is_empty() {
            chunks.push(current.trim().to_string());
            current.clear();
        }

        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(line);
    }
    if !current.trim().is_empty() {
        chunks.push(current.trim().to_string());
    }

    if chunks.is_empty() {
        chunks.push(normalized.trim().to_string());
    }

    // Ensure each game has a termination marker in movetext.
    let termination_re = Regex::new(r#"(?:1-0|0-1|1/2-1/2|\*)\s*$"#)
        .expect("valid pgn-termination regex");

    let normalized_chunks = chunks
        .into_iter()
        .map(|mut chunk| {
            if !termination_re.is_match(chunk.trim_end()) {
                if !chunk.ends_with('\n') {
                    chunk.push('\n');
                }
                chunk.push('*');
            }
            chunk
        })
        .collect::<Vec<_>>();

    normalized_chunks.join("\n\n")
}

fn ensure_db_initialized(db: &mut SqliteConnection) -> Result<()> {
    #[derive(QueryableByName)]
    struct TableInfo {
        #[diesel(sql_type = Text, column_name = "name")]
        _name: String,
    }

    let tables_exist = {
        let result: std::result::Result<Vec<TableInfo>, _> = sql_query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='Players' LIMIT 1",
        )
        .load(db);
        result.is_ok() && !result.unwrap().is_empty()
    };

    if !tables_exist {
        core::init_db(db, "Profile Database", "Profile database")?;
        // Ensure dedupe protections are present for future INSERT OR IGNORE behavior.
        db.batch_execute(GAMES_DELETE_DUPLICATES)?;
        db.batch_execute(GAMES_CREATE_DEDUPE_UNIQUE_INDEX)?;
    } else {
        // Some legacy/partial profile DBs can have Players but miss Info.
        // Ensure metadata table exists so profile queries never fail with
        // "no such table: info".
        ensure_info_table(db)?;
    }

    // If a previous version created Players as WITHOUT ROWID, inserts that omit ID will fail.
    // Migrate it back to a rowid table in-place (keeps existing data).
    ensure_players_rowid_table(db)?;
    let _ = ensure_games_columns(db);

    // Profile databases store additional computed/derived stats for analyzed games.
    // This is safe to run on any DB file (CREATE TABLE IF NOT EXISTS), but primarily targets profiles.
    analysis_stats::ensure_profile_analysis_tables(db)?;
    weakness_model::ensure_profile_weakness_tables(db)?;

    // Keep profile DB titles descriptive whenever we can infer a profile/player name.
    // This upgrades legacy DBs that still have generic titles like "Profile Database".
    let current_title: Option<String> = info::table
        .filter(info::name.eq("Title"))
        .select(info::value)
        .first::<Option<String>>(db)
        .optional()?
        .flatten()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    let profile_player_name: Option<String> = info::table
        .filter(info::name.eq("ProfilePlayerName"))
        .select(info::value)
        .first::<Option<String>>(db)
        .optional()?
        .flatten()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    let is_generic_title = current_title
        .as_deref()
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            normalized.is_empty()
                || normalized == "profile database"
                || normalized == "profile"
                || normalized == "untitled"
        })
        .unwrap_or(true);

    if is_generic_title {
        if let Some(profile_name) = profile_player_name {
            upsert_info_value(db, "Title", &profile_name)?;
        }
    }

    Ok(())
}

fn ensure_info_table(db: &mut SqliteConnection) -> Result<()> {
    sql_query(
        "CREATE TABLE IF NOT EXISTS Info (
            Name TEXT PRIMARY KEY NOT NULL,
            Value TEXT
        ) WITHOUT ROWID",
    )
    .execute(db)?;
    Ok(())
}

fn ensure_players_rowid_table(db: &mut SqliteConnection) -> Result<()> {
    #[derive(QueryableByName)]
    struct SqlRow {
        #[diesel(sql_type = Text, column_name = "sql")]
        sql: String,
    }

    let sql: Option<String> = sql_query(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='Players' LIMIT 1",
    )
    .load::<SqlRow>(db)?
    .into_iter()
    .next()
    .map(|r| r.sql);

    let Some(sql) = sql else { return Ok(()); };
    if !sql.to_ascii_uppercase().contains("WITHOUT ROWID") {
        return Ok(());
    }

    // Recreate Players as a normal rowid table.
    // Preserve existing data (ID, Name, Elo) if any.
    // Use SAVEPOINT so this can run inside an outer transaction too.
    // (Fixes: 'cannot start a transaction within a transaction')
    sql_query("SAVEPOINT ocs_players_rowid_fix").execute(db)?;
    let migrate_res = (|| -> Result<()> {
        db.batch_execute(
            "CREATE TABLE IF NOT EXISTS Players__rowid_fix (
               ID INTEGER PRIMARY KEY,
               Name TEXT UNIQUE,
               Elo INTEGER
             );
             INSERT OR IGNORE INTO Players__rowid_fix (ID, Name, Elo)
               SELECT ID, Name, Elo FROM Players;
             DROP TABLE Players;
             ALTER TABLE Players__rowid_fix RENAME TO Players;",
        )?;
        Ok(())
    })();

    match migrate_res {
        Ok(()) => {
            sql_query("RELEASE SAVEPOINT ocs_players_rowid_fix").execute(db)?;
        }
        Err(e) => {
            let _ = sql_query("ROLLBACK TO SAVEPOINT ocs_players_rowid_fix").execute(db);
            let _ = sql_query("RELEASE SAVEPOINT ocs_players_rowid_fix").execute(db);
            return Err(e);
        }
    }

    Ok(())
}

pub(crate) fn convert_pgn_impl<'a>(
    file: PathBuf,
    db_path: PathBuf,
    timestamp: Option<i32>,
    app: tauri::AppHandle,
    title: String,
    description: Option<String>,
    state: &tauri::State<'a, AppState>,
) -> Result<()> {
    let description = description.unwrap_or_default();
    let extension = file.extension();

    let db_exists = db_path.exists();

    // create the database file
    let db = &mut get_db_or_create(
        state,
        db_path.to_str().unwrap(),
        ConnectionOptions {
            enable_foreign_keys: false,
            busy_timeout: Some(Duration::from_secs(30)),
            journal_mode: JournalMode::Off,
        },
    )?;

    // Check if tables exist, even if the file exists
    // This handles cases where the file exists but is empty or corrupted
    let tables_exist = {
        #[derive(QueryableByName)]
        struct TableInfo {
            #[diesel(sql_type = Text, column_name = "name")]
            _name: String,
        }

        // Check if Players table exists
        let result: std::result::Result<Vec<TableInfo>, _> =
            sql_query("SELECT name FROM sqlite_master WHERE type='table' AND name='Players'")
                .load(db);

        result.is_ok() && !result.unwrap().is_empty()
    };

    let needs_init = !db_exists || !tables_exist;

    if needs_init {
        // Initialize database if file doesn't exist or tables are missing
        if !tables_exist && db_exists {
            // Database file exists but tables are missing, reinitializing
        }
        core::init_db(db, &title, &description)?;
    }

    // Ensure dedupe protections are present even on existing databases.
    // 1) Remove any existing duplicates (allows creating the unique index).
    // 2) Create a unique index so INSERT OR IGNORE can reliably skip duplicates.
    db.batch_execute(GAMES_DELETE_DUPLICATES)?;
    db.batch_execute(GAMES_CREATE_DEDUPE_UNIQUE_INDEX)?;

    let file = File::open(&file)?;

    let uncompressed: Box<dyn std::io::Read + Send> = if extension == Some("bz2".as_ref()) {
        Box::new(bzip2::read::MultiBzDecoder::new(file))
    } else if extension == Some("zst".as_ref()) {
        Box::new(zstd::Decoder::new(file)?)
    } else {
        Box::new(file)
    };

    // start counting time
    let start = Instant::now();

    let mut importer = Importer::new(timestamp.map(|t| t as i64));
    let mut name_counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();

    // OPTIMIZED: Use bulk insert context for maximum performance
    // This applies aggressive pragmas, drops indexes, uses BEGIN IMMEDIATE,
    // and caches lookups for players/events/sites
    // Run the heavy insert portion inside Diesel's transaction manager.
    // This avoids nested-BEGIN issues because Diesel uses SAVEPOINTs for nested transactions.
    let txn_res = db.transaction::<_, Error, _>(|db| {
        let mut bulk_ctx = bulk_insert::BulkInsertContext::new(db)?;

        // OPTIMIZED: Batch inserts for better performance
        // Collect games in batches to reduce transaction overhead
        const BATCH_SIZE: usize = 5000;
        let mut batch: Vec<TempGame> = Vec::with_capacity(BATCH_SIZE);
        let mut total_processed = 0;

        for game in BufferedReader::new(uncompressed)
            .into_iter(&mut importer)
            .flatten()
            .flatten()
        {
            if let Some(w) = game
                .white_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                *name_counts.entry(w.to_string()).or_insert(0) += 1;
            }
            if let Some(b) = game
                .black_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                *name_counts.entry(b.to_string()).or_insert(0) += 1;
            }

            batch.push(game);

            if batch.len() >= BATCH_SIZE {
                bulk_ctx.insert_games_batch(batch.drain(..).collect())?;

                total_processed += BATCH_SIZE;
                let elapsed = start.elapsed().as_millis() as u32;
                app.emit("convert_progress", (total_processed, elapsed))
                    .unwrap();
            }
        }

        if !batch.is_empty() {
            let batch_len = batch.len();
            bulk_ctx.insert_games_batch(batch.drain(..).collect())?;

            total_processed += batch_len;
            let elapsed = start.elapsed().as_millis() as u32;
            app.emit("convert_progress", (total_processed, elapsed))
                .unwrap();
        }

        // Recreate indexes + restore pragmas (best-effort) inside the transaction.
        // If any of these fail, the transaction will roll back, keeping DB consistent.
        bulk_ctx.finalize()?;
        Ok(())
    });

    txn_res?;

    // Re-obtain connection after bulk insert finalization to ensure it's in a valid state
    let db = &mut get_db_or_create(
        state,
        db_path.to_str().unwrap(),
        ConnectionOptions {
            enable_foreign_keys: false,
            busy_timeout: Some(Duration::from_secs(30)),
            journal_mode: JournalMode::Off,
        },
    )?;

    // get game, player, event and site counts and to the info table
    let game_count: i64 = games::table.count().get_result(db)?;
    let player_count: i64 = players::table.count().get_result(db)?;
    let event_count: i64 = events::table.count().get_result(db)?;
    let site_count: i64 = sites::table.count().get_result(db)?;

    let counts = [
        ("GameCount", game_count),
        ("PlayerCount", player_count),
        ("EventCount", event_count),
        ("SiteCount", site_count),
    ];

    for c in counts.iter() {
        insert_into(info::table)
            .values((info::name.eq(c.0), info::value.eq(c.1.to_string())))
            .on_conflict(info::name)
            .do_update()
            .set(info::value.eq(c.1.to_string()))
            .execute(db)?;
    }

    // If we're writing into a profile database, persist the "main" player so dashboards can
    // correctly infer opponents and colors. Keep any existing profile player if already set.
    let is_profile_db = db_path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.starts_with("profile_") && s.ends_with(".db3"))
        .unwrap_or(false);

    if is_profile_db {
        let existing_profile_player_id: Option<String> = info::table
            .filter(info::name.eq("ProfilePlayerId"))
            .select(info::value)
            .first::<Option<String>>(db)
            .optional()?
            .flatten();

        if existing_profile_player_id.is_none() {
            // Prefer picking the profile's active player based on profile metadata (ProfilePlayerName/Title).
            // Fall back to the most frequent name in the imported PGNs.
            fn normalize_name(s: &str) -> String {
                let mut out = String::with_capacity(s.len());
                let mut prev_space = true;
                for ch in s.chars() {
                    let c = ch.to_ascii_lowercase();
                    if c.is_ascii_alphanumeric() {
                        out.push(c);
                        prev_space = false;
                    } else if c.is_whitespace() || c == '-' || c == '_' || c == ',' || c == '.' {
                        if !prev_space {
                            out.push(' ');
                            prev_space = true;
                        }
                    }
                }
                out.trim().to_string()
            }

            let profile_player_name: Option<String> = info::table
                .filter(info::name.eq("ProfilePlayerName"))
                .select(info::value)
                .first::<Option<String>>(db)
                .optional()?
                .flatten()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            let title_name: Option<String> = info::table
                .filter(info::name.eq("Title"))
                .select(info::value)
                .first::<Option<String>>(db)
                .optional()?
                .flatten()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            let preferred_raw = profile_player_name.or(title_name).unwrap_or_default();
            let preferred_norm = normalize_name(&preferred_raw);

            let mut best_name: Option<(String, u32, u8)> = None;
            for (name, count) in &name_counts {
                let n = normalize_name(name);
                if n.is_empty() {
                    continue;
                }
                let score = if !preferred_norm.is_empty() && n == preferred_norm {
                    3u8
                } else if !preferred_norm.is_empty()
                    && (n.contains(&preferred_norm) || preferred_norm.contains(&n))
                {
                    2u8
                } else {
                    1u8
                };

                let candidate = (name.trim().to_string(), *count, score);
                best_name = match best_name {
                    None => Some(candidate),
                    Some(prev) => {
                        if candidate.2 > prev.2 || (candidate.2 == prev.2 && candidate.1 > prev.1) {
                            Some(candidate)
                        } else {
                            Some(prev)
                        }
                    }
                };
            }

            let main_player_name = best_name
                .map(|v| v.0)
                .or_else(|| {
                    name_counts
                        .into_iter()
                        .max_by_key(|(_, c)| *c)
                        .map(|(n, _)| n.trim().to_string())
                })
                .filter(|s| !s.is_empty());

            if let Some(main_player_name) = main_player_name {
                let pid = create_player(db, &main_player_name)?.id;
                upsert_info_value(db, "ProfilePlayerId", &pid.to_string())?;
                upsert_info_value(db, "ProfilePlayerName", &main_player_name)?;
            }
        }
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn convert_pgn(
    file: PathBuf,
    db_path: PathBuf,
    timestamp: Option<i32>,
    app: tauri::AppHandle,
    title: String,
    description: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    convert_pgn_impl(file, db_path, timestamp, app, title, description, &state)
}

#[tauri::command]
#[specta::specta]
pub async fn init_profile_db(
    db_path: PathBuf,
    title: String,
    description: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let description = description.unwrap_or_default();
    let normalized_title = title.trim().to_string();
    let db_exists = db_path.exists();

    let db = &mut get_db_or_create(
        &state,
        db_path.to_str().unwrap(),
        ConnectionOptions::default(),
    )?;

    let tables_exist = {
        #[derive(QueryableByName)]
        struct TableInfo {
            #[diesel(sql_type = Text, column_name = "name")]
            _name: String,
        }

        let result: std::result::Result<Vec<TableInfo>, _> =
            sql_query("SELECT name FROM sqlite_master WHERE type='table' AND name='Players'")
                .load(db);

        result.is_ok() && !result.unwrap().is_empty()
    };

    let needs_init = !db_exists || !tables_exist;
    if needs_init {
        if !tables_exist && db_exists {
            // Database file exists but tables are missing, reinitializing
        }
        core::init_db(db, &title, &description)?;
        let _ = db.batch_execute(INDEXES_SQL);
    }

    // Ensure profile analysis tables exist (for older profiles and fresh ones).
    analysis_stats::ensure_profile_analysis_tables(db)?;
    weakness_model::ensure_profile_weakness_tables(db)?;

    // Store the profile's active player name (used for opponent detection after imports).
    // Do not override if already present (profiles should be stable).
    if !title.trim().is_empty() {
        let existing: Option<String> = info::table
            .filter(info::name.eq("ProfilePlayerName"))
            .select(info::value)
            .first::<Option<String>>(db)
            .optional()?
            .flatten();
        if existing.is_none() {
            upsert_info_value(db, "ProfilePlayerName", title.trim())?;
        }
    }

    // Always keep profile DB metadata aligned with the current profile name.
    // This prevents generic labels ("Profile Database") from showing up in selectors.
    if !normalized_title.is_empty() {
        upsert_info_value(db, "Title", &normalized_title)?;
        if description.trim().is_empty() {
            upsert_info_value(db, "Description", "Profile database")?;
        } else {
            upsert_info_value(db, "Description", description.trim())?;
        }
    }

    Ok(())
}

/// Persist computed, engine-derived analysis stats for a single profile database game.
///
/// This is called by the frontend after an engine analysis run completes (individual report or Analyze All).
#[tauri::command]
#[specta::specta]
pub async fn save_profile_game_analysis_stats(
    profile_id: String,
    game_id: i32,
    initial_fen: String,
    moves: Vec<String>,
    analysis: Vec<crate::chess::types::MoveAnalysis>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<()> {
    let db_path = app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?;

    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions::default(),
    )?;

    ensure_db_initialized(db)?;

    #[derive(QueryableByName)]
    struct GameRow {
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "Result")]
        result: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Integer, column_name = "WhiteID")]
        white_id: i32,
        #[diesel(sql_type = diesel::sql_types::Integer, column_name = "BlackID")]
        black_id: i32,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "TimeControl")]
        time_control: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "ECO")]
        eco: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Integer>, column_name = "PlyCount")]
        ply_count: Option<i32>,
    }

    let row: Option<GameRow> = sql_query(
        "SELECT Result, WhiteID, BlackID, TimeControl, ECO, PlyCount FROM Games WHERE ID = ?1 LIMIT 1",
    )
    .bind::<diesel::sql_types::Integer, _>(game_id)
    .load::<GameRow>(db)?
    .into_iter()
    .next();

    let Some(row) = row else {
        return Err(Error::PackageManager(format!(
            "save_profile_game_analysis_stats: game not found (Games.ID={game_id})"
        )));
    };

    let winner = analysis_stats::winner_from_result(row.result.as_deref());
    let mut stats = analysis_stats::compute_game_analysis_stats(winner, &initial_fen, &moves, &analysis)?;

    // Store additional computed stats (forks, etc.) into the Extra JSON blob.
    #[derive(QueryableByName)]
    struct InfoRow {
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "Value")]
        value: Option<String>,
    }
    let profile_player_id: Option<i32> =
        sql_query("SELECT Value FROM Info WHERE Name = 'ProfilePlayerId' LIMIT 1")
            .load::<InfoRow>(db)
            .ok()
            .and_then(|v| v.into_iter().next().and_then(|r| r.value))
            .and_then(|s| s.trim().parse::<i32>().ok())
            .filter(|v| *v > 0);

    if let Some(pid) = profile_player_id {
        let profile_color = if row.white_id == pid {
            Some(shakmaty::Color::White)
        } else if row.black_id == pid {
            Some(shakmaty::Color::Black)
        } else {
            None
        };

        if let Some(profile_color) = profile_color {
            if let Ok(forks) = analysis_stats::compute_engine_validated_forks_extra(
                &initial_fen,
                &moves,
                &analysis,
                profile_color,
            ) {
                if let Some(obj) = stats.extra.as_object_mut() {
                    obj.insert("forks".to_string(), forks);
                }
            }

            if let Ok(computed) = weakness_model::compute_weakness_features_v1(
                &initial_fen,
                &moves,
                profile_color,
                row.time_control.as_deref(),
                row.eco.as_deref(),
                row.ply_count,
            ) {
                let upsert_row = weakness_model::WeaknessGameFeaturesUpsert {
                    game_id,
                    model_version: weakness_model::WEAKNESS_MODEL_VERSION_V1,
                    computed_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
                    opening_family: computed.opening_family,
                    time_control_bucket: computed.time_control_bucket,
                    color_played: Some(computed.color_played),
                    ply_bucket_features_json: computed.ply_bucket_features_json,
                    features_json: computed.features_json,
                };
                if let Err(e) = weakness_model::upsert_weakness_game_features(db, &upsert_row) {
                    eprintln!("weakness model upsert failed for game {game_id}: {e}");
                }
            } else {
                eprintln!("weakness model feature extraction failed for game {game_id}");
            }
        }
    }

    analysis_stats::upsert_game_analysis_stats(db, game_id, &stats)?;

    Ok(())
}

fn parse_profile_game_date_to_timestamp_ms(date: Option<&str>) -> Option<i64> {
    let s = date?.trim();
    if s.len() < 10 {
        return None;
    }

    let b = s.as_bytes();
    if b.len() < 10
        || !b[0].is_ascii_digit()
        || !b[1].is_ascii_digit()
        || !b[2].is_ascii_digit()
        || !b[3].is_ascii_digit()
    {
        return None;
    }

    let year: i32 = ((b[0] - b'0') as i32) * 1000
        + ((b[1] - b'0') as i32) * 100
        + ((b[2] - b'0') as i32) * 10
        + ((b[3] - b'0') as i32);

    let mut i = 4usize;
    while i < b.len() && !b[i].is_ascii_digit() {
        i += 1;
    }
    if i + 1 >= b.len() {
        return None;
    }

    let mut month: u32 = 0;
    let mut md = 0usize;
    while i < b.len() && b[i].is_ascii_digit() && md < 2 {
        month = month * 10 + (b[i] - b'0') as u32;
        i += 1;
        md += 1;
    }
    if month == 0 || month > 12 {
        return None;
    }

    while i < b.len() && !b[i].is_ascii_digit() {
        i += 1;
    }
    if i + 1 >= b.len() {
        return None;
    }

    let mut day: u32 = 0;
    let mut dd = 0usize;
    while i < b.len() && b[i].is_ascii_digit() && dd < 2 {
        day = day * 10 + (b[i] - b'0') as u32;
        i += 1;
        dd += 1;
    }
    if day == 0 || day > 31 {
        return None;
    }

    let nd = NaiveDate::from_ymd_opt(year, month, day)?;
    Some(chrono::Utc.from_utc_datetime(&nd.and_hms_opt(0, 0, 0)?).timestamp_millis())
}

const WEAKNESS_MATE_AS_CP: i32 = 100_000;
const WEAKNESS_BLUNDER_SWING_CP: i32 = 150;
const WEAKNESS_MISTAKE_SWING_CP: i32 = 90;
const WEAKNESS_INACCURACY_SWING_CP: i32 = 40;

#[derive(Debug, Clone, Copy)]
struct WeaknessErrorRates {
    blunder_rate: f64,
    mistake_rate: f64,
    inaccuracy_rate: f64,
}

fn weakness_extract_eval_scores_from_analyzed_pgn(pgn: &str) -> Vec<i32> {
    let re = Regex::new(r#"\[%eval\s+([^\]]+)\]"#).ok();
    let Some(re) = re else {
        return vec![];
    };

    let mut out: Vec<i32> = Vec::new();
    for cap in re.captures_iter(pgn) {
        let raw = cap.get(1).map(|m| m.as_str()).unwrap_or("").trim();
        if raw.is_empty() {
            continue;
        }
        let token = raw.split_whitespace().next().unwrap_or(raw);
        let token = token.split('/').next().unwrap_or(token);
        let token = token.split(',').next().unwrap_or(token).trim();

        if let Some(rest) = token.strip_prefix('#') {
            let m = rest.trim().parse::<i32>().ok().unwrap_or(0);
            if m == 0 {
                out.push(0);
            } else {
                out.push(m.signum() * WEAKNESS_MATE_AS_CP);
            }
            continue;
        }

        if let Ok(v) = token.parse::<f32>() {
            out.push((v * 100.0).round() as i32);
        }
    }

    out
}

fn weakness_profile_error_rates_from_analyzed_pgn(
    analyzed_pgn: &str,
    profile_is_white: bool,
) -> Option<WeaknessErrorRates> {
    let scores = weakness_extract_eval_scores_from_analyzed_pgn(analyzed_pgn);
    if scores.len() < 2 {
        return None;
    }

    let mut considered = 0usize;
    let mut blunders = 0usize;
    let mut mistakes = 0usize;
    let mut inaccuracies = 0usize;
    for idx in 1..scores.len() {
        let ply = (idx as i32) + 1;
        let is_profile_move = if profile_is_white { ply % 2 == 1 } else { ply % 2 == 0 };
        if !is_profile_move {
            continue;
        }

        let delta_white_cp = scores[idx] - scores[idx - 1];
        let delta_profile_cp = if profile_is_white { delta_white_cp } else { -delta_white_cp };
        considered += 1;
        if delta_profile_cp <= -WEAKNESS_BLUNDER_SWING_CP {
            blunders += 1;
        } else if delta_profile_cp <= -WEAKNESS_MISTAKE_SWING_CP {
            mistakes += 1;
        } else if delta_profile_cp <= -WEAKNESS_INACCURACY_SWING_CP {
            inaccuracies += 1;
        }
    }

    if considered == 0 {
        None
    } else {
        Some(WeaknessErrorRates {
            blunder_rate: (blunders as f64) / (considered as f64),
            mistake_rate: (mistakes as f64) / (considered as f64),
            inaccuracy_rate: (inaccuracies as f64) / (considered as f64),
        })
    }
}

fn weakness_variation_starts_with_rook_move(variation: &GameTree) -> bool {
    for node in variation.nodes() {
        if let pgn::GameTreeNode::Move(san_plus) = node {
            let san = san_plus.san.to_string();
            return san.starts_with('R');
        }
    }
    false
}

/// Returns the ply where the profile made a blunder (`??` / `$4`) and
/// the first move in the engine variation is a rook move (activation opportunity).
fn weakness_profile_blunder_rook_activation_ply_from_analyzed_pgn(
    analyzed_pgn: &str,
    profile_is_white: bool,
) -> Option<i32> {
    if !analyzed_pgn.contains("??") && !analyzed_pgn.contains("$4") {
        return None;
    }

    let mut reader = BufferedReader::new_cursor(analyzed_pgn.as_bytes());
    let mut importer = Importer::new(None);
    let game = reader.read_game(&mut importer).ok().flatten().flatten()?;

    let mut ply = 0i32;
    let mut white_to_move = game.position.turn().is_white();
    let mut last_move_ply: Option<i32> = None;
    let mut last_move_profile = false;
    let mut last_move_blunder = false;

    for node in game.tree.nodes() {
        match node {
            pgn::GameTreeNode::Move(san_plus) => {
                ply += 1;
                let mover_is_white = white_to_move;
                white_to_move = !white_to_move;
                last_move_ply = Some(ply);
                last_move_profile = mover_is_white == profile_is_white;
                // Some PGNs keep "??" as SAN suffix instead of NAG.
                last_move_blunder = last_move_profile && san_plus.to_string().contains("??");
            }
            pgn::GameTreeNode::Nag(nag) => {
                // NAG 4 is "blunder".
                if last_move_profile && nag.0 == 4 {
                    last_move_blunder = true;
                }
            }
            pgn::GameTreeNode::Variation(variation) => {
                if last_move_profile && last_move_blunder && weakness_variation_starts_with_rook_move(variation) {
                    return last_move_ply;
                }
            }
            pgn::GameTreeNode::Comment(_) => {}
        }
    }

    None
}

fn weakness_normalize_platform(site: &str) -> PlatformFilter {
    let lower = site.to_lowercase();
    if lower.contains("lichess") {
        PlatformFilter::Lichess
    } else if lower.contains("chess.com") || lower.contains("chesscom") {
        PlatformFilter::ChessCom
    } else {
        PlatformFilter::All
    }
}

fn weakness_get_time_control(_site: &str, time_control: &str) -> TimeControlFilter {
    let tc = time_control.trim();
    if tc.is_empty() {
        return TimeControlFilter::Any;
    }

    let lower = tc.to_lowercase();
    if lower.contains("correspondence") || lower.contains("daily") || lower.contains("classical") {
        return TimeControlFilter::Classical;
    }

    let base_seconds: Option<f64> = if let Some((base, _inc)) = tc.split_once('+') {
        base.trim().parse::<f64>().ok()
    } else {
        tc.parse::<f64>().ok()
    };

    let Some(base) = base_seconds else {
        return TimeControlFilter::Any;
    };

    if base < 180.0 {
        return TimeControlFilter::Bullet;
    }
    if base < 480.0 {
        return TimeControlFilter::Blitz;
    }
    if base < 1500.0 {
        return TimeControlFilter::Rapid;
    }
    TimeControlFilter::Classical
}

fn weakness_normalize_color_played(color_played: &Option<String>) -> Option<&'static str> {
    let raw = color_played.as_ref()?;
    let normalized = raw.trim().to_lowercase();
    if normalized == "white" {
        Some("white")
    } else if normalized == "black" {
        Some("black")
    } else {
        None
    }
}

fn weakness_filter_signature(filters: &Option<PlayerStatsFilters>) -> String {
    let Some(f) = filters else {
        return "all".to_string();
    };
    let platform = match f.platform {
        PlatformFilter::All => "all",
        PlatformFilter::Lichess => "lichess",
        PlatformFilter::ChessCom => "chesscom",
    };
    let tc = match f.time_control {
        TimeControlFilter::Any => "any",
        TimeControlFilter::Bullet => "bullet",
        TimeControlFilter::Blitz => "blitz",
        TimeControlFilter::Rapid => "rapid",
        TimeControlFilter::Classical => "classical",
    };
    let dr = match f.date_range {
        Some(DateRange::SevenDays) => "7d",
        Some(DateRange::ThirtyDays) => "30d",
        Some(DateRange::NinetyDays) => "90d",
        Some(DateRange::OneYear) => "1y",
        Some(DateRange::All) => "all",
        None => "none",
    };
    let elo = f
        .opponent_elo_bucket
        .as_deref()
        .unwrap_or("all")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>();
    format!("p-{platform}_tc-{tc}_elo-{elo}_dr-{dr}")
}

fn weakness_date_range_earliest_ms(date_range: &DateRange, last_date: i64) -> i64 {
    const MS_DAY: i64 = 86_400_000;
    match date_range {
        DateRange::All => i64::MIN,
        DateRange::SevenDays => last_date - 7 * MS_DAY,
        DateRange::ThirtyDays => last_date - 30 * MS_DAY,
        DateRange::NinetyDays => last_date - 90 * MS_DAY,
        DateRange::OneYear => last_date - 365 * MS_DAY,
    }
}

fn load_or_infer_profile_player_id_for_weakness(db: &mut SqliteConnection) -> Result<Option<i32>> {
    #[derive(QueryableByName)]
    struct InfoRow {
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "Value")]
        value: Option<String>,
    }
    #[derive(QueryableByName)]
    struct CountRow {
        #[diesel(sql_type = diesel::sql_types::BigInt, column_name = "c")]
        c: i64,
    }
    #[derive(QueryableByName)]
    struct CandidateRow {
        #[diesel(sql_type = diesel::sql_types::Integer, column_name = "player_id")]
        player_id: i32,
        #[diesel(sql_type = diesel::sql_types::BigInt, column_name = "c")]
        c: i64,
    }

    let existing: Option<i32> = sql_query("SELECT Value FROM Info WHERE Name = 'ProfilePlayerId' LIMIT 1")
        .load::<InfoRow>(db)?
        .into_iter()
        .next()
        .and_then(|r| r.value)
        .and_then(|v| v.trim().parse::<i32>().ok())
        .filter(|v| *v > 0);

    let existing_total_count = if let Some(existing_id) = existing {
        sql_query("SELECT COUNT(*) AS c FROM Games WHERE WhiteID = ?1 OR BlackID = ?1")
            .bind::<diesel::sql_types::Integer, _>(existing_id)
            .load::<CountRow>(db)?
            .into_iter()
            .next()
            .map(|r| r.c)
            .unwrap_or(0)
    } else {
        0
    };

    let existing_analyzed_count = if let Some(existing_id) = existing {
        sql_query(
            r#"
            SELECT COUNT(*) AS c
            FROM Games g
            INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
            WHERE g.WhiteID = ?1 OR g.BlackID = ?1
            "#,
        )
        .bind::<diesel::sql_types::Integer, _>(existing_id)
        .load::<CountRow>(db)?
        .into_iter()
        .next()
        .map(|r| r.c)
        .unwrap_or(0)
    } else {
        0
    };

    let dominant_analyzed = sql_query(
        r#"
        SELECT player_id, COUNT(*) AS c
        FROM (
            SELECT g.WhiteID AS player_id
            FROM Games g
            INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
            UNION ALL
            SELECT g.BlackID AS player_id
            FROM Games g
            INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
        )
        GROUP BY player_id
        ORDER BY c DESC
        LIMIT 1
        "#,
    )
    .load::<CandidateRow>(db)?
    .into_iter()
    .next()
    .filter(|r| r.player_id > 0);

    let dominant_all_games = sql_query(
        r#"
        SELECT player_id, COUNT(*) AS c
        FROM (
            SELECT WhiteID AS player_id FROM Games
            UNION ALL
            SELECT BlackID AS player_id FROM Games
        )
        GROUP BY player_id
        ORDER BY c DESC
        LIMIT 1
        "#,
    )
    .load::<CandidateRow>(db)?
    .into_iter()
    .next()
    .filter(|r| r.player_id > 0);

    // Keep explicit profile id only when it has meaningful analyzed coverage;
    // otherwise prefer the dominant player in analyzed games.
    let chosen = if let Some(existing_id) = existing {
        let dominant_analyzed_same = dominant_analyzed
            .as_ref()
            .map(|r| r.player_id == existing_id)
            .unwrap_or(false);
        if existing_analyzed_count >= 8 || dominant_analyzed_same {
            Some(existing_id)
        } else if let Some(candidate) = dominant_analyzed.as_ref() {
            Some(candidate.player_id)
        } else if existing_total_count > 0 {
            Some(existing_id)
        } else {
            dominant_all_games.as_ref().map(|r| r.player_id)
        }
    } else if let Some(candidate) = dominant_analyzed.as_ref() {
        Some(candidate.player_id)
    } else {
        dominant_all_games.as_ref().map(|r| r.player_id)
    }
    .filter(|pid| *pid > 0);

    let Some(pid) = chosen else {
        return Ok(None);
    };

    if existing != Some(pid) {
        let _ = sql_query(
            "INSERT INTO Info (Name, Value) VALUES ('ProfilePlayerId', ?1)
             ON CONFLICT(Name) DO UPDATE SET Value = excluded.Value",
        )
        .bind::<diesel::sql_types::Text, _>(pid.to_string())
        .execute(db);
    }

    Ok(Some(pid))
}

fn profile_outcome_from_result(result: Option<&str>, profile_is_white: bool) -> Option<String> {
    let r = result.unwrap_or("*").trim();
    if r.is_empty() {
        return Some("unknown".to_string());
    }
    let outcome = match r {
        "1-0" => {
            if profile_is_white {
                "win"
            } else {
                "loss"
            }
        }
        "0-1" => {
            if profile_is_white {
                "loss"
            } else {
                "win"
            }
        }
        "1/2-1/2" => "draw",
        _ => "unknown",
    };
    Some(outcome.to_string())
}

fn backfill_profile_weakness_features(
    db: &mut SqliteConnection,
    profile_player_id: i32,
) -> Result<i32> {
    const STARTPOS_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const MAX_BACKFILL_GAMES: i32 = 20000;

    #[derive(QueryableByName)]
    struct MissingFeatureRow {
        #[diesel(sql_type = diesel::sql_types::Integer, column_name = "game_id")]
        game_id: i32,
        #[diesel(sql_type = diesel::sql_types::Integer, column_name = "WhiteID")]
        white_id: i32,
        #[diesel(sql_type = diesel::sql_types::Integer, column_name = "BlackID")]
        black_id: i32,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "TimeControl")]
        time_control: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "ECO")]
        eco: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Integer>, column_name = "PlyCount")]
        ply_count: Option<i32>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "FEN")]
        fen: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Binary, column_name = "Moves")]
        moves: Vec<u8>,
    }

    let rows: Vec<MissingFeatureRow> = sql_query(
        r#"
        SELECT
            g.ID AS game_id,
            g.WhiteID,
            g.BlackID,
            g.TimeControl,
            g.ECO,
            g.PlyCount,
            g.FEN,
            g.Moves
        FROM Games g
        INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
        LEFT JOIN WeaknessGameFeatures wgf ON wgf.GameID = g.ID
        WHERE (g.WhiteID = ?1 OR g.BlackID = ?1)
          AND (wgf.GameID IS NULL OR wgf.ModelVersion < ?2)
        ORDER BY g.ID DESC
        LIMIT ?3
        "#,
    )
    .bind::<diesel::sql_types::Integer, _>(profile_player_id)
    .bind::<diesel::sql_types::Integer, _>(weakness_model::WEAKNESS_MODEL_VERSION_V1)
    .bind::<diesel::sql_types::Integer, _>(MAX_BACKFILL_GAMES)
    .load::<MissingFeatureRow>(db)?;

    let mut filled = 0i32;
    for row in rows {
        let profile_color = if row.white_id == profile_player_id {
            Some(shakmaty::Color::White)
        } else if row.black_id == profile_player_id {
            Some(shakmaty::Color::Black)
        } else {
            None
        };
        let Some(profile_color) = profile_color else {
            continue;
        };

        let start_pos = row
            .fen
            .as_deref()
            .and_then(|f| Fen::from_ascii(f.as_bytes()).ok())
            .and_then(|f| f.into_position(CastlingMode::Chess960).ok());
        let decoded_moves = match extract_main_line_moves(&row.moves, start_pos) {
            Ok(m) => m,
            Err(e) => {
                eprintln!(
                    "weakness model backfill decode failed for game {}: {}",
                    row.game_id, e
                );
                continue;
            }
        };
        let moves_uci: Vec<String> = decoded_moves
            .into_iter()
            .map(|m| m.to_uci(CastlingMode::Standard).to_string())
            .collect();

        let initial_fen = row
            .fen
            .clone()
            .unwrap_or_else(|| STARTPOS_FEN.to_string());
        let computed = match weakness_model::compute_weakness_features_v1(
            &initial_fen,
            &moves_uci,
            profile_color,
            row.time_control.as_deref(),
            row.eco.as_deref(),
            row.ply_count,
        ) {
            Ok(v) => v,
            Err(e) => {
                eprintln!(
                    "weakness model backfill extraction failed for game {}: {}",
                    row.game_id, e
                );
                continue;
            }
        };

        let upsert_row = weakness_model::WeaknessGameFeaturesUpsert {
            game_id: row.game_id,
            model_version: weakness_model::WEAKNESS_MODEL_VERSION_V1,
            computed_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            opening_family: computed.opening_family,
            time_control_bucket: computed.time_control_bucket,
            color_played: Some(computed.color_played),
            ply_bucket_features_json: computed.ply_bucket_features_json,
            features_json: computed.features_json,
        };
        if weakness_model::upsert_weakness_game_features(db, &upsert_row).is_ok() {
            filled += 1;
        }
    }

    Ok(filled)
}

pub fn backfill_profile_weakness_features_for_player(
    db: &mut SqliteConnection,
    profile_player_id: i32,
) -> Result<i32> {
    backfill_profile_weakness_features(db, profile_player_id)
}

/// Build and return a ranked strategic weakness model for the profile.
///
/// The command incrementally backfills missing per-game weakness features, recomputes a snapshot,
/// persists it, and returns top-ranked signals with evidence rows.
#[tauri::command]
#[specta::specta]
pub async fn get_profile_weakness_model(
    profile_id: String,
    limit: Option<u32>,
    filters: Option<PlayerStatsFilters>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<weakness_model::ProfileWeaknessModel> {
    let db_path = app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?;

    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions::default(),
    )?;
    ensure_db_initialized(db)?;
    // Keep weakness model compatible with legacy profiles where analyzed games exist in analysis.db3
    // but GameAnalysisStats has not been backfilled yet.
    let _ = analysis_stats::backfill_profile_phase_stats_from_analysis_db(
        app.clone(),
        db,
        &profile_id,
        5000,
    );
    let filter_sig = weakness_filter_signature(&filters);

    let Some(profile_player_id) = load_or_infer_profile_player_id_for_weakness(db)? else {
        return Ok(weakness_model::ProfileWeaknessModel {
            snapshot_key: format!(
                "wm:v{}:{profile_id}:{filter_sig}",
                weakness_model::WEAKNESS_MODEL_VERSION_V1
            ),
            model_version: weakness_model::WEAKNESS_MODEL_VERSION_V1,
            generated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            total_games: 0,
            scored_games: 0,
            backfilled_games: 0,
            signals: vec![],
            signals_by_color: weakness_model::ProfileWeaknessSignalsByColor::default(),
        });
    };

    let backfilled = backfill_profile_weakness_features(db, profile_player_id)?;

    #[derive(QueryableByName)]
    struct ModelRow {
        #[diesel(sql_type = diesel::sql_types::Integer, column_name = "game_id")]
        game_id: i32,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "site")]
        site: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "Date")]
        date: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "Result")]
        result: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "time_control")]
        time_control: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Integer, column_name = "WhiteID")]
        white_id: i32,
        #[diesel(sql_type = diesel::sql_types::Integer, column_name = "BlackID")]
        black_id: i32,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "white_name")]
        white_name: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "black_name")]
        black_name: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Integer>, column_name = "white_elo")]
        white_elo: Option<i32>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Integer>, column_name = "black_elo")]
        black_elo: Option<i32>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Integer>, column_name = "PlyCount")]
        ply_count: Option<i32>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "OpeningFamily")]
        opening_family: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "TimeControlBucket")]
        time_control_bucket: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "ColorPlayed")]
        color_played: Option<String>,
        #[diesel(sql_type = diesel::sql_types::Text, column_name = "PlyBucketFeaturesJson")]
        ply_bucket_features_json: String,
        #[diesel(sql_type = diesel::sql_types::Text, column_name = "FeaturesJson")]
        features_json: String,
    }

    let model_rows: Vec<ModelRow> = sql_query(
        r#"
        SELECT
            g.ID AS game_id,
            s.Name AS site,
            g.Date,
            g.Result,
            g.TimeControl AS time_control,
            g.WhiteID,
            g.BlackID,
            pw.Name AS white_name,
            pb.Name AS black_name,
            g.WhiteElo AS white_elo,
            g.BlackElo AS black_elo,
            g.PlyCount,
            wgf.OpeningFamily,
            wgf.TimeControlBucket,
            wgf.ColorPlayed,
            wgf.PlyBucketFeaturesJson,
            wgf.FeaturesJson
        FROM Games g
        INNER JOIN Sites s ON s.ID = g.SiteID
        LEFT JOIN Players pw ON pw.ID = g.WhiteID
        LEFT JOIN Players pb ON pb.ID = g.BlackID
        INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
        INNER JOIN WeaknessGameFeatures wgf ON wgf.GameID = g.ID
        WHERE g.WhiteID = ?1 OR g.BlackID = ?1
          AND wgf.ModelVersion >= ?2
        "#,
    )
    .bind::<diesel::sql_types::Integer, _>(profile_player_id)
    .bind::<diesel::sql_types::Integer, _>(weakness_model::WEAKNESS_MODEL_VERSION_V1)
    .load::<ModelRow>(db)?;

    let mut filtered_rows: Vec<(ModelRow, Option<i64>)> = Vec::with_capacity(model_rows.len());
    for row in model_rows {
        if let Some(active_filters) = &filters {
            let site = row.site.clone().unwrap_or_default();
            if !site.trim().is_empty() {
                match active_filters.platform {
                    PlatformFilter::All => {}
                    PlatformFilter::Lichess => {
                        if weakness_normalize_platform(&site) != PlatformFilter::Lichess {
                            continue;
                        }
                    }
                    PlatformFilter::ChessCom => {
                        if weakness_normalize_platform(&site) != PlatformFilter::ChessCom {
                            continue;
                        }
                    }
                }
            }

            if !matches!(active_filters.time_control, TimeControlFilter::Any) {
                let tc = row.time_control.clone().unwrap_or_default();
                if weakness_get_time_control(&site, &tc) != active_filters.time_control {
                    continue;
                }
            }

            if let Some(bucket) = &active_filters.opponent_elo_bucket {
                if let Ok(start) = bucket.parse::<i32>() {
                    let end = start + 199;
                    let profile_is_white = row.white_id == profile_player_id;
                    let opponent_elo = if profile_is_white { row.black_elo } else { row.white_elo };
                    let Some(opponent_elo) = opponent_elo else {
                        continue;
                    };
                    if opponent_elo < start || opponent_elo > end {
                        continue;
                    }
                }
            }
        }

        let ts = parse_profile_game_date_to_timestamp_ms(row.date.as_deref());
        filtered_rows.push((row, ts));
    }

    if let Some(active_filters) = &filters {
        if let Some(date_range) = &active_filters.date_range {
            if !filtered_rows.is_empty() {
                let mut max_date: Option<i64> = None;
                for (_row, ts) in &filtered_rows {
                    if let Some(t) = *ts {
                        max_date = Some(max_date.map_or(t, |m| m.max(t)));
                    }
                }

                if let Some(last_date) = max_date {
                    let earliest = weakness_date_range_earliest_ms(date_range, last_date);
                    filtered_rows.retain(|(_row, ts)| ts.map(|t| t >= earliest).unwrap_or(false));
                }
            }
        }
    }

    let model_rows: Vec<ModelRow> = filtered_rows.into_iter().map(|(row, _ts)| row).collect();

    let game_ids: Vec<String> = model_rows.iter().map(|r| r.game_id.to_string()).collect();
    let mut stats_rows =
        crate::analysis_storage::analysis_db_get_game_stats_bulk(app.clone(), game_ids.clone(), Some(profile_id.clone()))?;
    if stats_rows.is_empty() && !profile_id.trim().is_empty() {
        stats_rows = crate::analysis_storage::analysis_db_get_game_stats_bulk(app.clone(), game_ids.clone(), None)?;
    }
    let stats_map: std::collections::HashMap<String, (f64, f64, Option<i64>)> = stats_rows
        .into_iter()
        .map(|s| (s.game_id, (s.accuracy, s.acpl, s.estimated_elo)))
        .collect();

    let mut analyzed_rows = crate::analysis_storage::analysis_db_get_analyzed_games_bulk(
        app.clone(),
        game_ids.clone(),
        Some(profile_id.clone()),
    )?;
    if analyzed_rows.is_empty() && !profile_id.trim().is_empty() {
        analyzed_rows =
            crate::analysis_storage::analysis_db_get_analyzed_games_bulk(app.clone(), game_ids.clone(), None)?;
    }
    let analyzed_map: std::collections::HashMap<String, String> = analyzed_rows
        .into_iter()
        .map(|r| (r.game_id, r.analyzed_pgn))
        .collect();

    let mut input_rows: Vec<weakness_model::WeaknessAggregationInputRow> = Vec::new();
    for row in model_rows {
        let game_id_key = row.game_id.to_string();
        let stats = stats_map.get(&game_id_key).copied();
        let profile_is_white = row.white_id == profile_player_id;
        let analyzed_pgn = analyzed_map.get(&game_id_key);
        let error_rates = analyzed_pgn
            .and_then(|pgn| weakness_profile_error_rates_from_analyzed_pgn(pgn, profile_is_white));
        let opponent_name = if profile_is_white {
            row.black_name.clone()
        } else {
            row.white_name.clone()
        };
        let outcome = profile_outcome_from_result(row.result.as_deref(), profile_is_white);
        let mut features_json =
            serde_json::from_str::<serde_json::Value>(&row.features_json)
                .unwrap_or_else(|_| serde_json::json!({}));
        let first_rook_activation_ply = features_json
            .get("rookActivity")
            .and_then(|v| v.get("firstRookActivationPly"))
            .and_then(|v| v.as_i64());
        let should_probe_blunder_rook_activation = first_rook_activation_ply
            .map(|ply| ply <= 40)
            .unwrap_or(false);
        let blunder_rook_activation_ply = if should_probe_blunder_rook_activation {
            analyzed_pgn.and_then(|pgn| {
                weakness_profile_blunder_rook_activation_ply_from_analyzed_pgn(pgn, profile_is_white)
            })
        } else {
            None
        };
        if let Some(ply) = blunder_rook_activation_ply {
            if !features_json.is_object() {
                features_json = serde_json::json!({});
            }
            if let Some(root) = features_json.as_object_mut() {
                let rook_activity = root
                    .entry("rookActivity".to_string())
                    .or_insert_with(|| serde_json::json!({}));
                if !rook_activity.is_object() {
                    *rook_activity = serde_json::json!({});
                }
                if let Some(rook_obj) = rook_activity.as_object_mut() {
                    rook_obj.insert("missedActivationBlunder".to_string(), serde_json::json!(true));
                    rook_obj.insert(
                        "missedActivationBlunderPly".to_string(),
                        serde_json::json!(ply),
                    );
                }
            }
        }
        let ply_bucket_features_json =
            serde_json::from_str::<serde_json::Value>(&row.ply_bucket_features_json)
                .unwrap_or_else(|_| serde_json::json!({}));

        input_rows.push(weakness_model::WeaknessAggregationInputRow {
            game_id: row.game_id,
            timestamp_ms: parse_profile_game_date_to_timestamp_ms(row.date.as_deref()),
            profile_outcome: outcome,
            opponent_name,
            accuracy: stats.map(|s| s.0),
            acpl: stats.map(|s| s.1),
            blunder_rate: error_rates.map(|r| r.blunder_rate),
            mistake_rate: error_rates.map(|r| r.mistake_rate),
            inaccuracy_rate: error_rates.map(|r| r.inaccuracy_rate),
            estimated_elo: stats.and_then(|s| s.2),
            opening_family: row.opening_family,
            time_control_bucket: row.time_control_bucket,
            color_played: row.color_played,
            game_length_ply: row.ply_count,
            ply_bucket_features_json,
            features_json,
        });
    }

    let build = weakness_model::build_weakness_snapshot_v1(
        &input_rows,
        limit.map(|v| v.clamp(1, 24) as usize),
        Some(4),
    );
    let per_color_limit = 7usize;
    let white_rows = input_rows
        .iter()
        .filter(|row| weakness_normalize_color_played(&row.color_played) == Some("white"))
        .cloned()
        .collect::<Vec<_>>();
    let black_rows = input_rows
        .iter()
        .filter(|row| weakness_normalize_color_played(&row.color_played) == Some("black"))
        .cloned()
        .collect::<Vec<_>>();
    let white_build =
        weakness_model::build_weakness_snapshot_v1(&white_rows, Some(per_color_limit), Some(4));
    let black_build =
        weakness_model::build_weakness_snapshot_v1(&black_rows, Some(per_color_limit), Some(4));
    let signals_by_color = weakness_model::ProfileWeaknessSignalsByColor {
        white: weakness_model::compose_profile_signals_from_upserts(
            &white_build.signals,
            &white_build.evidence,
        ),
        black: weakness_model::compose_profile_signals_from_upserts(
            &black_build.signals,
            &black_build.evidence,
        ),
    };

    let snapshot_key = format!(
        "wm:v{}:{profile_id}:{filter_sig}",
        weakness_model::WEAKNESS_MODEL_VERSION_V1
    );
    let generated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let scope_metadata = if let Some(active_filters) = &filters {
        let platform = match active_filters.platform {
            PlatformFilter::All => "all",
            PlatformFilter::Lichess => "lichess",
            PlatformFilter::ChessCom => "chesscom",
        };
        let time_control = match active_filters.time_control {
            TimeControlFilter::Any => "any",
            TimeControlFilter::Bullet => "bullet",
            TimeControlFilter::Blitz => "blitz",
            TimeControlFilter::Rapid => "rapid",
            TimeControlFilter::Classical => "classical",
        };
        let date_range = match active_filters.date_range {
            Some(DateRange::SevenDays) => "7d",
            Some(DateRange::ThirtyDays) => "30d",
            Some(DateRange::NinetyDays) => "90d",
            Some(DateRange::OneYear) => "1y",
            Some(DateRange::All) => "all",
            None => "none",
        };
        serde_json::json!({
            "scope": filter_sig,
            "platform": platform,
            "timeControl": time_control,
            "opponentEloBucket": active_filters.opponent_elo_bucket.clone(),
            "dateRange": date_range,
        })
    } else {
        serde_json::json!({
            "scope": "all",
        })
    };
    weakness_model::replace_weakness_snapshot(
        db,
        &snapshot_key,
        weakness_model::WEAKNESS_MODEL_VERSION_V1,
        &generated_at,
        &scope_metadata,
        &build.signals,
        &build.evidence,
    )?;

    let signal_limit = limit.unwrap_or(12).clamp(1, 24);
    let signal_rows = weakness_model::get_weakness_signals(db, &snapshot_key, signal_limit, 0)?;
    let mut evidence_by_signal: std::collections::HashMap<String, Vec<weakness_model::WeaknessEvidenceRow>> =
        std::collections::HashMap::new();
    for signal in &signal_rows {
        let evidence = weakness_model::get_weakness_evidence(db, &snapshot_key, &signal.signal_key, 4, 0)?;
        evidence_by_signal.insert(signal.signal_key.clone(), evidence);
    }

    Ok(weakness_model::compose_profile_weakness_model(
        snapshot_key,
        generated_at,
        build.total_games,
        build.scored_games,
        backfilled,
        signal_rows,
        evidence_by_signal,
        Some(signals_by_color),
    ))
}

/// Aggregate analyzed-game outcomes by the phase in which the game became decisively won/lost.
///
/// Returned counts are computed from the profile DB (Games + GameAnalysisStats) and respect the
/// same global filters used in other profile stats panels (platform, time control, opponent ELO, date range).
#[tauri::command]
#[specta::specta]
pub async fn get_profile_phase_outcomes(
    profile_id: String,
    filters: PlayerStatsFilters,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<analysis_stats::PhaseOutcomeBucket>> {
    let db_path = app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?;

    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions::default(),
    )?;
    ensure_db_initialized(db)?;

    analysis_stats::compute_profile_phase_outcomes(app, db, &profile_id, &filters)
}

#[tauri::command]
#[specta::specta]
pub async fn get_profile_phase_accuracy(
    profile_id: String,
    filters: PlayerStatsFilters,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<analysis_stats::PhaseAccuracyBucket>> {
    let db_path = app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?;

    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions::default(),
    )?;
    ensure_db_initialized(db)?;

    analysis_stats::compute_profile_phase_accuracy(app, db, &profile_id, &filters)
}

#[tauri::command]
#[specta::specta]
pub async fn get_profile_outcome_accuracy(
    profile_id: String,
    filters: PlayerStatsFilters,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<analysis_stats::OutcomeAccuracyStats> {
    let db_path = app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?;

    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions::default(),
    )?;
    ensure_db_initialized(db)?;

    analysis_stats::compute_profile_outcome_accuracy(app, db, &profile_id, &filters)
}

#[tauri::command]
#[specta::specta]
pub async fn get_profile_fork_stats(
    profile_id: String,
    filters: PlayerStatsFilters,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<analysis_stats::ForkStats> {
    let db_path = app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?;

    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions::default(),
    )?;
    ensure_db_initialized(db)?;

    analysis_stats::compute_profile_fork_stats(app, db, &profile_id, &filters)
}

#[tauri::command]
#[specta::specta]
pub async fn generate_profile_missed_fork_puzzles(
    profile_id: String,
    filters: PlayerStatsFilters,
    piece: Option<String>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<analysis_stats::ForkPuzzleGeneration> {
    let db_path = app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?;

    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions::default(),
    )?;
    ensure_db_initialized(db)?;

    analysis_stats::generate_profile_missed_fork_puzzles(
        app,
        db,
        &profile_id,
        &filters,
        piece.as_deref(),
    )
}

#[tauri::command]
#[specta::specta]
pub async fn get_profile_missed_fork_games(
    profile_id: String,
    filters: PlayerStatsFilters,
    piece: String,
    limit: u32,
    offset: u32,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<analysis_stats::MissedForkGameRow>> {
    let db_path = app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?;

    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions::default(),
    )?;
    ensure_db_initialized(db)?;

    analysis_stats::get_profile_missed_fork_games(
        app,
        db,
        &profile_id,
        &filters,
        &piece,
        limit,
        offset,
    )
}

#[tauri::command]
#[specta::specta]
pub async fn get_profile_outcome_reason_breakdown(
    profile_id: String,
    filters: PlayerStatsFilters,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<analysis_stats::OutcomeReasonBreakdown> {
    let db_path = app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?;

    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions::default(),
    )?;
    ensure_db_initialized(db)?;

    analysis_stats::compute_profile_outcome_reason_breakdown(app, db, &profile_id, &filters)
}

#[tauri::command]
#[specta::specta]
pub async fn get_profile_intensity_breakdown(
    profile_id: String,
    filters: PlayerStatsFilters,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<analysis_stats::IntensityBreakdown> {
    let db_path = app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?;

    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions::default(),
    )?;
    ensure_db_initialized(db)?;

    analysis_stats::compute_profile_intensity_breakdown(app, db, &profile_id, &filters)
}

#[tauri::command]
#[specta::specta]
pub async fn get_profile_intensity_outcomes(
    profile_id: String,
    filters: PlayerStatsFilters,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<analysis_stats::IntensityOutcomeBucket>> {
    let db_path = app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?;

    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions::default(),
    )?;
    ensure_db_initialized(db)?;

    analysis_stats::compute_profile_intensity_outcomes(app, db, &profile_id, &filters)
}

#[tauri::command]
#[specta::specta]
pub async fn get_profile_intensity_accuracy(
    profile_id: String,
    filters: PlayerStatsFilters,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<analysis_stats::IntensityAccuracyBucket>> {
    let db_path = app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?;

    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions::default(),
    )?;
    ensure_db_initialized(db)?;

    analysis_stats::compute_profile_intensity_accuracy(app, db, &profile_id, &filters)
}

/// List analyzed games for a given phase bucket.
///
/// This powers the Profiles -> Stats detail table when clicking a phase category.
#[tauri::command]
#[specta::specta]
pub async fn get_profile_phase_games(
    profile_id: String,
    filters: PlayerStatsFilters,
    phase: String,
    limit: u32,
    offset: u32,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<analysis_stats::PhaseGameRow>> {
    let db_path = app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?;

    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions::default(),
    )?;
    ensure_db_initialized(db)?;

    analysis_stats::get_profile_phase_games(app, db, &profile_id, &filters, &phase, limit, offset)
}

#[tauri::command]
#[specta::specta]
pub async fn get_profile_intensity_games(
    profile_id: String,
    filters: PlayerStatsFilters,
    intensity: String,
    limit: u32,
    offset: u32,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<analysis_stats::IntensityGameRow>> {
    let db_path = app
        .path()
        .resolve(format!("db/profile_{profile_id}.db3"), BaseDirectory::AppData)?;

    let db = &mut get_db_or_create(
        &state,
        db_path.to_string_lossy().as_ref(),
        ConnectionOptions::default(),
    )?;
    ensure_db_initialized(db)?;

    analysis_stats::get_profile_intensity_games(
        app, db, &profile_id, &filters, &intensity, limit, offset,
    )
}

#[derive(Serialize, Type)]
pub struct DatabaseInfo {
    title: String,
    description: String,
    player_count: i32,
    event_count: i32,
    game_count: i32,
    storage_size: i64,
    filename: String,
    indexed: bool,
}

#[derive(QueryableByName, Debug, Serialize)]
struct IndexInfo {
    #[diesel(sql_type = Text, column_name = "name")]
    _name: String,
}

fn check_index_exists(conn: &mut SqliteConnection) -> Result<bool> {
    let query = sql_query(GAMES_CHECK_INDEXES);
    let indexes: Vec<IndexInfo> = query.load(conn)?;
    Ok(!indexes.is_empty())
}

#[tauri::command]
#[specta::specta]
pub async fn get_db_info(
    file: PathBuf,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<DatabaseInfo> {
    let db_path = PathBuf::from("db").join(file);

    // OPTIMIZED: Removed - called frequently, not critical

    let path = app.path().resolve(db_path, BaseDirectory::AppData)?;

    fn is_malformed_sqlite_message(msg: &str) -> bool {
        let m = msg.to_lowercase();
        m.contains("database disk image is malformed") || m.contains("file is not a database")
    }

    fn is_locked_sqlite_message(msg: &str) -> bool {
        let m = msg.to_lowercase();
        m.contains("database is locked")
            || m.contains("database table is locked")
            || m.contains("database schema is locked")
    }

    fn cleanup_malformed_db(state: &tauri::State<'_, AppState>, path: &PathBuf) {
        let path_str = path.to_string_lossy().into_owned();
        let _ = state.connection_pool.remove(&path_str);
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(format!("{}.partial", path.display()));
    }

    fn read_database_info(db: &mut SqliteConnection, path: &PathBuf) -> Result<DatabaseInfo> {
        let player_count = players::table.count().get_result::<i64>(db)? as i32;
        let game_count = games::table.count().get_result::<i64>(db)? as i32;
        let event_count = events::table.count().get_result::<i64>(db)? as i32;

        let title = match info::table
            .filter(info::name.eq("Title"))
            .first(db)
            .map(|title_info: Info| title_info.value)
        {
            Ok(Some(title)) => title,
            _ => "Untitled".to_string(),
        };

        let description = match info::table
            .filter(info::name.eq("Description"))
            .first(db)
            .map(|description_info: Info| description_info.value)
        {
            Ok(Some(description)) => description,
            _ => "".to_string(),
        };

        let storage_size = path.metadata()?.len() as i64;
        let filename = path.file_name().expect("get filename").to_string_lossy();

        let is_indexed = check_index_exists(db)?;
        Ok(DatabaseInfo {
            title,
            description,
            player_count,
            game_count,
            event_count,
            storage_size,
            filename: filename.to_string(),
            indexed: is_indexed,
        })
    }

    // Avoid using the connection pool for lightweight metadata reads.
    // If a DB file is corrupted (e.g. interrupted download), r2d2 may retry and block for a long time.
    // Establishing directly fails fast and keeps the UI responsive.
    let mut db = match SqliteConnection::establish(path.to_str().unwrap()) {
        Ok(db) => db,
        Err(e) => {
            let msg = e.to_string();
            if is_malformed_sqlite_message(&msg) {
                cleanup_malformed_db(&state, &path);
                return Err(Error::PackageManager(
                    "Corrupted database detected and removed".to_string(),
                ));
            }
            return Err(e.into());
        }
    };
    let _ = db.batch_execute(&PRAGMA_BUSY_TIMEOUT.replace("{0}", "60000"));

    let mut res = read_database_info(&mut db, &path);
    if let Err(e) = &res {
        if is_locked_sqlite_message(&e.to_string()) {
            tokio::time::sleep(Duration::from_millis(120)).await;
            res = read_database_info(&mut db, &path);
        }
    }

    match res {
        Ok(info) => Ok(info),
        Err(e) => {
            if is_malformed_sqlite_message(&e.to_string()) {
                cleanup_malformed_db(&state, &path);
                return Err(Error::PackageManager(
                    "Corrupted database detected and removed".to_string(),
                ));
            }
            Err(e)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn create_indexes(file: PathBuf, state: tauri::State<'_, AppState>) -> Result<()> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    db.batch_execute(INDEXES_SQL)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_indexes(file: PathBuf, state: tauri::State<'_, AppState>) -> Result<()> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    db.batch_execute(DELETE_INDEXES_SQL)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn edit_db_info(
    file: PathBuf,
    title: Option<String>,
    description: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    if let Some(title) = title {
        diesel::insert_into(info::table)
            .values((info::name.eq("Title"), info::value.eq(title.clone())))
            .on_conflict(info::name)
            .do_update()
            .set(info::value.eq(title))
            .execute(db)?;
    }

    if let Some(description) = description {
        diesel::insert_into(info::table)
            .values((
                info::name.eq("Description"),
                info::value.eq(description.clone()),
            ))
            .on_conflict(info::name)
            .do_update()
            .set(info::value.eq(description))
            .execute(db)?;
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn set_profile_metadata(
    file: PathBuf,
    key: String,
    value: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    match value {
        Some(value) => {
            diesel::insert_into(info::table)
                .values((info::name.eq(key.clone()), info::value.eq(value.clone())))
                .on_conflict(info::name)
                .do_update()
                .set(info::value.eq(value))
                .execute(db)?;
        }
        None => {
            diesel::delete(info::table.filter(info::name.eq(key))).execute(db)?;
        }
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Type)]
pub enum Sides {
    BlackWhite,
    WhiteBlack,
    Any,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Type)]
pub enum GameSort {
    #[default]
    #[serde(rename = "id")]
    Id,
    #[serde(rename = "date")]
    Date,
    #[serde(rename = "whiteElo")]
    WhiteElo,
    #[serde(rename = "blackElo")]
    BlackElo,
    #[serde(rename = "averageElo")]
    AverageElo,
    #[serde(rename = "ply_count")]
    PlyCount,
}

#[derive(Default, Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Type)]
pub enum SortDirection {
    #[serde(rename = "asc")]
    Asc,
    #[default]
    #[serde(rename = "desc")]
    Desc,
}

#[derive(Default, Debug, Clone, Deserialize, PartialEq, Eq, Hash, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryOptions<SortT> {
    pub skip_count: bool,
    #[specta(optional)]
    pub page: Option<i32>,
    #[specta(optional)]
    pub page_size: Option<i32>,
    pub sort: SortT,
    pub direction: SortDirection,
}

// Helper functions for serializing/deserializing u64 as string for bigint compatibility
mod bigint_serde {
    use serde::Deserializer;

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        use serde::de::Visitor;
        use std::fmt;

        struct BigIntVisitor;

        impl<'de> Visitor<'de> for BigIntVisitor {
            type Value = Option<u64>;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a string representing a u64, a number, bigint, or null")
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(None)
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                // Handle null/unit values
                Ok(None)
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                deserializer.deserialize_any(self)
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                value.parse::<u64>().map(Some).map_err(|e| {
                    serde::de::Error::custom(format!("Failed to parse '{}' as u64: {}", value, e))
                })
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                value.parse::<u64>().map(Some).map_err(|e| {
                    serde::de::Error::custom(format!("Failed to parse '{}' as u64: {}", value, e))
                })
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(Some(value))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                if value < 0 {
                    return Err(serde::de::Error::custom(format!(
                        "Negative value {} cannot be converted to u64",
                        value
                    )));
                }
                Ok(Some(value as u64))
            }

            // Handle i128/u128 for JavaScript BigInt values
            fn visit_i128<E>(self, value: i128) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                if value < 0 {
                    return Err(serde::de::Error::custom(format!(
                        "Negative value {} cannot be converted to u64",
                        value
                    )));
                }
                if value > u64::MAX as i128 {
                    return Err(serde::de::Error::custom(format!(
                        "Value {} exceeds u64::MAX",
                        value
                    )));
                }
                Ok(Some(value as u64))
            }

            fn visit_u128<E>(self, value: u128) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                if value > u64::MAX as u128 {
                    return Err(serde::de::Error::custom(format!(
                        "Value {} exceeds u64::MAX",
                        value
                    )));
                }
                Ok(Some(value as u64))
            }

            // Handle f64 (JavaScript numbers that might be sent as floats)
            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                if value < 0.0 || value.fract() != 0.0 {
                    return Err(serde::de::Error::custom(format!(
                        "Value {} cannot be converted to u64 (must be non-negative integer)",
                        value
                    )));
                }
                Ok(Some(value as u64))
            }

            // Handle u32 (common JavaScript number range)
            fn visit_u32<E>(self, value: u32) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(Some(value as u64))
            }

            // Handle i32 (common JavaScript number range)
            fn visit_i32<E>(self, value: i32) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                if value < 0 {
                    return Err(serde::de::Error::custom(format!(
                        "Negative value {} cannot be converted to u64",
                        value
                    )));
                }
                Ok(Some(value as u64))
            }

            // Handle u16, u8, i16, i8 for completeness
            fn visit_u16<E>(self, value: u16) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(Some(value as u64))
            }

            fn visit_u8<E>(self, value: u8) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(Some(value as u64))
            }

            fn visit_i16<E>(self, value: i16) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                if value < 0 {
                    return Err(serde::de::Error::custom(format!(
                        "Negative value {} cannot be converted to u64",
                        value
                    )));
                }
                Ok(Some(value as u64))
            }

            fn visit_i8<E>(self, value: i8) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                if value < 0 {
                    return Err(serde::de::Error::custom(format!(
                        "Negative value {} cannot be converted to u64",
                        value
                    )));
                }
                Ok(Some(value as u64))
            }

            // Handle map/object case - Tauri might serialize bigint as {"type": "bigint", "value": "..."}
            // or similar structures
            fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
            where
                M: serde::de::MapAccess<'de>,
            {
                let mut value_str: Option<String> = None;
                let mut value_num: Option<u64> = None;

                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "value" | "Value" | "val" => {
                            // Try to get the value as string first
                            if let Ok(s) = map.next_value::<String>() {
                                value_str = Some(s);
                            } else if let Ok(n) = map.next_value::<u64>() {
                                value_num = Some(n);
                            } else if let Ok(n) = map.next_value::<i64>() {
                                if n >= 0 {
                                    value_num = Some(n as u64);
                                }
                            }
                        }
                        _ => {
                            // Skip unknown keys
                            let _ = map.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }

                // Prefer parsed string, then number
                if let Some(s) = value_str {
                    s.parse::<u64>().map(Some).map_err(|e| {
                        serde::de::Error::custom(format!(
                            "Failed to parse bigint value '{}' as u64: {}",
                            s, e
                        ))
                    })
                } else if let Some(n) = value_num {
                    Ok(Some(n))
                } else {
                    Err(serde::de::Error::custom(
                        "Could not extract value from bigint map structure",
                    ))
                }
            }
        }

        // Use deserialize_option to properly handle Option<u64>
        // This correctly handles null, missing fields, and actual values
        deserializer.deserialize_option(BigIntVisitor)
    }
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq, Hash, Type)]
pub struct GameQueryJs {
    #[specta(optional)]
    pub options: Option<QueryOptions<GameSort>>,
    /// Optional limit for number of game details to load (stats are always full)
    /// Used to fetch small preview (e.g., 10) and then on-demand up to 1000
    /// Using u64 instead of usize for better bigint compatibility with TypeScript
    /// Serialized as string to handle bigint in JSON
    #[specta(optional)]
    #[serde(with = "bigint_serde", default)]
    pub game_details_limit: Option<u64>,
    #[specta(optional)]
    pub player1: Option<i32>,
    #[specta(optional)]
    pub player2: Option<i32>,
    #[specta(optional)]
    pub tournament_id: Option<i32>,
    #[specta(optional)]
    pub start_date: Option<String>,
    #[specta(optional)]
    pub end_date: Option<String>,
    #[specta(optional)]
    pub range1: Option<(i32, i32)>,
    #[specta(optional)]
    pub range2: Option<(i32, i32)>,
    #[specta(optional)]
    pub sides: Option<Sides>,
    #[specta(optional)]
    pub outcome: Option<String>,
    #[specta(optional)]
    pub position: Option<PositionQueryJs>,
    #[specta(optional)]
    pub wanted_result: Option<String>,
    /// Optional time control category filter.
    /// Expected values: ultra_bullet, bullet, blitz, rapid, classical, correspondence, daily.
    #[specta(optional)]
    pub time_control_category: Option<String>,
}

impl GameQueryJs {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn position(mut self, position: PositionQueryJs) -> Self {
        self.position = Some(position);
        self
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct QueryResponse<T> {
    pub data: T,
    pub count: Option<i32>,
}

#[tauri::command]
#[specta::specta]
pub async fn get_games(
    file: PathBuf,
    query: GameQueryJs,
    state: tauri::State<'_, AppState>,
) -> Result<QueryResponse<Vec<NormalizedGame>>> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    let mut count: Option<i64> = None;
    let query_options = query.options.unwrap_or_default();

    let (white_players, black_players) = diesel::alias!(players as white, players as black);
    let mut sql_query = games::table
        .inner_join(white_players.on(games::white_id.eq(white_players.field(players::id))))
        .inner_join(black_players.on(games::black_id.eq(black_players.field(players::id))))
        .inner_join(events::table.on(games::event_id.eq(events::id)))
        .inner_join(sites::table.on(games::site_id.eq(sites::id)))
        .into_boxed();
    let mut count_query = games::table.into_boxed();

    // if let Some(speed) = query.speed {
    //     sql_query = sql_query.filter(games::speed.eq(speed as i32));
    //     count_query = count_query.filter(games::speed.eq(speed as i32));
    // }

    if let Some(outcome) = query.outcome {
        sql_query = sql_query.filter(games::result.eq(outcome.clone()));
        count_query = count_query.filter(games::result.eq(outcome));
    }

    if let Some(start_date) = query.start_date {
        sql_query = sql_query.filter(games::date.ge(start_date.clone()));
        count_query = count_query.filter(games::date.ge(start_date));
    }

    if let Some(end_date) = query.end_date {
        sql_query = sql_query.filter(games::date.le(end_date.clone()));
        count_query = count_query.filter(games::date.le(end_date));
    }

    if let Some(tournament_id) = query.tournament_id {
        sql_query = sql_query.filter(games::event_id.eq(tournament_id));
        count_query = count_query.filter(games::event_id.eq(tournament_id));
    }

    if let Some(category) = query.time_control_category.as_deref() {
        let normalized = category.trim().to_lowercase();
        let tc_lower_sql = "lower(Games.TimeControl)";
        let total_seconds_sql = "(CASE \
            WHEN Games.TimeControl IS NULL THEN NULL \
            WHEN Games.TimeControl = '-' THEN NULL \
            WHEN Games.TimeControl LIKE '1/%' THEN NULL \
            WHEN instr(Games.TimeControl,'+') > 0 THEN \
              CAST(substr(Games.TimeControl,1,instr(Games.TimeControl,'+')-1) AS INTEGER) + \
              CAST(substr(Games.TimeControl,instr(Games.TimeControl,'+')+1) AS INTEGER) * 40 \
            ELSE CAST(Games.TimeControl AS INTEGER) \
          END)";

        let clause: Option<String> = match normalized.as_str() {
            "correspondence" => Some(format!(
                "Games.TimeControl = '-' OR {tc_lower_sql} LIKE '%correspondence%'"
            )),
            "daily" => Some(format!("Games.TimeControl LIKE '1/%' OR {tc_lower_sql} LIKE '%daily%'")),
            "ultra_bullet" => Some(format!(
                "{tc_lower_sql} LIKE '%ultra%' OR ({total_seconds_sql} < 30)"
            )),
            "bullet" => Some(format!(
                "{tc_lower_sql} LIKE '%bullet%' OR ({total_seconds_sql} >= 30 AND {total_seconds_sql} < 180)"
            )),
            "blitz" => Some(format!(
                "{tc_lower_sql} LIKE '%blitz%' OR ({total_seconds_sql} >= 180 AND {total_seconds_sql} < 480)"
            )),
            "rapid" => Some(format!(
                "{tc_lower_sql} LIKE '%rapid%' OR ({total_seconds_sql} >= 480 AND {total_seconds_sql} < 1500)"
            )),
            "classical" => Some(format!(
                "{tc_lower_sql} LIKE '%classical%' OR ({total_seconds_sql} >= 1500)"
            )),
            _ => None,
        };

        if let Some(where_sql) = clause {
            sql_query =
                sql_query.filter(diesel::dsl::sql::<diesel::sql_types::Bool>(where_sql.as_str()));
            count_query =
                count_query.filter(diesel::dsl::sql::<diesel::sql_types::Bool>(where_sql.as_str()));
        }
    }

    if let Some(limit) = query_options.page_size {
        sql_query = sql_query.limit(limit as i64);
    }

    if let Some(page) = query_options.page {
        sql_query = sql_query.offset(((page - 1) * query_options.page_size.unwrap_or(10)) as i64);
    }

    match query.sides {
        Some(Sides::BlackWhite) => {
            if let Some(player1) = query.player1 {
                sql_query = sql_query.filter(games::black_id.eq(player1));
                count_query = count_query.filter(games::black_id.eq(player1));
            }
            if let Some(player2) = query.player2 {
                sql_query = sql_query.filter(games::white_id.eq(player2));
                count_query = count_query.filter(games::white_id.eq(player2));
            }

            if let Some(range1) = query.range1 {
                sql_query = sql_query.filter(games::black_elo.between(range1.0, range1.1));
                count_query = count_query.filter(games::black_elo.between(range1.0, range1.1));
            }

            if let Some(range2) = query.range2 {
                sql_query = sql_query.filter(games::white_elo.between(range2.0, range2.1));
                count_query = count_query.filter(games::white_elo.between(range2.0, range2.1));
            }
        }
        Some(Sides::WhiteBlack) => {
            if let Some(player1) = query.player1 {
                sql_query = sql_query.filter(games::white_id.eq(player1));
                count_query = count_query.filter(games::white_id.eq(player1));
            }
            if let Some(player2) = query.player2 {
                sql_query = sql_query.filter(games::black_id.eq(player2));
                count_query = count_query.filter(games::black_id.eq(player2));
            }

            if let Some(range1) = query.range1 {
                sql_query = sql_query.filter(games::white_elo.between(range1.0, range1.1));
                count_query = count_query.filter(games::white_elo.between(range1.0, range1.1));
            }

            if let Some(range2) = query.range2 {
                sql_query = sql_query.filter(games::black_elo.between(range2.0, range2.1));
                count_query = count_query.filter(games::black_elo.between(range2.0, range2.1));
            }
        }
        Some(Sides::Any) => {
            if let Some(player1) = query.player1 {
                sql_query =
                    sql_query.filter(games::white_id.eq(player1).or(games::black_id.eq(player1)));
                count_query =
                    count_query.filter(games::white_id.eq(player1).or(games::black_id.eq(player1)));
            }
            if let Some(player2) = query.player2 {
                sql_query =
                    sql_query.filter(games::white_id.eq(player2).or(games::black_id.eq(player2)));
                count_query =
                    count_query.filter(games::white_id.eq(player2).or(games::black_id.eq(player2)));
            }

            if let (Some(range1), Some(range2)) = (query.range1, query.range2) {
                sql_query = sql_query.filter(
                    games::white_elo
                        .between(range1.0, range1.1)
                        .or(games::black_elo.between(range1.0, range1.1))
                        .or(games::white_elo
                            .between(range2.0, range2.1)
                            .or(games::black_elo.between(range2.0, range2.1))),
                );
                count_query = count_query.filter(
                    games::white_elo
                        .between(range1.0, range1.1)
                        .or(games::black_elo.between(range1.0, range1.1))
                        .or(games::white_elo
                            .between(range2.0, range2.1)
                            .or(games::black_elo.between(range2.0, range2.1))),
                );
            } else {
                if let Some(range1) = query.range1 {
                    sql_query = sql_query.filter(
                        games::white_elo
                            .between(range1.0, range1.1)
                            .or(games::black_elo.between(range1.0, range1.1)),
                    );
                    count_query = count_query.filter(
                        games::white_elo
                            .between(range1.0, range1.1)
                            .or(games::black_elo.between(range1.0, range1.1)),
                    );
                }

                if let Some(range2) = query.range2 {
                    sql_query = sql_query.filter(
                        games::white_elo
                            .between(range2.0, range2.1)
                            .or(games::black_elo.between(range2.0, range2.1)),
                    );
                    count_query = count_query.filter(
                        games::white_elo
                            .between(range2.0, range2.1)
                            .or(games::black_elo.between(range2.0, range2.1)),
                    );
                }
            }
        }
        None => {}
    }

    sql_query = match query_options.sort {
        GameSort::Id => match query_options.direction {
            SortDirection::Asc => sql_query.order(games::id.asc()),
            SortDirection::Desc => sql_query.order(games::id.desc()),
        },
        GameSort::Date => match query_options.direction {
            SortDirection::Asc => sql_query.order((games::date.asc(), games::time.asc())),
            SortDirection::Desc => sql_query.order((games::date.desc(), games::time.desc())),
        },
        GameSort::WhiteElo => match query_options.direction {
            SortDirection::Asc => sql_query.order(games::white_elo.asc()),
            SortDirection::Desc => sql_query.order(games::white_elo.desc()),
        },
        GameSort::BlackElo => match query_options.direction {
            SortDirection::Asc => sql_query.order(games::black_elo.asc()),
            SortDirection::Desc => sql_query.order(games::black_elo.desc()),
        },
        GameSort::AverageElo => {
            // AverageElo will be sorted in Rust after calculating
            sql_query
        }
        GameSort::PlyCount => match query_options.direction {
            SortDirection::Asc => sql_query.order(games::ply_count.asc()),
            SortDirection::Desc => sql_query.order(games::ply_count.desc()),
        },
    };

    if !query_options.skip_count {
        count = Some(
            count_query
                .select(diesel::dsl::count(games::id))
                .first(db)?,
        );
    }

    let games: Vec<(Game, Player, Player, Event, Site)> = sql_query.load(db)?;
    let mut normalized_games = normalize_games(games)?;

    // Sort by average ELO if needed (calculated in Rust)
    if matches!(query_options.sort, GameSort::AverageElo) {
        normalized_games.sort_by(|a, b| {
            // Calculate average ELO: (white_elo + black_elo) / 2, rounded
            // If only one ELO is available, use that one
            // If neither is available, treat as 0 for sorting purposes
            let a_avg = match (a.white_elo, a.black_elo) {
                (Some(white), Some(black)) => {
                    // Round the average (same as Math.round in TypeScript)
                    let sum = white + black;
                    Some((sum + 1) / 2) // This is equivalent to rounding for integers
                }
                (Some(elo), None) | (None, Some(elo)) => Some(elo),
                (None, None) => None,
            };
            let b_avg = match (b.white_elo, b.black_elo) {
                (Some(white), Some(black)) => {
                    let sum = white + black;
                    Some((sum + 1) / 2)
                }
                (Some(elo), None) | (None, Some(elo)) => Some(elo),
                (None, None) => None,
            };

            // For sorting, treat None as 0 (lowest priority)
            let a_val = a_avg.unwrap_or(0);
            let b_val = b_avg.unwrap_or(0);

            match query_options.direction {
                SortDirection::Asc => a_val.cmp(&b_val),
                SortDirection::Desc => b_val.cmp(&a_val), // Descending: higher ELO first
            }
        });
    }

    Ok(QueryResponse {
        data: normalized_games,
        count: count.map(|c| c as i32),
    })
}

fn normalize_games(games: Vec<(Game, Player, Player, Event, Site)>) -> Result<Vec<NormalizedGame>> {
    games
        .into_iter()
        .map(|(game, white, black, event, site)| {
            core::normalize_game(game, white, black, event, site)
        })
        .collect::<Result<_>>()
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct PlayerQuery {
    pub options: QueryOptions<PlayerSort>,
    #[specta(optional)]
    pub name: Option<String>,
    #[specta(optional)]
    pub range: Option<(i32, i32)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum PlayerSort {
    #[serde(rename = "id")]
    Id,
    #[serde(rename = "name")]
    Name,
    #[serde(rename = "elo")]
    Elo,
}

#[tauri::command]
#[specta::specta]
pub async fn get_player(
    file: PathBuf,
    id: i32,
    state: tauri::State<'_, AppState>,
) -> Result<Option<Player>> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    let player = players::table
        .filter(players::id.eq(id))
        .first::<Player>(db)
        .optional()?;
    Ok(player)
}

#[tauri::command]
#[specta::specta]
pub async fn get_players(
    file: PathBuf,
    query: PlayerQuery,
    state: tauri::State<'_, AppState>,
) -> Result<QueryResponse<Vec<Player>>> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    let mut count: Option<i64> = None;

    let mut sql_query = players::table.into_boxed();
    let mut count_query = players::table.into_boxed();
    sql_query = sql_query.filter(players::name.is_not("Unknown"));
    count_query = count_query.filter(players::name.is_not("Unknown"));

    if let Some(name) = query.name {
        sql_query = sql_query.filter(players::name.like(format!("%{}%", name)));
        count_query = count_query.filter(players::name.like(format!("%{}%", name)));
    }

    if let Some(range) = query.range {
        sql_query = sql_query.filter(players::elo.between(range.0, range.1));
        count_query = count_query.filter(players::elo.between(range.0, range.1));
    }

    if !query.options.skip_count {
        count = Some(count_query.count().get_result(db)?);
    }

    if let Some(limit) = query.options.page_size {
        sql_query = sql_query.limit(limit as i64);
    }

    if let Some(page) = query.options.page {
        sql_query = sql_query.offset(((page - 1) * query.options.page_size.unwrap_or(10)) as i64);
    }

    sql_query = match query.options.sort {
        PlayerSort::Id => match query.options.direction {
            SortDirection::Asc => sql_query.order(players::id.asc()),
            SortDirection::Desc => sql_query.order(players::id.desc()),
        },
        PlayerSort::Name => match query.options.direction {
            SortDirection::Asc => sql_query.order(players::name.asc()),
            SortDirection::Desc => sql_query.order(players::name.desc()),
        },
        PlayerSort::Elo => match query.options.direction {
            SortDirection::Asc => sql_query.order(players::elo.asc()),
            SortDirection::Desc => sql_query.order(players::elo.desc()),
        },
    };

    let players = sql_query.load::<Player>(db)?;

    Ok(QueryResponse {
        data: players,
        count: count.map(|c| c as i32),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum TournamentSort {
    #[serde(rename = "id")]
    Id,
    #[serde(rename = "name")]
    Name,
    #[serde(rename = "start_date")]
    StartDate,
    #[serde(rename = "end_date")]
    EndDate,
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct TournamentQuery {
    pub options: QueryOptions<TournamentSort>,
    pub name: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn get_tournaments(
    file: PathBuf,
    query: TournamentQuery,
    state: tauri::State<'_, AppState>,
) -> Result<QueryResponse<Vec<Event>>> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    ensure_db_initialized(db)?;
    let mut count: Option<i64> = None;

    let mut sql_query = events::table.into_boxed();
    let mut count_query = events::table.into_boxed();
    sql_query = sql_query.filter(events::name.is_not("Unknown"));
    count_query = count_query.filter(events::name.is_not("Unknown"));

    if let Some(name) = query.name {
        sql_query = sql_query.filter(events::name.like(format!("%{}%", name)));
        count_query = count_query.filter(events::name.like(format!("%{}%", name)));
    }

    if !query.options.skip_count {
        count = Some(count_query.count().get_result(db)?);
    }

    if let Some(limit) = query.options.page_size {
        sql_query = sql_query.limit(limit as i64);
    }

    if let Some(page) = query.options.page {
        sql_query = sql_query.offset(((page - 1) * query.options.page_size.unwrap_or(10)) as i64);
    }

    sql_query = match query.options.sort {
        TournamentSort::Id => match query.options.direction {
            SortDirection::Asc => sql_query.order(events::id.asc()),
            SortDirection::Desc => sql_query.order(events::id.desc()),
        },
        TournamentSort::Name => match query.options.direction {
            SortDirection::Asc => sql_query.order(events::name.asc()),
            SortDirection::Desc => sql_query.order(events::name.desc()),
        },
        TournamentSort::StartDate => match query.options.direction {
            SortDirection::Asc => sql_query.order(events::start_date.asc()),
            SortDirection::Desc => sql_query.order(events::start_date.desc()),
        },
        TournamentSort::EndDate => match query.options.direction {
            SortDirection::Asc => sql_query.order(events::end_date.asc()),
            SortDirection::Desc => sql_query.order(events::end_date.desc()),
        },
    };

    let events = sql_query.load::<Event>(db)?;

    Ok(QueryResponse {
        data: events,
        count: count.map(|c| c as i32),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum ManagedEventType {
    #[serde(rename = "otb_tournament")]
    OtbTournament,
    #[serde(rename = "online_tournament")]
    OnlineTournament,
    #[serde(rename = "league")]
    League,
}

impl ManagedEventType {
    fn as_str(&self) -> &'static str {
        match self {
            ManagedEventType::OtbTournament => "otb_tournament",
            ManagedEventType::OnlineTournament => "online_tournament",
            ManagedEventType::League => "league",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateManagedEventPayload {
    pub name: String,
    pub event_type: ManagedEventType,
    #[specta(optional)]
    pub location: Option<String>,
    #[specta(optional)]
    pub start_date: Option<String>,
    #[specta(optional)]
    pub end_date: Option<String>,
    #[specta(optional)]
    pub time_control: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn upsert_managed_event(
    file: PathBuf,
    payload: CreateManagedEventPayload,
    state: tauri::State<'_, AppState>,
) -> Result<Event> {
    use crate::db::schema::events;

    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    ensure_db_initialized(db)?;

    let name = payload.name.trim().to_string();
    if name.is_empty() {
        return Err(Error::InvalidInput("Event name cannot be empty".to_string()));
    }

    let event_type = payload.event_type.as_str();
    let location = payload.location.as_ref().map(|s| s.trim().to_string());
    let start_date = payload.start_date.as_ref().map(|s| s.trim().to_string());
    let end_date = payload.end_date.as_ref().map(|s| s.trim().to_string());
    let time_control = payload.time_control.as_ref().map(|s| s.trim().to_string());

    diesel::insert_into(events::table)
        .values((
            events::name.eq(&name),
            events::event_type.eq(Some(event_type)),
            events::location.eq(location.as_deref()),
            events::start_date.eq(start_date.as_deref()),
            events::end_date.eq(end_date.as_deref()),
            events::time_control.eq(time_control.as_deref()),
        ))
        .on_conflict(events::name)
        .do_update()
        .set((
            events::event_type.eq(Some(event_type)),
            events::location.eq(location.as_deref()),
            events::start_date.eq(start_date.as_deref()),
            events::end_date.eq(end_date.as_deref()),
            events::time_control.eq(time_control.as_deref()),
        ))
        .execute(db)?;

    let event = events::table
        .filter(events::name.eq(&name))
        .first::<Event>(db)?;
    Ok(event)
}

#[tauri::command]
#[specta::specta]
pub async fn list_managed_events(
    file: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Event>> {
    use crate::db::schema::events;

    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    ensure_db_initialized(db)?;

    let out = events::table
        .filter(events::event_type.is_not_null())
        .order(events::id.asc())
        .load::<Event>(db)?;
    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_managed_event(
    file: PathBuf,
    event_id: i32,
    state: tauri::State<'_, AppState>,
) -> Result<bool> {
    use crate::db::schema::{comments, events, games};

    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    ensure_db_initialized(db)?;

    let deleted = db.transaction::<_, Error, _>(|db| {
        let event_exists = events::table
            .filter(events::id.eq(event_id))
            .select(events::id)
            .first::<i32>(db)
            .optional()?
            .is_some();

        if !event_exists {
            return Ok(false);
        }

        let game_ids = games::table
            .filter(games::event_id.eq(event_id))
            .select(games::id)
            .load::<i32>(db)?;

        if !game_ids.is_empty() && sqlite_table_exists(db, "Comments")? {
            diesel::delete(comments::table.filter(comments::game_id.eq_any(&game_ids)))
                .execute(db)?;
        }

        diesel::delete(games::table.filter(games::event_id.eq(event_id))).execute(db)?;
        diesel::delete(events::table.filter(events::id.eq(event_id))).execute(db)?;

        Ok(true)
    })?;

    Ok(deleted)
}

#[derive(Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AddEventGamesFromPgnOptions {
    #[specta(optional)]
    pub date: Option<String>,
    #[specta(optional)]
    pub round: Option<String>,
    #[specta(optional)]
    pub result: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn add_event_games_from_pgn(
    file: PathBuf,
    event_id: i32,
    pgn: String,
    options: Option<AddEventGamesFromPgnOptions>,
    state: tauri::State<'_, AppState>,
) -> Result<i32> {
    use crate::db::schema::events;

    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    ensure_db_initialized(db)?;

    if event_id <= 0 {
        return Err(Error::InvalidInput("Invalid event id".to_string()));
    }

    let trimmed = pgn.trim();
    if trimmed.is_empty() {
        return Err(Error::InvalidInput("PGN cannot be empty".to_string()));
    }
    let normalized_pgn = normalize_pgn_for_import(trimmed);

    let (event_type, event_time_control) = events::table
        .filter(events::id.eq(event_id))
        .select((events::event_type, events::time_control))
        .first::<(Option<String>, Option<String>)>(db)
        .optional()?
        .ok_or_else(|| Error::InvalidInput("Event not found".to_string()))?;
    let preferred_site_name = match event_type.as_deref() {
        Some("online_tournament") => Some("Online"),
        Some("league") => Some("League"),
        _ => Some("OTB"),
    };
    let forced_date = options
        .as_ref()
        .and_then(|value| value.date.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "?" && !value.contains('?'))
        .map(|value| value.to_string());
    let forced_round = options
        .as_ref()
        .and_then(|value| value.round.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "?")
        .map(|value| value.to_string());
    let forced_result = match options
        .as_ref()
        .and_then(|value| value.result.as_deref())
        .map(str::trim)
    {
        Some("1-0") => Some("1-0".to_string()),
        Some("0-1") => Some("0-1".to_string()),
        Some("1/2-1/2") => Some("1/2-1/2".to_string()),
        Some("*") => Some("*".to_string()),
        _ => None,
    };

    let mut importer = Importer::new(None);
    let mut inserted_total: i32 = 0;
    let mut parsed_total: i32 = 0;
    let mut parse_errors: i32 = 0;
    let mut first_parse_error: Option<String> = None;

    db.transaction::<_, Error, _>(|db| {
        for parsed in BufferedReader::new_cursor(normalized_pgn.as_bytes()).into_iter(&mut importer) {
            match parsed {
                Ok(Some(game)) => {
                    parsed_total += 1;
                    let mut game = game;
                    if let Some(date) = forced_date.as_ref() {
                        game.date = Some(date.clone());
                    }
                    if let Some(round) = forced_round.as_ref() {
                        game.round = Some(round.clone());
                    }
                    if let Some(result) = forced_result.as_ref() {
                        game.result = Some(result.clone());
                    }
                    let inserted = insert_to_db_with_event_override(
                        db,
                        &game,
                        event_id,
                        preferred_site_name,
                        event_time_control.as_deref(),
                    )?;
                    if inserted {
                        inserted_total += 1;
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    parse_errors += 1;
                    if first_parse_error.is_none() {
                        first_parse_error = Some(e.to_string());
                    }
                }
            }
        }
        Ok(())
    })?;

    if parsed_total == 0 {
        let detail = first_parse_error
            .map(|e| format!(": {e}"))
            .unwrap_or_default();
        return Err(Error::InvalidInput(format!(
            "No PGN games could be parsed{detail}"
        )));
    }

    if inserted_total == 0 && parse_errors > 0 {
        let detail = first_parse_error
            .map(|e| format!(": {e}"))
            .unwrap_or_default();
        return Err(Error::InvalidInput(format!(
            "PGN parsing failed for all candidate games{detail}"
        )));
    }

    Ok(inserted_total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weakness_filter_signature_all_any_all_all_time() {
        let filters = Some(PlayerStatsFilters {
            platform: PlatformFilter::All,
            time_control: TimeControlFilter::Any,
            opponent_elo_bucket: None,
            date_range: Some(DateRange::All),
        });

        let signature = weakness_filter_signature(&filters);
        assert_eq!(signature, "p-all_tc-any_elo-all_dr-all");
    }
}

#[tauri::command]
#[specta::specta]
pub async fn add_profile_games_from_pgn(
    profile_id: String,
    source_player_name: String,
    pgn: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<i32> {
    let trimmed = pgn.trim();
    if trimmed.is_empty() {
        return Err(Error::InvalidInput("PGN cannot be empty".to_string()));
    }

    let db_path = app.path().resolve(
        format!("db/profile_{profile_id}.db3"),
        BaseDirectory::AppData,
    )?;

    let db = &mut get_db_or_create(&state, db_path.to_str().unwrap(), ConnectionOptions::default())?;
    ensure_db_initialized(db)?;

    // Normalize a player name so we can match variants like "Last, First" vs "Last First".
    fn normalize_name(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut prev_space = true;
        for ch in s.chars() {
            let c = ch.to_ascii_lowercase();
            if c.is_ascii_alphanumeric() {
                out.push(c);
                prev_space = false;
            } else if c.is_whitespace() || c == '-' || c == '_' || c == ',' || c == '.' {
                if !prev_space {
                    out.push(' ');
                    prev_space = true;
                }
            }
        }
        out.trim().to_string()
    }

    let mut importer = Importer::new(None);
    let mut inserted_total: i32 = 0;
    let mut name_counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut normalized_counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();

    db.transaction::<_, Error, _>(|db| {
        for game in BufferedReader::new_cursor(trimmed.as_bytes())
            .into_iter(&mut importer)
            .flatten()
            .flatten()
        {
            if let Some(w) = game.white_name.as_ref() {
                if !w.trim().is_empty() {
                    *name_counts.entry(w.trim().to_string()).or_insert(0) += 1;
                    let nw = normalize_name(w);
                    if !nw.is_empty() {
                        *normalized_counts.entry(nw).or_insert(0) += 1;
                    }
                }
            }
            if let Some(b) = game.black_name.as_ref() {
                if !b.trim().is_empty() {
                    *name_counts.entry(b.trim().to_string()).or_insert(0) += 1;
                    let nb = normalize_name(b);
                    if !nb.is_empty() {
                        *normalized_counts.entry(nb).or_insert(0) += 1;
                    }
                }
            }

            let inserted = insert_to_db_with_event_override(db, &game, 0, None, None)?;
            if inserted {
                inserted_total += 1;
            }
        }
        Ok(())
    })?;

    // Pick the profile "main player" so dashboards can reliably compute opponents.
    let preferred_norm = normalize_name(&source_player_name);
    let mut best_norm: Option<(String, u32, u8)> = None;
    for (norm, count) in &normalized_counts {
        let score = if !preferred_norm.is_empty() && norm == &preferred_norm {
            3u8
        } else if !preferred_norm.is_empty() && (norm.contains(&preferred_norm) || preferred_norm.contains(norm)) {
            2u8
        } else {
            1u8
        };
        let candidate = (norm.clone(), *count, score);
        best_norm = match best_norm {
            None => Some(candidate),
            Some(prev) => {
                if candidate.2 > prev.2 || (candidate.2 == prev.2 && candidate.1 > prev.1) {
                    Some(candidate)
                } else {
                    Some(prev)
                }
            }
        };
    }

    let main_player_name = best_norm
        .as_ref()
        .and_then(|(norm, _count, _score)| {
            name_counts
                .iter()
                .filter(|(name, _)| normalize_name(name) == *norm)
                .max_by_key(|(_, c)| *c)
                .map(|(name, _)| name.clone())
        })
        .or_else(|| {
            // Fallback: most frequent raw name observed in the PGN.
            name_counts
                .iter()
                .max_by_key(|(_, c)| *c)
                .map(|(name, _)| name.clone())
        })
        .or_else(|| {
            // Last resort: use the provided source name (may not match a real player row).
            let s = source_player_name.trim();
            if s.is_empty() { None } else { Some(s.to_string()) }
        });

    let existing_profile_player_id: Option<String> = info::table
        .filter(info::name.eq("ProfilePlayerId"))
        .select(info::value)
        .first::<Option<String>>(db)
        .optional()?
        .flatten();

    let should_override_profile_player = existing_profile_player_id.is_none() || !source_player_name.trim().is_empty();
    if should_override_profile_player {
        if let Some(main_player_name) = main_player_name {
            let pid = create_player(db, &main_player_name)?.id;
            upsert_info_value(db, "ProfilePlayerId", &pid.to_string())?;
            upsert_info_value(db, "ProfilePlayerName", &main_player_name)?;
        }
    }

    Ok(inserted_total)
}

#[derive(Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateEventGamePayload {
    pub white: String,
    pub black: String,
    #[specta(optional)]
    pub date: Option<String>,
    #[specta(optional)]
    pub round: Option<String>,
    pub result: Outcome,
}

#[tauri::command]
#[specta::specta]
pub async fn create_event_game(
    file: PathBuf,
    event_id: i32,
    payload: CreateEventGamePayload,
    state: tauri::State<'_, AppState>,
) -> Result<i32> {
    use crate::db::schema::{events, games};

    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    ensure_db_initialized(db)?;

    if event_id <= 0 {
        return Err(Error::InvalidInput("Invalid event id".to_string()));
    }

    // Resolve event metadata for default site/time control.
    let (event_type, event_time_control) = events::table
        .filter(events::id.eq(event_id))
        .select((events::event_type, events::time_control))
        .first::<(Option<String>, Option<String>)>(db)?;

    let white_name = payload.white.trim().to_string();
    let black_name = payload.black.trim().to_string();
    if white_name.is_empty() || black_name.is_empty() {
        return Err(Error::InvalidInput(
            "White and Black player names are required".to_string(),
        ));
    }

    let white_id = create_player(db, &white_name)?.id;
    let black_id = create_player(db, &black_name)?.id;

    let site_name = match event_type.as_deref() {
        Some("online_tournament") => "Online",
        Some("league") => "League",
        _ => "OTB",
    };
    let site_id = create_site(db, site_name)?.id;

    let mut moves: Vec<u8> = Vec::new();
    GameTree::new().encode(&mut moves, None);

    let pos = Chess::default();
    let pawn_home = get_pawn_home(pos.board());
    let material = pgn::get_material_count(pos.board());
    let white_material = material.white as i32;
    let black_material = material.black as i32;

    let date = payload.date.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    let round = payload.round.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());

    let result_str = payload.result.to_string();

    let new_game = NewGame {
        event_id,
        site_id,
        date,
        time: None,
        round,
        white_id,
        white_elo: None,
        black_id,
        black_elo: None,
        white_material,
        black_material,
        result: Some(result_str.as_str()),
        termination: None,
        time_control: event_time_control.as_deref(),
        eco: None,
        ply_count: 0,
        fen: None,
        moves: moves.as_slice(),
        pawn_home: pawn_home as i32,
    };

    // We may hit the dedupe index; insert-or-ignore and then fetch the matching row ID.
    diesel::insert_or_ignore_into(games::table)
        .values(&new_game)
        .execute(db)?;

    let game_id = games::table
        .filter(games::event_id.eq(event_id))
        .filter(games::site_id.eq(site_id))
        .filter(games::white_id.eq(white_id))
        .filter(games::black_id.eq(black_id))
        .filter(games::moves.eq(moves.as_slice()))
        .filter(games::date.eq(date))
        .filter(games::time.is_null())
        .order(games::id.desc())
        .select(games::id)
        .first::<i32>(db)?;

    Ok(game_id)
}

#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct PlayerGameInfo {
    pub site_stats_data: Vec<SiteStatsData>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, Type)]
#[repr(u8)] // Ensure minimal memory usage (as u8)
pub enum GameOutcome {
    #[default]
    Won = 0,
    Drawn = 1,
    Lost = 2,
}

impl GameOutcome {
    pub fn from_str(result_str: &str, is_white: bool) -> Option<Self> {
        match result_str {
            "1-0" => Some(if is_white {
                GameOutcome::Won
            } else {
                GameOutcome::Lost
            }),
            "1/2-1/2" => Some(GameOutcome::Drawn),
            "0-1" => Some(if is_white {
                GameOutcome::Lost
            } else {
                GameOutcome::Won
            }),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct SiteStatsData {
    pub site: String,
    pub player: String,
    pub data: Vec<StatsData>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct StatsData {
    pub date: String,
    pub time: Option<String>,
    pub is_player_white: bool,
    pub player_elo: i32,
    pub opponent_elo: Option<i32>,
    pub result: GameOutcome,
    pub time_control: String,
    pub opening: String,
}

#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct ProfileSidebarStats {
    pub sidebar_model: PlayerSidebarModel,
    pub elo_buckets: Vec<EloBucket>,
}

#[derive(Serialize, Debug, Clone, Type, tauri_specta::Event)]
pub struct DatabaseProgress {
    pub id: String,
    pub progress: f64,
}

fn normalize_account_key_parts(raw: &str) -> Option<(String, String)> {
    let normalized = raw.trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }

    let stripped = normalized
        .strip_prefix("lichess:")
        .or_else(|| normalized.strip_prefix("chesscom:"))
        .unwrap_or(&normalized)
        .trim()
        .to_string();

    if stripped.is_empty() {
        return None;
    }

    Some((normalized, stripped))
}

fn collect_player_game_info(
    db: &mut SqliteConnection,
    id: i32,
    include_opening: bool,
    app: Option<&tauri::AppHandle>,
) -> Result<PlayerGameInfo> {
    type GameInfo = (
        i32,
        i32,
        Option<String>,
        Option<String>,
        Option<String>,
        Vec<u8>,
        Option<i32>,
        Option<i32>,
        Option<String>,
        Option<String>,
        Option<String>,
    );

    let info: Vec<GameInfo> = games::table
        .inner_join(sites::table.on(games::site_id.eq(sites::id)))
        .inner_join(players::table.on(players::id.eq(id)))
        .select((
            games::white_id,
            games::black_id,
            games::result,
            games::date,
            games::time,
            games::moves,
            games::white_elo,
            games::black_elo,
            games::time_control,
            sites::name,
            players::name,
        ))
        .filter(games::white_id.eq(id).or(games::black_id.eq(id)))
        .filter(games::fen.is_null())
        .load(db)?;

    let mut game_info = PlayerGameInfo::default();
    let progress = AtomicUsize::new(0);
    game_info.site_stats_data = info
        .par_iter()
        .filter_map(
            |(
                white_id,
                black_id,
                outcome,
                date,
                time,
                moves,
                white_elo,
                black_elo,
                time_control,
                site,
                player,
            )| {
                let is_white = *white_id == id;
                let is_black = *black_id == id;
                let result = GameOutcome::from_str(outcome.as_deref()?, is_white);

                if !is_white && !is_black
                    || is_white && white_elo.is_none()
                    || is_black && black_elo.is_none()
                    || result.is_none()
                    || date.is_none()
                    || site.is_none()
                    || player.is_none()
                {
                    return None;
                }

                let site = site.as_deref().map(|s| {
                    if s.starts_with("https://lichess.org/") {
                        "Lichess".to_string()
                    } else {
                        s.to_string()
                    }
                })?;

                let opening = if include_opening {
                    let mut setups = vec![];
                    let mut chess = Chess::default();

                    // Extract main line moves from the extended format
                    let main_moves = match extract_main_line_moves(moves, Some(chess.clone())) {
                        Ok(moves) => moves,
                        Err(_) => {
                            // If extraction fails, skip this game
                            return None;
                        }
                    };

                    for (i, m) in main_moves.iter().enumerate() {
                        if i > 54 {
                            // max length of opening in data
                            break;
                        }
                        chess.play_unchecked(m);
                        setups.push(chess.clone().into_setup(EnPassantMode::Legal));
                    }

                    setups.reverse();
                    setups
                        .iter()
                        .find_map(|setup| get_opening_from_setup(setup.clone()).ok())
                        .unwrap_or_default()
                } else {
                    String::new()
                };

                if let Some(app) = app {
                    let p = progress.fetch_add(1, Ordering::Relaxed);
                    if p % 1000 == 0 || p == info.len() - 1 {
                        let _ = DatabaseProgress {
                            id: id.to_string(),
                            progress: (p as f64 / info.len() as f64) * 100_f64,
                        }
                        .emit(app);
                    }
                }

                Some(SiteStatsData {
                    site: site.clone(),
                    player: player.clone().unwrap(),
                    data: vec![StatsData {
                        date: date.clone().unwrap(),
                        time: time.clone(),
                        is_player_white: is_white,
                        player_elo: if is_white {
                            white_elo.unwrap()
                        } else {
                            black_elo.unwrap()
                        },
                        opponent_elo: if is_white { *black_elo } else { *white_elo },
                        result: result.unwrap(),
                        time_control: time_control.clone().unwrap_or_default(),
                        opening,
                    }],
                })
            },
        )
        .fold(
            || DashMap::new(),
            |acc, data| {
                acc.entry((data.site.clone(), data.player.clone()))
                    .or_insert_with(Vec::new)
                    .extend(data.data);
                acc
            },
        )
        .reduce(
            || DashMap::new(),
            |acc1, acc2| {
                for ((site, player), data) in acc2 {
                    acc1.entry((site, player))
                        .or_insert_with(Vec::new)
                        .extend(data);
                }
                acc1
            },
        )
        .into_iter()
        .map(|((site, player), data)| SiteStatsData { site, player, data })
        .collect();

    Ok(game_info)
}

#[tauri::command]
#[specta::specta]
pub async fn get_players_game_info(
    file: PathBuf,
    id: i32,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<PlayerGameInfo> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    collect_player_game_info(db, id, true, Some(&app))
}

#[tauri::command]
#[specta::specta]
pub async fn get_profile_accounts_game_info(
    profile_id: String,
    account_keys: Vec<String>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<PlayerGameInfo> {
    if profile_id.trim().is_empty() || account_keys.is_empty() {
        return Ok(PlayerGameInfo::default());
    }

    let profile_db = app
        .path()
        .resolve(format!("db/profile_{}.db3", profile_id.trim()), BaseDirectory::AppData)?;
    let db = &mut get_db_or_create(&state, profile_db.to_str().unwrap(), ConnectionOptions::default())?;

    #[derive(QueryableByName)]
    struct PlayerIdRow {
        #[diesel(sql_type = diesel::sql_types::Integer, column_name = "ID")]
        id: i32,
    }

    let mut player_ids = Vec::new();
    let mut seen_player_ids = std::collections::HashSet::new();

    for account_key in account_keys {
        let Some((normalized_key, stripped_key)) = normalize_account_key_parts(&account_key) else {
            continue;
        };

        let rows: Vec<PlayerIdRow> = sql_query(
            r#"
            SELECT ID
            FROM Players
            WHERE Name IS NOT NULL
              AND trim(Name) <> ''
              AND (
                lower(trim(Name)) = ?
                OR replace(replace(lower(trim(Name)), 'lichess:', ''), 'chesscom:', '') = ?
              )
            ORDER BY ID ASC
            LIMIT 1
            "#,
        )
        .bind::<Text, _>(normalized_key)
        .bind::<Text, _>(stripped_key)
        .load(db)?;

        if let Some(row) = rows.first() {
            if seen_player_ids.insert(row.id) {
                player_ids.push(row.id);
            }
        }
    }

    if player_ids.is_empty() {
        return Ok(PlayerGameInfo::default());
    }

    let mut all_site_stats = Vec::new();
    for player_id in player_ids {
        let info = collect_player_game_info(db, player_id, true, Some(&app))?;
        all_site_stats.extend(info.site_stats_data);
    }

    Ok(PlayerGameInfo {
        site_stats_data: merge_site_stats_data(&all_site_stats),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn get_profile_sidebar_stats(
    profile_id: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ProfileSidebarStats> {
    if profile_id.trim().is_empty() {
        return Ok(ProfileSidebarStats::default());
    }

    let profile_db = app
        .path()
        .resolve(format!("db/profile_{}.db3", profile_id.trim()), BaseDirectory::AppData)?;
    let db = &mut get_db_or_create(&state, profile_db.to_str().unwrap(), ConnectionOptions::default())?;
    ensure_db_initialized(db)?;

    // Keep compatibility with older profiles where analysis tables may still be missing.
    analysis_stats::ensure_profile_analysis_tables(db)?;

    let Some(profile_player_id) = load_or_infer_profile_player_id_for_weakness(db)? else {
        return Ok(ProfileSidebarStats::default());
    };

    // Style classification depends on opening names; without them the backend
    // falls back to `playerStyle.noData`.
    let game_info = collect_player_game_info(db, profile_player_id, true, None)?;
    let site_stats = game_info.site_stats_data;

    Ok(ProfileSidebarStats {
        sidebar_model: compute_player_sidebar_model(&site_stats),
        elo_buckets: calculate_elo_buckets(&site_stats),
    })
}

fn empty_rating_timeline() -> RatingTimeline {
    RatingTimeline {
        data: Vec::new(),
        dates: Vec::new(),
        platforms: Vec::new(),
    }
}

fn merge_rating_timelines_from_filtered(filtered: Vec<(StatsData, String)>) -> RatingTimeline {
    let mut by_site: HashMap<String, Vec<StatsData>> = HashMap::new();
    for (game, site) in filtered {
        by_site.entry(site).or_insert_with(Vec::new).push(game);
    }

    let mut all_timelines: Vec<RatingTimeline> = Vec::new();
    for (site, games) in by_site {
        all_timelines.push(calculate_rating_timeline(&games, &site));
    }

    if all_timelines.is_empty() {
        return empty_rating_timeline();
    }

    let mut all_dates_set: HashSet<i64> = HashSet::new();
    let mut all_platforms: Vec<PlatformInfo> = Vec::new();

    for timeline in &all_timelines {
        all_dates_set.extend(timeline.dates.iter().copied());
        all_platforms.extend(timeline.platforms.clone());
    }

    let mut all_dates: Vec<i64> = all_dates_set.into_iter().collect();
    all_dates.sort_unstable();

    let mut data: Vec<RatingDataPoint> = Vec::new();
    for &date in &all_dates {
        let mut entry = RatingDataPoint {
            date,
            chesscom: None,
            lichess: None,
        };

        for timeline in &all_timelines {
            if let Some(point) = timeline.data.iter().find(|p| p.date == date) {
                if point.chesscom.is_some() {
                    entry.chesscom = point.chesscom;
                }
                if point.lichess.is_some() {
                    entry.lichess = point.lichess;
                }
            }
        }
        data.push(entry);
    }

    let mut platform_map: HashMap<String, PlatformInfo> = HashMap::new();
    for platform in all_platforms {
        platform_map.insert(platform.key.clone(), platform);
    }

    RatingTimeline {
        data,
        dates: all_dates,
        platforms: platform_map.into_values().collect(),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_profile_game_stats(
    profile_id: String,
    filters: PlayerStatsFilters,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<GameStats> {
    if profile_id.trim().is_empty() {
        return Ok(extract_game_stats(&[]));
    }

    let profile_db = app
        .path()
        .resolve(format!("db/profile_{}.db3", profile_id.trim()), BaseDirectory::AppData)?;
    let db = &mut get_db_or_create(&state, profile_db.to_str().unwrap(), ConnectionOptions::default())?;
    ensure_db_initialized(db)?;

    let Some(profile_player_id) = load_or_infer_profile_player_id_for_weakness(db)? else {
        return Ok(extract_game_stats(&[]));
    };

    let game_info = collect_player_game_info(db, profile_player_id, false, None)?;
    let filtered = filter_games(&game_info.site_stats_data, &filters);
    let games: Vec<StatsData> = filtered.into_iter().map(|(game, _)| game).collect();
    Ok(extract_game_stats(&games))
}

#[tauri::command]
#[specta::specta]
pub async fn get_profile_rating_timeline(
    profile_id: String,
    filters: PlayerStatsFilters,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<RatingTimeline> {
    if profile_id.trim().is_empty() {
        return Ok(empty_rating_timeline());
    }

    let profile_db = app
        .path()
        .resolve(format!("db/profile_{}.db3", profile_id.trim()), BaseDirectory::AppData)?;
    let db = &mut get_db_or_create(&state, profile_db.to_str().unwrap(), ConnectionOptions::default())?;
    ensure_db_initialized(db)?;

    let Some(profile_player_id) = load_or_infer_profile_player_id_for_weakness(db)? else {
        return Ok(empty_rating_timeline());
    };

    let game_info = collect_player_game_info(db, profile_player_id, false, None)?;
    let filtered = filter_games(&game_info.site_stats_data, &filters);
    Ok(merge_rating_timelines_from_filtered(filtered))
}

/// Optimize a database: create indexes, run ANALYZE, apply pragmas, and update Lichess tournament events.
#[tauri::command]
#[specta::specta]
pub async fn optimize_database(
    file: PathBuf,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    use diesel::connection::SimpleConnection;
    use crate::db::online_sync::update_lichess_tournament_events_standalone;
    
    let db = &mut get_db_or_create(
        &state,
        file.to_str().unwrap(),
        ConnectionOptions::default(),
    )?;
    
    // Step 1: Create additional indexes
    if let Err(e) = db.batch_execute(crate::db::ADDITIONAL_INDEXES_SQL) {
        // Log but don't fail - indexes are best-effort
        eprintln!("Database optimization warning (indexes): {}", e);
    }
    
    // Step 2: Update query planner statistics
    if let Err(e) = db.batch_execute("ANALYZE Games; ANALYZE Players; ANALYZE Events; ANALYZE Sites;") {
        eprintln!("ANALYZE warning: {}", e);
    }
    
    // Step 3: Apply performance pragmas
    if let Err(e) = db.batch_execute(crate::db::PRAGMA_PERFORMANCE) {
        eprintln!("Performance pragmas warning: {}", e);
    }
    
    // Step 4: Update Lichess tournament events if any exist
    if let Err(e) = update_lichess_tournament_events_standalone(db, &app, false).await {
        eprintln!("Error updating Lichess tournament events: {}", e);
        // Don't fail the entire optimization if this fails
    }
    
    Ok(())
}

/// Delete a database file and cleanup resources
/// OPTIMIZED: Removed PRAGMA optimize (unnecessary before deletion), reduced wait times, and close connections first
#[tauri::command]
#[specta::specta]
pub async fn delete_database(
    file: PathBuf,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    use std::fs::remove_file;

    let path_str = file.to_string_lossy().into_owned();
    let canonical_path_str = std::fs::canonicalize(&file)
        .ok()
        .and_then(|path| path.to_str().map(|value| value.to_string()));

    let same_path = |left: &str, right: &str| {
        if cfg!(windows) {
            left.eq_ignore_ascii_case(right)
        } else {
            left == right
        }
    };

    let remove_pool_entry = |state: &tauri::State<'_, AppState>, key: &str| {
        if let Some((_, pool)) = state.connection_pool.remove(key) {
            drop(pool);
        }
    };

    let clear_readonly = |path: &PathBuf| {
        if let Ok(metadata) = std::fs::metadata(path) {
            let mut permissions = metadata.permissions();
            if permissions.readonly() {
                permissions.set_readonly(false);
                let _ = std::fs::set_permissions(path, permissions);
            }
        }
    };

    // STEP 1: Cancel any ongoing searches by acquiring all permits
    // This will stop new searches and wait for current ones to complete
    let _permits = state.new_request.clone();
    let permit1 = _permits.acquire().await.ok();
    let permit2 = _permits.acquire().await.ok();

    // STEP 2: Remove from connection pool FIRST - this closes all connections
    // Do this BEFORE any database operations to ensure connections are closed immediately
    remove_pool_entry(&state, &path_str);
    if let Some(canonical) = canonical_path_str.as_deref() {
        if !same_path(&path_str, canonical) {
            remove_pool_entry(&state, canonical);
        }
    }

    // STEP 3: Clear in-memory cache (do this after closing connections)
    let mut path_aliases: Vec<String> = vec![path_str.clone()];
    if let Some(canonical) = canonical_path_str.as_ref() {
        if !path_aliases.iter().any(|existing| same_path(existing, canonical)) {
            path_aliases.push(canonical.clone());
        }
    }
    let cache_keys_to_remove: Vec<_> = state
        .line_cache
        .iter()
        .filter(|entry| {
            let key_path = entry.key().1.to_string_lossy();
            path_aliases
                .iter()
                .any(|candidate| same_path(candidate, key_path.as_ref()))
        })
        .map(|entry| entry.key().clone())
        .collect();

    for key in cache_keys_to_remove {
        state.line_cache.remove(&key);
    }

    // Drop permits after cleanup
    drop(permit1);
    drop(permit2);

    // STEP 4: Clear persistent position cache (non-blocking, errors are ignored)
    // This operation can be slow, but we don't wait for it to complete
    let _ = crate::db::position_cache::clear_cache_for_database(&app, &file);

    let wal_path = PathBuf::from(format!("{}-wal", file.display()));
    let shm_path = PathBuf::from(format!("{}-shm", file.display()));
    let sidecar_paths = [wal_path, shm_path];

    // STEP 5: Retry aggressively on lock/contention scenarios (common on Windows).
    let mut last_delete_error: Option<std::io::Error> = None;
    for attempt in 0..8u64 {
        if !file.exists() {
            break;
        }

        clear_readonly(&file);
        match remove_file(&file) {
            Ok(_) => {
                last_delete_error = None;
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                last_delete_error = None;
                break;
            }
            Err(e) => {
                last_delete_error = Some(e);
                if attempt < 7 {
                    tokio::time::sleep(std::time::Duration::from_millis(120 * (attempt + 1))).await;
                }
            }
        }
    }

    if file.exists() {
        let reason = last_delete_error
            .map(|err| err.to_string())
            .unwrap_or_else(|| "unknown file lock error".to_string());
        return Err(Error::PackageManager(format!(
            "Failed to delete database file '{}': {reason}",
            file.display()
        )));
    }

    // STEP 6: Best-effort cleanup for SQLite sidecar files.
    for sidecar in sidecar_paths {
        for attempt in 0..5u64 {
            if !sidecar.exists() {
                break;
            }

            clear_readonly(&sidecar);
            match remove_file(&sidecar) {
                Ok(_) => break,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) if attempt < 4 => {
                    tokio::time::sleep(std::time::Duration::from_millis(80 * (attempt + 1))).await;
                }
                Err(_) => break,
            }
        }
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_duplicated_games(
    file: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    db.batch_execute(GAMES_DELETE_DUPLICATES)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_empty_games(file: PathBuf, state: tauri::State<'_, AppState>) -> Result<()> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    diesel::delete(games::table.filter(games::ply_count.eq(0))).execute(db)?;

    Ok(())
}

struct PgnGame {
    event: Option<String>,
    site: Option<String>,
    date: Option<String>,
    round: Option<String>,
    white: Option<String>,
    black: Option<String>,
    result: Option<String>,
    time_control: Option<String>,
    eco: Option<String>,
    white_elo: Option<String>,
    black_elo: Option<String>,
    ply_count: Option<String>,
    fen: Option<String>,
    moves: String,
}

impl PgnGame {
    fn write(&self, writer: &mut impl Write) -> Result<()> {
        writeln!(
            writer,
            "[Event \"{}\"]",
            self.event.as_deref().unwrap_or("")
        )?;
        writeln!(writer, "[Site \"{}\"]", self.site.as_deref().unwrap_or(""))?;
        writeln!(writer, "[Date \"{}\"]", self.date.as_deref().unwrap_or(""))?;
        writeln!(
            writer,
            "[Round \"{}\"]",
            self.round.as_deref().unwrap_or("")
        )?;
        writeln!(
            writer,
            "[White \"{}\"]",
            self.white.as_deref().unwrap_or("")
        )?;
        writeln!(
            writer,
            "[Black \"{}\"]",
            self.black.as_deref().unwrap_or("")
        )?;
        writeln!(
            writer,
            "[Result \"{}\"]",
            self.result.as_deref().unwrap_or("*")
        )?;
        if let Some(time_control) = self.time_control.as_deref() {
            writeln!(writer, "[TimeControl \"{}\"]", time_control)?;
        }
        if let Some(eco) = self.eco.as_deref() {
            writeln!(writer, "[ECO \"{}\"]", eco)?;
        }
        if let Some(white_elo) = self.white_elo.as_deref() {
            writeln!(writer, "[WhiteElo \"{}\"]", white_elo)?;
        }
        if let Some(black_elo) = self.black_elo.as_deref() {
            writeln!(writer, "[BlackElo \"{}\"]", black_elo)?;
        }
        if let Some(ply_count) = self.ply_count.as_deref() {
            writeln!(writer, "[PlyCount \"{}\"]", ply_count)?;
        }
        if let Some(fen) = self.fen.as_deref() {
            writeln!(writer, "[SetUp \"1\"]")?;
            writeln!(writer, "[FEN \"{}\"]", fen)?;
        }
        writeln!(writer)?;
        writer.write_all(self.moves.as_bytes())?;
        match self.result.as_deref() {
            Some("1-0") => writeln!(writer, "1-0"),
            Some("0-1") => writeln!(writer, "0-1"),
            Some("1/2-1/2") => writeln!(writer, "1/2-1/2"),
            _ => writeln!(writer, "*"),
        }?;
        writeln!(writer)?;
        Ok(())
    }
}

fn sanitize_zip_component(s: &str) -> String {
    let s = s.trim();
    if s.is_empty() {
        return "Unknown".to_string();
    }

    let mut out = String::with_capacity(s.len());
    let mut last_was_sep = false;

    for ch in s.chars() {
        let allowed = ch.is_alphanumeric() || matches!(ch, '-' | '_' | '.');
        let mapped = if allowed { ch } else { '_' };
        let is_sep = mapped == '_';

        if is_sep {
            if !last_was_sep {
                out.push('_');
            }
            last_was_sep = true;
        } else {
            out.push(mapped);
            last_was_sep = false;
        }
    }

    let trimmed = out.trim_matches(&['_', '.'][..]).to_string();
    if trimmed.is_empty() {
        "Unknown".to_string()
    } else {
        trimmed
    }
}

fn zip_filename_for_game(white: Option<&str>, black: Option<&str>, date: Option<&str>, result: Option<&str>) -> String {
    let white = sanitize_zip_component(white.unwrap_or("WhiteUser"));
    let black = sanitize_zip_component(black.unwrap_or("BlackUser"));
    let date = sanitize_zip_component(date.unwrap_or("UnknownDate"));
    let result = sanitize_zip_component(result.unwrap_or("*"));
    format!("{white}_{black}_{date}_{result}.pgn")
}

fn export_pgn_games_to_zip<W: Write + Seek>(zip: &mut ZipWriter<W>, games: Vec<PgnGame>) -> Result<()> {
    let options = ZipFileOptions::default()
        .compression_method(CompressionMethod::Deflated);

    let mut used: HashMap<String, u32> = HashMap::new();

    for g in games {
        let mut pgn_buf: Vec<u8> = Vec::new();
        g.write(&mut pgn_buf)?;

        let base_name = zip_filename_for_game(
            g.white.as_deref(),
            g.black.as_deref(),
            g.date.as_deref(),
            g.result.as_deref(),
        );

        let entry_name = match used.get(&base_name).copied() {
            None => base_name.clone(),
            Some(n) => {
                let stem = base_name.trim_end_matches(".pgn");
                format!("{stem}_{}.pgn", n + 1)
            }
        };
        *used.entry(base_name).or_insert(0) += 1;

        zip.start_file(entry_name, options.clone())?;
        zip.write_all(&pgn_buf)?;
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn export_to_pgn(
    file: PathBuf,
    dest_file: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(dest_file)?;

    let mut writer = BufWriter::new(file);

    let (white_players, black_players) = diesel::alias!(players as white, players as black);
    games::table
        .inner_join(white_players.on(games::white_id.eq(white_players.field(players::id))))
        .inner_join(black_players.on(games::black_id.eq(black_players.field(players::id))))
        .inner_join(events::table.on(games::event_id.eq(events::id)))
        .inner_join(sites::table.on(games::site_id.eq(sites::id)))
        .load_iter::<(Game, Player, Player, Event, Site), DefaultLoadingMode>(db)?
        .flatten()
        .map(|(game, white, black, event, site)| {
            let pgn = PgnGame {
                event: event.name,
                site: site.name,
                date: game.date,
                round: game.round,
                white: white.name,
                black: black.name,
                result: game.result,
                time_control: game.time_control,
                eco: game.eco,
                white_elo: game.white_elo.map(|e| e.to_string()),
                black_elo: game.black_elo.map(|e| e.to_string()),
                ply_count: game.ply_count.map(|e| e.to_string()),
                fen: game.fen.clone(),
                moves: GameTree::from_bytes(
                    &game.moves,
                    game.fen
                        .map(|fen| Fen::from_ascii(fen.as_bytes()).ok())
                        .flatten()
                        .map(|fen| Chess::from_setup(fen.into(), CastlingMode::Chess960).ok())
                        .flatten(),
                )?
                .to_string(),
            };

            pgn.write(&mut writer)?;

            Ok(())
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn export_position_games_to_pgn(
    file: PathBuf,
    fen: String,
    dest_file: PathBuf,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    use crate::db::position_cache::get_cached_position;

    // Get cached game IDs for this position
    let game_ids = match get_cached_position(&app, &fen, &file)? {
        Some((_, ids)) => ids,
        None => {
            return Err(Error::PackageManager(
                "Position not found in cache".to_string(),
            ))
        }
    };

    if game_ids.is_empty() {
        return Err(Error::PackageManager(
            "No games found for this position".to_string(),
        ));
    }

    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(dest_file)?;

    let writer = BufWriter::new(file);
    let mut zip = ZipWriter::new(writer);

    let (white_players, black_players) = diesel::alias!(players as white, players as black);
    let pgn_games = games::table
        .inner_join(white_players.on(games::white_id.eq(white_players.field(players::id))))
        .inner_join(black_players.on(games::black_id.eq(black_players.field(players::id))))
        .inner_join(events::table.on(games::event_id.eq(events::id)))
        .inner_join(sites::table.on(games::site_id.eq(sites::id)))
        .filter(games::id.eq_any(&game_ids))
        .load_iter::<(Game, Player, Player, Event, Site), DefaultLoadingMode>(db)?
        .flatten()
        .map(|(game, white, black, event, site)| {
            Ok(PgnGame {
                event: event.name,
                site: site.name,
                date: game.date,
                round: game.round,
                white: white.name,
                black: black.name,
                result: game.result,
                time_control: game.time_control,
                eco: game.eco,
                white_elo: game.white_elo.map(|e| e.to_string()),
                black_elo: game.black_elo.map(|e| e.to_string()),
                ply_count: game.ply_count.map(|e| e.to_string()),
                fen: game.fen.clone(),
                moves: GameTree::from_bytes(
                    &game.moves,
                    game.fen
                        .map(|fen| Fen::from_ascii(fen.as_bytes()).ok())
                        .flatten()
                        .map(|fen| Chess::from_setup(fen.into(), CastlingMode::Chess960).ok())
                        .flatten(),
                )?
                .to_string(),
            })
        })
        .collect::<Result<Vec<PgnGame>>>()?;

    export_pgn_games_to_zip(&mut zip, pgn_games)?;
    let _ = zip.finish()?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn export_selected_games_to_pgn(
    file: PathBuf,
    game_ids: Vec<i32>,
    dest_file: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    if game_ids.is_empty() {
        return Err(Error::PackageManager("No games selected".to_string()));
    }

    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(dest_file)?;

    let writer = BufWriter::new(file);
    let mut zip = ZipWriter::new(writer);

    let (white_players, black_players) = diesel::alias!(players as white, players as black);
    let pgn_games = games::table
        .inner_join(white_players.on(games::white_id.eq(white_players.field(players::id))))
        .inner_join(black_players.on(games::black_id.eq(black_players.field(players::id))))
        .inner_join(events::table.on(games::event_id.eq(events::id)))
        .inner_join(sites::table.on(games::site_id.eq(sites::id)))
        .filter(games::id.eq_any(&game_ids))
        .load_iter::<(Game, Player, Player, Event, Site), DefaultLoadingMode>(db)?
        .flatten()
        .map(|(game, white, black, event, site)| {
            Ok(PgnGame {
                event: event.name,
                site: site.name,
                date: game.date,
                round: game.round,
                white: white.name,
                black: black.name,
                result: game.result,
                time_control: game.time_control,
                eco: game.eco,
                white_elo: game.white_elo.map(|e| e.to_string()),
                black_elo: game.black_elo.map(|e| e.to_string()),
                ply_count: game.ply_count.map(|e| e.to_string()),
                fen: game.fen.clone(),
                moves: GameTree::from_bytes(
                    &game.moves,
                    game.fen
                        .map(|fen| Fen::from_ascii(fen.as_bytes()).ok())
                        .flatten()
                        .map(|fen| Chess::from_setup(fen.into(), CastlingMode::Chess960).ok())
                        .flatten(),
                )?
                .to_string(),
            })
        })
        .collect::<Result<Vec<PgnGame>>>()?;

    export_pgn_games_to_zip(&mut zip, pgn_games)?;
    let _ = zip.finish()?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_db_game(
    file: PathBuf,
    game_id: i32,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    core::remove_game(db, game_id)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_game(
    file: PathBuf,
    game_id: i32,
    state: tauri::State<'_, AppState>,
) -> Result<NormalizedGame> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    Ok(core::get_game(db, game_id)?)
}

#[tauri::command]
#[specta::specta]
pub async fn update_game(
    file: PathBuf,
    game_id: i32,
    update: UpdateGame,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    core::update_game(db, game_id, &update)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn merge_players(
    file: PathBuf,
    player1: i32,
    player2: i32,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    // Check if the players never played against each other
    let count: i64 = games::table
        .filter(games::white_id.eq(player1).and(games::black_id.eq(player2)))
        .or_filter(games::white_id.eq(player2).and(games::black_id.eq(player1)))
        .limit(1)
        .count()
        .get_result(db)?;

    if count > 0 {
        return Err(Error::NotDistinctPlayers);
    }

    diesel::update(games::table.filter(games::white_id.eq(player1)))
        .set(games::white_id.eq(player2))
        .execute(db)?;
    diesel::update(games::table.filter(games::black_id.eq(player1)))
        .set(games::black_id.eq(player2))
        .execute(db)?;

    diesel::delete(players::table.filter(players::id.eq(player1))).execute(db)?;

    let player_count: i64 = players::table.count().get_result(db)?;
    diesel::insert_into(info::table)
        .values((
            info::name.eq("PlayerCount"),
            info::value.eq(player_count.to_string()),
        ))
        .on_conflict(info::name)
        .do_update()
        .set(info::value.eq(player_count.to_string()))
        .execute(db)?;

    Ok(())
}

/// Clear the in-memory game cache to free memory
/// FIXED: Also clear position search cache to prevent unbounded growth
#[tauri::command]
#[specta::specta]
pub fn clear_games(state: tauri::State<'_, AppState>) -> Result<()> {
    // Clear position search cache to free memory
    state.line_cache.clear();
    Ok(())
}


/// Pre-cache openings from the embedded ECO opening book.
/// This function reads all ECO opening positions (derived from eco.json),
/// searches for each position in the database, and caches the results.
#[tauri::command]
#[specta::specta]
pub async fn precache_openings(
    database_path: PathBuf,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    use std::sync::{Arc, Mutex};
    use tauri::Emitter;
    use tokio::sync::Semaphore;

    // Load all openings from the ECO JSON source as (name, fen)
    let openings = crate::opening::opening_fens_for_precache();

    let total = openings.len();
    let processed = Arc::new(Mutex::new(0usize));
    let errors = Arc::new(Mutex::new(0usize));

    // Get a reference to AppState (Tauri manages it internally, likely with Arc)
    let state_arc = state.inner();


    // Limit concurrency to avoid overwhelming the database
    let semaphore = Arc::new(Semaphore::new(4)); // Process 4 openings at a time

    // Process openings in parallel using futures instead of tokio::spawn
    // This avoids the 'static lifetime requirement
    use futures_util::future;
    let futures: Vec<_> = openings
        .into_iter()
        .map(|(name, fen)| {
            let app_clone = app.clone();
            let db_path_clone = database_path.clone();
            let fen_clone = fen.clone();
            let name_clone = name.clone();
            let processed_clone = processed.clone();
            let errors_clone = errors.clone();
            let semaphore_clone = semaphore.clone();
            let state_inner = state_arc;
            let total_for_closure = total;

            async move {
                let _permit = semaphore_clone.acquire().await.unwrap();

                // Check if already cached
                if let Ok(true) = crate::db::position_cache::is_position_cached(
                    &app_clone,
                    &fen_clone,
                    &db_path_clone,
                ) {
                    let mut p = processed_clone.lock().unwrap();
                    *p += 1;
                    if *p % 10 == 0 {
                        app_clone
                            .emit(
                                "precache-progress",
                                serde_json::json!({
                                    "processed": *p,
                                    "total": total_for_closure,
                                    "errors": *errors_clone.lock().unwrap(),
                                    "current": name_clone
                                }),
                            )
                            .ok();
                    }
                    return;
                }

                // Get database connection directly using Arc<AppState>
                let db_result = {
                    let state_ref = &*state_inner;
                    let file_str = db_path_clone.to_str().unwrap();
                    // Access the connection pool from AppState directly
                    let pool = match state_ref.connection_pool.get(file_str) {
                        Some(p) => p.clone(),
                        None => {
                            // Create new pool if it doesn't exist
                            use diesel::r2d2::ConnectionManager;
                            use diesel::SqliteConnection;
                            let manager = ConnectionManager::<SqliteConnection>::new(file_str);
                            let new_pool = match diesel::r2d2::Pool::builder()
                                .max_size(32)
                                .min_idle(Some(4))
                                .connection_timeout(std::time::Duration::from_secs(30))
                                .build(manager)
                            {
                                Ok(p) => p,
                                Err(_) => {
                                    let mut e = errors_clone.lock().unwrap();
                                    *e += 1;
                                    return;
                                }
                            };
                            state_ref
                                .connection_pool
                                .insert(file_str.to_string(), new_pool.clone());
                            new_pool
                        }
                    };
                    pool.get().map_err(|e| {
                        Error::PackageManager(format!("Failed to get connection: {}", e))
                    })
                };

                let mut db = match db_result {
                    Ok(conn) => conn,
                    Err(_) => {
                        let mut e = errors_clone.lock().unwrap();
                        *e += 1;
                        return;
                    }
                };

                // Convert position query
                let position_query = match PositionQuery::exact_from_fen(&fen_clone) {
                    Ok(q) => q,
                    Err(_) => {
                        let mut e = errors_clone.lock().unwrap();
                        *e += 1;
                        return;
                    }
                };

                // Perform simplified search - just get stats and game IDs
                // We'll use the internal search functions from search.rs
                let query_js = {
                    let mut q = GameQueryJs::default();
                    q.position = Some(PositionQueryJs {
                        fen: fen_clone.clone(),
                        type_: "exact".to_string(),
                    });
                    q.game_details_limit = Some(1000);
                    q
                };

                let is_online = crate::db::search::is_online_database(&db_path_clone);
                let (stats, game_ids) = if is_online {
                    let total_count: i64 = games::table.count().get_result(&mut db).unwrap_or(0);
                    let total_games = total_count.max(0) as usize;
                    let (stats_vec, ids) = crate::db::search::search_position_online_internal(
                        &mut db,
                        &position_query,
                        &query_js,
                        &app_clone,
                        "precache",
                        &state_inner,
                        total_games,
                    );
                    (stats_vec, ids)
                } else {
                    match crate::db::search::search_position_local_internal(
                        &mut db,
                        &position_query,
                        &query_js,
                        &app_clone,
                        "precache",
                        &state_inner,
                    ) {
                        Ok((stats_vec, ids)) => (stats_vec, ids),
                        Err(e) => {
                            let _ = e;
                            let mut e = errors_clone.lock().unwrap();
                            *e += 1;
                            return;
                        }
                    }
                };

                // Save to cache
                if let Err(e) = crate::db::position_cache::save_position_cache(
                    &app_clone,
                    &fen_clone,
                    &db_path_clone,
                    &stats,
                    &game_ids,
                ) {
                    let _ = e;
                    let mut e = errors_clone.lock().unwrap();
                    *e += 1;
                } else {
                    let mut p = processed_clone.lock().unwrap();
                    *p += 1;
                    if *p % 10 == 0 || *p == total_for_closure {
                        app_clone
                            .emit(
                                "precache-progress",
                                serde_json::json!({
                                    "processed": *p,
                                    "total": total_for_closure,
                                    "errors": *errors_clone.lock().unwrap(),
                                    "current": name_clone
                                }),
                            )
                            .ok();
                    }
                }
            }
        })
        .collect();

    // Execute all futures concurrently with semaphore limiting
    future::join_all(futures).await;

    let final_processed = *processed.lock().unwrap();
    let final_errors = *errors.lock().unwrap();

    // Emit final progress
    app.emit(
        "precache-progress",
        serde_json::json!({
            "processed": final_processed,
            "total": total,
            "errors": final_errors,
            "completed": true
        }),
    )
    .ok();

    Ok(())
}

/// Download pre-calculated position cache database
#[tauri::command]
#[specta::specta]
pub async fn download_position_cache(app: tauri::AppHandle) -> Result<()> {
    use crate::fs::download_file;
    use tauri::path::BaseDirectory;

    // Get the path where position_cache.db3 should be stored
    let cache_path = app
        .path()
        .resolve("position_cache.db3", BaseDirectory::AppData)
        .map_err(|e| Error::PackageManager(format!("Failed to resolve cache DB path: {}", e)))?;

    // Ensure parent directory exists
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to create cache directory: {}", e),
            ))
        })?;
    }

    // Download URL for pre-calculated position cache
    let download_url = "https://pub-ea015655e3e044baaea19e7e0bf574f9.r2.dev/position_cache.db3";


    // Download the file (will overwrite if it exists)
    // Use "db_position_cache" as ID to match the format expected by ProgressButton
    download_file(
        "db_position_cache".to_string(),
        download_url.to_string(),
        cache_path.clone(),
        app.clone(),
        None,
        None,
        None,
    )
    .await?;

    // Create a marker file to indicate that the pre-calculated cache was installed
    // This distinguishes it from a cache that was generated on-the-fly during searches
    let marker_path = app
        .path()
        .resolve("position_cache.installed", BaseDirectory::AppData)
        .map_err(|e| Error::PackageManager(format!("Failed to resolve marker path: {}", e)))?;

    // Write a simple marker file with timestamp
    use std::io::Write;
    let mut marker_file = std::fs::File::create(&marker_path).map_err(|e| {
        Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("Failed to create marker file: {}", e),
        ))
    })?;
    
    // Write installation timestamp
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| {
            Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to get timestamp: {}", e),
            ))
        })?
        .as_secs();
    
    marker_file.write_all(timestamp.to_string().as_bytes()).map_err(|e| {
        Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("Failed to write marker file: {}", e),
        ))
    })?;

    Ok(())
}

fn sanitize_db_filename(name: &str) -> String {
    // Keep it simple and predictable across platforms.
    // Windows forbids: < > : " / \ | ? * and control chars. We also guard against path separators.
    let trimmed = name.trim();
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        let is_invalid = matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            || ch.is_control();
        if is_invalid {
            out.push('_');
        } else {
            out.push(ch);
        }
    }

    let out = out.trim().trim_matches('.').to_string();
    if out.is_empty() {
        "database".to_string()
    } else {
        out
    }
}

/// Download a default game database into AppData/db and set its Source metadata.
///
/// This moves the path/source handling to the backend. Download progress is emitted via `download-progress`.
#[tauri::command]
#[specta::specta]
pub async fn download_game_database(
    database_id: i32,
    url: String,
    title: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    use crate::fs::download_file;
    use tauri::path::BaseDirectory;

    let title_trim = title.trim().to_string();
    if title_trim.is_empty() {
        return Err(Error::InvalidInput("Database title cannot be empty".to_string()));
    }

    // Keep the legacy special-case behavior for Position Cache.
    if title_trim == "Position Cache" {
        return download_position_cache(app).await;
    }

    let file_name = sanitize_db_filename(&title_trim);
    let db_path = app
        .path()
        .resolve(format!("db/{file_name}.db3"), BaseDirectory::AppData)
        .map_err(|e| Error::PackageManager(format!("Failed to resolve DB path: {e}")))?;

    // Download into a temporary file first. This prevents leaving a corrupted SQLite DB behind
    // if the download is interrupted.
    let tmp_path = app
        .path()
        .resolve(format!("db/{file_name}.db3.partial"), BaseDirectory::AppData)
        .map_err(|e| Error::PackageManager(format!("Failed to resolve temp DB path: {e}")))?;

    // Use the same ID format as the existing UI expects.
    let download_res = download_file(
        format!("db_{database_id}"),
        url,
        tmp_path.clone(),
        app.clone(),
        None,
        None,
        None,
    )
    .await;

    if let Err(e) = download_res {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }

    // Replace existing DB atomically (best-effort on Windows).
    if db_path.exists() {
        let _ = std::fs::remove_file(&db_path);
    }
    std::fs::rename(&tmp_path, &db_path)?;

    // Mark DB source so the frontend can display/filter it.
    let db = &mut get_db_or_create(&state, db_path.to_str().unwrap(), ConnectionOptions::default())?;
    upsert_info_value(db, "Source", "local")?;

    Ok(())
}

// ============================================================================
// Player Statistics Commands
// ============================================================================

use std::collections::{HashMap, HashSet};

/// Calculate game statistics from filtered games
#[tauri::command]
#[specta::specta]
pub async fn calculate_player_game_stats(
    site_stats_data: Vec<SiteStatsData>,
    filters: PlayerStatsFilters,
) -> Result<GameStats> {
    tauri::async_runtime::spawn_blocking(move || {
        let filtered = filter_games(&site_stats_data, &filters);
        let games: Vec<StatsData> = filtered.into_iter().map(|(game, _)| game).collect();
        Ok::<_, Error>(extract_game_stats(&games))
    })
    .await
    .map_err(|e| Error::PackageManager(format!("calculate_player_game_stats join error: {e}")))?
}

/// Calculate ELO buckets from game data
#[tauri::command]
#[specta::specta]
pub async fn calculate_player_elo_buckets(site_stats_data: Vec<SiteStatsData>) -> Vec<EloBucket> {
    tauri::async_runtime::spawn_blocking(move || calculate_elo_buckets(&site_stats_data))
        .await
        .unwrap_or_default()
}

/// Calculate the sidebar model for PlayerSidebarCard (style + ELO summary).
#[tauri::command]
#[specta::specta]
pub async fn calculate_player_sidebar_model(site_stats_data: Vec<SiteStatsData>) -> PlayerSidebarModel {
    tauri::async_runtime::spawn_blocking(move || compute_player_sidebar_model(&site_stats_data))
        .await
        .unwrap_or_default()
}

/// Calculate opening statistics
#[tauri::command]
#[specta::specta]
pub async fn calculate_player_openings_stats(
    site_stats_data: Vec<SiteStatsData>,
    filters: PlayerStatsFilters,
    color: bool, // true for white, false for black
) -> Vec<OpeningStats> {
    tauri::async_runtime::spawn_blocking(move || {
        let filtered = filter_games(&site_stats_data, &filters);
        let games: Vec<StatsData> = filtered.into_iter().map(|(game, _)| game).collect();
        aggregate_openings(&games, color)
    })
    .await
    .unwrap_or_default()
}

/// Calculate rating timeline
#[tauri::command]
#[specta::specta]
pub async fn calculate_player_rating_timeline(
    site_stats_data: Vec<SiteStatsData>,
    filters: PlayerStatsFilters,
) -> Result<RatingTimeline> {
    tauri::async_runtime::spawn_blocking(move || {
        let filtered = filter_games(&site_stats_data, &filters);

        // Group by site and calculate timeline for each
        let mut all_timelines: Vec<RatingTimeline> = Vec::new();
        let mut by_site: HashMap<String, Vec<StatsData>> = HashMap::new();

        for (game, site) in filtered {
            by_site.entry(site).or_insert_with(Vec::new).push(game);
        }

        for (site, games) in by_site {
            let timeline = calculate_rating_timeline(&games, &site);
            all_timelines.push(timeline);
        }

        // Merge timelines from different sites
        if all_timelines.is_empty() {
            return Ok::<_, Error>(RatingTimeline {
                data: Vec::new(),
                dates: Vec::new(),
                platforms: Vec::new(),
            });
        }

        // Combine all dates
        let mut all_dates: HashSet<i64> = HashSet::new();
        let mut all_platforms: Vec<PlatformInfo> = Vec::new();

        for timeline in &all_timelines {
            all_dates.extend(timeline.dates.iter().copied());
            all_platforms.extend(timeline.platforms.clone());
        }

        let mut all_dates: Vec<i64> = all_dates.into_iter().collect();
        all_dates.sort();

        // Build merged data points
        let mut data: Vec<RatingDataPoint> = Vec::new();
        for &date in &all_dates {
            let mut entry = RatingDataPoint {
                date,
                chesscom: None,
                lichess: None,
            };

            for timeline in &all_timelines {
                if let Some(point) = timeline.data.iter().find(|p| p.date == date) {
                    if point.chesscom.is_some() {
                        entry.chesscom = point.chesscom;
                    }
                    if point.lichess.is_some() {
                        entry.lichess = point.lichess;
                    }
                }
            }

            data.push(entry);
        }

        // Deduplicate platforms
        let mut platform_map: HashMap<String, PlatformInfo> = HashMap::new();
        for platform in all_platforms {
            platform_map.insert(platform.key.clone(), platform);
        }
        let platforms: Vec<PlatformInfo> = platform_map.into_values().collect();

        Ok::<_, Error>(RatingTimeline {
            data,
            dates: all_dates,
            platforms,
        })
    })
    .await
    .map_err(|e| Error::PackageManager(format!("calculate_player_rating_timeline join error: {e}")))?
}

/// Calculate ELO domain for rating chart
#[tauri::command]
#[specta::specta]
pub async fn calculate_player_elo_domain(rating_timeline: RatingTimeline) -> Option<EloDomain> {
    tauri::async_runtime::spawn_blocking(move || calculate_elo_domain(&rating_timeline))
        .await
        .unwrap_or(None)
}

/// Merge site stats data from multiple sources
#[tauri::command]
#[specta::specta]
pub async fn merge_player_site_stats(site_stats_data_list: Vec<SiteStatsData>) -> Vec<SiteStatsData> {
    tauri::async_runtime::spawn_blocking(move || merge_site_stats_data(&site_stats_data_list))
        .await
        .unwrap_or_default()
}

/// Fill missing months in monthly data
#[tauri::command]
#[specta::specta]
pub async fn fill_missing_months_data(data: Vec<MonthData>) -> Vec<MonthData> {
    tauri::async_runtime::spawn_blocking(move || fill_missing_months(&data))
        .await
        .unwrap_or_default()
}

/// Merge years in monthly data
#[tauri::command]
#[specta::specta]
pub async fn merge_years_data(data: Vec<MonthData>) -> Vec<MonthData> {
    tauri::async_runtime::spawn_blocking(move || merge_years(&data))
        .await
        .unwrap_or_default()
}

/// Calculate earliest date based on date range
#[tauri::command]
#[specta::specta]
pub async fn calculate_earliest_date_from_range(
    date_range: DateRange,
    rating_dates: Vec<i64>,
) -> Option<i64> {
    tauri::async_runtime::spawn_blocking(move || calculate_earliest_date(date_range, &rating_dates))
        .await
        .unwrap_or(None)
}

fn sanitize_db_filename_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else if ch.is_whitespace() {
            out.push('_');
        }
        // Drop any other characters.
    }

    // Avoid empty/degenerate filenames.
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "database".to_string()
    } else {
        trimmed
    }
}

fn slug_to_title(slug: &str) -> String {
    let words = slug
        .split(|c: char| c == '-' || c == '_' || c.is_whitespace())
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => first.to_ascii_uppercase().to_string() + &chars.as_str().to_ascii_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>();

    if words.is_empty() {
        "Online tournament".to_string()
    } else {
        words.join(" ")
    }
}

fn parse_lichess_broadcast_url(url: &str) -> Result<(String, String)> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| Error::PackageManager(format!("Invalid URL: {e}")))?;

    if parsed.scheme() != "https" {
        return Err(Error::PackageManager(
            "Only https:// URLs are supported".to_string(),
        ));
    }

    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if host != "lichess.org" {
        return Err(Error::PackageManager(
            "Only lichess.org URLs are supported".to_string(),
        ));
    }

    let segments = parsed
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();

    // Example:
    // https://lichess.org/broadcast/<slug>/<broadcastId>
    if segments.len() >= 3 && segments[0] == "broadcast" {
        let slug = segments[1].to_string();
        let id = segments[2].to_string();
        if id.is_empty() {
            return Err(Error::PackageManager(
                "Missing broadcast id in URL".to_string(),
            ));
        }
        return Ok((id, slug));
    }

    Err(Error::PackageManager(
        "Unsupported online tournament URL".to_string(),
    ))
}

fn truncate_for_error(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        text.to_string()
    } else {
        format!("{}…", &text[..max_len])
    }
}

fn extract_broadcast_ids_from_group_html(html: &str) -> Vec<String> {
    // The group page contains a list of cards:
    // <a href="/broadcast/<slug>/<broadcastId>" class="relay-card ...">
    //
    // We extract the final path segment as the broadcastId.
    let re =
        Regex::new(r#"href="/broadcast/[^"]+/([A-Za-z0-9]{8})""#).expect("valid regex");

    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for cap in re.captures_iter(html) {
        if let Some(m) = cap.get(1) {
            let id = m.as_str().to_string();
            if seen.insert(id.clone()) {
                out.push(id);
            }
        }
    }
    out
}

async fn download_lichess_broadcast_pgn(
    client: &reqwest::Client,
    broadcast_id: &str,
) -> Result<Option<Vec<u8>>> {
    let pgn_url = format!("https://lichess.org/api/broadcast/{broadcast_id}.pgn");
    let res = client
        .get(&pgn_url)
        .header(
            reqwest::header::ACCEPT,
            "application/x-chess-pgn, text/plain, */*",
        )
        .send()
        .await?;

    if !res.status().is_success() {
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(Error::PackageManager(format!(
            "Failed to download broadcast PGN ({status}): {}",
            truncate_for_error(&text, 600)
        )));
    }

    let bytes = res.bytes().await?;
    let bytes = bytes.to_vec();

    // Lichess occasionally returns HTML (e.g. an error page) with a 200.
    // Ensure we fail loudly instead of creating an empty/broken database.
    let looks_like_pgn = {
        let mut i = 0usize;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        bytes.get(i) == Some(&b'[') || bytes.windows(6).take(2048).any(|w| w == b"[Event")
    };
    if !looks_like_pgn {
        let snippet = String::from_utf8_lossy(&bytes);
        return Err(Error::PackageManager(format!(
            "Lichess returned non-PGN content for broadcast {broadcast_id}: {}",
            truncate_for_error(&snippet, 600)
        )));
    }

    Ok(Some(bytes))
}

fn upsert_info_value(db: &mut SqliteConnection, name: &str, value: &str) -> Result<()> {
    diesel::insert_into(info::table)
        .values((info::name.eq(name), info::value.eq(value)))
        .on_conflict(info::name)
        .do_update()
        .set(info::value.eq(value))
        .execute(db)?;
    Ok(())
}

fn normalize_db_source(source: &str) -> Option<&'static str> {
    match source.trim().to_ascii_lowercase().as_str() {
        "local" => Some("local"),
        "online" => Some("online"),
        "external" => Some("external"),
        _ => None,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn import_online_tournament(
    url: String,
    title: Option<String>,
    description: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let (broadcast_id, slug) = parse_lichess_broadcast_url(&url)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .user_agent("Obsidian Chess Studio")
        .build()?;

    // The incoming URL can be either:
    // - a group page (listing many broadcasts), e.g. .../broadcast/<group>/<groupId>
    // - a single broadcast page (a specific round), e.g. .../broadcast/<round>/<roundId>
    //
    // Only the *roundId* works with `/api/broadcast/{id}.pgn`.
    // For group pages, we scrape the group HTML for all child broadcast IDs and
    // download each one via the API, concatenating PGNs together.
    let pgn_bytes: Vec<u8> = match download_lichess_broadcast_pgn(&client, &broadcast_id).await? {
        Some(bytes) => bytes,
        None => {
            // Treat `broadcast_id` as a group id, fetch the group HTML and extract child IDs.
            let group_html = client.get(&url).send().await?.text().await?;
            let ids = extract_broadcast_ids_from_group_html(&group_html);
            if ids.is_empty() {
                return Err(Error::PackageManager(
                    "Could not find any broadcasts on the provided page".to_string(),
                ));
            }

            // Safety: cap the number of broadcasts to avoid extremely large imports.
            let max_ids = 200usize;
            let ids = ids.into_iter().take(max_ids).collect::<Vec<_>>();

            let mut combined: Vec<u8> = Vec::new();
            for id in ids {
                let Some(bytes) = download_lichess_broadcast_pgn(&client, &id).await? else {
                    return Err(Error::PackageManager(format!(
                        "Failed to download broadcast PGN (404): {id}"
                    )));
                };
                if !combined.is_empty() {
                    combined.extend_from_slice(b"\n\n");
                }
                combined.extend_from_slice(&bytes);
            }

            combined
        }
    };

    if pgn_bytes.is_empty() {
        return Err(Error::PackageManager(
            "Downloaded PGN is empty".to_string(),
        ));
    }

    let inferred_title = slug_to_title(&slug);
    let db_title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or(inferred_title);

    let db_description = description
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| format!("Imported from {url}"));

    let mut base = sanitize_db_filename_component(&slug);
    if base.len() > 50 {
        base.truncate(50);
    }
    let filename = format!("{base}_{broadcast_id}.db3");
    let db_rel = PathBuf::from("db").join(&filename);
    let db_path = app.path().resolve(db_rel, BaseDirectory::AppData)?;
    let db_path_str = db_path.to_string_lossy().into_owned();

    #[derive(QueryableByName)]
    struct TableInfo {
        #[diesel(sql_type = Text, column_name = "name")]
        _name: String,
    }

    let cleanup_db_path = |path: &PathBuf| {
        let path_str = path.to_string_lossy().into_owned();
        if let Some((_, pool)) = state.connection_pool.remove(&path_str) {
            drop(pool);
        }
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(format!("{}.partial", path.display()));
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    };

    let has_players_table = |path: &PathBuf| -> bool {
        if !path.exists() {
            return false;
        }
        let mut conn = match SqliteConnection::establish(path.to_str().unwrap()) {
            Ok(c) => c,
            Err(_) => return false,
        };
        match sql_query("SELECT name FROM sqlite_master WHERE type='table' AND name='Players' LIMIT 1")
            .load::<TableInfo>(&mut conn)
        {
            Ok(rows) => !rows.is_empty(),
            Err(_) => false,
        }
    };

    if db_path.exists() {
        if has_players_table(&db_path) {
            return Err(Error::PackageManager(format!(
                "Database already exists: {filename}"
            )));
        }
        // Previous failed import can leave an invalid .db3 without schema.
        // Clean it so retrying the same URL works.
        cleanup_db_path(&db_path);
    }

    // Use a temporary DB path and only move it into place if conversion succeeds.
    let temp_db_path = PathBuf::from(format!("{}.partial", db_path.display()));
    cleanup_db_path(&temp_db_path);

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temp_pgn_path = std::env::temp_dir()
        .join(format!("ocs_lichess_broadcast_{broadcast_id}_{ts}.pgn"));

    std::fs::write(&temp_pgn_path, &pgn_bytes)?;

    let convert_res = convert_pgn_impl(
        temp_pgn_path.clone(),
        temp_db_path.clone(),
        None,
        app.clone(),
        db_title,
        Some(db_description),
        &state,
    );

    let _ = std::fs::remove_file(&temp_pgn_path);
    if let Err(e) = convert_res {
        cleanup_db_path(&temp_db_path);
        return Err(e);
    }

    // Ensure no open pooled connections keep the temp/final files locked on Windows.
    if let Some((_, pool)) = state
        .connection_pool
        .remove(&temp_db_path.to_string_lossy().into_owned())
    {
        drop(pool);
    }
    if let Some((_, pool)) = state.connection_pool.remove(&db_path_str) {
        drop(pool);
    }

    // Finalize with retries first (rename), then fallback to copy+delete for stubborn locks.
    let mut finalize_err: Option<String> = None;
    let mut finalized = false;

    for attempt in 0..6u64 {
        match std::fs::rename(&temp_db_path, &db_path) {
            Ok(()) => {
                finalized = true;
                break;
            }
            Err(e) => {
                finalize_err = Some(e.to_string());
                if attempt < 5 {
                    tokio::time::sleep(Duration::from_millis(120 * (attempt + 1))).await;
                }
            }
        }
    }

    if !finalized {
        for attempt in 0..6u64 {
            match std::fs::copy(&temp_db_path, &db_path) {
                Ok(_) => {
                    let _ = std::fs::remove_file(&temp_db_path);
                    let _ = std::fs::remove_file(format!("{}-wal", temp_db_path.display()));
                    let _ = std::fs::remove_file(format!("{}-shm", temp_db_path.display()));
                    finalized = true;
                    break;
                }
                Err(e) => {
                    finalize_err = Some(e.to_string());
                    if attempt < 5 {
                        tokio::time::sleep(Duration::from_millis(120 * (attempt + 1))).await;
                    }
                }
            }
        }
    }

    if !finalized {
        cleanup_db_path(&temp_db_path);
        return Err(Error::PackageManager(format!(
            "Failed to finalize imported database {filename}: {}",
            finalize_err.unwrap_or_else(|| "unknown file lock error".to_string())
        )));
    }

    // Mark DB source so the frontend can display/filter it.
    let _ = state.connection_pool.remove(&db_path_str);
    let db = &mut get_db_or_create(
        &state,
        db_path.to_str().unwrap(),
        ConnectionOptions::default(),
    )?;
    if let Err(e) = upsert_info_value(db, "Source", "online") {
        let lower = e.to_string().to_lowercase();
        let is_locked = lower.contains("database is locked")
            || lower.contains("database table is locked")
            || lower.contains("database schema is locked");
        if !is_locked {
            return Err(e);
        }
        // Non-fatal: import already succeeded and data is on disk.
        // Source metadata can be set later via set_db_source.
        eprintln!("Warning: could not set Source=online for {}: {}", filename, e);
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn set_db_source(file: PathBuf, source: String, _state: tauri::State<'_, AppState>) -> Result<()> {
    let Some(source_norm) = normalize_db_source(&source) else {
        return Err(Error::PackageManager("Invalid database source".to_string()));
    };

    fn is_malformed_sqlite_message(msg: &str) -> bool {
        let m = msg.to_lowercase();
        m.contains("database disk image is malformed") || m.contains("file is not a database")
    }

    // Fail fast for corrupted DB files and avoid caching a broken pool.
    let mut db = match SqliteConnection::establish(file.to_str().unwrap()) {
        Ok(db) => db,
        Err(e) => {
            let msg = e.to_string();
            if is_malformed_sqlite_message(&msg) {
                let _ = std::fs::remove_file(&file);
                let _ = std::fs::remove_file(format!("{}.partial", file.display()));
                return Err(Error::PackageManager(
                    "Corrupted database detected and removed".to_string(),
                ));
            }
            return Err(e.into());
        }
    };

    let res: Result<()> = (|| {
        upsert_info_value(&mut db, "Source", source_norm)?;
        Ok(())
    })();

    match res {
        Ok(()) => Ok(()),
        Err(e) => {
            if is_malformed_sqlite_message(&e.to_string()) {
                let _ = std::fs::remove_file(&file);
                let _ = std::fs::remove_file(format!("{}.partial", file.display()));
                return Err(Error::PackageManager(
                    "Corrupted database detected and removed".to_string(),
                ));
            }
            Err(e)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_db_source(file: PathBuf, _state: tauri::State<'_, AppState>) -> Result<Option<String>> {
    fn is_malformed_sqlite_message(msg: &str) -> bool {
        let m = msg.to_lowercase();
        m.contains("database disk image is malformed") || m.contains("file is not a database")
    }

    // Fail fast for corrupted DB files and avoid blocking the UI.
    let mut db = match SqliteConnection::establish(file.to_str().unwrap()) {
        Ok(db) => db,
        Err(e) => {
            let msg = e.to_string();
            if is_malformed_sqlite_message(&msg) {
                let _ = std::fs::remove_file(&file);
                let _ = std::fs::remove_file(format!("{}.partial", file.display()));
                return Err(Error::PackageManager(
                    "Corrupted database detected and removed".to_string(),
                ));
            }
            return Err(e.into());
        }
    };

    let res: Result<Option<String>> = (|| {
        let res: std::result::Result<Info, _> =
            info::table.filter(info::name.eq("Source")).first(&mut db);
        match res {
            Ok(info_row) => Ok(info_row.value),
            Err(_) => Ok(None),
        }
    })();

    match res {
        Ok(v) => Ok(v),
        Err(e) => {
            if is_malformed_sqlite_message(&e.to_string()) {
                let _ = std::fs::remove_file(&file);
                let _ = std::fs::remove_file(format!("{}.partial", file.display()));
                return Err(Error::PackageManager(
                    "Corrupted database detected and removed".to_string(),
                ));
            }
            Err(e)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn merge_profile_event_from_db_player(
    profile_db_file: PathBuf,
    source_db_file: PathBuf,
    player_id: i32,
    event_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<i32> {
    use crate::db::schema::{events as events_tbl, games as games_tbl, players as players_tbl, sites as sites_tbl};

    if player_id <= 0 {
        return Err(Error::InvalidInput("Invalid player id".to_string()));
    }

    let name = event_name.trim().to_string();
    if name.is_empty() {
        return Err(Error::InvalidInput("Event name cannot be empty".to_string()));
    }

    // Open profile DB and ensure schema.
    let profile_db = &mut get_db_or_create(
        &state,
        profile_db_file.to_str().unwrap(),
        ConnectionOptions::default(),
    )?;
    ensure_db_initialized(profile_db)?;

    // Create/update managed event in profile DB.
    diesel::insert_into(events_tbl::table)
        .values((
            events_tbl::name.eq(&name),
            events_tbl::event_type.eq(Some(ManagedEventType::OnlineTournament.as_str())),
        ))
        .on_conflict(events_tbl::name)
        .do_update()
        .set(events_tbl::event_type.eq(Some(ManagedEventType::OnlineTournament.as_str())))
        .execute(profile_db)?;

    let event_id = events_tbl::table
        .filter(events_tbl::name.eq(&name))
        .select(events_tbl::id)
        .first::<i32>(profile_db)?;

    // Open source DB.
    let source_db = &mut get_db_or_create(
        &state,
        source_db_file.to_str().unwrap(),
        ConnectionOptions::default(),
    )?;

    let source_player_name: String = players_tbl::table
        .filter(players_tbl::id.eq(player_id))
        .select(players_tbl::name)
        .first::<Option<String>>(source_db)?
        .unwrap_or_default()
        .trim()
        .to_string();
    if source_player_name.is_empty() {
        return Err(Error::InvalidInput(
            "Selected player has no name".to_string(),
        ));
    }

    // Load all games for the selected player.
    let (white_players, black_players) = diesel::alias!(players_tbl as white, players_tbl as black);
    let rows = games_tbl::table
        .inner_join(white_players.on(games_tbl::white_id.eq(white_players.field(players_tbl::id))))
        .inner_join(black_players.on(games_tbl::black_id.eq(black_players.field(players_tbl::id))))
        .inner_join(events_tbl::table.on(games_tbl::event_id.eq(events_tbl::id)))
        .inner_join(sites_tbl::table.on(games_tbl::site_id.eq(sites_tbl::id)))
        .filter(games_tbl::white_id.eq(player_id).or(games_tbl::black_id.eq(player_id)))
        .load::<(Game, Player, Player, Event, Site)>(source_db)?;

    let mut inserted_total: i32 = 0;

    // Insert games into profile DB overriding event_id.
    profile_db.transaction::<_, Error, _>(|profile_db| {
        for (game, white, black, event, site) in rows.iter() {
            let mut pgn_bytes: Vec<u8> = Vec::new();
            {
                let mut writer = BufWriter::new(&mut pgn_bytes);

                let pgn_game = PgnGame {
                    event: event.name.clone(),
                    site: site.name.clone(),
                    date: game.date.clone(),
                    round: game.round.clone(),
                    white: white.name.clone(),
                    black: black.name.clone(),
                    result: game.result.clone(),
                    time_control: game.time_control.clone(),
                    eco: game.eco.clone(),
                    white_elo: game.white_elo.map(|e| e.to_string()),
                    black_elo: game.black_elo.map(|e| e.to_string()),
                    ply_count: game.ply_count.map(|e| e.to_string()),
                    fen: game.fen.clone(),
                    moves: GameTree::from_bytes(
                        &game.moves,
                        game.fen
                            .as_deref()
                            .and_then(|fen| Fen::from_ascii(fen.as_bytes()).ok())
                            .and_then(|fen| Chess::from_setup(fen.into(), CastlingMode::Chess960).ok()),
                    )?
                    .to_string(),
                };

                pgn_game.write(&mut writer)?;
                writer.flush()?;
            }

            let mut importer = Importer::new(None);
            for temp in BufferedReader::new_cursor(&pgn_bytes)
                .into_iter(&mut importer)
                .flatten()
                .flatten()
            {
                let inserted =
                    insert_to_db_with_event_override(profile_db, &temp, event_id, None, None)?;
                if inserted {
                    inserted_total += 1;
                }
            }
        }
        Ok(())
    })?;

    // Store the selected player as the profile "main player" for correct opponent detection in dashboards.
    #[derive(diesel::QueryableByName)]
    struct PlayerIdRow {
        #[diesel(sql_type = diesel::sql_types::Integer, column_name = "ID")]
        id: i32,
    }
    let rows: Vec<PlayerIdRow> = diesel::sql_query(
        "SELECT ID FROM Players WHERE lower(Name) = lower(?1) LIMIT 1",
    )
    .bind::<diesel::sql_types::Text, _>(source_player_name.clone())
    .load(profile_db)?;

    // Keep the profile's active player stable once set.
    let existing_profile_player_id: Option<String> = info::table
        .filter(info::name.eq("ProfilePlayerId"))
        .select(info::value)
        .first::<Option<String>>(profile_db)
        .optional()?
        .flatten();

    if existing_profile_player_id.is_none() {
        if let Some(pid) = rows.first().map(|r| r.id) {
            upsert_info_value(profile_db, "ProfilePlayerId", &pid.to_string())?;
            upsert_info_value(profile_db, "ProfilePlayerName", &source_player_name)?;
        }
    }

    Ok(inserted_total)
}
