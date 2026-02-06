//! Computed per-game analysis statistics for profile databases.
//!
//! These stats are derived from engine analysis output and persisted into the profile DB.
//! The table is intentionally forward-compatible: additional computed stats should go into `extra` JSON.

use crate::chess::types::{MoveAnalysis, ScoreValue};
use crate::db::pgn::get_material_count;
use crate::db::{GameOutcome, PlatformFilter, PlayerStatsFilters, TimeControlFilter};
use crate::error::{Error, Result};
use crate::analysis_storage::{
    analysis_db_get_analyzed_game_ids, analysis_db_get_analyzed_games_bulk, AnalyzedGameEntry,
};
use chrono::{SecondsFormat, Utc};
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{BigInt, Integer, Nullable, Text};
use serde_json::{json, Value};
use shakmaty::{fen::Fen, uci::UciMove, CastlingMode, Chess, Position};
use tauri::AppHandle;

const PROFILE_ANALYSIS_TABLES_SQL: &str =
    include_str!("../../../database/schema/profile_analysis_tables.sql");

const VERSION_V1: i32 = 1;
const WIN_THRESHOLD_CP: i32 = 300;
const SAFE_THRESHOLD_CP: i32 = 150;
const MATE_AS_CP: i32 = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WinnerSide {
    White,
    Black,
    Draw,
    Unknown,
}

