use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::Path,
    path::PathBuf,
    sync::Mutex,
};

use csv::ReaderBuilder;
use diesel::{
    connection::SimpleConnection, insert_into, BoolExpressionMethods, Connection,
    ExpressionMethods, QueryDsl, RunQueryDsl,
};
use once_cell::sync::Lazy;
use rand::seq::SliceRandom;
use serde::Deserialize;
use serde::Serialize;
use shakmaty::{fen::Fen, san::SanPlus, uci::UciMove, CastlingMode, Chess, Position};
use specta::Type;
use tauri::{path::BaseDirectory, Emitter, Manager};

use crate::{
    db::{puzzles, Puzzle},
    error::Error,
};

/// Converts a technical theme name to a friendly name
fn get_theme_friendly_name(theme: &str) -> String {
    let theme_lower = theme.to_lowercase();
    let friendly_names: HashMap<&str, &str> = [
        ("advantage", "Advantage"),
        ("anastasiamate", "Anastasia's Mate"),
        ("arabianmate", "Arabian Mate"),
        ("attackingf2f7", "Attacking f2/f7"),
        ("backrankmate", "Back Rank Mate"),
        ("bishopendgame", "Bishop Endgame"),
        ("bodenmate", "Boden's Mate"),
        ("capturingdefender", "Capturing Defender"),
        ("castling", "Castling"),
        ("crushing", "Crushing"),
        ("defensive", "Defensive"),
        ("deflection", "Deflection"),
        ("discoveredattack", "Discovered Attack"),
        ("doublecheck", "Double Check"),
        ("doublestake", "Double Threat"),
        ("endgame", "Endgame"),
        ("enpassant", "En Passant"),
        ("equality", "Equality"),
        ("exposedking", "Exposed King"),
        ("fork", "Fork"),
        ("hangingpiece", "Hanging Piece"),
        ("interference", "Interference"),
        ("intermezzo", "Intermezzo"),
        ("knightendgame", "Knight Endgame"),
        ("long", "Long"),
        ("mate", "Mate"),
        ("matein1", "Mate in 1"),
        ("matein2", "Mate in 2"),
        ("matein3", "Mate in 3"),
        ("matein4", "Mate in 4"),
        ("matein5", "Mate in 5"),
        ("middlegame", "Middlegame"),
        ("one-move", "One Move"),
        ("opening", "Opening"),
        ("pawnendgame", "Pawn Endgame"),
        ("pin", "Pin"),
        ("promotion", "Promotion"),
        ("queenendgame", "Queen Endgame"),
        ("queenrookendgame", "Queen & Rook Endgame"),
        ("queenrook", "Queen & Rook"),
        ("doublebishopmate", "Double Bishop Mate"),
        ("doublebishop", "Double Bishop"),
        ("queensideattack", "Queenside Attack"),
        ("kingsideattack", "Kingside Attack"),
        ("quietmove", "Quiet Move"),
        ("rookendgame", "Rook Endgame"),
        ("sacrifice", "Sacrifice"),
        ("short", "Short"),
        ("skewer", "Skewer"),
        ("smotheredmate", "Smothered Mate"),
        ("trappedpiece", "Trapped Piece"),
        ("underpromotion", "Underpromotion"),
        ("verylong", "Very Long"),
        ("x-rayattack", "X-Ray Attack"),
        ("zugzwang", "Zugzwang"),
    ]
    .iter()
    .cloned()
    .collect();

    // Check exact match first
    if let Some(friendly) = friendly_names.get(theme_lower.as_str()) {
        return friendly.to_string();
    }

    // Try to split camelCase or words separated by common patterns
    // Split on common word boundaries: lowercase to uppercase transitions, numbers, etc.
    let mut result = String::new();
    let mut chars = theme.chars().peekable();
    let mut prev_was_lower = false;
    let mut prev_was_upper = false;
    let mut prev_was_digit = false;
    let mut word_start = true;

    while let Some(ch) = chars.next() {
        let is_upper = ch.is_uppercase();
        let is_lower = ch.is_lowercase();
        let is_digit = ch.is_ascii_digit();

        // Add space before uppercase if previous was lowercase or digit
        if is_upper && (prev_was_lower || prev_was_digit) && !result.is_empty() {
            result.push(' ');
            word_start = true;
        }
        // Add space before lowercase if we have multiple uppercase letters in a row (like "QueenRook")
        else if is_lower && prev_was_upper {
            if let Some(&next_ch) = chars.peek() {
                if next_ch.is_uppercase() {
                    result.push(' ');
                    word_start = true;
                }
            }
        }
        // Add space before digit if previous was letter
        else if is_digit && (prev_was_lower || prev_was_upper) && !result.is_empty() {
            result.push(' ');
            word_start = true;
        }

        // Handle special cases
        if ch == '-' || ch == '_' {
            result.push(' ');
            word_start = true;
            continue;
        }

        // Capitalize first letter of each word
        if word_start {
            result.push_str(&ch.to_uppercase().collect::<String>());
            word_start = false;
        } else {
            result.push(ch);
        }

        prev_was_lower = is_lower;
        prev_was_upper = is_upper;
        prev_was_digit = is_digit;
    }

    // Clean up multiple spaces
    result = result.split_whitespace().collect::<Vec<_>>().join(" ");

    // Handle common patterns and fix specific cases
    result = result
        .replace("End Game", "Endgame")
        .replace("Mate In", "Mate in")
        .replace("Queen Rook", "Queen & Rook")
        .replace("King Side", "Kingside")
        .replace("Queen Side", "Queenside")
        .replace("X Ray", "X-Ray")
        .replace("En Passant", "En Passant")
        .replace("F 2 F 7", "f2/f7")
        .replace("F2 F7", "f2/f7");

    result
}

/// Converts a technical opening tag name to a friendly name
fn get_opening_tag_friendly_name(tag: &str) -> String {
    let tag_lower = tag.to_lowercase();
    let friendly_names: HashMap<&str, &str> = [
        ("sicilian", "Sicilian Defense"),
        ("french", "French Defense"),
        ("catalan", "Catalan Opening"),
        ("queensgambit", "Queen's Gambit"),
        ("kingsgambit", "King's Gambit"),
        ("italian", "Italian Game"),
        ("spanish", "Spanish Game"),
        ("ruylopez", "Ruy López"),
        ("carokann", "Caro-Kann Defense"),
        ("pirc", "Pirc Defense"),
        ("modern", "Modern Defense"),
        ("nimzoindian", "Nimzo-Indian Defense"),
        ("queensindian", "Queen's Indian Defense"),
        ("kingsindian", "King's Indian Defense"),
        ("english", "English Opening"),
        ("dutch", "Dutch Defense"),
        ("scandinavian", "Scandinavian Defense"),
        ("alekhine", "Alekhine's Defense"),
        ("benoni", "Benoni Defense"),
        ("grunfeld", "Grünfeld Defense"),
        ("london", "London System"),
        ("trompowsky", "Trompowsky Attack"),
        ("reti", "Réti Opening"),
        ("bird", "Bird's Opening"),
        ("bogoindian", "Bogo-Indian Defense"),
        ("slav", "Slav Defense"),
        ("semi-slav", "Semi-Slav Defense"),
        ("tarrasch", "Tarrasch Defense"),
        ("scholar", "Scholar's Mate"),
        ("fools", "Fool's Mate"),
    ]
    .iter()
    .cloned()
    .collect();

    // Check exact match first
    if let Some(friendly) = friendly_names.get(tag_lower.as_str()) {
        return friendly.to_string();
    }

    // Split camelCase or words separated by common patterns
    // This handles cases like "QueenRook" -> "Queen Rook"
    let mut result = String::new();
    let mut chars = tag.chars().peekable();
    let mut prev_was_lower = false;
    let mut prev_was_upper = false;
    let mut prev_was_digit = false;
    let mut word_start = true;

    while let Some(ch) = chars.next() {
        let is_upper = ch.is_uppercase();
        let is_lower = ch.is_lowercase();
        let is_digit = ch.is_ascii_digit();

        // Add space before uppercase if previous was lowercase or digit
        if is_upper && (prev_was_lower || prev_was_digit) && !result.is_empty() {
            result.push(' ');
            word_start = true;
        }
        // Add space before lowercase if we have multiple uppercase letters in a row (like "QueenRook")
        else if is_lower && prev_was_upper {
            if let Some(&next_ch) = chars.peek() {
                if next_ch.is_uppercase() {
                    result.push(' ');
                    word_start = true;
                }
            }
        }
        // Add space before digit if previous was letter
        else if is_digit && (prev_was_lower || prev_was_upper) && !result.is_empty() {
            result.push(' ');
            word_start = true;
        }

        // Handle special cases
        if ch == '-' || ch == '_' {
            result.push(' ');
            word_start = true;
            continue;
        }

        // Capitalize first letter of each word
        if word_start {
            result.push_str(&ch.to_uppercase().collect::<String>());
            word_start = false;
        } else {
            result.push(ch);
        }

        prev_was_lower = is_lower;
        prev_was_upper = is_upper;
        prev_was_digit = is_digit;
    }

    // Clean up multiple spaces
    result = result.split_whitespace().collect::<Vec<_>>().join(" ");

    // Handle common patterns and fix specific cases
    result = result
        .replace("Queen Rook", "Queen & Rook")
        .replace("King Side", "Kingside")
        .replace("Queen Side", "Queenside")
        .replace("Semi Slav", "Semi-Slav")
        .replace("Bogo Indian", "Bogo-Indian")
        .replace("Nimzo Indian", "Nimzo-Indian")
        .replace("King S", "King's")
        .replace("Queen S", "Queen's");

    result
}

/// Cache for puzzles to reduce database queries
#[derive(Debug)]
struct PuzzleCache {
    /// Database file path used by the current cache
    file: Option<String>,
    /// Queue of ready-to-serve puzzles
    cache: VecDeque<Puzzle>,
    /// Candidate deck (IDs only) matching the current filters
    candidate_ids: Vec<i32>,
    /// Cursor to the next ID in the candidate deck
    candidate_index: usize,
    /// Minimum rating filter used for the current cache
    min_rating: u16,
    /// Maximum rating filter used for the current cache
    max_rating: u16,
    /// Maximum number of puzzles to cache at once
    cache_size: usize,
    /// Random flag used for the current cache
    random: bool,
    /// Themes filter used for the current cache
    themes: Option<Vec<String>>,
    /// Opening tags filter used for the current cache
    opening_tags: Option<Vec<String>>,
    /// Side-to-move filter used for the current cache ("w" | "b")
    side_to_move: Option<String>,
    /// Whether schema/table capabilities were checked for the current file
    normalized_state_ready: bool,
}

impl PuzzleCache {
    const DEFAULT_INITIAL_PREFETCH: usize = 160;
    const PREFETCH_BATCH_SIZE: usize = 64;
    const LOW_WATERMARK: usize = 48;

    /// Create a new puzzle cache with default settings
    fn new() -> Self {
        Self {
            file: None,
            cache: VecDeque::new(),
            candidate_ids: Vec::new(),
            candidate_index: 0,
            min_rating: 0,
            max_rating: 0,
            cache_size: Self::DEFAULT_INITIAL_PREFETCH,
            random: true,
            themes: None,
            opening_tags: None,
            side_to_move: None,
            normalized_state_ready: false,
        }
    }

    /// Configure the cache size
    ///
    /// # Arguments
    /// * `size` - The maximum number of puzzles to cache at once
    #[allow(dead_code)]
    fn with_cache_size(mut self, size: usize) -> Self {
        self.cache_size = size.max(1);
        self
    }

    fn normalize_filter_list(values: Option<Vec<String>>) -> Option<Vec<String>> {
        let mut cleaned = values
            .unwrap_or_default()
            .into_iter()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>();
        if cleaned.is_empty() {
            return None;
        }
        cleaned.sort_unstable();
        cleaned.dedup();
        Some(cleaned)
    }

    fn normalize_side_to_move(value: Option<String>) -> Option<String> {
        let v = value?.trim().to_ascii_lowercase();
        match v.as_str() {
            // UI filter represents the player's side.
            // Puzzle flow plays the first move automatically, then the player moves.
            // Therefore, player side is the opposite of the FEN side-to-move.
            "white" | "w" => Some("b".to_string()),
            "black" | "b" => Some("w".to_string()),
            _ => None,
        }
    }

    fn dedupe_ids_preserve_order(ids: Vec<i32>) -> Vec<i32> {
        let mut seen = HashSet::with_capacity(ids.len());
        ids.into_iter().filter(|id| seen.insert(*id)).collect()
    }

