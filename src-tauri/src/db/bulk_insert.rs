use std::collections::HashMap;
use std::io::Write;

use diesel::{connection::SimpleConnection, prelude::*, SqliteConnection};
use shakmaty::Position;

use crate::db::{models::NewGame, ops::{create_event, create_player, create_site}, pgn::TempGame, schema::games};
use crate::error::Result;

use super::get_pawn_home;

// #region agent log
fn agent_log(hypothesis_id: &str, location: &str, message: &str, data: serde_json::Value) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let line = serde_json::json!({
        "sessionId": "debug-session",
        "runId": "run1",
        "hypothesisId": hypothesis_id,
        "location": location,
        "message": message,
        "data": data,
        "timestamp": ts
    });
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(r#"d:\OCS\.cursor\debug.log"#)
    {
        let _ = writeln!(f, "{}", line.to_string());
    }
}
// #endregion

/// Cache for lookups during bulk insert to avoid repeated queries (case-sensitive, like DB UNIQUE constraints).
struct BatchCache {
    players: HashMap<String, i32>,
    events: HashMap<String, i32>,
    sites: HashMap<String, i32>,
}

impl BatchCache {
    fn new() -> Self {
        Self { players: HashMap::new(), events: HashMap::new(), sites: HashMap::new() }
    }

    fn player_id(&mut self, conn: &mut SqliteConnection, name: &str) -> Result<i32> {
        if let Some(&id) = self.players.get(name) { return Ok(id); }
        let row = create_player(conn, name)?;
        self.players.insert(name.to_string(), row.id);
        Ok(row.id)
    }

    fn event_id(&mut self, conn: &mut SqliteConnection, name: &str) -> Result<i32> {
        if let Some(&id) = self.events.get(name) { return Ok(id); }
        let row = create_event(conn, name)?;
        self.events.insert(name.to_string(), row.id);
        Ok(row.id)
    }

    fn site_id(&mut self, conn: &mut SqliteConnection, name: &str) -> Result<i32> {
        if let Some(&id) = self.sites.get(name) { return Ok(id); }
        let row = create_site(conn, name)?;
        self.sites.insert(name.to_string(), row.id);
        Ok(row.id)
    }
}

/// Optimized bulk insert context.
///
/// Key properties:
/// - Does NOT create manual transactions/savepoints (lets Diesel handle transactions).
/// - Drops secondary indexes before inserts, recreates after.
/// - Applies bulk pragmas; if SQLite rejects some inside an outer transaction, falls back to safe subset.
pub struct BulkInsertContext<'a> {
    pub(crate) conn: &'a mut SqliteConnection,
    cache: BatchCache,
    pragmas_applied: bool,
    indexes_dropped: bool,
}

impl<'a> BulkInsertContext<'a> {
    pub fn new(conn: &'a mut SqliteConnection) -> Result<Self> {
        // #region agent log
        agent_log(
            "H5",
            "src-tauri/src/db/bulk_insert.rs:BulkInsertContext::new",
            "bulk_insert:new_enter",
            serde_json::json!({}),
        );
        // #endregion

        // Apply bulk pragmas (best-effort if we are inside an outer txn).
        if let Err(e) = conn.batch_execute(super::PRAGMA_BULK_INSERT) {
            let msg = e.to_string().to_ascii_lowercase();
            if msg.contains("transaction") || msg.contains("within a transaction") {
                let _ = conn.batch_execute(
                    "PRAGMA synchronous = NORMAL;\
                     PRAGMA foreign_keys = OFF;\
                     PRAGMA temp_store = MEMORY;\
                     PRAGMA mmap_size = 1073741824;\
                     PRAGMA cache_size = -200000;\
                     PRAGMA count_changes = OFF;",
                );
            } else {
                return Err(crate::error::Error::from(e));
            }
        }

        // Drop non-dedupe indexes to speed inserts (best-effort).
        let _ = conn.batch_execute(super::DROP_INDEXES_FOR_BULK_SQL);

        // #region agent log
        agent_log(
            "H5",
            "src-tauri/src/db/bulk_insert.rs:BulkInsertContext::new",
            "bulk_insert:new_exit_ok",
            serde_json::json!({}),
        );
        // #endregion

        Ok(Self { conn, cache: BatchCache::new(), pragmas_applied: true, indexes_dropped: true })
    }

