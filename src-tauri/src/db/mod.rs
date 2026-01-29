mod bulk_insert;
mod core;
mod encoding;
mod models;
mod ops;
mod pgn;
mod player_stats;
mod player_style;
mod position_cache;
mod schema;
mod search;
mod sync_state;
mod online_sync;
pub use sync_state::*;
pub use online_sync::{get_account_import_stats, sync_account_games_to_profile_db, AccountSyncProgress};

use crate::{
    db::{encoding::extract_main_line_moves, models::*, ops::*, schema::*},
    error::{Error, Result},
    opening::get_opening_from_setup,
    AppState,
};
use dashmap::DashMap;
use diesel::{
    connection::{DefaultLoadingMode, SimpleConnection},
    insert_into,
    prelude::*,
    r2d2::{ConnectionManager, Pool},
    sql_query,
    sql_types::Text,
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
) -> Result<bool> {
    let pawn_home = get_pawn_home(game.position.board());

    let white_id = if let Some(name) = &game.white_name {
        create_player(db, name)?.id
    } else {
        0
    };

    let black_id = if let Some(name) = &game.black_name {
        create_player(db, name)?.id
    } else {
        0
    };

    let event_id = if event_id_override > 0 {
        event_id_override
    } else if let Some(name) = &game.event_name {
        create_event(db, name)?.id
    } else {
        0
    };

    let site_id = if let Some(name) = &game.site_name {
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

    let new_game = NewGame {
        white_id,
        black_id,
        ply_count,
        eco: game.eco.as_deref(),
        round: game.round.as_deref(),
        white_elo: game.white_elo,
        black_elo: game.black_elo,
        white_material: minimal_white_material,
        black_material: minimal_black_material,
        date: game.date.as_deref(),
        time: game.time.as_deref(),
        time_control: game.time_control.as_deref(),
        site_id,
        event_id,
        fen: game.fen.as_deref(),
        result: game.result.as_deref(),
        moves: game.moves.as_slice(),
        pawn_home: pawn_home as i32,
    };

    core::add_game(db, new_game)
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
    }

    // If a previous version created Players as WITHOUT ROWID, inserts that omit ID will fail.
    // Migrate it back to a rowid table in-place (keeps existing data).
    ensure_players_rowid_table(db)?;

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
            busy_timeout: None,
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
            busy_timeout: None,
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

    Ok(())
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

    fn cleanup_malformed_db(state: &tauri::State<'_, AppState>, path: &PathBuf) {
        let path_str = path.to_string_lossy().into_owned();
        let _ = state.connection_pool.remove(&path_str);
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(format!("{}.partial", path.display()));
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

    let res: Result<DatabaseInfo> = (|| {
        let player_count = players::table.count().get_result::<i64>(&mut db)? as i32;
        let game_count = games::table.count().get_result::<i64>(&mut db)? as i32;
        let event_count = events::table.count().get_result::<i64>(&mut db)? as i32;

        let title = match info::table
            .filter(info::name.eq("Title"))
            .first(&mut db)
            .map(|title_info: Info| title_info.value)
        {
            Ok(Some(title)) => title,
            _ => "Untitled".to_string(),
        };

        let description = match info::table
            .filter(info::name.eq("Description"))
            .first(&mut db)
            .map(|description_info: Info| description_info.value)
        {
            Ok(Some(description)) => description,
            _ => "".to_string(),
        };

        let storage_size = path.metadata()?.len() as i64;
        let filename = path.file_name().expect("get filename").to_string_lossy();

        let is_indexed = check_index_exists(&mut db)?;
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
    })();

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
        // Only allow deleting managed events.
        let managed_exists = events::table
            .filter(events::id.eq(event_id))
            .filter(events::event_type.is_not_null())
            .select(events::id)
            .first::<i32>(db)
            .optional()?
            .is_some();

        if !managed_exists {
            return Ok(false);
        }

        let game_ids = games::table
            .filter(games::event_id.eq(event_id))
            .select(games::id)
            .load::<i32>(db)?;

        if !game_ids.is_empty() {
            diesel::delete(comments::table.filter(comments::game_id.eq_any(&game_ids)))
                .execute(db)?;
        }

        diesel::delete(games::table.filter(games::event_id.eq(event_id))).execute(db)?;
        diesel::delete(events::table.filter(events::id.eq(event_id))).execute(db)?;

        Ok(true)
    })?;

    Ok(deleted)
}

#[tauri::command]
#[specta::specta]
pub async fn add_event_games_from_pgn(
    file: PathBuf,
    event_id: i32,
    pgn: String,
    state: tauri::State<'_, AppState>,
) -> Result<i32> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    ensure_db_initialized(db)?;

    if event_id <= 0 {
        return Err(Error::InvalidInput("Invalid event id".to_string()));
    }

    let trimmed = pgn.trim();
    if trimmed.is_empty() {
        return Err(Error::InvalidInput("PGN cannot be empty".to_string()));
    }

    let mut importer = Importer::new(None);
    let mut inserted_total: i32 = 0;

    db.transaction::<_, Error, _>(|db| {
        for game in BufferedReader::new_cursor(trimmed.as_bytes())
            .into_iter(&mut importer)
            .flatten()
            .flatten()
        {
            let inserted = insert_to_db_with_event_override(db, &game, event_id)?;
            if inserted {
                inserted_total += 1;
            }
        }
        Ok(())
    })?;

    Ok(inserted_total)
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

            let inserted = insert_to_db_with_event_override(db, &game, 0)?;
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
    pub is_player_white: bool,
    pub player_elo: i32,
    pub opponent_elo: Option<i32>,
    pub result: GameOutcome,
    pub time_control: String,
    pub opening: String,
}