    fn ensure_temp_query_tables(db: &mut diesel::SqliteConnection) -> Result<(), Error> {
        db.batch_execute(
            r#"
            CREATE TEMP TABLE IF NOT EXISTS temp_theme_filter (
                theme TEXT PRIMARY KEY
            );
            CREATE TEMP TABLE IF NOT EXISTS temp_opening_filter (
                opening_tag TEXT PRIMARY KEY
            );
            CREATE TEMP TABLE IF NOT EXISTS temp_seed_opening_ids (
                puzzle_id INTEGER PRIMARY KEY
            );
            CREATE TEMP TABLE IF NOT EXISTS temp_puzzle_batch_ids (
                ord INTEGER PRIMARY KEY,
                puzzle_id INTEGER NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    fn refill_temp_theme_filter(
        db: &mut diesel::SqliteConnection,
        themes: &[String],
    ) -> Result<(), Error> {
        use diesel::sql_query;
        use diesel::sql_types::Text;

        sql_query("DELETE FROM temp_theme_filter;").execute(db)?;
        for theme in themes {
            sql_query("INSERT OR IGNORE INTO temp_theme_filter(theme) VALUES (?1)")
                .bind::<Text, _>(theme)
                .execute(db)?;
        }
        Ok(())
    }

    fn refill_temp_seed_opening_ids(
        db: &mut diesel::SqliteConnection,
        min_rating: u16,
        max_rating: u16,
        side_to_move: Option<&str>,
    ) -> Result<(), Error> {
        use diesel::sql_query;
        use diesel::sql_types::{Integer, Text};

        sql_query("DELETE FROM temp_seed_opening_ids;").execute(db)?;
        if let Some(side) = side_to_move {
            sql_query(
                "INSERT OR IGNORE INTO temp_seed_opening_ids(puzzle_id)
                 SELECT DISTINCT p.id
                 FROM puzzle_opening_tags po
                 JOIN temp_opening_filter tof ON tof.opening_tag = po.opening_tag
                 JOIN puzzles p ON p.id = po.puzzle_id
                 WHERE p.rating BETWEEN ?1 AND ?2
                   AND SUBSTR(p.fen, INSTR(p.fen, ' ') + 1, 1) = ?3",
            )
            .bind::<Integer, _>(i32::from(min_rating))
            .bind::<Integer, _>(i32::from(max_rating))
            .bind::<Text, _>(side)
            .execute(db)?;
        } else {
            sql_query(
                "INSERT OR IGNORE INTO temp_seed_opening_ids(puzzle_id)
                 SELECT DISTINCT p.id
                 FROM puzzle_opening_tags po
                 JOIN temp_opening_filter tof ON tof.opening_tag = po.opening_tag
                 JOIN puzzles p ON p.id = po.puzzle_id
                 WHERE p.rating BETWEEN ?1 AND ?2",
            )
            .bind::<Integer, _>(i32::from(min_rating))
            .bind::<Integer, _>(i32::from(max_rating))
            .execute(db)?;
        }

        Ok(())
    }

    fn refill_temp_opening_filter(
        db: &mut diesel::SqliteConnection,
        opening_tags: &[String],
    ) -> Result<(), Error> {
        use diesel::sql_query;
        use diesel::sql_types::Text;

        sql_query("DELETE FROM temp_opening_filter;").execute(db)?;
        for tag in opening_tags {
            sql_query("INSERT OR IGNORE INTO temp_opening_filter(opening_tag) VALUES (?1)")
                .bind::<Text, _>(tag)
                .execute(db)?;
        }
        Ok(())
    }

    fn refill_temp_batch_ids(db: &mut diesel::SqliteConnection, ids: &[i32]) -> Result<(), Error> {
        use diesel::sql_query;
        use diesel::sql_types::Integer;

        sql_query("DELETE FROM temp_puzzle_batch_ids;").execute(db)?;
        for (idx, id) in ids.iter().enumerate() {
            sql_query("INSERT INTO temp_puzzle_batch_ids(ord, puzzle_id) VALUES (?1, ?2)")
                .bind::<Integer, _>(idx as i32)
                .bind::<Integer, _>(*id)
                .execute(db)?;
        }
        Ok(())
    }

    // Query candidates by theme (IDs only).
    // Pattern:
    // SELECT p.id
    // FROM puzzle_themes pt
    // JOIN puzzles p ON p.id = pt.puzzle_id
    // WHERE pt.theme IN (...)
    //   AND p.rating BETWEEN @minRating AND @maxRating;
    fn query_candidate_ids_by_themes(
        &self,
        db: &mut diesel::SqliteConnection,
        min_rating: u16,
        max_rating: u16,
        themes: &[String],
        side_to_move: Option<&str>,
    ) -> Result<Vec<i32>, Error> {
        use diesel::deserialize::QueryableByName;
        use diesel::sql_query;
        use diesel::sql_types::{Integer, Text};

        #[derive(QueryableByName)]
        struct IdRow {
            #[diesel(sql_type = Integer, column_name = "id")]
            id: i32,
        }

        if themes.is_empty() {
            return Ok(Vec::new());
        }

        Self::refill_temp_theme_filter(db, themes)?;

        let rows: Vec<IdRow> = if let Some(side) = side_to_move {
            sql_query(
                "SELECT DISTINCT p.id AS id
                 FROM puzzle_themes pt
                 JOIN temp_theme_filter tf ON tf.theme = pt.theme
                 JOIN puzzles p ON p.id = pt.puzzle_id
                 WHERE p.rating BETWEEN ?1 AND ?2
                   AND SUBSTR(p.fen, INSTR(p.fen, ' ') + 1, 1) = ?3",
            )
            .bind::<Integer, _>(i32::from(min_rating))
            .bind::<Integer, _>(i32::from(max_rating))
            .bind::<Text, _>(side)
            .load(db)?
        } else {
            sql_query(
                "SELECT DISTINCT p.id AS id
                 FROM puzzle_themes pt
                 JOIN temp_theme_filter tf ON tf.theme = pt.theme
                 JOIN puzzles p ON p.id = pt.puzzle_id
                 WHERE p.rating BETWEEN ?1 AND ?2",
            )
            .bind::<Integer, _>(i32::from(min_rating))
            .bind::<Integer, _>(i32::from(max_rating))
            .load(db)?
        };

        Ok(rows.into_iter().map(|row| row.id).collect())
    }

    // Query candidates by opening tag (IDs only).
    // Pattern:
    // SELECT p.id
    // FROM puzzle_opening_tags po
    // JOIN puzzles p ON p.id = po.puzzle_id
    // WHERE po.opening_tag IN (...)
    //   AND p.rating BETWEEN @minRating AND @maxRating;
    fn query_candidate_ids_by_openings(
        &self,
        db: &mut diesel::SqliteConnection,
        min_rating: u16,
        max_rating: u16,
        opening_tags: &[String],
        side_to_move: Option<&str>,
    ) -> Result<Vec<i32>, Error> {
        use diesel::deserialize::QueryableByName;
        use diesel::sql_query;
        use diesel::sql_types::{Integer, Text};

        #[derive(QueryableByName)]
        struct IdRow {
            #[diesel(sql_type = Integer, column_name = "id")]
            id: i32,
        }

        if opening_tags.is_empty() {
            return Ok(Vec::new());
        }

        Self::refill_temp_opening_filter(db, opening_tags)?;

        let rows: Vec<IdRow> = if let Some(side) = side_to_move {
            sql_query(
                "SELECT DISTINCT p.id AS id
                 FROM puzzle_opening_tags po
                 JOIN temp_opening_filter tf ON tf.opening_tag = po.opening_tag
                 JOIN puzzles p ON p.id = po.puzzle_id
                 WHERE p.rating BETWEEN ?1 AND ?2
                   AND SUBSTR(p.fen, INSTR(p.fen, ' ') + 1, 1) = ?3",
            )
            .bind::<Integer, _>(i32::from(min_rating))
            .bind::<Integer, _>(i32::from(max_rating))
            .bind::<Text, _>(side)
            .load(db)?
        } else {
            sql_query(
                "SELECT DISTINCT p.id AS id
                 FROM puzzle_opening_tags po
                 JOIN temp_opening_filter tf ON tf.opening_tag = po.opening_tag
                 JOIN puzzles p ON p.id = po.puzzle_id
                 WHERE p.rating BETWEEN ?1 AND ?2",
            )
            .bind::<Integer, _>(i32::from(min_rating))
            .bind::<Integer, _>(i32::from(max_rating))
            .load(db)?
        };

        Ok(rows.into_iter().map(|row| row.id).collect())
    }

    // Query candidates by BOTH theme and opening tags.
    // Strategy: seed with opening-filtered ids (usually narrower), then join themes.
    fn query_candidate_ids_by_themes_and_openings(
        &self,
        db: &mut diesel::SqliteConnection,
        min_rating: u16,
        max_rating: u16,
        themes: &[String],
        opening_tags: &[String],
        side_to_move: Option<&str>,
    ) -> Result<Vec<i32>, Error> {
        use diesel::deserialize::QueryableByName;
        use diesel::sql_query;
        use diesel::sql_types::Integer;

        #[derive(QueryableByName)]
        struct IdRow {
            #[diesel(sql_type = Integer, column_name = "id")]
            id: i32,
        }

        if themes.is_empty() || opening_tags.is_empty() {
            return Ok(Vec::new());
        }

        Self::refill_temp_theme_filter(db, themes)?;
        Self::refill_temp_opening_filter(db, opening_tags)?;
        Self::refill_temp_seed_opening_ids(db, min_rating, max_rating, side_to_move)?;

        let rows: Vec<IdRow> = sql_query(
            "SELECT DISTINCT s.puzzle_id AS id
             FROM temp_seed_opening_ids s
             JOIN puzzle_themes pt ON pt.puzzle_id = s.puzzle_id
             JOIN temp_theme_filter tf ON tf.theme = pt.theme",
        )
        .load(db)?;

        Ok(rows.into_iter().map(|row| row.id).collect())
    }

    fn query_candidate_ids_by_rating_only(
        &self,
        db: &mut diesel::SqliteConnection,
        min_rating: u16,
        max_rating: u16,
        side_to_move: Option<&str>,
    ) -> Result<Vec<i32>, Error> {
        use diesel::deserialize::QueryableByName;
        use diesel::sql_query;
        use diesel::sql_types::{Integer, Text};

        #[derive(QueryableByName)]
        struct IdRow {
            #[diesel(sql_type = Integer, column_name = "id")]
            id: i32,
        }

        let rows: Vec<IdRow> = if let Some(side) = side_to_move {
            sql_query(
                "SELECT p.id AS id
                 FROM puzzles p
                 WHERE p.rating BETWEEN ?1 AND ?2
                   AND SUBSTR(p.fen, INSTR(p.fen, ' ') + 1, 1) = ?3",
            )
            .bind::<Integer, _>(i32::from(min_rating))
            .bind::<Integer, _>(i32::from(max_rating))
            .bind::<Text, _>(side)
            .load(db)?
        } else {
            sql_query(
                "SELECT p.id AS id
                 FROM puzzles p
                 WHERE p.rating BETWEEN ?1 AND ?2",
            )
            .bind::<Integer, _>(i32::from(min_rating))
            .bind::<Integer, _>(i32::from(max_rating))
            .load(db)?
        };

        Ok(rows.into_iter().map(|row| row.id).collect())
    }

    fn build_candidate_deck(
        &mut self,
        db: &mut diesel::SqliteConnection,
        min_rating: u16,
        max_rating: u16,
        random: bool,
        themes: Option<&Vec<String>>,
        opening_tags: Option<&Vec<String>>,
        side_to_move: Option<&str>,
    ) -> Result<(), Error> {
        let mut candidate_ids = match (themes, opening_tags) {
            (Some(theme_list), Some(opening_list))
                if !theme_list.is_empty() && !opening_list.is_empty() =>
            {
                self.query_candidate_ids_by_themes_and_openings(
                    db,
                    min_rating,
                    max_rating,
                    theme_list,
                    opening_list,
                    side_to_move,
                )?
            }
            (Some(theme_list), _) if !theme_list.is_empty() => self.query_candidate_ids_by_themes(
                db,
                min_rating,
                max_rating,
                theme_list,
                side_to_move,
            )?,
            (_, Some(opening_list)) if !opening_list.is_empty() => self
                .query_candidate_ids_by_openings(
                    db,
                    min_rating,
                    max_rating,
                    opening_list,
                    side_to_move,
                )?,
            _ => {
                self.query_candidate_ids_by_rating_only(db, min_rating, max_rating, side_to_move)?
            }
        };

        candidate_ids = Self::dedupe_ids_preserve_order(candidate_ids);

        if random {
            let mut rng = rand::thread_rng();
            candidate_ids.shuffle(&mut rng);
        } else {
            candidate_ids.sort_unstable();
        }

        self.candidate_ids = candidate_ids;
        self.candidate_index = 0;
        self.cache.clear();
        Ok(())
    }

    fn fetch_puzzles_by_ids(
        db: &mut diesel::SqliteConnection,
        ids: &[i32],
    ) -> Result<Vec<Puzzle>, Error> {
        use diesel::deserialize::QueryableByName;
        use diesel::prelude::*;
        use diesel::sql_query;
        use diesel::sql_types::{Integer, Text};

        #[derive(QueryableByName)]
        struct PuzzleRow {
            #[diesel(sql_type = Integer, column_name = "id")]
            id: i32,
            #[diesel(sql_type = Text, column_name = "fen")]
            fen: String,
            #[diesel(sql_type = Text, column_name = "moves")]
            moves: String,
            #[diesel(sql_type = Integer, column_name = "rating")]
            rating: i32,
            #[diesel(sql_type = Integer, column_name = "rating_deviation")]
            rating_deviation: i32,
        }

        if ids.is_empty() {
            return Ok(Vec::new());
        }

        Self::refill_temp_batch_ids(db, ids)?;

        let rows: Vec<PuzzleRow> = sql_query(
            "SELECT p.id, p.fen, p.moves, p.rating, p.rating_deviation
             FROM puzzles p
             JOIN temp_puzzle_batch_ids b ON b.puzzle_id = p.id
             ORDER BY b.ord ASC",
        )
        .load(db)?;

        Ok(rows
            .into_iter()
            .map(|row| Puzzle {
                id: row.id,
                fen: row.fen,
                moves: row.moves,
                rating: row.rating,
                rating_deviation: row.rating_deviation,
                popularity: 0,
                nb_plays: 0,
                themes: None,
                game_url: None,
                opening_tags: None,
            })
            .collect())
    }

    fn refill_ready_queue(
        &mut self,
        db: &mut diesel::SqliteConnection,
        target_size: usize,
    ) -> Result<(), Error> {
        if self.candidate_ids.is_empty() {
            return Ok(());
        }

        while self.cache.len() < target_size {
            if self.candidate_index >= self.candidate_ids.len() {
                self.candidate_index = 0;
                if self.random && self.candidate_ids.len() > 1 {
                    let mut rng = rand::thread_rng();
                    self.candidate_ids.shuffle(&mut rng);
                }
            }

            let remaining_target = target_size.saturating_sub(self.cache.len());
            let remaining_deck = self
                .candidate_ids
                .len()
                .saturating_sub(self.candidate_index);
            let take_count = remaining_target
                .min(Self::PREFETCH_BATCH_SIZE)
                .min(remaining_deck);

            if take_count == 0 {
                break;
            }

            let ids_batch = self.candidate_ids
                [self.candidate_index..self.candidate_index + take_count]
                .to_vec();
            self.candidate_index += take_count;

            let puzzles = Self::fetch_puzzles_by_ids(db, &ids_batch)?;
            if puzzles.is_empty() {
                break;
            }
            self.cache.extend(puzzles);
        }

        Ok(())
    }

    /// Loads puzzles into the cache if needed
    ///
    /// This method will reload the cache if:
    /// - The cache is empty
    /// - The rating filters have changed
    /// - We've reached the end of the current cache
    ///
    /// # Arguments
    /// * `file` - Path to the puzzle database
    /// * `min_rating` - Minimum puzzle rating to include
    /// * `max_rating` - Maximum puzzle rating to include
    /// * `random` - Randomize puzzle in cache
    /// * `themes` - Optional themes filter

    /// Loads puzzles into the cache with optional theme and opening tag filters
    fn get_puzzles_with_filters(
        &mut self,
        file: &str,
        min_rating: u16,
        max_rating: u16,
        random: bool,
        themes: Option<Vec<String>>,
        opening_tags: Option<Vec<String>>,
        side_to_move: Option<String>,
    ) -> Result<(), Error> {
        let themes = Self::normalize_filter_list(themes);
        let opening_tags = Self::normalize_filter_list(opening_tags);
        let side_to_move = Self::normalize_side_to_move(side_to_move);
        let file_changed = self.file.as_deref() != Some(file);

        if file_changed {
            self.normalized_state_ready = false;
        }

        let themes_changed = self.themes != themes;
        let opening_tags_changed = self.opening_tags != opening_tags;
        let side_to_move_changed = self.side_to_move != side_to_move;
        let filters_changed = file_changed
            || self.min_rating != min_rating
            || self.max_rating != max_rating
            || self.random != random
            || themes_changed
            || opening_tags_changed
            || side_to_move_changed
            || self.candidate_ids.is_empty();

        if filters_changed || self.cache.is_empty() || self.cache.len() < Self::LOW_WATERMARK {
            let mut db = diesel::SqliteConnection::establish(file)?;
            apply_local_puzzle_read_pragmas(&mut db);
            Self::ensure_temp_query_tables(&mut db)?;

            if filters_changed {
                // Some third-party or legacy puzzle databases may be missing nullable columns that our
                // schema expects. Add them if needed before querying.
                ensure_puzzles_optional_columns(&mut db)?;

                if !self.normalized_state_ready {
                    // Always use normalized tables. If missing, migrate/create/populate once.
                    let db_path = PathBuf::from(file);
                    migrate_puzzle_database_to_normalized(&db_path)?;
                    const PUZZLES_INDEXES: &str =
                        include_str!("../../database/indexes/puzzles_indexes.sql");
                    db.batch_execute(PUZZLES_INDEXES)?;

                    self.normalized_state_ready = true;
                }

                self.build_candidate_deck(
                    &mut db,
                    min_rating,
                    max_rating,
                    random,
                    themes.as_ref(),
                    opening_tags.as_ref(),
                    side_to_move.as_deref(),
                )?;

                self.min_rating = min_rating;
                self.max_rating = max_rating;
                self.random = random;
                self.themes = themes.clone();
                self.opening_tags = opening_tags.clone();
                self.side_to_move = side_to_move.clone();
                self.file = Some(file.to_string());
            }

            if self.cache.is_empty() {
                self.refill_ready_queue(&mut db, self.cache_size)?;
            } else if self.cache.len() < Self::LOW_WATERMARK {
                self.refill_ready_queue(&mut db, Self::LOW_WATERMARK + Self::PREFETCH_BATCH_SIZE)?;
            }
        }

        Ok(())
    }

    /// Gets the next puzzle from the cache
    ///
    /// # Returns
    /// * `Some(Puzzle)` if a puzzle is available
    /// * `None` if no more puzzles are available in the cache
    fn get_next_puzzle(&mut self) -> Option<Puzzle> {
        self.cache.pop_front()
    }

    fn get_next_puzzles(&mut self, count: usize) -> Vec<Puzzle> {
        let take = count.min(self.cache.len());
        self.cache.drain(..take).collect()
    }
}

/// Ensures the `puzzles` table contains the nullable columns expected by the app.
///
/// Some external databases may omit these columns; we add them as nullable TEXT so
/// the rest of the query layer can remain stable.
fn ensure_puzzles_optional_columns(db: &mut diesel::SqliteConnection) -> Result<(), Error> {
    use diesel::deserialize::QueryableByName;
    use diesel::sql_query;
    #[derive(QueryableByName)]
    struct ColumnInfo {
        #[diesel(sql_type = diesel::sql_types::Text, column_name = "name")]
        name: String,
    }

    let columns: Vec<ColumnInfo> = sql_query("PRAGMA table_info(puzzles)").load(db)?;
    let has = |col: &str| columns.iter().any(|c| c.name == col);

    if !has("themes") {
        db.batch_execute("ALTER TABLE puzzles ADD COLUMN themes TEXT;")?;
    }
    if !has("game_url") {
        db.batch_execute("ALTER TABLE puzzles ADD COLUMN game_url TEXT;")?;
    }
    if !has("opening_tags") {
        db.batch_execute("ALTER TABLE puzzles ADD COLUMN opening_tags TEXT;")?;
    }

    Ok(())
}

/// Applies local performance PRAGMAs for puzzle read workloads.
/// Best-effort: failures are ignored because these are runtime hints.
fn apply_local_puzzle_read_pragmas(db: &mut diesel::SqliteConnection) {
    let _ = db.batch_execute("PRAGMA temp_store = MEMORY;");
    let _ = db.batch_execute("PRAGMA cache_size = -64000;");
    let _ = db.batch_execute("PRAGMA synchronous = NORMAL;");
    let _ = db.batch_execute("PRAGMA mmap_size = 268435456;");
    let _ = db.batch_execute("PRAGMA busy_timeout = 5000;");
    // Keep WAL for local workloads where possible.
    let _ = db.batch_execute("PRAGMA journal_mode = WAL;");
}

static PUZZLE_CACHE: Lazy<Mutex<PuzzleCache>> = Lazy::new(|| Mutex::new(PuzzleCache::new()));

/// Gets a random puzzle from the database within the specified rating range
///
/// This function uses a cache to avoid repeated database queries. The cache is
/// refreshed when it's empty, when the rating range changes, or when all puzzles
/// in the cache have been used.
///
/// # Arguments
/// * `file` - Path to the puzzle database
/// * `min_rating` - Minimum puzzle rating to include
/// * `max_rating` - Maximum puzzle rating to include
/// * `random` - Randomize puzzle in cache
/// * `themes` - Optional list of themes to filter by (puzzle must contain at least one)
/// * `opening_tags` - Optional list of opening tags to filter by (puzzle must contain at least one)
///
/// # Returns
/// * `Ok(Puzzle)` if a puzzle was found
/// * `Err(Error::NoPuzzles)` if no puzzles match the criteria
/// * Other errors if there was a problem accessing the database
#[tauri::command]
#[specta::specta]
pub fn get_puzzle(
    file: String,
    min_rating: u16,
    max_rating: u16,
    random: bool,
    themes: Option<Vec<String>>,
    opening_tags: Option<Vec<String>>,
    side_to_move: Option<String>,
) -> Result<Puzzle, Error> {
    let mut cache = PUZZLE_CACHE
        .lock()
        .map_err(|e| Error::MutexLockFailed(format!("Failed to lock puzzle cache: {}", e)))?;
    cache.get_puzzles_with_filters(
        &file,
        min_rating,
        max_rating,
        random,
        themes,
        opening_tags,
        side_to_move,
    )?;
    // Return the next ready puzzle from the queue
    match cache.get_next_puzzle() {
        Some(puzzle) => Ok(puzzle),
        None => Err(Error::NoPuzzles),
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_puzzle_batch(
    file: String,
    min_rating: u16,
    max_rating: u16,
    random: bool,
    themes: Option<Vec<String>>,
    opening_tags: Option<Vec<String>>,
    side_to_move: Option<String>,
    count: u16,
) -> Result<Vec<Puzzle>, Error> {
    let requested = usize::from(count).clamp(1, 128);

    let mut cache = PUZZLE_CACHE
        .lock()
        .map_err(|e| Error::MutexLockFailed(format!("Failed to lock puzzle cache: {}", e)))?;

    cache.get_puzzles_with_filters(
        &file,
        min_rating,
        max_rating,
        random,
        themes.clone(),
        opening_tags.clone(),
        side_to_move.clone(),
    )?;

    let mut puzzles = cache.get_next_puzzles(requested);
    if puzzles.len() < requested {
        cache.get_puzzles_with_filters(
            &file,
            min_rating,
            max_rating,
            random,
            themes,
            opening_tags,
            side_to_move,
        )?;
        let remaining = requested.saturating_sub(puzzles.len());
        puzzles.extend(cache.get_next_puzzles(remaining));
    }

    if puzzles.is_empty() {
        Err(Error::NoPuzzles)
    } else {
        Ok(puzzles)
    }
}

fn validate_puzzle_db_file(file: &str) -> Result<(), Error> {
    let file_path = Path::new(file);
    if !file_path.exists() {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "Puzzle database file does not exist: {}",
                file_path.display()
            ),
        )));
    }

    let metadata = file_path.metadata()?;
    if metadata.len() == 0 {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Puzzle database file is empty: {}", file_path.display()),
        )));
    }

    Ok(())
}