impl WinnerSide {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::White => "white",
            Self::Black => "black",
            Self::Draw => "draw",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GamePhase {
    Opening,
    Middlegame,
    Endgame,
}

impl GamePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Opening => "opening",
            Self::Middlegame => "middlegame",
            Self::Endgame => "endgame",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ComputedGameAnalysisStats {
    pub winner: WinnerSide,
    pub win_phase: GamePhase,
    pub win_ply: Option<i32>,
    pub computed_at: String,
    pub version: i32,
    pub extra: Value,
}

pub fn ensure_profile_analysis_tables(db: &mut SqliteConnection) -> Result<()> {
    db.batch_execute(PROFILE_ANALYSIS_TABLES_SQL)?;

    // Migrate any legacy/partial rows that still have WinPhase = "unknown" into a real phase,
    // using WinPly when present, otherwise Games.PlyCount when available.
    //
    // This keeps the UI free of an "unknown" bucket while remaining deterministic.
    let _ = sql_query(
        r#"
        UPDATE GameAnalysisStats
        SET WinPhase = (
          SELECT CASE
            WHEN COALESCE(GameAnalysisStats.WinPly, Games.PlyCount, 0) <= 20 THEN 'opening'
            WHEN COALESCE(GameAnalysisStats.WinPly, Games.PlyCount, 0) <= 80 THEN 'middlegame'
            ELSE 'endgame'
          END
          FROM Games
          WHERE Games.ID = GameAnalysisStats.GameID
        )
        WHERE lower(COALESCE(WinPhase, '')) = 'unknown' OR trim(COALESCE(WinPhase, '')) = ''
        "#,
    )
    .execute(db);

    Ok(())
}

pub fn winner_from_result(result: Option<&str>) -> WinnerSide {
    let Some(r) = result.map(|s| s.trim()) else {
        return WinnerSide::Unknown;
    };

    match r {
        "1-0" => WinnerSide::White,
        "0-1" => WinnerSide::Black,
        "1/2-1/2" => WinnerSide::Draw,
        "*" | "" => WinnerSide::Unknown,
        _ => WinnerSide::Unknown,
    }
}

fn score_to_white_cp(score: &ScoreValue) -> i32 {
    match score {
        ScoreValue::Cp(cp) => *cp,
        ScoreValue::Mate(m) => {
            if *m == 0 {
                0
            } else {
                m.signum() * MATE_AS_CP
            }
        }
    }
}

fn is_winning_for(winner: WinnerSide, cp: i32) -> bool {
    match winner {
        WinnerSide::White => cp >= WIN_THRESHOLD_CP,
        WinnerSide::Black => cp <= -WIN_THRESHOLD_CP,
        _ => false,
    }
}

fn is_safe_for(winner: WinnerSide, cp: i32) -> bool {
    match winner {
        WinnerSide::White => cp >= SAFE_THRESHOLD_CP,
        WinnerSide::Black => cp <= -SAFE_THRESHOLD_CP,
        _ => false,
    }
}

fn is_winning_for_opponent(winner: WinnerSide, cp: i32) -> bool {
    match winner {
        WinnerSide::White => cp <= -WIN_THRESHOLD_CP,
        WinnerSide::Black => cp >= WIN_THRESHOLD_CP,
        _ => false,
    }
}

fn is_profile_game_decided_ply(winner: WinnerSide, scores: &[Option<i32>], from: usize) -> bool {
    let mut total = 0usize;
    let mut good = 0usize;
    for s in scores.iter().skip(from) {
        total += 1;
        let Some(cp) = *s else {
            continue;
        };
        if is_winning_for_opponent(winner, cp) {
            return false;
        }
        if is_safe_for(winner, cp) {
            good += 1;
        }
    }

    if total == 0 {
        return false;
    }
    // Require a strong majority of remaining positions to remain safely winning.
    good * 5 >= total * 4 // >= 80%
}

fn detect_win_ply(winner: WinnerSide, analysis: &[MoveAnalysis]) -> Option<i32> {
    if !matches!(winner, WinnerSide::White | WinnerSide::Black) {
        return None;
    }

    let scores: Vec<Option<i32>> = analysis
        .iter()
        .map(|a| {
            a.best
                .first()
                .map(|b| score_to_white_cp(&b.score.value))
        })
        .collect();

    for (i, s) in scores.iter().enumerate() {
        let Some(cp) = *s else { continue };
        if !is_winning_for(winner, cp) {
            continue;
        }
        if is_profile_game_decided_ply(winner, &scores, i) {
            return Some(i as i32);
        }
    }
    None
}

fn detect_win_ply_relaxed(winner: WinnerSide, analysis: &[MoveAnalysis]) -> Option<i32> {
    if !matches!(winner, WinnerSide::White | WinnerSide::Black) {
        return None;
    }

    let scores: Vec<Option<i32>> = analysis
        .iter()
        .map(|a| {
            a.best
                .first()
                .map(|b| score_to_white_cp(&b.score.value))
        })
        .collect();

    const RELAXED_WIN_CP: i32 = 200;
    const RELAXED_SAFE_CP: i32 = 100;

    let is_winning = |cp: i32| match winner {
        WinnerSide::White => cp >= RELAXED_WIN_CP,
        WinnerSide::Black => cp <= -RELAXED_WIN_CP,
        _ => false,
    };
    let is_safe = |cp: i32| match winner {
        WinnerSide::White => cp >= RELAXED_SAFE_CP,
        WinnerSide::Black => cp <= -RELAXED_SAFE_CP,
        _ => false,
    };
    let is_opponent_winning = |cp: i32| match winner {
        WinnerSide::White => cp <= -RELAXED_WIN_CP,
        WinnerSide::Black => cp >= RELAXED_WIN_CP,
        _ => false,
    };

    let decided_from = |from: usize| -> bool {
        let mut total = 0usize;
        let mut good = 0usize;
        for s in scores.iter().skip(from) {
            total += 1;
            let Some(cp) = *s else { continue };
            if is_opponent_winning(cp) {
                return false;
            }
            if is_safe(cp) {
                good += 1;
            }
        }
        total > 0 && good * 5 >= total * 4
    };

    for (i, s) in scores.iter().enumerate() {
        let Some(cp) = *s else { continue };
        if !is_winning(cp) {
            continue;
        }
        if decided_from(i) {
            return Some(i as i32);
        }
    }
    None
}

fn total_material_value(pos: &Chess) -> u32 {
    let m = get_material_count(pos.board());
    (m.white as u32) + (m.black as u32)
}

fn compute_phase_at_ply(initial_fen: &str, moves: &[String], ply: usize) -> Result<GamePhase> {
    let fen = Fen::from_ascii(initial_fen.as_bytes())?;
    let mut chess: Chess = fen.into_position(CastlingMode::Chess960)?;

    for m in moves.iter().take(ply) {
        let uci = UciMove::from_ascii(m.as_bytes())
            .map_err(|_| Error::PackageManager(format!("Invalid UCI move in analysis moves: {m}")))?;
        let mv = uci.to_move(&chess)
            .map_err(|_| Error::PackageManager(format!("Illegal move for position in analysis moves: {m}")))?;
        chess.play_unchecked(&mv);
        if chess.is_game_over() {
            break;
        }
    }

    let total_material = total_material_value(&chess);

    // Heuristic split:
    // - Opening is early AND material-rich.
    // - Endgame is material-light.
    // - Otherwise middlegame.
    //
    // `get_material_count` is a weighted material sum per side (P=1, N/B=3, R=5, Q=9).
    // Starting total (both sides) is ~78 in standard chess.
    let is_endgame = total_material <= 30;
    if is_endgame {
        return Ok(GamePhase::Endgame);
    }
    if ply <= 20 && total_material >= 70 {
        return Ok(GamePhase::Opening);
    }
    Ok(GamePhase::Middlegame)
}

fn phase_from_ply_fallback(ply: i32) -> GamePhase {
    if ply <= 20 {
        GamePhase::Opening
    } else if ply <= 80 {
        GamePhase::Middlegame
    } else {
        GamePhase::Endgame
    }
}

pub fn compute_game_analysis_stats(
    winner: WinnerSide,
    initial_fen: &str,
    moves: &[String],
    analysis: &[MoveAnalysis],
) -> Result<ComputedGameAnalysisStats> {
    let last_ply = moves.len() as i32;

    // Phase classification is total (no "unknown"):
    // - Decisive games: detect the earliest "decided" ply (strict, then relaxed). If still missing, fall back to end ply.
    // - Draws/unknown results: classify by end ply.
    let (phase_ply, method) = match winner {
        WinnerSide::White | WinnerSide::Black => {
            if let Some(p) = detect_win_ply(winner, analysis) {
                (p, "eval_stable_v1")
            } else if let Some(p) = detect_win_ply_relaxed(winner, analysis) {
                (p, "eval_stable_relaxed_v1")
            } else {
                (last_ply, "end_ply_fallback_v1")
            }
        }
        WinnerSide::Draw | WinnerSide::Unknown => (last_ply, "end_ply_draw_v1"),
    };

    let win_phase = compute_phase_at_ply(initial_fen, moves, phase_ply.max(0) as usize)
        .unwrap_or_else(|_| phase_from_ply_fallback(phase_ply));

    Ok(ComputedGameAnalysisStats {
        winner,
        win_phase,
        win_ply: Some(phase_ply),
        computed_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        version: VERSION_V1,
        extra: json!({
            "method": method,
            "thresholdCp": WIN_THRESHOLD_CP,
            "safeCp": SAFE_THRESHOLD_CP,
        }),
    })
}

pub fn upsert_game_analysis_stats(
    db: &mut SqliteConnection,
    game_id: i32,
    stats: &ComputedGameAnalysisStats,
) -> Result<()> {
    ensure_profile_analysis_tables(db)?;

    let extra = serde_json::to_string(&stats.extra).unwrap_or_else(|_| "{}".to_string());

    sql_query(
        "INSERT INTO GameAnalysisStats (GameID, Winner, WinPhase, WinPly, ComputedAt, Version, Extra)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(GameID) DO UPDATE SET
           Winner=excluded.Winner,
           WinPhase=excluded.WinPhase,
           WinPly=excluded.WinPly,
           ComputedAt=excluded.ComputedAt,
           Version=excluded.Version,
           Extra=excluded.Extra",
    )
    .bind::<Integer, _>(game_id)
    .bind::<Text, _>(stats.winner.as_str())
    .bind::<Text, _>(stats.win_phase.as_str())
    .bind::<Nullable<Integer>, _>(stats.win_ply)
    .bind::<Text, _>(&stats.computed_at)
    .bind::<Integer, _>(stats.version)
    .bind::<Text, _>(&extra)
    .execute(db)?;

    Ok(())
}

fn detect_win_ply_from_scores(winner: WinnerSide, scores: &[i32]) -> Option<i32> {
    if !matches!(winner, WinnerSide::White | WinnerSide::Black) {
        return None;
    }

    let opt_scores: Vec<Option<i32>> = scores.iter().map(|v| Some(*v)).collect();
    for (i, cp) in scores.iter().enumerate() {
        if !is_winning_for(winner, *cp) {
            continue;
        }
        if is_profile_game_decided_ply(winner, &opt_scores, i) {
            return Some(i as i32);
        }
    }
    None
}

fn phase_from_ply(win_ply: i32) -> GamePhase {
    phase_from_ply_fallback(win_ply)
}

fn extract_eval_scores_from_analyzed_pgn(pgn: &str) -> Vec<i32> {
    // Common formats:
    // - { [%eval 0.34] }
    // - { [%eval -1.23/18] }
    // - { [%eval #3] } / { [%eval #-5] }
    //
    // We read them in textual order and treat them as consecutive position evals (white POV).
    let re = regex::Regex::new(r#"\[%eval\s+([^\]]+)\]"#).ok();
    let Some(re) = re else { return vec![]; };

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
                out.push(m.signum() * MATE_AS_CP);
            }
            continue;
        }