#[derive(Serialize, Debug, Clone, Type, tauri_specta::Event)]
pub struct DatabaseProgress {
    pub id: String,
    pub progress: f64,
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
    let _timer = Instant::now();

    let sql_query = games::table
        .inner_join(sites::table.on(games::site_id.eq(sites::id)))
        .inner_join(players::table.on(players::id.eq(id)))
        .select((
            games::white_id,
            games::black_id,
            games::result,
            games::date,
            games::moves,
            games::white_elo,
            games::black_elo,
            games::time_control,
            sites::name,
            players::name,
        ))
        .filter(games::white_id.eq(id).or(games::black_id.eq(id)))
        .filter(games::fen.is_null());

    type GameInfo = (
        i32,
        i32,
        Option<String>,
        Option<String>,
        Vec<u8>,
        Option<i32>,
        Option<i32>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let info: Vec<GameInfo> = sql_query.load(db)?;

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
                let opening = setups
                    .iter()
                    .find_map(|setup| get_opening_from_setup(setup.clone()).ok())
                    .unwrap_or_default();

                let p = progress.fetch_add(1, Ordering::Relaxed);
                if p % 1000 == 0 || p == info.len() - 1 {
                    let _ = DatabaseProgress {
                        id: id.to_string(),
                        progress: (p as f64 / info.len() as f64) * 100_f64,
                    }
                    .emit(&app);
                }

                Some(SiteStatsData {
                    site: site.clone(),
                    player: player.clone().unwrap(),
                    data: vec![StatsData {
                        date: date.clone().unwrap(),
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

    // Player stats computed

    Ok(game_info)
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

    // STEP 1: Cancel any ongoing searches by acquiring all permits
    // This will stop new searches and wait for current ones to complete
    let _permits = state.new_request.clone();
    let permit1 = _permits.acquire().await.ok();
    let permit2 = _permits.acquire().await.ok();

    // STEP 2: Remove from connection pool FIRST - this closes all connections
    // Do this BEFORE any database operations to ensure connections are closed immediately
    if let Some((_, pool)) = state.connection_pool.remove(&path_str) {
        // Force drop the pool to close all connections immediately
        drop(pool);
    }

    // STEP 3: Clear in-memory cache (do this after closing connections)
    let cache_keys_to_remove: Vec<_> = state
        .line_cache
        .iter()
        .filter(|entry| entry.key().1 == file)
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

    // STEP 5: Brief wait for OS to release file handles (reduced from 500ms to 100ms)
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // STEP 6: Try to delete with fewer retries and shorter delays
    for attempt in 1..=2 {
        if file.exists() {
            match remove_file(&file) {
                Ok(_) => {
                    return Ok(());
                }
                Err(_e) if attempt < 2 => {
                    // Shorter delay: 200ms instead of 500ms * attempt
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
                Err(e) => {
                    return Err(Error::Io(e));
                }
            }
        } else {
            return Ok(());
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


/// Pre-cache openings from TSV files
/// This function reads all opening TSV files, converts PGN to FEN,
/// searches for each position in the database, and caches the results
#[tauri::command]
#[specta::specta]
pub async fn precache_openings(
    database_path: PathBuf,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    use crate::opening::TSV_DATA;
    use csv::ReaderBuilder;
    use shakmaty::{fen::Fen, san::San, Chess, EnPassantMode};
    use std::sync::{Arc, Mutex};
    use tauri::Emitter;
    use tokio::sync::Semaphore;

    #[derive(serde::Deserialize)]
    struct OpeningRecord {
        #[allow(dead_code)]
        eco: String,
        name: String,
        pgn: String,
    }

    // Load all openings from TSV files
    let mut openings: Vec<(String, String)> = Vec::new(); // (name, fen)

    for tsv_data in TSV_DATA {
        let mut rdr = ReaderBuilder::new().delimiter(b'\t').from_reader(tsv_data);
        for result in rdr.deserialize() {
            match result {
                Ok(record) => {
                    let record: OpeningRecord = record;
                    // Convert PGN to FEN
                    let mut pos = Chess::default();
                    for token in record.pgn.split_whitespace() {
                        if let Ok(san) = token.parse::<San>() {
                            if let Ok(mv) = san.to_move(&pos) {
                                pos.play_unchecked(&mv);
                            }
                        }
                    }
                    let fen = Fen::from_setup(pos.into_setup(EnPassantMode::Legal));
                    openings.push((record.name, fen.to_string()));
                }
                Err(_) => continue,
            }
        }
    }

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
    if db_path.exists() {
        return Err(Error::PackageManager(format!(
            "Database already exists: {filename}"
        )));
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temp_pgn_path = std::env::temp_dir()
        .join(format!("ocs_lichess_broadcast_{broadcast_id}_{ts}.pgn"));

    std::fs::write(&temp_pgn_path, &pgn_bytes)?;

    let convert_res = convert_pgn_impl(
        temp_pgn_path.clone(),
        db_path.clone(),
        None,
        app.clone(),
        db_title,
        Some(db_description),
        &state,
    );

    let _ = std::fs::remove_file(&temp_pgn_path);
    convert_res?;

    // Mark DB source so the frontend can display/filter it.
    let db = &mut get_db_or_create(
        &state,
        db_path.to_str().unwrap(),
        ConnectionOptions::default(),
    )?;
    upsert_info_value(db, "Source", "online")?;

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
                let inserted = insert_to_db_with_event_override(profile_db, &temp, event_id)?;
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