/// Checks if a puzzle database has the themes and opening_tags columns
///
/// # Arguments
/// * `file` - Path to the puzzle database
///
/// # Returns
/// * `Ok((has_themes, has_opening_tags))` indicating which columns exist
/// * `Err(Error)` if there was a problem accessing the database
#[allow(dead_code)] // Used by frontend via Tauri commands
#[tauri::command]
#[specta::specta]
pub fn check_puzzle_db_columns(file: String) -> Result<(bool, bool), Error> {
    validate_puzzle_db_file(&file)?;

    let mut db = diesel::SqliteConnection::establish(&file)?;

    // Use PRAGMA table_info to check if columns exist
    use diesel::prelude::*;
    use diesel::sql_query;

    #[derive(QueryableByName)]
    struct ColumnInfo {
        #[diesel(sql_type = diesel::sql_types::Text, column_name = "name")]
        name: String,
    }

    let columns: Vec<ColumnInfo> = sql_query("PRAGMA table_info(puzzles)").load(&mut db)?;

    let has_themes = columns.iter().any(|col| col.name == "themes");
    let has_opening_tags = columns.iter().any(|col| col.name == "opening_tags");

    Ok((has_themes, has_opening_tags))
}

/// Theme option with technical value and friendly label
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThemeOption {
    pub value: String,
    pub label: String,
}

/// Theme group containing a category name and its themes
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThemeGroup {
    pub group: String,
    pub items: Vec<ThemeOption>,
}

/// Gets the category/group for a theme
fn get_theme_category(theme: &str) -> &'static str {
    let theme_lower = theme.to_lowercase();

    // Mate patterns
    if theme_lower.contains("mate") || theme_lower == "zugzwang" {
        return "Mate Patterns";
    }

    // Tactics
    if matches!(
        theme_lower.as_str(),
        "fork"
            | "pin"
            | "skewer"
            | "deflection"
            | "discoveredattack"
            | "x-rayattack"
            | "interference"
            | "intermezzo"
            | "capturingdefender"
            | "hangingpiece"
            | "trappedpiece"
            | "doublecheck"
            | "doublestake"
            | "exposedking"
    ) {
        return "Tactics";
    }

    // Endgames
    if theme_lower.contains("endgame") || theme_lower == "endgame" {
        return "Endgames";
    }

    // Strategy
    if matches!(
        theme_lower.as_str(),
        "advantage" | "equality" | "crushing" | "defensive" | "queensideattack"
    ) {
        return "Strategy";
    }

    // Special Moves
    if matches!(
        theme_lower.as_str(),
        "castling" | "enpassant" | "promotion" | "underpromotion"
    ) {
        return "Special Moves";
    }

    // Game Phases
    if matches!(theme_lower.as_str(), "opening" | "middlegame" | "endgame") {
        return "Game Phases";
    }

    // Puzzle Length
    if matches!(
        theme_lower.as_str(),
        "short" | "long" | "verylong" | "one-move"
    ) {
        return "Puzzle Length";
    }

    // Default category
    "Other"
}

/// Opening tag option with technical value and friendly label
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpeningTagOption {
    pub value: String,
    pub label: String,
}

/// Combined metadata required by the puzzles front-end filters panel.
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PuzzleFiltersMetadata {
    pub rating_range: Option<(u16, u16)>,
    pub has_themes: bool,
    pub has_opening_tags: bool,
    pub themes: Vec<ThemeGroup>,
    pub opening_tags: Vec<OpeningTagOption>,
}

fn group_themes_for_ui(theme_values: Vec<String>) -> Vec<ThemeGroup> {
    let mut grouped: HashMap<String, Vec<ThemeOption>> = HashMap::new();
    for theme in theme_values {
        let category = get_theme_category(&theme).to_string();
        let option = ThemeOption {
            value: theme.clone(),
            label: get_theme_friendly_name(&theme),
        };
        grouped
            .entry(category)
            .or_insert_with(Vec::new)
            .push(option);
    }

    let mut groups: Vec<ThemeGroup> = grouped
        .into_iter()
        .map(|(group, mut items)| {
            items.sort_by(|a, b| a.label.cmp(&b.label));
            ThemeGroup { group, items }
        })
        .collect();
    groups.sort_by(|a, b| a.group.cmp(&b.group));
    groups
}

fn opening_tags_for_ui(opening_values: Vec<String>) -> Vec<OpeningTagOption> {
    let mut result = opening_values
        .into_iter()
        .map(|tag| OpeningTagOption {
            value: tag.clone(),
            label: get_opening_tag_friendly_name(&tag),
        })
        .collect::<Vec<_>>();
    result.sort_by(|a, b| a.label.cmp(&b.label));
    result
}

fn query_available_opening_tags_for_filters(
    db: &mut diesel::SqliteConnection,
    min_rating: u16,
    max_rating: u16,
    themes: Option<&[String]>,
    side_to_move: Option<&str>,
) -> Result<Vec<String>, Error> {
    use diesel::prelude::*;
    use diesel::sql_query;
    use diesel::sql_types::{Integer, Text};

    #[derive(QueryableByName)]
    struct TagRow {
        #[diesel(sql_type = Text, column_name = "opening_tag")]
        opening_tag: String,
    }

    let rows: Vec<TagRow> = if let Some(theme_list) = themes.filter(|v| !v.is_empty()) {
        PuzzleCache::refill_temp_theme_filter(db, theme_list)?;
        if let Some(side) = side_to_move {
            sql_query(
                "SELECT DISTINCT po.opening_tag AS opening_tag
                 FROM puzzle_opening_tags po
                 JOIN puzzles p ON p.id = po.puzzle_id
                 JOIN puzzle_themes pt ON pt.puzzle_id = p.id
                 JOIN temp_theme_filter tf ON tf.theme = pt.theme
                 WHERE p.rating BETWEEN ?1 AND ?2
                   AND SUBSTR(p.fen, INSTR(p.fen, ' ') + 1, 1) = ?3
                 ORDER BY po.opening_tag",
            )
            .bind::<Integer, _>(i32::from(min_rating))
            .bind::<Integer, _>(i32::from(max_rating))
            .bind::<Text, _>(side)
            .load(db)?
        } else {
            sql_query(
                "SELECT DISTINCT po.opening_tag AS opening_tag
                 FROM puzzle_opening_tags po
                 JOIN puzzles p ON p.id = po.puzzle_id
                 JOIN puzzle_themes pt ON pt.puzzle_id = p.id
                 JOIN temp_theme_filter tf ON tf.theme = pt.theme
                 WHERE p.rating BETWEEN ?1 AND ?2
                 ORDER BY po.opening_tag",
            )
            .bind::<Integer, _>(i32::from(min_rating))
            .bind::<Integer, _>(i32::from(max_rating))
            .load(db)?
        }
    } else if let Some(side) = side_to_move {
        sql_query(
            "SELECT DISTINCT po.opening_tag AS opening_tag
             FROM puzzle_opening_tags po
             JOIN puzzles p ON p.id = po.puzzle_id
             WHERE p.rating BETWEEN ?1 AND ?2
               AND SUBSTR(p.fen, INSTR(p.fen, ' ') + 1, 1) = ?3
             ORDER BY po.opening_tag",
        )
        .bind::<Integer, _>(i32::from(min_rating))
        .bind::<Integer, _>(i32::from(max_rating))
        .bind::<Text, _>(side)
        .load(db)?
    } else {
        sql_query(
            "SELECT DISTINCT po.opening_tag AS opening_tag
             FROM puzzle_opening_tags po
             JOIN puzzles p ON p.id = po.puzzle_id
             WHERE p.rating BETWEEN ?1 AND ?2
             ORDER BY po.opening_tag",
        )
        .bind::<Integer, _>(i32::from(min_rating))
        .bind::<Integer, _>(i32::from(max_rating))
        .load(db)?
    };

    Ok(rows.into_iter().map(|r| r.opening_tag).collect())
}