    pub fn insert_games_batch(&mut self, games: Vec<TempGame>) -> Result<()> {
        use crate::db::pgn;

        if games.is_empty() {
            return Ok(());
        }

        // #region agent log
        agent_log(
            "H3",
            "src-tauri/src/db/bulk_insert.rs:BulkInsertContext::insert_games_batch",
            "bulk_insert:insert_games_batch_enter",
            serde_json::json!({ "games": games.len() }),
        );
        // #endregion

        let batch_start = std::time::Instant::now();

        // Avoid SQLite bind limits. Keep conservative.
        let mut sub_batch_size: usize = 300;

        let mut iter = games.into_iter();
        let mut sub_batch: Vec<TempGame> = Vec::with_capacity(sub_batch_size);

        loop {
            sub_batch.clear();
            for _ in 0..sub_batch_size {
                if let Some(g) = iter.next() {
                    sub_batch.push(g);
                } else {
                    break;
                }
            }
            if sub_batch.is_empty() {
                break;
            }

            // Build NewGame rows borrowing from TempGame data (sub_batch must live until execute()).
            let mut rows: Vec<NewGame> = Vec::with_capacity(sub_batch.len());

            for g in &sub_batch {
                let pawn_home = get_pawn_home(g.position.board());

                let white_id = match g.white_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    Some(name) => self.cache.player_id(self.conn, name)?,
                    None => 0,
                };
                let black_id = match g.black_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    Some(name) => self.cache.player_id(self.conn, name)?,
                    None => 0,
                };
                let event_id = match g.event_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    Some(name) => self.cache.event_id(self.conn, name)?,
                    None => 0,
                };
                let site_id = match g.site_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    Some(name) => self.cache.site_id(self.conn, name)?,
                    None => 0,
                };

                let ply_count = g.tree.count_main_line_moves() as i32;
                let final_material = pgn::get_material_count(g.position.board());
                let minimal_white_material = g.material_count.white.min(final_material.white) as i32;
                let minimal_black_material = g.material_count.black.min(final_material.black) as i32;

                rows.push(NewGame {
                    white_id,
                    black_id,
                    ply_count,
                    eco: g.eco.as_deref(),
                    round: g.round.as_deref(),
                    white_elo: g.white_elo,
                    black_elo: g.black_elo,
                    white_material: minimal_white_material,
                    black_material: minimal_black_material,
                    date: g.date.as_deref(),
                    time: g.time.as_deref(),
                    time_control: g.time_control.as_deref(),
                    site_id,
                    event_id,
                    fen: g.fen.as_deref(),
                    result: g.result.as_deref(),
                    moves: g.moves.as_slice(),
                    pawn_home: pawn_home as i32,
                });
            }

            // Execute bulk insert for this chunk.
            match diesel::insert_or_ignore_into(games::table).values(&rows).execute(self.conn) {
                Ok(_) => {}
                Err(e) => {
                    let msg = e.to_string().to_ascii_lowercase();
                    if msg.contains("too many sql variables") && sub_batch_size > 50 {
                        sub_batch_size = (sub_batch_size / 2).max(50);
                        // retry current sub_batch by splitting rows
                        let mut start = 0usize;
                        while start < rows.len() {
                            let end = (start + sub_batch_size).min(rows.len());
                            if let Err(e2) = diesel::insert_or_ignore_into(games::table)
                                .values(&rows[start..end])
                                .execute(self.conn)
                            {
                                return Err(crate::error::Error::from(e2));
                            }
                            start = end;
                        }
                    } else {
                        return Err(crate::error::Error::from(e));
                    }
                }
            }
        }

        // #region agent log
        agent_log(
            "H3",
            "src-tauri/src/db/bulk_insert.rs:BulkInsertContext::insert_games_batch",
            "bulk_insert:insert_games_batch_exit_ok",
            serde_json::json!({ "ms": batch_start.elapsed().as_millis() }),
        );
        // #endregion

        Ok(())
    }

    pub fn finalize(self) -> Result<()> {
        // Recreate indexes (best-effort: if this fails, DB still has data; user can recreate later).
        if self.indexes_dropped {
            let _ = self.conn.batch_execute(super::INDEXES_SQL);
        }

        if self.pragmas_applied {
            let _ = self.conn.batch_execute(super::PRAGMA_PERFORMANCE);
        }
        let _ = self.conn.batch_execute(super::PRAGMA_FOREIGN_KEYS_ON);
        let _ = self.conn.batch_execute("PRAGMA journal_mode=DELETE;");

        Ok(())
    }
}