        if let Ok(v) = token.parse::<f32>() {
            out.push((v * 100.0).round() as i32);
        }
    }
    out
}

#[derive(QueryableByName, Debug)]
struct MissingRow {
    #[diesel(sql_type = Integer, column_name = "ID")]
    id: i32,
    #[diesel(sql_type = Nullable<Text>, column_name = "Result")]
    result: Option<String>,
}

pub fn backfill_profile_phase_stats_from_analysis_db(
    app: AppHandle,
    db: &mut SqliteConnection,
    profile_id: &str,
    max_games: usize,
) -> Result<u32> {
    ensure_profile_analysis_tables(db)?;

    // Select candidates from analysis.db3 first (by recent `updated_at`), then backfill only those
    // that correspond to profile DB Games.ID and are missing GameAnalysisStats.
    //
    // This avoids missing older Games.IDs when the profile DB is large but only a subset was analyzed.
    let analyzed_game_ids = analysis_db_get_analyzed_game_ids(app.clone(), Some(profile_id.to_string()), max_games)?;
    let analyzed_game_ids: Vec<i32> = analyzed_game_ids
        .into_iter()
        .filter_map(|s| s.parse::<i32>().ok())
        .filter(|v| *v > 0)
        .collect();

    if analyzed_game_ids.is_empty() {
        return Ok(0);
    }

    let mut missing: Vec<MissingRow> = Vec::new();
    const CHUNK: usize = 400; // keep well under SQLite default variable limit (999)
    for chunk in analyzed_game_ids.chunks(CHUNK) {
        // We interpolate ids directly because they are parsed integers coming from the local analysis DB.
        // This avoids Diesel type churn when binding a dynamic number of parameters.
        let ids = chunk
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let q = sql_query(format!(
            "SELECT g.ID, g.Result
             FROM Games g
             LEFT JOIN GameAnalysisStats s ON s.GameID = g.ID
             WHERE s.GameID IS NULL
               AND g.ID IN ({ids})"
        ));
        let mut rows: Vec<MissingRow> = q.load(db)?;
        missing.append(&mut rows);
    }

    if missing.is_empty() {
        return Ok(0);
    }

    let missing_ids: Vec<String> = missing.iter().map(|r| r.id.to_string()).collect();
    let mut analyzed_rows: Vec<AnalyzedGameEntry> =
        analysis_db_get_analyzed_games_bulk(app.clone(), missing_ids.clone(), Some(profile_id.to_string()))?;
    if analyzed_rows.is_empty() && !profile_id.trim().is_empty() {
        // Backwards compatibility: allow looking up legacy entries stored under the empty profile id.
        analyzed_rows = analysis_db_get_analyzed_games_bulk(app, missing_ids.clone(), None)?;
    }

    if analyzed_rows.is_empty() {
        return Ok(0);
    }

    let mut result_by_id = std::collections::HashMap::<String, Option<String>>::new();
    for r in missing {
        result_by_id.insert(r.id.to_string(), r.result);
    }

    let mut inserted = 0u32;
    for row in analyzed_rows {
        let Ok(game_id) = row.game_id.parse::<i32>() else {
            continue;
        };
        let result = result_by_id.get(&row.game_id).and_then(|v| v.as_deref());
        let winner = winner_from_result(result);

        // We can only infer win ply from eval annotations in analyzed PGN.
        // Phase classification for backfill uses a ply-based heuristic (no move list required).
        let scores = extract_eval_scores_from_analyzed_pgn(&row.analyzed_pgn);
        let last_ply = scores.len() as i32;
        let win_ply = detect_win_ply_from_scores(winner, &scores).unwrap_or(last_ply.max(0));
        let win_phase = phase_from_ply(win_ply);

        let stats = ComputedGameAnalysisStats {
            winner,
            win_phase,
            win_ply: Some(win_ply),
            computed_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            version: VERSION_V1,
            extra: json!({
                "method": "pgn_eval_backfill_v2",
                "thresholdCp": WIN_THRESHOLD_CP,
                "safeCp": SAFE_THRESHOLD_CP,
                "maxGames": max_games,
            }),
        };

        upsert_game_analysis_stats(db, game_id, &stats)?;
        inserted += 1;
    }

    Ok(inserted)
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PhaseOutcomeBucket {
    pub phase: String, // "opening" | "middlegame" | "endgame"
    pub won: u32,
    pub drawn: u32,
    pub lost: u32,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PhaseGameRow {
    pub game_id: i32,
    pub date: Option<String>,
    pub site: String,
    pub white: String,
    pub black: String,
    pub result: Option<String>,
    pub win_phase: String, // "opening" | "middlegame" | "endgame"
}

fn normalize_platform(site: &str) -> PlatformFilter {
    let lower = site.to_lowercase();
    if lower.contains("lichess") {
        PlatformFilter::Lichess
    } else if lower.contains("chess.com") || lower.contains("chesscom") {
        PlatformFilter::ChessCom
    } else {
        PlatformFilter::All // treat unknown as "not filterable"
    }
}

// Copied (with minimal adjustments) from `player_stats.rs` to keep filter behavior consistent.
fn parse_date_to_timestamp(date: &str) -> Option<i64> {
    let s = date.trim();
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

    use chrono::{NaiveDate, TimeZone};
    let nd = NaiveDate::from_ymd_opt(year, month, day)?;
    Some(chrono::Utc.from_utc_datetime(&nd.and_hms_opt(0, 0, 0)?).timestamp_millis())
}

// Copied (with minimal adjustments) from `player_stats.rs` to keep filter behavior consistent.
fn get_time_control(_site: &str, time_control: &str) -> TimeControlFilter {
    let tc = time_control.trim();
    if tc.is_empty() {
        return TimeControlFilter::Any;
    }

    // Chess.com formats: "600" or "600+5" or textual
    let lower = tc.to_lowercase();
    if lower.contains("correspondence") {
        return TimeControlFilter::Classical;
    }
    if lower.contains("daily") {
        return TimeControlFilter::Classical;
    }

    // Parse seconds from "base+inc" if possible.
    let base_seconds: Option<f64> = if let Some((base, _inc)) = tc.split_once('+') {
        base.trim().parse::<f64>().ok()
    } else {
        tc.parse::<f64>().ok()
    };

    // If parsing fails, fall back to site heuristics.
    let Some(base) = base_seconds else {
        return TimeControlFilter::Any;
    };

    // Lichess uses seconds. Chess.com is typically seconds too in PGN imports for online.
    // We'll treat the value as seconds across both.
    let total = base;

    // Groups are aligned with existing UI mapping (Any/Bullet/Blitz/Rapid/Classical).
    if total < 180.0 {
        return TimeControlFilter::Bullet;
    }
    if total < 480.0 {
        return TimeControlFilter::Blitz;
    }
    if total < 1500.0 {
        return TimeControlFilter::Rapid;
    }
    TimeControlFilter::Classical
}

fn phase_key(s: &str) -> &'static str {
    match s.trim().to_lowercase().as_str() {
        "opening" => "opening",
        "middlegame" => "middlegame",
        "endgame" => "endgame",
        _ => "endgame",
    }
}

fn ensure_phase_stats_present(
    app: AppHandle,
    db: &mut SqliteConnection,
    profile_id: &str,
) -> Result<()> {
    ensure_profile_analysis_tables(db)?;

    #[derive(QueryableByName)]
    struct CountRow {
        #[diesel(sql_type = BigInt, column_name = "c")]
        c: i64,
    }

    let stats_count: i64 = sql_query("SELECT COUNT(*) as c FROM GameAnalysisStats")
        .load::<CountRow>(db)
        .ok()
        .and_then(|v| v.into_iter().next().map(|r| r.c))
        .unwrap_or(0);

    let _ = if stats_count == 0 {
        backfill_profile_phase_stats_from_analysis_db(app, db, profile_id, 2000)
    } else {
        backfill_profile_phase_stats_from_analysis_db(app, db, profile_id, 200)
    };

    Ok(())
}

fn load_or_infer_profile_player_id(db: &mut SqliteConnection) -> Result<Option<i32>> {
    #[derive(QueryableByName)]
    struct InfoRow {
        #[diesel(sql_type = Nullable<Text>, column_name = "Value")]
        value: Option<String>,
    }

    let existing: Option<i32> = sql_query("SELECT Value FROM Info WHERE Name = 'ProfilePlayerId' LIMIT 1")
        .load::<InfoRow>(db)?
        .into_iter()
        .next()
        .and_then(|r| r.value)
        .and_then(|v| v.trim().parse::<i32>().ok())
        .filter(|v| *v > 0);

    if existing.is_some() {
        return Ok(existing);
    }

    #[derive(QueryableByName)]
    struct IdRow {
        #[diesel(sql_type = Integer, column_name = "player_id")]
        player_id: i32,
    }

    let inferred: Option<i32> = sql_query(
        r#"
        SELECT player_id
        FROM (
            SELECT WhiteId AS player_id, COUNT(*) AS c FROM Games GROUP BY WhiteId
            UNION ALL
            SELECT BlackId AS player_id, COUNT(*) AS c FROM Games GROUP BY BlackId
        )
        GROUP BY player_id
        ORDER BY SUM(c) DESC
        LIMIT 1
        "#,
    )
    .load::<IdRow>(db)?
    .into_iter()
    .next()
    .map(|r| r.player_id)
    .filter(|v| *v > 0);

    let Some(pid) = inferred else {
        return Ok(None);
    };

    let _ = sql_query(
        "INSERT INTO Info (Name, Value) VALUES ('ProfilePlayerId', ?1)
         ON CONFLICT(Name) DO UPDATE SET Value=excluded.Value",
    )
    .bind::<Text, _>(pid.to_string())
    .execute(db);

    Ok(Some(pid))
}

pub fn compute_profile_phase_outcomes(
    app: AppHandle,
    db: &mut SqliteConnection,
    profile_id: &str,
    filters: &PlayerStatsFilters,
) -> Result<Vec<PhaseOutcomeBucket>> {
    ensure_phase_stats_present(app, db, profile_id)?;

    let Some(profile_player_id) = load_or_infer_profile_player_id(db)? else {
        return Ok(vec![]);
    };

    #[derive(QueryableByName)]
    struct Row {
        #[diesel(sql_type = Integer, column_name = "game_id")]
        game_id: i32,
        #[diesel(sql_type = Nullable<Text>, column_name = "Date")]
        date: Option<String>,
        #[diesel(sql_type = Nullable<Text>, column_name = "Result")]
        result: Option<String>,
        #[diesel(sql_type = Nullable<Text>, column_name = "TimeControl")]
        time_control: Option<String>,
        #[diesel(sql_type = Integer, column_name = "WhiteID")]
        white_id: i32,
        #[diesel(sql_type = Integer, column_name = "BlackID")]
        black_id: i32,
        #[diesel(sql_type = Nullable<Integer>, column_name = "WhiteElo")]
        white_elo: Option<i32>,
        #[diesel(sql_type = Nullable<Integer>, column_name = "BlackElo")]
        black_elo: Option<i32>,
        #[diesel(sql_type = Nullable<Text>, column_name = "site")]
        site: Option<String>,
        #[diesel(sql_type = Text, column_name = "win_phase")]
        win_phase: String,
    }

    let rows: Vec<Row> = sql_query(
        r#"
        SELECT
          g.ID AS game_id,
          g.Date,
          g.Result,
          g.TimeControl,
          g.WhiteID,
          g.BlackID,
          g.WhiteElo,
          g.BlackElo,
          s.Name AS site,
          gas.WinPhase AS win_phase
        FROM Games g
        INNER JOIN Sites s ON s.ID = g.SiteID
        INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
        WHERE g.WhiteID = ?1 OR g.BlackID = ?1
        "#,
    )
    .bind::<Integer, _>(profile_player_id)
    .load(db)?;

    // Apply platform, time control, opponent bucket filters first.
    let mut filtered: Vec<(Row, String, Option<i64>)> = Vec::new();
    filtered.reserve(rows.len());
    for r in rows {
        let site = r.site.clone().unwrap_or_default();
        if !site.trim().is_empty() {
            match filters.platform {
                PlatformFilter::All => {}
                PlatformFilter::Lichess => {
                    if normalize_platform(&site) != PlatformFilter::Lichess {
                        continue;
                    }
                }
                PlatformFilter::ChessCom => {
                    if normalize_platform(&site) != PlatformFilter::ChessCom {
                        continue;
                    }
                }
            }
        }

        if !matches!(filters.time_control, TimeControlFilter::Any) {
            let tc = r.time_control.clone().unwrap_or_default();
            if get_time_control(&site, &tc) != filters.time_control {
                continue;
            }
        }

        if let Some(bucket) = &filters.opponent_elo_bucket {
            if let Ok(start) = bucket.parse::<i32>() {
                let end = start + 199;
                let is_player_white = r.white_id == profile_player_id;
                let opp = if is_player_white { r.black_elo } else { r.white_elo };
                let Some(opp_elo) = opp else {
                    continue;
                };
                if opp_elo < start || opp_elo > end {
                    continue;
                }
            }
        }

        let ts = r
            .date
            .as_deref()
            .and_then(parse_date_to_timestamp);
        filtered.push((r, site, ts));
    }

    // Date range filter mirrors `filter_games`: anchor to last date among filtered games.
    if let Some(date_range) = &filters.date_range {
        if !filtered.is_empty() {
            let mut max_date: Option<i64> = None;
            for (_r, _site, ts) in &filtered {
                if let Some(t) = *ts {
                    max_date = Some(max_date.map_or(t, |m| m.max(t)));
                }
            }

            if let Some(last_date) = max_date {
                const MS_DAY: i64 = 86_400_000;
                let earliest = match date_range {
                    crate::db::DateRange::All => i64::MIN,
                    crate::db::DateRange::SevenDays => last_date - 7 * MS_DAY,
                    crate::db::DateRange::ThirtyDays => last_date - 30 * MS_DAY,
                    crate::db::DateRange::NinetyDays => last_date - 90 * MS_DAY,
                    crate::db::DateRange::OneYear => last_date - 365 * MS_DAY,
                };

                filtered.retain(|(_r, _site, ts)| ts.map(|t| t >= earliest).unwrap_or(false));
            }
        }
    }

    let mut buckets = [
        ("opening", PhaseOutcomeBucket { phase: "opening".to_string(), won: 0, drawn: 0, lost: 0 }),
        ("middlegame", PhaseOutcomeBucket { phase: "middlegame".to_string(), won: 0, drawn: 0, lost: 0 }),
        ("endgame", PhaseOutcomeBucket { phase: "endgame".to_string(), won: 0, drawn: 0, lost: 0 }),
    ];

    for (r, _site, _ts) in filtered {
        let Some(result) = r.result.as_deref() else { continue };
        let is_player_white = r.white_id == profile_player_id;
        let Some(outcome) = GameOutcome::from_str(result, is_player_white) else { continue };
        let key = phase_key(&r.win_phase);
        let bucket = if key == "opening" {
            &mut buckets[0].1
        } else if key == "middlegame" {
            &mut buckets[1].1
        } else {
            &mut buckets[2].1 // default -> endgame
        };
        match outcome {
            GameOutcome::Won => bucket.won += 1,
            GameOutcome::Drawn => bucket.drawn += 1,
            GameOutcome::Lost => bucket.lost += 1,
        }
    }

    Ok(buckets.into_iter().map(|(_, b)| b).collect())
}

pub fn get_profile_phase_games(
    app: AppHandle,
    db: &mut SqliteConnection,
    profile_id: &str,
    filters: &PlayerStatsFilters,
    phase: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<PhaseGameRow>> {
    ensure_phase_stats_present(app, db, profile_id)?;

    let Some(profile_player_id) = load_or_infer_profile_player_id(db)? else {
        return Ok(vec![]);
    };

    let phase_norm = match phase_key(phase) {
        "opening" => "opening",
        "middlegame" => "middlegame",
        "endgame" => "endgame",
        _ => return Ok(vec![]),
    }
    .to_string();
    let limit = limit.clamp(1, 500) as i32;
    let offset = offset as i32;

    #[derive(QueryableByName)]
    struct Row {
        #[diesel(sql_type = Integer, column_name = "game_id")]
        game_id: i32,
        #[diesel(sql_type = Nullable<Text>, column_name = "Date")]
        date: Option<String>,
        #[diesel(sql_type = Nullable<Text>, column_name = "Result")]
        result: Option<String>,
        #[diesel(sql_type = Nullable<Text>, column_name = "TimeControl")]
        time_control: Option<String>,
        #[diesel(sql_type = Integer, column_name = "WhiteID")]
        white_id: i32,
        #[diesel(sql_type = Integer, column_name = "BlackID")]
        black_id: i32,
        #[diesel(sql_type = Nullable<Integer>, column_name = "WhiteElo")]
        white_elo: Option<i32>,
        #[diesel(sql_type = Nullable<Integer>, column_name = "BlackElo")]
        black_elo: Option<i32>,
        #[diesel(sql_type = Nullable<Text>, column_name = "site")]
        site: Option<String>,
        #[diesel(sql_type = Nullable<Text>, column_name = "white_name")]
        white_name: Option<String>,
        #[diesel(sql_type = Nullable<Text>, column_name = "black_name")]
        black_name: Option<String>,
        #[diesel(sql_type = Text, column_name = "win_phase")]
        win_phase: String,
    }

    let rows: Vec<Row> = sql_query(
        r#"
        SELECT
          g.ID AS game_id,
          g.Date,
          g.Result,
          g.TimeControl,
          g.WhiteID,
          g.BlackID,
          g.WhiteElo,
          g.BlackElo,
          s.Name AS site,
          wp.Name AS white_name,
          bp.Name AS black_name,
          gas.WinPhase AS win_phase
        FROM Games g
        INNER JOIN Sites s ON s.ID = g.SiteID
        LEFT JOIN Players wp ON wp.ID = g.WhiteID
        LEFT JOIN Players bp ON bp.ID = g.BlackID
        INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
        WHERE (g.WhiteID = ?1 OR g.BlackID = ?1)
          AND lower(gas.WinPhase) = lower(?2)
        "#,
    )
    .bind::<Integer, _>(profile_player_id)
    .bind::<Text, _>(&phase_norm)
    .load(db)?;

    // Apply platform, time control, opponent bucket filters first.
    let mut filtered: Vec<(Row, String, Option<i64>)> = Vec::new();
    filtered.reserve(rows.len());
    for r in rows {
        let site = r.site.clone().unwrap_or_default();
        if !site.trim().is_empty() {
            match filters.platform {
                PlatformFilter::All => {}
                PlatformFilter::Lichess => {
                    if normalize_platform(&site) != PlatformFilter::Lichess {
                        continue;
                    }
                }
                PlatformFilter::ChessCom => {
                    if normalize_platform(&site) != PlatformFilter::ChessCom {
                        continue;
                    }
                }
            }
        }

        if !matches!(filters.time_control, TimeControlFilter::Any) {
            let tc = r.time_control.clone().unwrap_or_default();
            if get_time_control(&site, &tc) != filters.time_control {
                continue;
            }
        }

        if let Some(bucket) = &filters.opponent_elo_bucket {
            if let Ok(start) = bucket.parse::<i32>() {
                let end = start + 199;
                let is_player_white = r.white_id == profile_player_id;
                let opp = if is_player_white { r.black_elo } else { r.white_elo };
                let Some(opp_elo) = opp else {
                    continue;
                };
                if opp_elo < start || opp_elo > end {
                    continue;
                }
            }
        }

        let ts = r.date.as_deref().and_then(parse_date_to_timestamp);
        filtered.push((r, site, ts));
    }

    // Date range filter mirrors `filter_games`: anchor to last date among filtered games.
    if let Some(date_range) = &filters.date_range {
        if !filtered.is_empty() {
            let mut max_date: Option<i64> = None;
            for (_r, _site, ts) in &filtered {
                if let Some(t) = *ts {
                    max_date = Some(max_date.map_or(t, |m| m.max(t)));
                }
            }

            if let Some(last_date) = max_date {
                const MS_DAY: i64 = 86_400_000;
                let earliest = match date_range {
                    crate::db::DateRange::All => i64::MIN,
                    crate::db::DateRange::SevenDays => last_date - 7 * MS_DAY,
                    crate::db::DateRange::ThirtyDays => last_date - 30 * MS_DAY,
                    crate::db::DateRange::NinetyDays => last_date - 90 * MS_DAY,
                    crate::db::DateRange::OneYear => last_date - 365 * MS_DAY,
                };

                filtered.retain(|(_r, _site, ts)| ts.map(|t| t >= earliest).unwrap_or(false));
            }
        }
    }

    // Stable ordering: newest game id first (approx chronological for imports).
    filtered.sort_by(|(a, _, _), (b, _, _)| b.game_id.cmp(&a.game_id));

    let start = offset.max(0) as usize;
    let end = start.saturating_add(limit as usize).min(filtered.len());

    let mut out: Vec<PhaseGameRow> = Vec::new();
    if start >= filtered.len() {
        return Ok(out);
    }

    for (r, site, _ts) in filtered.into_iter().skip(start).take(end - start) {
        out.push(PhaseGameRow {
            game_id: r.game_id,
            date: r.date,
            site,
            white: r.white_name.unwrap_or_else(|| r.white_id.to_string()),
            black: r.black_name.unwrap_or_else(|| r.black_id.to_string()),
            result: r.result,
            win_phase: phase_key(&r.win_phase).to_string(),
        });
    }

    Ok(out)
}