fn query_available_themes_for_filters(
    db: &mut diesel::SqliteConnection,
    min_rating: u16,
    max_rating: u16,
    opening_tags: Option<&[String]>,
    side_to_move: Option<&str>,
) -> Result<Vec<String>, Error> {
    use diesel::prelude::*;
    use diesel::sql_query;
    use diesel::sql_types::{Integer, Text};

    #[derive(QueryableByName)]
    struct ThemeRow {
        #[diesel(sql_type = Text, column_name = "theme")]
        theme: String,
    }

    let rows: Vec<ThemeRow> = if let Some(opening_list) = opening_tags.filter(|v| !v.is_empty()) {
        PuzzleCache::refill_temp_opening_filter(db, opening_list)?;
        if let Some(side) = side_to_move {
            sql_query(
                "SELECT DISTINCT pt.theme AS theme
                 FROM puzzle_themes pt
                 JOIN puzzles p ON p.id = pt.puzzle_id
                 JOIN puzzle_opening_tags po ON po.puzzle_id = p.id
                 JOIN temp_opening_filter tf ON tf.opening_tag = po.opening_tag
                 WHERE p.rating BETWEEN ?1 AND ?2
                   AND SUBSTR(p.fen, INSTR(p.fen, ' ') + 1, 1) = ?3
                 ORDER BY pt.theme",
            )
            .bind::<Integer, _>(i32::from(min_rating))
            .bind::<Integer, _>(i32::from(max_rating))
            .bind::<Text, _>(side)
            .load(db)?
        } else {
            sql_query(
                "SELECT DISTINCT pt.theme AS theme
                 FROM puzzle_themes pt
                 JOIN puzzles p ON p.id = pt.puzzle_id
                 JOIN puzzle_opening_tags po ON po.puzzle_id = p.id
                 JOIN temp_opening_filter tf ON tf.opening_tag = po.opening_tag
                 WHERE p.rating BETWEEN ?1 AND ?2
                 ORDER BY pt.theme",
            )
            .bind::<Integer, _>(i32::from(min_rating))
            .bind::<Integer, _>(i32::from(max_rating))
            .load(db)?
        }
    } else if let Some(side) = side_to_move {
        sql_query(
            "SELECT DISTINCT pt.theme AS theme
             FROM puzzle_themes pt
             JOIN puzzles p ON p.id = pt.puzzle_id
             WHERE p.rating BETWEEN ?1 AND ?2
               AND SUBSTR(p.fen, INSTR(p.fen, ' ') + 1, 1) = ?3
             ORDER BY pt.theme",
        )
        .bind::<Integer, _>(i32::from(min_rating))
        .bind::<Integer, _>(i32::from(max_rating))
        .bind::<Text, _>(side)
        .load(db)?
    } else {
        sql_query(
            "SELECT DISTINCT pt.theme AS theme
             FROM puzzle_themes pt
             JOIN puzzles p ON p.id = pt.puzzle_id
             WHERE p.rating BETWEEN ?1 AND ?2
             ORDER BY pt.theme",
        )
        .bind::<Integer, _>(i32::from(min_rating))
        .bind::<Integer, _>(i32::from(max_rating))
        .load(db)?
    };

    Ok(rows.into_iter().map(|r| r.theme).collect())
}

/// Gets distinct values for themes from a puzzle database
/// OPTIMIZED: Uses normalized table if available, otherwise falls back to old method
///
/// # Arguments
/// * `file` - Path to the puzzle database
///
/// # Returns
/// * `Ok(Vec<ThemeOption>)` with distinct theme values and their friendly names
/// * `Err(Error)` if there was a problem accessing the database
#[allow(dead_code)] // Used by frontend via Tauri commands
#[tauri::command]
#[specta::specta]
pub fn get_puzzle_themes(file: String) -> Result<Vec<ThemeGroup>, Error> {
    validate_puzzle_db_file(&file)?;

    let mut db = diesel::SqliteConnection::establish(&file)?;

    // First check if themes column exists
    let (has_themes, _) = check_puzzle_db_columns(file.clone())?;
    if !has_themes {
        return Ok(Vec::new());
    }

    // Check if normalized table exists (much faster)
    use diesel::prelude::*;
    use diesel::sql_query;
    #[derive(QueryableByName)]
    struct CountResult {
        #[diesel(sql_type = diesel::sql_types::BigInt, column_name = "count")]
        count: i64,
    }
    let result: Vec<CountResult> = sql_query(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='puzzle_themes'",
    )
    .load(&mut db)
    .unwrap_or_default();

    if result.first().map(|r| r.count).unwrap_or(0) > 0 {
        // Use normalized table - MUCH faster!
        // Check if friendly_name column exists
        #[derive(QueryableByName)]
        struct ColumnInfo {
            #[diesel(sql_type = diesel::sql_types::Text, column_name = "name")]
            name: String,
        }
        let columns: Vec<ColumnInfo> = sql_query("PRAGMA table_info(puzzle_themes)")
            .load(&mut db)
            .unwrap_or_default();
        let has_friendly_name = columns.iter().any(|col| col.name == "friendly_name");

        if has_friendly_name {
            #[derive(QueryableByName)]
            struct ThemeRow {
                #[diesel(sql_type = diesel::sql_types::Text, column_name = "theme")]
                theme: String,
                #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "friendly_name")]
                friendly_name: Option<String>,
            }
            let themes: Vec<ThemeRow> = sql_query("SELECT DISTINCT theme, friendly_name FROM puzzle_themes ORDER BY COALESCE(friendly_name, theme)")
                .load(&mut db)?;
            // Group themes by category
            let mut grouped: HashMap<String, Vec<ThemeOption>> = HashMap::new();
            for r in themes {
                let category = get_theme_category(&r.theme).to_string();
                let option = ThemeOption {
                    value: r.theme.clone(),
                    label: r
                        .friendly_name
                        .unwrap_or_else(|| get_theme_friendly_name(&r.theme)),
                };
                grouped
                    .entry(category)
                    .or_insert_with(Vec::new)
                    .push(option);
            }
            // Convert to sorted ThemeGroup vector
            let mut groups: Vec<ThemeGroup> = grouped
                .into_iter()
                .map(|(group, mut items)| {
                    items.sort_by(|a, b| a.label.cmp(&b.label));
                    ThemeGroup { group, items }
                })
                .collect();
            groups.sort_by(|a, b| a.group.cmp(&b.group));
            return Ok(groups);
        } else {
            #[derive(QueryableByName)]
            struct ThemeRow {
                #[diesel(sql_type = diesel::sql_types::Text, column_name = "theme")]
                theme: String,
            }
            let themes: Vec<ThemeRow> =
                sql_query("SELECT DISTINCT theme FROM puzzle_themes ORDER BY theme")
                    .load(&mut db)?;
            // Group themes by category
            let mut grouped: HashMap<String, Vec<ThemeOption>> = HashMap::new();
            for r in themes {
                let category = get_theme_category(&r.theme).to_string();
                let option = ThemeOption {
                    value: r.theme.clone(),
                    label: get_theme_friendly_name(&r.theme),
                };
                grouped
                    .entry(category)
                    .or_insert_with(Vec::new)
                    .push(option);
            }
            // Convert to sorted ThemeGroup vector
            let mut groups: Vec<ThemeGroup> = grouped
                .into_iter()
                .map(|(group, mut items)| {
                    items.sort_by(|a, b| a.label.cmp(&b.label));
                    ThemeGroup { group, items }
                })
                .collect();
            groups.sort_by(|a, b| a.group.cmp(&b.group));
            return Ok(groups);
        }
    }

    // Fallback to old method for databases without normalized tables
    let themes: Vec<Option<String>> = puzzles::table
        .select(puzzles::themes)
        .filter(puzzles::themes.is_not_null())
        .load(&mut db)?;

    let mut unique_themes = std::collections::HashSet::new();
    for theme_opt in themes {
        if let Some(theme_str) = theme_opt {
            for theme in theme_str.split_whitespace() {
                let trimmed = theme.trim().to_string();
                if !trimmed.is_empty() {
                    unique_themes.insert(trimmed);
                }
            }
        }
    }

    // Group themes by category
    let mut grouped: HashMap<String, Vec<ThemeOption>> = HashMap::new();
    for theme in unique_themes {
        let category = get_theme_category(&theme).to_string();
        let option = ThemeOption {
            value: theme.clone(),
            label: get_theme_friendly_name(&theme),
        };
        grouped
            .entry(category)
            .or_insert_with(Vec::new)
            .push(option);
    }
    // Convert to sorted ThemeGroup vector
    let mut groups: Vec<ThemeGroup> = grouped
        .into_iter()
        .map(|(group, mut items)| {
            items.sort_by(|a, b| a.label.cmp(&b.label));
            ThemeGroup { group, items }
        })
        .collect();
    groups.sort_by(|a, b| a.group.cmp(&b.group));
    Ok(groups)
}

/// Gets distinct values for opening_tags from a puzzle database
/// OPTIMIZED: Uses normalized table if available, otherwise falls back to old method
///
/// # Arguments
/// * `file` - Path to the puzzle database
///
/// # Returns
/// * `Ok(Vec<OpeningTagOption>)` with distinct opening tag values and their friendly names
/// * `Err(Error)` if there was a problem accessing the database
#[allow(dead_code)] // Used by frontend via Tauri commands
#[tauri::command]
#[specta::specta]
pub fn get_puzzle_opening_tags(file: String) -> Result<Vec<OpeningTagOption>, Error> {
    validate_puzzle_db_file(&file)?;

    let mut db = diesel::SqliteConnection::establish(&file)?;

    // First check if opening_tags column exists
    let (_, has_opening_tags) = check_puzzle_db_columns(file.clone())?;
    if !has_opening_tags {
        return Ok(Vec::new());
    }

    // Check if normalized table exists (much faster)
    use diesel::prelude::*;
    use diesel::sql_query;
    #[derive(QueryableByName)]
    struct CountResult {
        #[diesel(sql_type = diesel::sql_types::BigInt, column_name = "count")]
        count: i64,
    }
    let result: Vec<CountResult> = sql_query(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='puzzle_opening_tags'"
    ).load(&mut db).unwrap_or_default();

    if result.first().map(|r| r.count).unwrap_or(0) > 0 {
        // Use normalized table - MUCH faster!
        // Check if friendly_name column exists
        #[derive(QueryableByName)]
        struct ColumnInfo {
            #[diesel(sql_type = diesel::sql_types::Text, column_name = "name")]
            name: String,
        }
        let columns: Vec<ColumnInfo> = sql_query("PRAGMA table_info(puzzle_opening_tags)")
            .load(&mut db)
            .unwrap_or_default();
        let has_friendly_name = columns.iter().any(|col| col.name == "friendly_name");

        if has_friendly_name {
            #[derive(QueryableByName)]
            struct TagRow {
                #[diesel(sql_type = diesel::sql_types::Text, column_name = "opening_tag")]
                opening_tag: String,
                #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>, column_name = "friendly_name")]
                friendly_name: Option<String>,
            }
            let tags: Vec<TagRow> = sql_query("SELECT DISTINCT opening_tag, friendly_name FROM puzzle_opening_tags ORDER BY COALESCE(friendly_name, opening_tag)")
                .load(&mut db)?;
            // Return both value (technical) and label (friendly name)
            return Ok(tags
                .into_iter()
                .map(|r| OpeningTagOption {
                    value: r.opening_tag.clone(),
                    label: r
                        .friendly_name
                        .unwrap_or_else(|| get_opening_tag_friendly_name(&r.opening_tag)),
                })
                .collect());
        } else {
            #[derive(QueryableByName)]
            struct TagRow {
                #[diesel(sql_type = diesel::sql_types::Text, column_name = "opening_tag")]
                opening_tag: String,
            }
            let tags: Vec<TagRow> = sql_query(
                "SELECT DISTINCT opening_tag FROM puzzle_opening_tags ORDER BY opening_tag",
            )
            .load(&mut db)?;
            return Ok(tags
                .into_iter()
                .map(|r| OpeningTagOption {
                    value: r.opening_tag.clone(),
                    label: get_opening_tag_friendly_name(&r.opening_tag),
                })
                .collect());
        }
    }

    // Fallback to old method for databases without normalized tables
    let opening_tags: Vec<Option<String>> = puzzles::table
        .select(puzzles::opening_tags)
        .filter(puzzles::opening_tags.is_not_null())
        .load(&mut db)?;

    let mut unique_tags = std::collections::HashSet::new();
    for tag_opt in opening_tags {
        if let Some(tag_str) = tag_opt {
            if let Some(first_word) = tag_str.split_whitespace().next() {
                let trimmed = first_word.trim().to_string();
                if !trimmed.is_empty() {
                    unique_tags.insert(trimmed);
                }
            }
        }
    }

    let mut result: Vec<OpeningTagOption> = unique_tags
        .into_iter()
        .map(|tag| OpeningTagOption {
            value: tag.clone(),
            label: get_opening_tag_friendly_name(&tag),
        })
        .collect();
    result.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(result)
}

/// Returns all data required to render puzzle filters in one backend call.
#[tauri::command]
#[specta::specta]
pub fn get_puzzle_filters_metadata(file: String) -> Result<PuzzleFiltersMetadata, Error> {
    validate_puzzle_db_file(&file)?;

    let (has_themes_column, has_opening_tags_column) = check_puzzle_db_columns(file.clone())?;

    let themes = if has_themes_column {
        get_puzzle_themes(file.clone())?
    } else {
        Vec::new()
    };

    let opening_tags = if has_opening_tags_column {
        get_puzzle_opening_tags(file.clone())?
    } else {
        Vec::new()
    };

    let rating_range = get_puzzle_rating_range(file.clone())
        .ok()
        .and_then(|(min, max)| {
            if min == 0 && max == 0 {
                None
            } else {
                Some((min, max))
            }
        });

    Ok(PuzzleFiltersMetadata {
        rating_range,
        has_themes: !themes.is_empty(),
        has_opening_tags: !opening_tags.is_empty(),
        themes,
        opening_tags,
    })
}

/// Returns dependent puzzle filter options for the active context.
/// - `themes` options are filtered by `opening_tags` + rating range.
/// - `opening_tags` options are filtered by `themes` + rating range.
#[tauri::command]
#[specta::specta]
pub fn get_puzzle_dependent_filters_metadata(
    file: String,
    min_rating: u16,
    max_rating: u16,
    themes: Option<Vec<String>>,
    opening_tags: Option<Vec<String>>,
    side_to_move: Option<String>,
) -> Result<PuzzleFiltersMetadata, Error> {
    validate_puzzle_db_file(&file)?;

    let db_path = PathBuf::from(&file);
    let mut db = diesel::SqliteConnection::establish(&file)?;
    apply_local_puzzle_read_pragmas(&mut db);
    ensure_puzzles_optional_columns(&mut db)?;
    migrate_puzzle_database_to_normalized(&db_path)?;
    PuzzleCache::ensure_temp_query_tables(&mut db)?;

    let themes = PuzzleCache::normalize_filter_list(themes);
    let opening_tags = PuzzleCache::normalize_filter_list(opening_tags);
    let side_to_move = PuzzleCache::normalize_side_to_move(side_to_move);

    let available_opening_tags = query_available_opening_tags_for_filters(
        &mut db,
        min_rating,
        max_rating,
        themes.as_deref(),
        side_to_move.as_deref(),
    )?;
    let available_themes = query_available_themes_for_filters(
        &mut db,
        min_rating,
        max_rating,
        opening_tags.as_deref(),
        side_to_move.as_deref(),
    )?;

    let grouped_themes = group_themes_for_ui(available_themes);
    let opening_options = opening_tags_for_ui(available_opening_tags);

    Ok(PuzzleFiltersMetadata {
        rating_range: Some((min_rating, max_rating)),
        has_themes: !grouped_themes.is_empty(),
        has_opening_tags: !opening_options.is_empty(),
        themes: grouped_themes,
        opening_tags: opening_options,
    })
}

/// Gets the minimum and maximum rating range from a puzzle database
///
/// This function queries the database to find the lowest and highest puzzle ratings.
///
/// # Arguments
/// * `file` - Path to the puzzle database
///
/// # Returns
/// * `Ok((min_rating, max_rating))` with the rating range
/// * `Err(Error)` if there was a problem accessing the database
#[tauri::command]
#[specta::specta]
pub fn get_puzzle_rating_range(file: String) -> Result<(u16, u16), Error> {
    let mut db = diesel::SqliteConnection::establish(&file)?;

    let min_rating = puzzles::table
        .select(diesel::dsl::min(puzzles::rating))
        .first::<Option<i32>>(&mut db)?
        .unwrap_or(0) as u16;

    let max_rating = puzzles::table
        .select(diesel::dsl::max(puzzles::rating))
        .first::<Option<i32>>(&mut db)?
        .unwrap_or(0) as u16;

    Ok((min_rating, max_rating))
}

/// Information about a puzzle database
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PuzzleDatabaseInfo {
    /// The title of the puzzle database (derived from filename)
    title: String,
    /// Description of the puzzle database (currently not populated)
    /// TODO: Consider adding a way to store and retrieve database descriptions
    description: String,
    /// Number of puzzles in the database
    puzzle_count: i32,
    /// Size of the database file in bytes
    storage_size: i64,
    /// Full path to the database file
    path: String,
}

/// Gets information about a puzzle database
///
/// This function retrieves metadata about a puzzle database, including:
/// - The title (derived from the filename)
/// - The number of puzzles in the database
/// - The size of the database file
/// - The full path to the database file
///
/// # Arguments
/// * `file` - Relative path to the puzzle database within the app's data directory
/// * `app` - Tauri app handle used to resolve the full path
///
/// # Returns
/// * `Ok(PuzzleDatabaseInfo)` with the database information
/// * `Err(Error)` if there was a problem accessing the database or file
#[tauri::command]
#[specta::specta]
pub async fn get_puzzle_db_info(
    file: PathBuf,
    app: tauri::AppHandle,
) -> Result<PuzzleDatabaseInfo, Error> {
    // Ensure we're working with a relative path by checking if it's absolute
    let file_path = if file.is_absolute() {
        // If it's already absolute, use it directly
        file
    } else {
        // Otherwise, resolve it relative to the db directory in AppData
        let db_path = PathBuf::from("puzzles").join(file);
        app.path().resolve(db_path, BaseDirectory::AppData)?
    };

    // Verify the file actually exists before trying to open it
    if !file_path.exists() {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "Puzzle database file does not exist: {}",
                file_path.display()
            ),
        )));
    }

    // Verify the file is not empty (SQLite files should be at least a few bytes)
    let metadata = file_path.metadata()?;
    if metadata.len() == 0 {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Puzzle database file is empty: {}", file_path.display()),
        )));
    }

    let mut db = diesel::SqliteConnection::establish(&file_path.to_string_lossy())?;

    // Check if the puzzles table exists and get count safely
    let puzzle_count = match puzzles::table.count().get_result::<i64>(&mut db) {
        Ok(count) => count as i32,
        Err(diesel::result::Error::DatabaseError(kind, info)) => {
            // Check if the error is related to missing table
            if info.message().contains("no such table") {
                // Table doesn't exist - this could be an uninitialized database file
                // For safety, we return 0 instead of auto-initializing
                0
            } else {
                // For other database errors, propagate them
                return Err(Error::from(diesel::result::Error::DatabaseError(
                    kind, info,
                )));
            }
        }
        Err(e) => {
            // For other errors, propagate them
            return Err(Error::from(e));
        }
    };

    let storage_size = file_path.metadata()?.len() as i64;
    let filename = file_path
        .file_name()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Invalid path: no filename",
            )
        })?
        .to_string_lossy();

    Ok(PuzzleDatabaseInfo {
        title: filename.to_string(),
        description: "".to_string(),
        puzzle_count,
        storage_size,
        path: file_path.to_string_lossy().to_string(),
    })
}

/// Imports puzzles from a local file into a new puzzle database
///
/// This function can handle different types of puzzle files:
/// - PGN files containing puzzles (with FEN positions and solution moves)
/// - Existing puzzle database files (.db, .db3)
/// - Compressed files (.zst)
///
/// # Arguments
/// * `source_file` - Path to the source puzzle file
/// * `db_path` - Path where the new puzzle database should be created
/// * `title` - Title for the puzzle database
/// * `description` - Optional description for the puzzle database
/// * `app` - Tauri app handle for progress events
///
/// # Returns
/// * `Ok(())` if import was successful
/// * `Err(Error)` if there was a problem importing the file
#[tauri::command]
#[specta::specta]
pub async fn import_puzzle_file(
    source_file: PathBuf,
    db_path: PathBuf,
    title: String,
    description: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), Error> {
    let description = description.unwrap_or_default();

    // Check if source file exists
    if !source_file.exists() {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Source file not found",
        )));
    }

    // Create parent directory for the database if it doesn't exist
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Remove existing database file if it exists to avoid empty/corrupted files
    if db_path.exists() {
        std::fs::remove_file(&db_path).map_err(|e| {
            Error::IoError(std::io::Error::new(
                e.kind(),
                format!(
                    "Failed to remove existing database file '{}': {}",
                    db_path.display(),
                    e
                ),
            ))
        })?;
    }

    // Check file extension and name to determine format
    let extension = source_file.extension().and_then(|ext| ext.to_str());
    let file_name = source_file
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");

    // Check if it's a CSV file (could be .csv or .csv.zst)
    let is_csv = file_name.ends_with(".csv") || file_name.ends_with(".csv.zst");

    match extension {
        Some("db") | Some("db3") => {
            // Copy existing puzzle database
            copy_puzzle_database(&source_file, &db_path, &title, &description).await
        }
        Some("pgn") => {
            // Parse PGN file and extract puzzles
            import_puzzles_from_pgn(&source_file, &db_path, &title, &description, &app).await
        }
        Some("zst") => {
            // Handle compressed files - check if it's CSV or PGN
            if is_csv {
                import_puzzles_from_csv_compressed(
                    &source_file,
                    &db_path,
                    &title,
                    &description,
                    &app,
                )
                .await
            } else {
                import_puzzles_from_compressed(&source_file, &db_path, &title, &description, &app)
                    .await
            }
        }
        Some("csv") => {
            // Handle uncompressed CSV files
            import_puzzles_from_csv(&source_file, &db_path, &title, &description, &app).await
        }
        _ => Err(Error::UnsupportedFileFormat(format!(
            "Unsupported file format: {:?}",
            extension
        ))),
    }
}

/// Validates that a file is a valid SQLite database
fn validate_sqlite_database(file_path: &PathBuf) -> Result<(), Error> {
    // Verify the file exists
    if !file_path.exists() {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("File does not exist: {}", file_path.display()),
        )));
    }

    // Verify the file is not empty
    let metadata = file_path.metadata()?;
    if metadata.len() == 0 {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Database file is empty: {}", file_path.display()),
        )));
    }

    // First, try to open it as a SQLite database - this is the most reliable check
    // If Diesel can open it, it's valid
    match diesel::SqliteConnection::establish(&file_path.to_string_lossy()) {
        Ok(_) => {
            // Successfully opened, it's a valid SQLite database
            return Ok(());
        }
        Err(e) => {
            // If opening fails, check the header to provide better error messages
            let mut file = File::open(file_path)?;
            let mut header = [0u8; 16];

            // Try to read the header
            if let Ok(_) = file.read_exact(&mut header) {
                // SQLite database files start with "SQLite format 3\000" (16 bytes)
                // Using explicit array to ensure correct size
                let sqlite_magic: [u8; 16] = [
                    b'S', b'Q', b'L', b'i', b't', b'e', b' ', b'f', b'o', b'r', b'm', b'a', b't',
                    b' ', b'3', 0u8,
                ];

                // Check if header matches
                if header == sqlite_magic {
                    // Header matches but Diesel can't open it - might be corrupted or locked
                    return Err(Error::UnsupportedFileFormat(format!(
                        "File has correct SQLite header but cannot be opened as a database. This may indicate the file is corrupted, locked, or in use. Error: {}",
                        e
                    )));
                } else {
                    // Header doesn't match - check if it's HTML or other format
                    let header_str = String::from_utf8_lossy(&header);
                    if header_str.trim_start().starts_with("<!DOCTYPE")
                        || header_str.trim_start().starts_with("<html")
                        || header_str.trim_start().starts_with("<!doctype")
                        || header_str.trim_start().starts_with("<HTML")
                    {
                        // Read more of the file to return a clearer format error.
                        file.seek(SeekFrom::Start(0))?;
                        let mut sample = vec![0u8; 512.min(metadata.len() as usize)];
                        file.read_exact(&mut sample[..])?;
                        let sample_str = String::from_utf8_lossy(&sample);

                        return Err(Error::UnsupportedFileFormat(format!(
                            "Downloaded file appears to be an HTML page ({} bytes), not a database file. Please verify the link allows direct download. First 200 chars: {}",
                            metadata.len(),
                            sample_str.chars().take(200).collect::<String>()
                        )));
                    }

                    // Read the first bytes to return a clearer format error.
                    file.seek(SeekFrom::Start(0))?;
                    let mut extended_header = vec![0u8; 32.min(metadata.len() as usize)];
                    if extended_header.len() > 0 {
                        file.read_exact(&mut extended_header[..])?;
                    }

                    let header_hex: String = extended_header
                        .iter()
                        .map(|b| format!("{:02x}", b))
                        .collect::<Vec<_>>()
                        .join(" ");
                    let expected_hex: String = sqlite_magic
                        .iter()
                        .map(|b| format!("{:02x}", b))
                        .collect::<Vec<_>>()
                        .join(" ");

                    return Err(Error::UnsupportedFileFormat(format!(
                        "File is not a valid SQLite database. Expected SQLite format, but file header does not match.\nFile size: {} bytes.\nExpected header (hex): {}\nActual header (hex): {}\nDiesel error: {}\nFile may be corrupted or in wrong format.",
                        metadata.len(),
                        expected_hex,
                        header_hex,
                        e
                    )));
                }
            }

            // If we can't even read the header, return the Diesel error
            return Err(Error::UnsupportedFileFormat(format!(
                "Cannot open file as SQLite database. Error: {}",
                e
            )));
        }
    }
}

/// Copies an existing puzzle database to a new location
async fn copy_puzzle_database(
    source_file: &PathBuf,
    db_path: &PathBuf,
    _title: &str,
    _description: &str,
) -> Result<(), Error> {
    // Validate the source file before copying
    validate_sqlite_database(source_file)?;

    // Copy the source database file to the destination path
    std::fs::copy(source_file, db_path).map_err(|e| {
        Error::IoError(std::io::Error::new(
            e.kind(),
            format!("Failed to copy database: {}", e),
        ))
    })?;
    Ok(())
}

/// Validates a downloaded puzzle database file
#[tauri::command]
#[specta::specta]
pub async fn validate_puzzle_database(file: PathBuf) -> Result<bool, Error> {
    validate_sqlite_database(&file)?;
    Ok(true)
}

fn sanitize_puzzle_filename(name: &str) -> String {
    // Keep it simple and predictable across platforms.
    // Windows forbids: < > : " / \ | ? * and control chars. We also guard against path separators.
    let trimmed = name.trim();
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        let is_invalid =
            matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control();
        if is_invalid {
            out.push('_');
        } else {
            out.push(ch);
        }
    }

    let out = out.trim().trim_matches('.').to_string();
    if out.is_empty() {
        "puzzles".to_string()
    } else {
        out
    }
}

/// Download a puzzle database (or CSV source) into AppData/puzzles.
///
/// - Emits download progress via `download-progress`.
/// - For CSV/CSV.ZST sources, runs import (emits `import_puzzle_progress`) and deletes the temp file.
/// - For DB sources, validates the downloaded file and removes it if invalid.
#[tauri::command]
#[specta::specta]
pub async fn download_puzzle_database(
    database_id: i32,
    url: String,
    title: String,
    description: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), Error> {
    use crate::fs::download_file;
    use tauri::path::BaseDirectory;

    let title_trim = title.trim().to_string();
    if title_trim.is_empty() {
        return Err(Error::InvalidInput(
            "Puzzle database title cannot be empty".to_string(),
        ));
    }

    let file_name = sanitize_puzzle_filename(&title_trim);

    let is_csv = url.ends_with(".csv") || url.ends_with(".csv.zst");
    if is_csv {
        // Download to temp file first, then import to a DB.
        let tmp_ext = if url.ends_with(".csv.zst") {
            "csv.zst"
        } else {
            "csv"
        };
        let tmp_path = app
            .path()
            .resolve(
                format!("puzzles/{file_name}.download.{tmp_ext}"),
                BaseDirectory::AppData,
            )
            .map_err(|e| {
                Error::PackageManager(format!("Failed to resolve puzzle temp path: {e}"))
            })?;

        let db_path = app
            .path()
            .resolve(format!("puzzles/{file_name}.db3"), BaseDirectory::AppData)
            .map_err(|e| Error::PackageManager(format!("Failed to resolve puzzle DB path: {e}")))?;

        let download_id = format!("puzzle_db_{database_id}");
        let download_res = download_file(
            download_id,
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

        let import_res = import_puzzle_file(
            tmp_path.clone(),
            db_path,
            title_trim,
            description,
            app.clone(),
        )
        .await;
        let _ = std::fs::remove_file(&tmp_path);
        return import_res;
    }

    // DB download: download into a partial file first, then rename.
    let db_path = app
        .path()
        .resolve(format!("puzzles/{file_name}.db3"), BaseDirectory::AppData)
        .map_err(|e| Error::PackageManager(format!("Failed to resolve puzzle DB path: {e}")))?;

    let tmp_path = app
        .path()
        .resolve(
            format!("puzzles/{file_name}.db3.partial"),
            BaseDirectory::AppData,
        )
        .map_err(|e| {
            Error::PackageManager(format!("Failed to resolve puzzle temp DB path: {e}"))
        })?;

    let download_id = format!("puzzle_db_{database_id}");
    let download_res = download_file(
        download_id,
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

    if db_path.exists() {
        let _ = std::fs::remove_file(&db_path);
    }
    std::fs::rename(&tmp_path, &db_path)?;

    // Validate and remove if invalid.
    if let Err(e) = validate_sqlite_database(&db_path) {
        let _ = std::fs::remove_file(&db_path);
        return Err(e);
    }

    Ok(())
}

fn strip_move_number_prefix(token: &str) -> &str {
    // Examples we want to handle:
    // - "1." / "1..." (sometimes separated tokens)
    // - "1.e4" / "1...e5" (sometimes combined tokens)
    let mut t = token.trim();
    let mut idx = 0usize;
    for c in t.chars() {
        if c.is_ascii_digit() || c == '.' {
            idx += c.len_utf8();
        } else {
            break;
        }
    }
    if idx > 0 {
        t = &t[idx..];
    }
    if t.starts_with("...") {
        t = &t[3..];
    }
    t.trim()
}

fn is_result_token(tok: &str) -> bool {
    matches!(tok, "1-0" | "0-1" | "1/2-1/2" | "*")
}

fn is_move_number_token(tok: &str) -> bool {
    let t = tok.trim();
    !t.is_empty() && t.chars().all(|c| c.is_ascii_digit() || c == '.')
}

fn tokenize_puzzle_movetext(movetext: &str) -> Vec<String> {
    movetext
        .split_whitespace()
        .filter_map(|raw| {
            if raw.is_empty() {
                return None;
            }
            if raw.starts_with('$') && raw[1..].chars().all(|c| c.is_ascii_digit()) {
                return None;
            }

            let mut t = strip_move_number_prefix(raw).to_string();
            if t.is_empty() {
                return None;
            }

            // Trim trailing move-number dots (e.g. "2." token)
            while t.ends_with('.') && is_move_number_token(&t) {
                t.pop();
            }

            let t = t.trim();
            if t.is_empty() {
                return None;
            }
            if is_result_token(t) || is_move_number_token(t) {
                return None;
            }

            Some(t.to_string())
        })
        .collect()
}

fn token_to_move(token: &str, pos: &Chess) -> Option<shakmaty::Move> {
    // Prefer SAN(+suffix), then fall back to UCI.
    if let Ok(sp) = SanPlus::from_ascii(token.as_bytes()) {
        if let Ok(mv) = sp.san.to_move(pos) {
            return Some(mv);
        }
    }
    if let Ok(uci) = UciMove::from_ascii(token.as_bytes()) {
        if let Ok(mv) = uci.to_move(pos) {
            return Some(mv);
        }
    }
    None
}

fn normalize_pgn_puzzle_moves_to_uci(fen: &str, movetext: &str) -> Result<String, Error> {
    let fen: Fen = fen.parse()?;
    let mut pos: Chess = fen.into_position(CastlingMode::Standard)?;

    let tokens = tokenize_puzzle_movetext(movetext);
    if tokens.is_empty() {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "No moves found in puzzle movetext",
        )));
    }

    let mut out: Vec<String> = Vec::with_capacity(tokens.len());
    for tok in tokens {
        let mv = token_to_move(&tok, &pos).ok_or_else(|| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Failed to parse puzzle move token: {}", tok),
            ))
        })?;

        let uci = mv.to_uci(CastlingMode::Standard).to_string();
        pos.play_unchecked(&mv);
        out.push(uci);
    }

    Ok(out.join(" "))
}

/// Imports puzzles from a PGN file
async fn import_puzzles_from_pgn(
    source_file: &PathBuf,
    db_path: &PathBuf,
    title: &str,
    description: &str,
    app: &tauri::AppHandle,
) -> Result<(), Error> {
    // Create the puzzle database
    create_puzzle_database(db_path, title, description)?;

    let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;

    // Read and parse PGN file with better error handling
    let file = File::open(source_file).map_err(|e| {
        Error::IoError(std::io::Error::new(
            e.kind(),
            format!("Failed to open file '{}': {}", source_file.display(), e),
        ))
    })?;

    let puzzles = parse_puzzles_from_pgn(file).map_err(|e| {
        Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "Failed to parse puzzles from '{}': {}",
                source_file.display(),
                e
            ),
        ))
    })?;

    let puzzles: Vec<NewPuzzle> = puzzles
        .into_iter()
        .filter_map(|mut puzzle| {
            match normalize_pgn_puzzle_moves_to_uci(&puzzle.fen, &puzzle.moves) {
                Ok(uci_moves) => {
                    puzzle.moves = uci_moves;
                    Some(puzzle)
                }
                Err(_) => None,
            }
        })
        .collect();

    if puzzles.is_empty() {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("No valid puzzles found in file '{}'", source_file.display()),
        )));
    }

    // Insert puzzles into database in batches
    let batch_size = 1000;
    let total_puzzles = puzzles.len();

    for (i, chunk) in puzzles.chunks(batch_size).enumerate() {
        db.transaction::<_, Error, _>(|db| {
            for puzzle in chunk {
                insert_into(puzzles::table).values(puzzle).execute(db)?;
            }
            Ok(())
        })?;

        // Emit progress event
        let processed = ((i + 1) * batch_size).min(total_puzzles);
        let _ = app.emit("import_puzzle_progress", (processed, total_puzzles));
    }

    Ok(())
}

/// Imports puzzles from a compressed file (PGN format)
async fn import_puzzles_from_compressed(
    source_file: &PathBuf,
    db_path: &PathBuf,
    title: &str,
    description: &str,
    app: &tauri::AppHandle,
) -> Result<(), Error> {
    // Create the puzzle database
    create_puzzle_database(db_path, title, description)?;

    let file = File::open(source_file).map_err(|e| {
        Error::IoError(std::io::Error::new(
            e.kind(),
            format!(
                "Failed to open compressed file '{}': {}",
                source_file.display(),
                e
            ),
        ))
    })?;

    let decoder = zstd::Decoder::new(file).map_err(|e| {
        Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "Failed to decompress file '{}': {}",
                source_file.display(),
                e
            ),
        ))
    })?;

    let puzzles = parse_puzzles_from_pgn(decoder).map_err(|e| {
        Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "Failed to parse puzzles from compressed file '{}': {}",
                source_file.display(),
                e
            ),
        ))
    })?;

    let puzzles: Vec<NewPuzzle> = puzzles
        .into_iter()
        .filter_map(|mut puzzle| {
            match normalize_pgn_puzzle_moves_to_uci(&puzzle.fen, &puzzle.moves) {
                Ok(uci_moves) => {
                    puzzle.moves = uci_moves;
                    Some(puzzle)
                }
                Err(_) => None,
            }
        })
        .collect();

    if puzzles.is_empty() {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "No valid puzzles found in compressed file '{}'",
                source_file.display()
            ),
        )));
    }

    let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;

    // Insert puzzles into database in batches
    let batch_size = 1000;
    let total_puzzles = puzzles.len();

    for (i, chunk) in puzzles.chunks(batch_size).enumerate() {
        db.transaction::<_, Error, _>(|db| {
            for puzzle in chunk {
                insert_into(puzzles::table).values(puzzle).execute(db)?;
            }
            Ok(())
        })?;

        // Emit progress event
        let processed = ((i + 1) * batch_size).min(total_puzzles);
        let _ = app.emit("import_puzzle_progress", (processed, total_puzzles));
    }

    Ok(())
}

/// Imports puzzles from a CSV file
/// Uses streaming processing for better performance with large files
async fn import_puzzles_from_csv(
    source_file: &PathBuf,
    db_path: &PathBuf,
    title: &str,
    description: &str,
    app: &tauri::AppHandle,
) -> Result<(), Error> {
    // Create the database first (without indexes for faster insertion)
    create_puzzle_database(db_path, title, description)?;

    // Use a guard to clean up the database file if insertion fails
    let result = (|| -> Result<(), Error> {
        let file = File::open(source_file).map_err(|e| {
            Error::IoError(std::io::Error::new(
                e.kind(),
                format!("Failed to open CSV file '{}': {}", source_file.display(), e),
            ))
        })?;

        let reader = BufReader::with_capacity(1024 * 1024, file); // 1MB buffer
        let mut csv_reader = ReaderBuilder::new().has_headers(true).from_reader(reader);

        let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;

        // Apply additional performance optimizations
        db.batch_execute("PRAGMA journal_mode = WAL;")?;
        db.batch_execute("PRAGMA synchronous = NORMAL;")?;
        db.batch_execute("PRAGMA cache_size = -128000;")?; // 128MB cache for bulk insert
        db.batch_execute("PRAGMA temp_store = MEMORY;")?;
        db.batch_execute("PRAGMA mmap_size = 536870912;")?; // 512MB for bulk operations

        // Process puzzles in streaming batches
        let batch_size = 10000; // Increased from 1000 for better performance
        let mut batch = Vec::with_capacity(batch_size);
        let mut total_inserted = 0;
        let mut batch_count = 0;

        for result in csv_reader.deserialize() {
            let record: LichessPuzzleCsv = result.map_err(|e| {
                Error::IoError(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Failed to parse CSV record: {}", e),
                ))
            })?;

            // Skip puzzles with missing required fields
            if record.fen.is_empty() || record.moves.is_empty() {
                continue;
            }

            let puzzle = NewPuzzle {
                fen: record.fen,
                moves: record.moves,
                rating: record.rating.unwrap_or(1500),
                rating_deviation: record.rating_deviation.unwrap_or(350),
                popularity: record.popularity.unwrap_or(0),
                nb_plays: record.nb_plays.unwrap_or(0),
                themes: record.themes,
                game_url: record.game_url,
                opening_tags: record.opening_tags,
            };

            batch.push(puzzle);

            // Insert when batch is full
            if batch.len() >= batch_size {
                db.transaction::<_, Error, _>(|db| {
                    for puzzle in &batch {
                        insert_into(puzzles::table).values(puzzle).execute(db)?;
                    }
                    Ok(())
                })?;

                total_inserted += batch.len();
                batch_count += 1;

                // Emit progress event every 10 batches to avoid too many events
                if batch_count % 10 == 0 {
                    let _ = app.emit("import_puzzle_progress", (total_inserted, 0));
                }

                batch.clear();
            }
        }

        // Insert remaining puzzles
        if !batch.is_empty() {
            db.transaction::<_, Error, _>(|db| {
                for puzzle in &batch {
                    insert_into(puzzles::table).values(puzzle).execute(db)?;
                }
                Ok(())
            })?;
            total_inserted += batch.len();
        }

        if total_inserted == 0 {
            return Err(Error::IoError(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "No valid puzzles found in CSV file '{}'",
                    source_file.display()
                ),
            )));
        }

        // Emit final progress
        let _ = app.emit("import_puzzle_progress", (total_inserted, total_inserted));

        // Populate normalized tables for fast filtering
        populate_normalized_tables(db_path)?;

        // Create indexes AFTER all data is inserted (much faster)
        create_puzzle_indexes(db_path)?;

        Ok(())
    })();

    // If insertion failed, remove the empty database file
    if result.is_err() && db_path.exists() {
        let _ = std::fs::remove_file(&db_path);
    }

    result
}

/// Imports puzzles from a compressed CSV file (.csv.zst)
/// Uses streaming processing for better performance with large files
async fn import_puzzles_from_csv_compressed(
    source_file: &PathBuf,
    db_path: &PathBuf,
    title: &str,
    description: &str,
    app: &tauri::AppHandle,
) -> Result<(), Error> {
    // Create the database first (without indexes for faster insertion)
    create_puzzle_database(db_path, title, description)?;

    // Use a guard to clean up the database file if insertion fails
    let result = (|| -> Result<(), Error> {
        let file = File::open(source_file).map_err(|e| {
            Error::IoError(std::io::Error::new(
                e.kind(),
                format!(
                    "Failed to open compressed CSV file '{}': {}",
                    source_file.display(),
                    e
                ),
            ))
        })?;

        let decoder = zstd::Decoder::new(file).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "Failed to decompress CSV file '{}': {}",
                    source_file.display(),
                    e
                ),
            ))
        })?;

        let reader = BufReader::with_capacity(1024 * 1024, decoder); // 1MB buffer
        let mut csv_reader = ReaderBuilder::new().has_headers(true).from_reader(reader);

        let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;

        // Apply additional performance optimizations
        db.batch_execute("PRAGMA journal_mode = WAL;")?;
        db.batch_execute("PRAGMA synchronous = NORMAL;")?;
        db.batch_execute("PRAGMA cache_size = -128000;")?; // 128MB cache for bulk insert
        db.batch_execute("PRAGMA temp_store = MEMORY;")?;
        db.batch_execute("PRAGMA mmap_size = 536870912;")?; // 512MB for bulk operations

        // Process puzzles in streaming batches
        let batch_size = 10000; // Increased from 1000 for better performance
        let mut batch = Vec::with_capacity(batch_size);
        let mut total_inserted = 0;
        let mut batch_count = 0;

        for result in csv_reader.deserialize() {
            let record: LichessPuzzleCsv = result.map_err(|e| {
                Error::IoError(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Failed to parse CSV record: {}", e),
                ))
            })?;

            // Skip puzzles with missing required fields
            if record.fen.is_empty() || record.moves.is_empty() {
                continue;
            }

            let puzzle = NewPuzzle {
                fen: record.fen,
                moves: record.moves,
                rating: record.rating.unwrap_or(1500),
                rating_deviation: record.rating_deviation.unwrap_or(350),
                popularity: record.popularity.unwrap_or(0),
                nb_plays: record.nb_plays.unwrap_or(0),
                themes: record.themes,
                game_url: record.game_url,
                opening_tags: record.opening_tags,
            };

            batch.push(puzzle);

            // Insert when batch is full
            if batch.len() >= batch_size {
                db.transaction::<_, Error, _>(|db| {
                    for puzzle in &batch {
                        insert_into(puzzles::table).values(puzzle).execute(db)?;
                    }
                    Ok(())
                })?;

                total_inserted += batch.len();
                batch_count += 1;

                // Emit progress event every 10 batches to avoid too many events
                if batch_count % 10 == 0 {
                    let _ = app.emit("import_puzzle_progress", (total_inserted, 0));
                }

                batch.clear();
            }
        }

        // Insert remaining puzzles
        if !batch.is_empty() {
            db.transaction::<_, Error, _>(|db| {
                for puzzle in &batch {
                    insert_into(puzzles::table).values(puzzle).execute(db)?;
                }
                Ok(())
            })?;
            total_inserted += batch.len();
        }

        if total_inserted == 0 {
            return Err(Error::IoError(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "No valid puzzles found in compressed CSV file '{}'",
                    source_file.display()
                ),
            )));
        }

        // Emit final progress
        let _ = app.emit("import_puzzle_progress", (total_inserted, total_inserted));

        // Populate normalized tables for fast filtering
        populate_normalized_tables(db_path)?;

        // Create indexes AFTER all data is inserted (much faster)
        create_puzzle_indexes(db_path)?;

        Ok(())
    })();

    // If insertion failed, remove the empty database file
    if result.is_err() && db_path.exists() {
        let _ = std::fs::remove_file(&db_path);
    }

    result
}

/// Creates a new puzzle database with the proper schema
/// Note: Indexes are NOT created here - they should be created after bulk insert for better performance
fn create_puzzle_database(
    db_path: &PathBuf,
    _title: &str,
    _description: &str,
) -> Result<(), Error> {
    let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;

    // Load the schema from external SQL files
    const PUZZLES_TABLES: &str = include_str!("../../database/schema/puzzles_tables.sql");

    // Apply performance optimizations BEFORE creating tables
    db.batch_execute("PRAGMA journal_mode = WAL;")?;
    db.batch_execute("PRAGMA synchronous = NORMAL;")?;
    db.batch_execute("PRAGMA cache_size = -64000;")?; // 64MB cache
    db.batch_execute("PRAGMA temp_store = MEMORY;")?;
    db.batch_execute("PRAGMA mmap_size = 268435456;")?; // 256MB
    db.batch_execute("PRAGMA page_size = 4096;")?;

    // Create the puzzles table using the external schema
    db.batch_execute(PUZZLES_TABLES)?;

    // NOTE: Indexes are NOT created here - they will be created after bulk insert

    // Verify the database was created successfully by checking file size
    // SQLite databases should be at least a few KB after schema creation
    let metadata = db_path.metadata()?;
    if metadata.len() == 0 {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Failed to create puzzle database: file is empty after schema creation"),
        )));
    }

    Ok(())
}

/// Populates normalized tables (puzzle_themes and puzzle_opening_tags) from puzzles table
/// This should be called after all puzzles are inserted but before creating indexes
fn populate_normalized_tables(db_path: &PathBuf) -> Result<(), Error> {
    let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;

    // Clear existing normalized data
    db.batch_execute("DELETE FROM puzzle_themes;")?;
    db.batch_execute("DELETE FROM puzzle_opening_tags;")?;

    // Get all puzzles with themes and opening_tags
    let puzzles_with_metadata: Vec<(i32, Option<String>, Option<String>)> = puzzles::table
        .select((puzzles::id, puzzles::themes, puzzles::opening_tags))
        .filter(
            puzzles::themes
                .is_not_null()
                .or(puzzles::opening_tags.is_not_null()),
        )
        .load(&mut db)?;

    // Process in batches for better performance using prepared statements
    let batch_size = 500;
    let mut theme_batch = Vec::new();
    let mut tag_batch = Vec::new();

    for (puzzle_id, themes_opt, opening_tags_opt) in puzzles_with_metadata {
        // Process themes
        if let Some(themes_str) = themes_opt {
            if !themes_str.trim().is_empty() {
                for theme in themes_str.split_whitespace() {
                    let trimmed = theme.trim();
                    if !trimmed.is_empty() {
                        theme_batch.push((puzzle_id, trimmed.to_string()));
                    }
                }
            }
        }

        // Process opening_tags (only first word)
        if let Some(tags_str) = opening_tags_opt {
            if !tags_str.trim().is_empty() {
                if let Some(first_word) = tags_str.split_whitespace().next() {
                    let trimmed = first_word.trim();
                    if !trimmed.is_empty() {
                        tag_batch.push((puzzle_id, trimmed.to_string()));
                    }
                }
            }
        }

        // Insert batches when they reach the size limit
        if theme_batch.len() >= batch_size {
            db.transaction::<_, Error, _>(|db| {
                for (id, theme) in &theme_batch {
                    // Use INSERT with proper escaping
                    let escaped_theme = theme.replace("'", "''");
                    let friendly_name = get_theme_friendly_name(theme);
                    let escaped_friendly = friendly_name.replace("'", "''");
                    diesel::sql_query(&format!(
                        "INSERT INTO puzzle_themes (puzzle_id, theme, friendly_name) VALUES ({}, '{}', '{}')",
                        id, escaped_theme, escaped_friendly
                    )).execute(db)?;
                }
                Ok(())
            })?;
            theme_batch.clear();
        }

        if tag_batch.len() >= batch_size {
            db.transaction::<_, Error, _>(|db| {
                for (id, tag) in &tag_batch {
                    // Use INSERT with proper escaping
                    let escaped_tag = tag.replace("'", "''");
                    let friendly_name = get_opening_tag_friendly_name(tag);
                    let escaped_friendly = friendly_name.replace("'", "''");
                    diesel::sql_query(&format!(
                        "INSERT INTO puzzle_opening_tags (puzzle_id, opening_tag, friendly_name) VALUES ({}, '{}', '{}')",
                        id, escaped_tag, escaped_friendly
                    )).execute(db)?;
                }
                Ok(())
            })?;
            tag_batch.clear();
        }
    }

    // Insert remaining items
    if !theme_batch.is_empty() {
        db.transaction::<_, Error, _>(|db| {
            for (id, theme) in &theme_batch {
                let escaped_theme = theme.replace("'", "''");
                let friendly_name = get_theme_friendly_name(theme);
                let escaped_friendly = friendly_name.replace("'", "''");
                diesel::sql_query(&format!(
                    "INSERT INTO puzzle_themes (puzzle_id, theme, friendly_name) VALUES ({}, '{}', '{}')",
                    id, escaped_theme, escaped_friendly
                )).execute(db)?;
            }
            Ok(())
        })?;
    }

    if !tag_batch.is_empty() {
        db.transaction::<_, Error, _>(|db| {
            for (id, tag) in &tag_batch {
                let escaped_tag = tag.replace("'", "''");
                let friendly_name = get_opening_tag_friendly_name(tag);
                let escaped_friendly = friendly_name.replace("'", "''");
                diesel::sql_query(&format!(
                    "INSERT INTO puzzle_opening_tags (puzzle_id, opening_tag, friendly_name) VALUES ({}, '{}', '{}')",
                    id, escaped_tag, escaped_friendly
                )).execute(db)?;
            }
            Ok(())
        })?;
    }

    Ok(())
}

/// Creates indexes on the puzzle database after bulk insert
fn create_puzzle_indexes(db_path: &PathBuf) -> Result<(), Error> {
    let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;
    const PUZZLES_INDEXES: &str = include_str!("../../database/indexes/puzzles_indexes.sql");
    db.batch_execute(PUZZLES_INDEXES)?;
    Ok(())
}

/// Migrates an existing puzzle database to include normalized tables
/// This should be called once for databases created before the optimization
fn migrate_puzzle_database_to_normalized(db_path: &PathBuf) -> Result<(), Error> {
    let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;

    // Check if normalized tables already exist
    use diesel::prelude::*;
    use diesel::sql_query;
    #[derive(QueryableByName)]
    struct CountResult {
        #[diesel(sql_type = diesel::sql_types::BigInt, column_name = "count")]
        count: i64,
    }
    let result: Vec<CountResult> = sql_query(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name IN ('puzzle_themes', 'puzzle_opening_tags')"
    ).load(&mut db).unwrap_or_default();

    if result.first().map(|r| r.count).unwrap_or(0) == 2 {
        // Tables already exist, migration not needed
        return Ok(());
    }

    // Check if tables exist and what columns they have
    let existing_count: Vec<CountResult> = sql_query(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name IN ('puzzle_themes', 'puzzle_opening_tags')"
    ).load(&mut db).unwrap_or_default();

    // Create normalized tables if they don't exist
    if existing_count.first().map(|r| r.count).unwrap_or(0) == 0 {
        db.batch_execute(
            r#"
            CREATE TABLE IF NOT EXISTS puzzle_themes (
                puzzle_id INTEGER NOT NULL,
                theme TEXT NOT NULL,
                friendly_name TEXT,
                PRIMARY KEY (puzzle_id, theme),
                FOREIGN KEY (puzzle_id) REFERENCES puzzles(id) ON DELETE CASCADE
            );
            
            CREATE TABLE IF NOT EXISTS puzzle_opening_tags (
                puzzle_id INTEGER NOT NULL,
                opening_tag TEXT NOT NULL,
                friendly_name TEXT,
                PRIMARY KEY (puzzle_id, opening_tag),
                FOREIGN KEY (puzzle_id) REFERENCES puzzles(id) ON DELETE CASCADE
            );
            "#,
        )?;

        // Populate normalized tables from existing data
        populate_normalized_tables(db_path)?;
    } else {
        // Tables exist, check if friendly_name column exists and add it if missing
        #[derive(QueryableByName)]
        struct ColumnInfo {
            #[diesel(sql_type = diesel::sql_types::Text, column_name = "name")]
            name: String,
        }

        // Check puzzle_themes
        let theme_columns: Vec<ColumnInfo> = sql_query("PRAGMA table_info(puzzle_themes)")
            .load(&mut db)
            .unwrap_or_default();
        if !theme_columns.iter().any(|col| col.name == "friendly_name") {
            db.batch_execute("ALTER TABLE puzzle_themes ADD COLUMN friendly_name TEXT;")?;
        }

        // Check puzzle_opening_tags
        let tag_columns: Vec<ColumnInfo> = sql_query("PRAGMA table_info(puzzle_opening_tags)")
            .load(&mut db)
            .unwrap_or_default();
        if !tag_columns.iter().any(|col| col.name == "friendly_name") {
            db.batch_execute("ALTER TABLE puzzle_opening_tags ADD COLUMN friendly_name TEXT;")?;
        }

        // Update existing records with friendly names
        // Get all distinct themes and update their friendly_name
        #[derive(QueryableByName)]
        struct ThemeRow {
            #[diesel(sql_type = diesel::sql_types::Text, column_name = "theme")]
            theme: String,
        }
        let themes: Vec<ThemeRow> =
            sql_query("SELECT DISTINCT theme FROM puzzle_themes WHERE friendly_name IS NULL")
                .load(&mut db)
                .unwrap_or_default();

        for theme_row in themes {
            let theme = theme_row.theme;
            let friendly_name = get_theme_friendly_name(&theme);
            let escaped_theme = theme.replace("'", "''");
            let escaped_friendly = friendly_name.replace("'", "''");
            let _ = db.batch_execute(&format!(
                "UPDATE puzzle_themes SET friendly_name = '{}' WHERE theme = '{}' AND friendly_name IS NULL",
                escaped_friendly, escaped_theme
            ));
        }

        // Get all distinct opening_tags and update their friendly_name
        #[derive(QueryableByName)]
        struct TagRow {
            #[diesel(sql_type = diesel::sql_types::Text, column_name = "opening_tag")]
            opening_tag: String,
        }
        let tags: Vec<TagRow> = sql_query(
            "SELECT DISTINCT opening_tag FROM puzzle_opening_tags WHERE friendly_name IS NULL",
        )
        .load(&mut db)
        .unwrap_or_default();

        for tag_row in tags {
            let tag = tag_row.opening_tag;
            let friendly_name = get_opening_tag_friendly_name(&tag);
            let escaped_tag = tag.replace("'", "''");
            let escaped_friendly = friendly_name.replace("'", "''");
            let _ = db.batch_execute(&format!(
                "UPDATE puzzle_opening_tags SET friendly_name = '{}' WHERE opening_tag = '{}' AND friendly_name IS NULL",
                escaped_friendly, escaped_tag
            ));
        }
    }

    // Create indexes if they don't exist
    db.batch_execute(
        r#"
        CREATE INDEX IF NOT EXISTS idx_puzzle_themes_puzzle_id ON puzzle_themes(puzzle_id);
        CREATE INDEX IF NOT EXISTS idx_puzzle_themes_theme ON puzzle_themes(theme);
        CREATE INDEX IF NOT EXISTS idx_puzzle_themes_theme_puzzle ON puzzle_themes(theme, puzzle_id);
        CREATE INDEX IF NOT EXISTS idx_puzzle_opening_tags_puzzle_id ON puzzle_opening_tags(puzzle_id);
        CREATE INDEX IF NOT EXISTS idx_puzzle_opening_tags_tag ON puzzle_opening_tags(opening_tag);
        CREATE INDEX IF NOT EXISTS idx_puzzle_opening_tags_tag_puzzle ON puzzle_opening_tags(opening_tag, puzzle_id);
        CREATE INDEX IF NOT EXISTS idx_puzzles_rating_id ON puzzles(rating, id);
        "#
    )?;

    Ok(())
}

/// Ensures that a database file has the proper puzzle schema initialized
///
/// This function checks if the puzzles table exists and creates it if missing.
/// This is useful for validating and repairing database files that may be
/// empty or corrupted.
///
/// # Arguments
/// * `db_path` - Path to the database file
///
/// # Returns
/// * `Ok(())` if the schema exists or was successfully created
/// * `Err(Error)` if there was a problem initializing the schema
#[allow(dead_code)]
fn ensure_puzzle_schema(db_path: &PathBuf) -> Result<(), Error> {
    let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;

    // Check if puzzles table exists by trying to query it
    match puzzles::table.count().get_result::<i64>(&mut db) {
        Ok(_) => {
            // Table exists and is queryable
            Ok(())
        }
        Err(diesel::result::Error::DatabaseError(kind, info)) => {
            // Check if the error is related to missing table
            if info.message().contains("no such table") {
                // Table doesn't exist, create it
                const PUZZLES_TABLES: &str =
                    include_str!("../../database/schema/puzzles_tables.sql");
                const PUZZLES_INDEXES: &str =
                    include_str!("../../database/indexes/puzzles_indexes.sql");

                db.batch_execute(PUZZLES_TABLES)?;
                db.batch_execute(PUZZLES_INDEXES)?;
                Ok(())
            } else {
                // Other database error
                Err(Error::from(diesel::result::Error::DatabaseError(
                    kind, info,
                )))
            }
        }
        Err(e) => {
            // Other database error
            Err(Error::from(e))
        }
    }
}

/// Parses puzzles from a PGN reader
fn parse_puzzles_from_pgn<R: Read>(mut reader: R) -> Result<Vec<NewPuzzle>, Error> {
    let mut puzzles = Vec::new();
    let mut current_puzzle = NewPuzzle::default();
    let mut in_puzzle = false;

    // Read all bytes and convert to string with lossy UTF-8 conversion
    let mut buffer = Vec::new();
    reader.read_to_end(&mut buffer)?;

    // Convert bytes to string, replacing invalid UTF-8 sequences with replacement characters
    let content = String::from_utf8_lossy(&buffer);

    for line in content.lines() {
        let line = line.trim();

        if line.is_empty() {
            if in_puzzle && current_puzzle.is_complete() {
                puzzles.push(current_puzzle);
                current_puzzle = NewPuzzle::default();
                in_puzzle = false;
            }
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            // Parse PGN headers
            if let Some((key, value)) = parse_pgn_header(line) {
                match key.as_str() {
                    "FEN" => {
                        current_puzzle.fen = value;
                        in_puzzle = true;
                    }
                    "Solution" | "Moves" => {
                        current_puzzle.moves = value;
                    }
                    "Rating" | "Elo" => {
                        if let Ok(rating) = value.parse::<i32>() {
                            current_puzzle.rating = rating;
                        }
                    }
                    "Popularity" => {
                        if let Ok(popularity) = value.parse::<i32>() {
                            current_puzzle.popularity = popularity;
                        }
                    }
                    "NbPlays" => {
                        if let Ok(nb_plays) = value.parse::<i32>() {
                            current_puzzle.nb_plays = nb_plays;
                        }
                    }
                    _ => {}
                }
            }
        } else if !line.starts_with('[') && in_puzzle && current_puzzle.moves.is_empty() {
            // If we have a non-header line and no moves yet, treat it as moves
            current_puzzle.moves = line.to_string();
        }
    }

    // Add the last puzzle if complete
    if in_puzzle && current_puzzle.is_complete() {
        puzzles.push(current_puzzle);
    }

    Ok(puzzles)
}

/// Parses a PGN header line and returns the key-value pair
fn parse_pgn_header(line: &str) -> Option<(String, String)> {
    if !line.starts_with('[') || !line.ends_with(']') {
        return None;
    }

    let content = &line[1..line.len() - 1];
    let mut parts = content.splitn(2, ' ');

    let key = parts.next()?.to_string();
    let value = parts.next()?;

    // Remove quotes if present
    let value = if value.starts_with('"') && value.ends_with('"') {
        &value[1..value.len() - 1]
    } else {
        value
    };

    Some((key, value.to_string()))
}

/// Represents a new puzzle to be inserted into the database
#[derive(diesel::Insertable, Default)]
#[diesel(table_name = puzzles)]
struct NewPuzzle {
    fen: String,
    moves: String,
    rating: i32,
    rating_deviation: i32,
    popularity: i32,
    nb_plays: i32,
    themes: Option<String>,
    game_url: Option<String>,
    opening_tags: Option<String>,
}

impl NewPuzzle {
    fn is_complete(&self) -> bool {
        !self.fen.is_empty() && !self.moves.is_empty()
    }
}

/// Structure for deserializing Lichess puzzle CSV rows
#[derive(Debug, Deserialize)]
struct LichessPuzzleCsv {
    #[serde(rename = "PuzzleId")]
    #[allow(dead_code)]
    puzzle_id: String,
    #[serde(rename = "FEN")]
    fen: String,
    #[serde(rename = "Moves")]
    moves: String,
    #[serde(rename = "Rating")]
    rating: Option<i32>,
    #[serde(rename = "RatingDeviation")]
    rating_deviation: Option<i32>,
    #[serde(rename = "Popularity")]
    popularity: Option<i32>,
    #[serde(rename = "NbPlays")]
    nb_plays: Option<i32>,
    #[serde(rename = "Themes")]
    themes: Option<String>,
    #[serde(rename = "GameUrl")]
    game_url: Option<String>,
    #[serde(rename = "OpeningTags")]
    opening_tags: Option<String>,
}

/// Parses puzzles from a CSV reader
#[allow(dead_code)] // May be used in the future for CSV parsing
fn parse_puzzles_from_csv<R: Read>(reader: R) -> Result<Vec<NewPuzzle>, Error> {
    let mut csv_reader = ReaderBuilder::new().has_headers(true).from_reader(reader);

    let mut puzzles = Vec::new();

    for result in csv_reader.deserialize() {
        let record: LichessPuzzleCsv = result.map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Failed to parse CSV record: {}", e),
            ))
        })?;

        // Skip puzzles with missing required fields
        if record.fen.is_empty() || record.moves.is_empty() {
            continue;
        }

        let puzzle = NewPuzzle {
            fen: record.fen,
            moves: record.moves,
            rating: record.rating.unwrap_or(1500),
            rating_deviation: record.rating_deviation.unwrap_or(350),
            popularity: record.popularity.unwrap_or(0),
            nb_plays: record.nb_plays.unwrap_or(0),
            themes: record.themes,
            game_url: record.game_url,
            opening_tags: record.opening_tags,
        };

        puzzles.push(puzzle);
    }

    Ok(puzzles)
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::connection::SimpleConnection;
    use tempfile::NamedTempFile;

    /// Creates a temporary SQLite database file with a minimal `puzzles` table
    /// and a few seed rows for testing.
    fn create_test_puzzle_db() -> NamedTempFile {
        let file = NamedTempFile::new().unwrap();
        let mut conn = diesel::SqliteConnection::establish(file.path().to_str().unwrap()).unwrap();

        // Create `puzzles` table and insert a few rows.
        // This matches the columns used by the production code via Diesel schema.
        conn.batch_execute(
            r#"
            CREATE TABLE IF NOT EXISTS puzzles (
                id INTEGER PRIMARY KEY,
                fen TEXT NOT NULL,
                moves TEXT NOT NULL,
                rating INTEGER NOT NULL,
                rating_deviation INTEGER NOT NULL,
                popularity INTEGER NOT NULL,
                nb_plays INTEGER NOT NULL,
                themes TEXT,
                game_url TEXT,
                opening_tags TEXT
            );

            INSERT INTO puzzles (fen, moves, rating, rating_deviation, popularity, nb_plays, themes, opening_tags)
            VALUES
                ('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e2e4', 1500, 50, 100, 1000, 'advantage', 'kings-gambit'),
                ('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2', 'd2d4', 1600, 60, 200, 2000, 'mate', 'queens-gambit'),
                ('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', 'e7e5', 1400, 40, 50, 500, NULL, NULL);
            "#,
        )
        .unwrap();

        file
    }

    /// Helper that avoids the global static cache inside `get_puzzle`.
    /// This keeps tests deterministic and safe when tests run in parallel.
    fn get_one_puzzle_via_local_cache(
        file: &str,
        min_rating: u16,
        max_rating: u16,
        random: bool,
        themes: Option<Vec<String>>,
        opening_tags: Option<Vec<String>>,
    ) -> Result<Puzzle, Error> {
        let mut cache = PuzzleCache::new();
        cache.get_puzzles_with_filters(
            file,
            min_rating,
            max_rating,
            random,
            themes,
            opening_tags,
            None,
        )?;

        match cache.get_next_puzzle() {
            Some(p) => Ok(p),
            None => Err(Error::NoPuzzles),
        }
    }

    #[test]
    fn test_check_puzzle_db_columns() {
        // Happy path: our test DB has both `themes` and `opening_tags` columns.
        let file = create_test_puzzle_db();
        let file_path = file.path().to_string_lossy().to_string();

        let result = check_puzzle_db_columns(file_path.clone());
        assert!(result.is_ok());
        let (has_themes, has_opening_tags) = result.unwrap();
        assert!(has_themes);
        assert!(has_opening_tags);

        // Non-existent file should error.
        let result = check_puzzle_db_columns("/nonexistent/puzzle.db".to_string());
        assert!(result.is_err());

        // Empty file should error (function explicitly rejects 0-byte DB files).
        let empty_file = NamedTempFile::new().unwrap();
        let result = check_puzzle_db_columns(empty_file.path().to_string_lossy().to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_get_puzzle_rating_range() {
        // The inserted ratings are 1500, 1600, 1400 => min=1400, max=1600.
        let file = create_test_puzzle_db();
        let file_path = file.path().to_string_lossy().to_string();

        let result = get_puzzle_rating_range(file_path);
        assert!(result.is_ok());
        let (min, max) = result.unwrap();
        assert_eq!(min, 1400);
        assert_eq!(max, 1600);
    }

    #[test]
    fn test_get_puzzle_basic_rating_range() {
        // Fetch any puzzle within range using a local cache instance.
        let file = create_test_puzzle_db();
        let file_path = file.path().to_string_lossy().to_string();

        let puzzle =
            get_one_puzzle_via_local_cache(&file_path, 1400, 1700, false, None, None).unwrap();

        assert!(puzzle.rating >= 1400 && puzzle.rating <= 1700);
    }

    #[test]
    fn test_get_puzzle_with_themes_filter() {
        // Only one puzzle has themes='advantage' in our seeded DB.
        let file = create_test_puzzle_db();
        let file_path = file.path().to_string_lossy().to_string();

        let puzzle = get_one_puzzle_via_local_cache(
            &file_path,
            1400,
            1700,
            false,
            Some(vec!["advantage".to_string()]),
            None,
        )
        .unwrap();

        assert_eq!(puzzle.id, 1);
        assert_eq!(puzzle.rating, 1500);
    }

    #[test]
    fn test_get_puzzle_with_opening_tags_filter() {
        // Only one puzzle has opening_tags='kings-gambit' in our seeded DB.
        let file = create_test_puzzle_db();
        let file_path = file.path().to_string_lossy().to_string();

        let puzzle = get_one_puzzle_via_local_cache(
            &file_path,
            1400,
            1700,
            false,
            None,
            Some(vec!["kings-gambit".to_string()]),
        )
        .unwrap();

        assert_eq!(puzzle.id, 1);
        assert_eq!(puzzle.rating, 1500);
    }

    #[test]
    fn test_get_puzzle_random_flag_does_not_error() {
        // Random selection should still return a puzzle for a range that contains rows.
        // We avoid asserting which puzzle, since "random" is inherently nondeterministic.
        let file = create_test_puzzle_db();
        let file_path = file.path().to_string_lossy().to_string();

        let puzzle =
            get_one_puzzle_via_local_cache(&file_path, 1400, 1700, true, None, None).unwrap();

        assert!(puzzle.rating >= 1400 && puzzle.rating <= 1700);
    }

    #[test]
    fn test_get_puzzle_no_matching_puzzles() {
        // No puzzles exist in [2000..3000] in our seeded DB => should return Error::NoPuzzles.
        let file = create_test_puzzle_db();
        let file_path = file.path().to_string_lossy().to_string();

        let result = get_one_puzzle_via_local_cache(&file_path, 2000, 3000, false, None, None);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), Error::NoPuzzles));
    }

    #[test]
    fn test_get_puzzle_themes() {
        // get_puzzle_themes should return grouped theme options.
        // Our DB contains "advantage" and "mate" (and one NULL).
        let file = create_test_puzzle_db();
        let file_path = file.path().to_string_lossy().to_string();

        let result = get_puzzle_themes(file_path.clone());
        assert!(result.is_ok());

        let groups = result.unwrap();
        assert!(!groups.is_empty());

        // Ensure at least one of the expected theme values is present somewhere.
        let has_expected = groups.iter().any(|g| {
            g.items
                .iter()
                .any(|item| item.value == "advantage" || item.value == "mate")
        });
        assert!(has_expected);

        // Non-existent file should error.
        let result = get_puzzle_themes("/nonexistent/puzzle.db".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_get_puzzle_opening_tags() {
        // get_puzzle_opening_tags should return distinct opening tags (first token).
        // Our DB has "kings-gambit" and "queens-gambit" (and one NULL).
        let file = create_test_puzzle_db();
        let file_path = file.path().to_string_lossy().to_string();

        let result = get_puzzle_opening_tags(file_path.clone());
        assert!(result.is_ok());

        let tags = result.unwrap();
        assert!(!tags.is_empty());

        let has_expected = tags
            .iter()
            .any(|t| t.value == "kings-gambit" || t.value == "queens-gambit");
        assert!(has_expected);

        // Non-existent file should error.
        let result = get_puzzle_opening_tags("/nonexistent/puzzle.db".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_get_puzzle_filters_metadata() {
        let file = create_test_puzzle_db();
        let file_path = file.path().to_string_lossy().to_string();

        let metadata = get_puzzle_filters_metadata(file_path).unwrap();

        assert_eq!(metadata.rating_range, Some((1400, 1600)));
        assert!(metadata.has_themes);
        assert!(metadata.has_opening_tags);
        assert!(!metadata.themes.is_empty());
        assert!(!metadata.opening_tags.is_empty());
    }

    #[test]
    fn test_validate_puzzle_database() {
        // `validate_puzzle_database` is async; run it via Tauri's async runtime helper
        // to avoid requiring tokio test macros.
        let file = create_test_puzzle_db();
        let file_path = file.path().to_path_buf();

        let ok = tauri::async_runtime::block_on(validate_puzzle_database(file_path)).unwrap();
        assert!(ok);

        // Non-existent file should error.
        let missing = std::path::PathBuf::from("/nonexistent/puzzle.db");
        let err = tauri::async_runtime::block_on(validate_puzzle_database(missing));
        assert!(err.is_err());
    }

    #[test]
    fn test_get_theme_friendly_name_exact_match() {
        // Exact matches should use the predefined dictionary.
        assert_eq!(get_theme_friendly_name("matein2"), "Mate in 2");
        assert_eq!(get_theme_friendly_name("anastasiamate"), "Anastasia's Mate");
        assert_eq!(get_theme_friendly_name("x-rayattack"), "X-Ray Attack");
    }

    #[test]
    fn test_get_theme_friendly_name_camelcase_hyphen_numbers() {
        // Should split camelCase and normalize special patterns.
        assert_eq!(
            get_theme_friendly_name("queenrookendgame"),
            "Queen & Rook Endgame"
        );
        assert_eq!(get_theme_friendly_name("kingsideattack"), "Kingside Attack");
        assert_eq!(get_theme_friendly_name("matein5"), "Mate in 5");

        // Hyphens and underscores should be treated as spaces.
        assert_eq!(get_theme_friendly_name("backrankmate"), "Back Rank Mate");
        assert_eq!(get_theme_friendly_name("one-move"), "One Move");
        assert_eq!(get_theme_friendly_name("verylong"), "Very Long");
    }

    #[test]
    fn test_get_opening_tag_friendly_name_exact_match_and_fallback() {
        // Exact match dictionary.
        let got1 = get_opening_tag_friendly_name("ruylopez");
        assert_eq!(got1, "Ruy López");

        let got2 = get_opening_tag_friendly_name("queensgambit");
        assert_eq!(got2, "Queen's Gambit");

        let got3 = get_opening_tag_friendly_name("semiSlav");
        assert_eq!(got3, "Semi-Slav");
    }

    #[test]
    fn test_parse_pgn_header_valid_and_invalid() {
        // Valid PGN header should be parsed as (key, value).
        let (k, v) =
            parse_pgn_header(r#"[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]"#)
                .unwrap();
        assert_eq!(k, "FEN");
        assert!(v.contains("rnbqkbnr/pppppppp"));

        // Invalid formats should return None.
        assert!(parse_pgn_header("FEN \"...\"").is_none());
        assert!(parse_pgn_header("[BrokenHeader]").is_none());
        assert!(parse_pgn_header("[Key]").is_none());
    }

    #[test]
    fn test_parse_puzzles_from_pgn_multiple_puzzles_and_last_one_kept() {
        // Ensure we can parse multiple puzzles and the last one is not lost
        // even if the file doesn't end with an empty line.
        let pgn = r#"
[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]
[Solution "e2e4"]
[Rating "1500"]

[FEN "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2"]
Moves "d2d4"
"#;

        let puzzles = parse_puzzles_from_pgn(pgn.as_bytes()).unwrap();
        assert_eq!(puzzles.len(), 2);

        assert_eq!(
            puzzles[0].fen,
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        );
        assert_eq!(puzzles[0].moves, "e2e4");
        assert_eq!(puzzles[0].rating, 1500);

        assert_eq!(
            puzzles[1].fen,
            "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2"
        );
        // Note: "Moves" header value is parsed as the raw string after the key; your parser
        // strips quotes only if the entire value is quoted. This will still be non-empty.
        assert!(!puzzles[1].moves.is_empty());
    }

    #[test]
    fn test_parse_puzzles_from_pgn_ignores_incomplete_entries() {
        // Missing moves -> puzzle should not be included.
        let pgn = r#"
[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]
[Rating "1500"]
"#;

        let puzzles = parse_puzzles_from_pgn(pgn.as_bytes()).unwrap();
        assert!(puzzles.is_empty());
    }

    #[test]
    fn test_puzzle_cache_counter_and_reload_when_exhausted() {
        // Verify PuzzleCache advances through the candidate deck without repeats until wrap.
        let file = create_test_puzzle_db();
        let file_path = file.path().to_string_lossy().to_string();

        let mut cache = PuzzleCache::new().with_cache_size(2);

        // First load
        cache
            .get_puzzles_with_filters(&file_path, 1400, 1700, false, None, None, None)
            .unwrap();

        let p1 = cache.get_next_puzzle().unwrap();
        let p2 = cache.get_next_puzzle().unwrap();
        assert!(cache.get_next_puzzle().is_none());
        assert_ne!(p1.id, p2.id);

        // On next refill with same filters, deck cursor should continue (third unique),
        // then wrap to the first entry.
        cache
            .get_puzzles_with_filters(&file_path, 1400, 1700, false, None, None, None)
            .unwrap();

        let p3 = cache.get_next_puzzle().unwrap();
        let p1_again = cache.get_next_puzzle().unwrap();

        assert_ne!(p3.id, p1.id);
        assert_ne!(p3.id, p2.id);
        assert_eq!(p1.id, p1_again.id);
    }

    #[test]
    fn test_puzzle_cache_reload_when_filters_change() {
        // Changing themes/opening_tags should force a cache reload.
        let file = create_test_puzzle_db();
        let file_path = file.path().to_string_lossy().to_string();

        let mut cache = PuzzleCache::new().with_cache_size(20);

        cache
            .get_puzzles_with_filters(&file_path, 1400, 1700, false, None, None, None)
            .unwrap();

        // Now reload with a theme filter that should narrow results.
        cache
            .get_puzzles_with_filters(
                &file_path,
                1400,
                1700,
                false,
                Some(vec!["advantage".to_string()]),
                None,
                None,
            )
            .unwrap();

        let p = cache.get_next_puzzle().unwrap();
        assert_eq!(p.id, 1);
        assert_eq!(p.rating, 1500);
    }
}
