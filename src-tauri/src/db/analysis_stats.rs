//! Computed per-game analysis statistics for profile databases.
//!
//! These stats are derived from engine analysis output and persisted into the profile DB.
//! The table is intentionally forward-compatible: additional computed stats should go into `extra` JSON.

use crate::chess::types::{BestMoves, MoveAnalysis, ScoreValue};
use crate::db::encoding::extract_main_line_moves;
use crate::db::pgn::get_material_count;
use crate::db::{GameOutcome, PlatformFilter, PlayerStatsFilters, TimeControlFilter};
use crate::error::{Error, Result};
use crate::analysis_storage::{
    analysis_db_get_analyzed_game_ids, analysis_db_get_analyzed_games_bulk,
    analysis_db_get_game_stats_bulk, AnalyzedGameEntry,
};
use chrono::{SecondsFormat, Utc};
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{BigInt, Integer, Nullable, Text};
use serde_json::{json, Value};
use shakmaty::{
    fen::Fen, san::SanPlus, uci::UciMove, CastlingMode, Chess, Color, EnPassantMode, Move, Position, Role,
};
use std::collections::HashSet;
use tauri::AppHandle;

const PROFILE_ANALYSIS_TABLES_SQL: &str =
    include_str!("../../../database/schema/profile_analysis_tables.sql");

const VERSION_V1: i32 = 1;
const WIN_THRESHOLD_CP: i32 = 300;
const SAFE_THRESHOLD_CP: i32 = 150;
const MATE_AS_CP: i32 = 100_000;

const FORKS_EXTRA_VER_V1: u32 = 1;
const FORK_PV_MAX_PLIES: usize = 3; // our move, their reply, our move
const FORK_MIN_GAIN_CP: i32 = 30;
const FORK_MIN_POSITION_CP: i32 = -180;
const FORK_REJECT_MATE_AGAINST_CP: i32 = -90_000;

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
pub struct PhaseAccuracyBucket {
    pub phase: String, // "opening" | "middlegame" | "endgame"
    pub avg_accuracy: Option<f64>,
    pub count: u32,
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

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IntensityGameRow {
    pub game_id: i32,
    pub date: Option<String>,
    pub site: String,
    pub white: String,
    pub black: String,
    pub result: Option<String>,
    pub intensity: String, // "calm" | "balanced" | "edge" | "intense" | "sudden" | "wild" | "gifted"
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeAccuracyStats {
    pub won_avg_accuracy: Option<f64>,
    pub drawn_avg_accuracy: Option<f64>,
    pub lost_avg_accuracy: Option<f64>,
    pub won_count: u32,
    pub drawn_count: u32,
    pub lost_count: u32,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ForkStats {
    pub found_count: u32,
    pub missed_count: u32,
    pub found_pawn_count: u32,
    pub found_knight_count: u32,
    pub found_bishop_count: u32,
    pub found_rook_count: u32,
    pub found_queen_count: u32,
    pub found_king_count: u32,
    pub missed_pawn_count: u32,
    pub missed_knight_count: u32,
    pub missed_bishop_count: u32,
    pub missed_rook_count: u32,
    pub missed_queen_count: u32,
    pub missed_king_count: u32,
    pub allowed_pawn_count: u32,
    pub allowed_knight_count: u32,
    pub allowed_bishop_count: u32,
    pub allowed_rook_count: u32,
    pub allowed_queen_count: u32,
    pub allowed_king_count: u32,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ForkPuzzleGeneration {
    pub count: u32,
    pub pgn: String,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MissedForkGameRow {
    pub game_id: i32,
    pub date: Option<String>,
    pub site: String,
    pub white: String,
    pub black: String,
    pub result: Option<String>,
    pub ply: u32,
    pub piece: String,
    pub engine_line_comment: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkPieceBuckets {
    pawn: u32,
    knight: u32,
    bishop: u32,
    rook: u32,
    queen: u32,
    king: u32,
}

impl ForkPieceBuckets {
    fn zero() -> Self {
        Self {
            pawn: 0,
            knight: 0,
            bishop: 0,
            rook: 0,
            queen: 0,
            king: 0,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkCountBuckets {
    total: u32,
    by_piece: ForkPieceBuckets,
}

impl ForkCountBuckets {
    fn zero() -> Self {
        Self {
            total: 0,
            by_piece: ForkPieceBuckets::zero(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MissedForkOccurrenceV1 {
    ply: u32,
    piece: String, // "pawn" | "knight" | ...
    fen: String,
    pv_san: Vec<String>,
    pv_uci: Vec<String>,
    #[serde(default)]
    fork_ply_in_pv: Option<u32>,
    #[serde(default)]
    alt_pv_san: Vec<String>,
    #[serde(default)]
    best_eval_cp: Option<i32>,
    #[serde(default)]
    alt_eval_cp: Option<i32>,
    #[serde(default)]
    gain_cp: Option<i32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForksExtraV1 {
    ver: u32,
    found: ForkCountBuckets,
    missed: ForkCountBuckets,
    allowed: ForkPieceBuckets,
    missed_occurrences: Vec<MissedForkOccurrenceV1>,
}

fn forks_extra_from_json_value(v: &Value) -> Option<ForksExtraV1> {
    let forks = v.get("forks")?;
    serde_json::from_value::<ForksExtraV1>(forks.clone()).ok()
}

fn role_bucket_mut<'a>(b: &'a mut ForkPieceBuckets, role: Role) -> &'a mut u32 {
    match role {
        Role::Pawn => &mut b.pawn,
        Role::Knight => &mut b.knight,
        Role::Bishop => &mut b.bishop,
        Role::Rook => &mut b.rook,
        Role::Queen => &mut b.queen,
        Role::King => &mut b.king,
    }
}

fn fork_piece_role_after_move(after: &Chess, mv: &Move) -> Role {
    after
        .board()
        .piece_at(mv.to())
        .map(|p| p.role)
        .unwrap_or(mv.role())
}

fn sorted_lines_by_multipv<'a>(m: &'a MoveAnalysis) -> Vec<&'a BestMoves> {
    let mut lines: Vec<&BestMoves> = m.best.iter().collect();
    lines.sort_by_key(|bm| bm.multipv);
    lines
}

fn eval_cp_for_side(score: &ScoreValue, side: Color) -> i32 {
    let white_cp = score_to_white_cp(score);
    match side {
        Color::White => white_cp,
        Color::Black => -white_cp,
    }
}

fn is_engine_fork_competitive(best_eval_cp: i32, alt_eval_cp: i32) -> bool {
    let gain = best_eval_cp - alt_eval_cp;
    // Reject "forks" in clearly lost/mating-against positions and require edge vs alternative line.
    best_eval_cp > FORK_REJECT_MATE_AGAINST_CP
        && best_eval_cp >= FORK_MIN_POSITION_CP
        && gain >= FORK_MIN_GAIN_CP
}

fn find_fork_in_pv(
    start: &Chess,
    pv_uci: &[String],
    profile_color: Color,
    max_plies: usize,
) -> Option<(usize, Role)> {
    if pv_uci.is_empty() || max_plies == 0 {
        return None;
    }
    let mut pos = start.clone();
    let limit = pv_uci.len().min(max_plies);
    for (idx, uci_str) in pv_uci.iter().take(limit).enumerate() {
        let mover = pos.turn();
        let uci = UciMove::from_ascii(uci_str.as_bytes()).ok()?;
        let mv = uci.to_move(&pos).ok()?;
        pos.play_unchecked(&mv);
        let to = mv.to();
        let role_after = fork_piece_role_after_move(&pos, &mv);
        if mover == profile_color && is_tactical_fork(&pos, to, mover) {
            return Some((idx, role_after));
        }
        if pos.is_game_over() {
            break;
        }
    }
    None
}

fn format_pgn_movetext_from_san(san_moves: &[String], black_to_move: bool) -> String {
    if san_moves.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    let mut ply: usize = 0;
    let mut move_no: usize = 1;
    while ply < san_moves.len() {
        if black_to_move && move_no == 1 {
            out.push_str("1... ");
            out.push_str(&san_moves[ply]);
            ply += 1;
            if ply < san_moves.len() {
                move_no += 1;
                out.push(' ');
            }
            continue;
        }
        out.push_str(&format!("{move_no}. "));
        out.push_str(&san_moves[ply]);
        ply += 1;
        if ply < san_moves.len() {
            out.push(' ');
            out.push_str(&san_moves[ply]);
            ply += 1;
        }
        if ply < san_moves.len() {
            move_no += 1;
            out.push(' ');
        }
    }
    out
}

pub fn compute_engine_validated_forks_extra(
    initial_fen: &str,
    moves: &[String],
    analysis: &[MoveAnalysis],
    profile_color: Color,
) -> Result<Value> {
    let fen = Fen::from_ascii(initial_fen.as_bytes())?;
    let mut pos: Chess = fen.into_position(CastlingMode::Chess960)?;

    let mut out = ForksExtraV1 {
        ver: FORKS_EXTRA_VER_V1,
        found: ForkCountBuckets::zero(),
        missed: ForkCountBuckets::zero(),
        allowed: ForkPieceBuckets::zero(),
        missed_occurrences: Vec::new(),
    };

    let max_ply = moves.len().min(analysis.len());
    for ply_idx in 0..max_ply {
        let mover = pos.turn();
        let uci_str = &moves[ply_idx];
        let uci = match UciMove::from_ascii(uci_str.as_bytes()) {
            Ok(v) => v,
            Err(_) => break,
        };
        let actual = match uci.to_move(&pos) {
            Ok(v) => v,
            Err(_) => break,
        };

        // Allowed forks: opponent played a fork (no engine validation needed).
        if mover != profile_color {
            let mut after = pos.clone();
            after.play_unchecked(&actual);
            let role_after = fork_piece_role_after_move(&after, &actual);
            if is_tactical_fork(&after, actual.to(), mover) {
                *role_bucket_mut(&mut out.allowed, role_after) += 1;
            }
        }

        // Found/missed forks are engine-validated and only counted on the profile player's turns.
        if mover == profile_color {
            let lines = sorted_lines_by_multipv(&analysis[ply_idx]);
            if lines.len() >= 2 {
                let best = lines[0];
                let alt = lines[1];
                let best_move_uci = best.uci_moves.first().cloned().unwrap_or_default();
                if !best_move_uci.is_empty() {
                    let best_eval_cp = eval_cp_for_side(&best.score.value, mover);
                    let alt_eval_cp = eval_cp_for_side(&alt.score.value, mover);
                    if is_engine_fork_competitive(best_eval_cp, alt_eval_cp) {
                        if let Some((fork_idx, fork_role)) =
                            find_fork_in_pv(&pos, &best.uci_moves, profile_color, FORK_PV_MAX_PLIES)
                        {
                            // Compare raw UCI strings to avoid castling-mode differences (e.g. Chess960).
                            let actual_uci_norm = uci_str.trim();
                            if actual_uci_norm == best_move_uci {
                                // Only count "found" when the actual best move itself is the fork move.
                                if fork_idx == 0 {
                                    out.found.total += 1;
                                    *role_bucket_mut(&mut out.found.by_piece, fork_role) += 1;
                                }
                            } else {
                                out.missed.total += 1;
                                *role_bucket_mut(&mut out.missed.by_piece, fork_role) += 1;

                                let fen_before =
                                    Fen::from_position(pos.clone(), EnPassantMode::Legal).to_string();
                                let pv_san: Vec<String> = best
                                    .san_moves
                                    .iter()
                                    .take(fork_idx + 1)
                                    .cloned()
                                    .collect();
                                let pv_uci: Vec<String> = best
                                    .uci_moves
                                    .iter()
                                    .take(fork_idx + 1)
                                    .cloned()
                                    .collect();
                                let alt_pv_san: Vec<String> = alt.san_moves.clone();
                                out.missed_occurrences.push(MissedForkOccurrenceV1 {
                                    ply: ply_idx as u32,
                                    piece: role_to_piece_key(fork_role).to_string(),
                                    fen: fen_before,
                                    pv_san,
                                    pv_uci,
                                    fork_ply_in_pv: Some(fork_idx as u32),
                                    alt_pv_san,
                                    best_eval_cp: Some(best_eval_cp),
                                    alt_eval_cp: Some(alt_eval_cp),
                                    gain_cp: Some(best_eval_cp - alt_eval_cp),
                                });
                            }
                        }
                    }
                }
            }
        }

        pos.play_unchecked(&actual);
        if pos.is_game_over() {
            break;
        }
    }

    Ok(serde_json::to_value(out).unwrap_or_else(|_| json!({})))
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeReasonBreakdown {
    pub won_checkmate_count: u32,
    pub won_timeout_count: u32,
    pub won_abandon_count: u32,
    pub won_resign_forfeit_count: u32,
    pub lost_checkmate_count: u32,
    pub lost_timeout_count: u32,
    pub lost_abandon_count: u32,
    pub lost_resign_forfeit_count: u32,
    pub drawn_agreement_count: u32,
    pub drawn_fifty_move_rule_count: u32,
    pub drawn_timeout_vs_insufficient_material_count: u32,
    pub drawn_insufficient_material_count: u32,
    pub drawn_repetition_count: u32,
    pub drawn_stalemate_count: u32,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IntensityBreakdown {
    pub calm_count: u32,
    pub balanced_count: u32,
    pub edge_count: u32,
    pub intense_count: u32,
    pub sudden_count: u32,
    pub wild_count: u32,
    pub gifted_count: u32,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IntensityOutcomeBucket {
    pub intensity: String, // "calm" | "balanced" | "edge" | "intense" | "sudden" | "wild" | "gifted"
    pub won: u32,
    pub drawn: u32,
    pub lost: u32,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IntensityAccuracyBucket {
    pub intensity: String, // "calm" | "balanced" | "edge" | "intense" | "sudden" | "wild" | "gifted"
    pub avg_accuracy: Option<f64>,
    pub count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutcomeReasonKind {
    Checkmate,
    Timeout,
    Abandon,
    ResignForfeit,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DrawReasonKind {
    Agreement,
    FiftyMoveRule,
    TimeoutVsInsufficientMaterial,
    InsufficientMaterial,
    Repetition,
    Stalemate,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IntensityKind {
    Calm,
    Balanced,
    Edge,
    Intense,
    Sudden,
    Wild,
    Gifted,
}

impl IntensityKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Calm => "calm",
            Self::Balanced => "balanced",
            Self::Edge => "edge",
            Self::Intense => "intense",
            Self::Sudden => "sudden",
            Self::Wild => "wild",
            Self::Gifted => "gifted",
        }
    }
}

fn parse_pgn_tag_value<'a>(pgn: &'a str, tag: &str) -> Option<&'a str> {
    let needle = format!("[{tag} \"");
    let start = pgn.find(&needle)?;
    let rest = &pgn[start + needle.len()..];
    let end = rest.find("\"]")?;
    Some(&rest[..end])
}

fn pgn_last_mainline_token(pgn: &str) -> Option<String> {
    // Use only movetext section (after first blank line).
    let movetext = pgn.split_once("\n\n").map(|(_, m)| m).unwrap_or(pgn);

    // Remove comments {...} and variations (...), preserving only mainline text.
    let mut out = String::with_capacity(movetext.len());
    let mut brace_depth = 0i32;
    let mut paren_depth = 0i32;
    for ch in movetext.chars() {
        match ch {
            '{' => {
                brace_depth += 1;
            }
            '}' => {
                if brace_depth > 0 {
                    brace_depth -= 1;
                }
            }
            '(' => {
                paren_depth += 1;
            }
            ')' => {
                if paren_depth > 0 {
                    paren_depth -= 1;
                }
            }
            _ => {
                if brace_depth == 0 && paren_depth == 0 {
                    out.push(ch);
                }
            }
        }
    }

    // Keep last relevant token (skip move numbers, NAGs, and game result tokens).
    let mut last: Option<String> = None;
    for raw in out.split_whitespace() {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }
        if token == "1-0" || token == "0-1" || token == "1/2-1/2" || token == "*" {
            continue;
        }
        if token.starts_with('$') {
            continue;
        }
        let is_move_number =
            token.ends_with('.') && token[..token.len().saturating_sub(1)].chars().all(|c| c.is_ascii_digit())
                || token.ends_with("...")
                    && token[..token.len().saturating_sub(3)].chars().all(|c| c.is_ascii_digit());
        if is_move_number {
            continue;
        }
        last = Some(token.to_string());
    }
    last
}

fn classify_outcome_reason_from_pgn(pgn: &str) -> OutcomeReasonKind {
    let termination = parse_pgn_tag_value(pgn, "Termination")
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    let full = pgn.to_ascii_lowercase();

    let last_token = pgn_last_mainline_token(pgn).unwrap_or_default();

    if termination.contains("checkmate") || full.contains("checkmate") || last_token.contains('#') {
        return OutcomeReasonKind::Checkmate;
    }

    if termination.contains("time forfeit")
        || termination.contains("timeout")
        || termination.contains("time out")
        || termination.contains("out of time")
        || termination.contains("won on time")
        || termination.contains("lost on time")
        || full.contains("time forfeit")
        || full.contains("won on time")
        || full.contains("lost on time")
    {
        return OutcomeReasonKind::Timeout;
    }

    if termination.contains("abandon") || full.contains("abandon") {
        return OutcomeReasonKind::Abandon;
    }

    if termination.contains("resign")
        || termination.contains("forfeit")
        || termination.contains("inactivity")
        || termination.contains("disconnected")
        || full.contains("resign")
        || full.contains("forfeit")
        || full.contains("inactivity")
    {
        return OutcomeReasonKind::ResignForfeit;
    }

    OutcomeReasonKind::Unknown
}

fn classify_outcome_reason(termination: Option<&str>, pgn: Option<&str>) -> OutcomeReasonKind {
    let term = termination
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    if !term.is_empty() {
        if term.contains("checkmate") {
            return OutcomeReasonKind::Checkmate;
        }
        if term.contains("time forfeit")
            || term.contains("timeout")
            || term.contains("time out")
            || term.contains("out of time")
            || term.contains("won on time")
            || term.contains("lost on time")
        {
            return OutcomeReasonKind::Timeout;
        }
        if term.contains("abandon") {
            return OutcomeReasonKind::Abandon;
        }
        if term.contains("resign")
            || term.contains("forfeit")
            || term.contains("inactivity")
            || term.contains("disconnected")
        {
            return OutcomeReasonKind::ResignForfeit;
        }
    }

    pgn.map(classify_outcome_reason_from_pgn)
        .unwrap_or(OutcomeReasonKind::Unknown)
}

fn classify_draw_reason_from_pgn(pgn: &str) -> DrawReasonKind {
    let termination = parse_pgn_tag_value(pgn, "Termination")
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let full = pgn.to_ascii_lowercase();

    if termination.contains("time forfeit vs insufficient material")
        || termination.contains("timeout vs insufficient material")
        || termination.contains("time out vs insufficient material")
        || full.contains("time forfeit vs insufficient material")
        || full.contains("timeout vs insufficient material")
        || full.contains("time out vs insufficient material")
    {
        return DrawReasonKind::TimeoutVsInsufficientMaterial;
    }

    if termination.contains("50-move")
        || termination.contains("50 move")
        || termination.contains("fifty-move")
        || termination.contains("fifty move")
        || full.contains("50-move")
        || full.contains("50 move")
        || full.contains("fifty-move")
        || full.contains("fifty move")
    {
        return DrawReasonKind::FiftyMoveRule;
    }

    if termination.contains("insufficient material") || full.contains("insufficient material") {
        return DrawReasonKind::InsufficientMaterial;
    }

    if termination.contains("repetition")
        || termination.contains("threefold")
        || full.contains("repetition")
        || full.contains("threefold")
    {
        return DrawReasonKind::Repetition;
    }

    if termination.contains("stalemate") || full.contains("stalemate") {
        return DrawReasonKind::Stalemate;
    }

    if termination.contains("agreement")
        || termination.contains("agreed")
        || termination.contains("mutual")
        || full.contains("draw by agreement")
        || full.contains("drawn by agreement")
        || full.contains("agreed draw")
    {
        return DrawReasonKind::Agreement;
    }

    // Draw + timeout phrasing without explicit "vs insufficient material"
    // is almost always that specific rule outcome.
    if termination.contains("time forfeit")
        || termination.contains("timeout")
        || termination.contains("time out")
        || termination.contains("out of time")
        || full.contains("time forfeit")
        || full.contains("timeout")
        || full.contains("time out")
        || full.contains("out of time")
    {
        return DrawReasonKind::TimeoutVsInsufficientMaterial;
    }

    DrawReasonKind::Unknown
}

fn classify_draw_reason(termination: Option<&str>, pgn: Option<&str>) -> DrawReasonKind {
    let term = termination.unwrap_or("").trim().to_ascii_lowercase();
    if !term.is_empty() {
        if term.contains("time forfeit vs insufficient material")
            || term.contains("timeout vs insufficient material")
            || term.contains("time out vs insufficient material")
        {
            return DrawReasonKind::TimeoutVsInsufficientMaterial;
        }
        if term.contains("50-move")
            || term.contains("50 move")
            || term.contains("fifty-move")
            || term.contains("fifty move")
        {
            return DrawReasonKind::FiftyMoveRule;
        }
        if term.contains("insufficient material") {
            return DrawReasonKind::InsufficientMaterial;
        }
        if term.contains("repetition") || term.contains("threefold") {
            return DrawReasonKind::Repetition;
        }
        if term.contains("stalemate") {
            return DrawReasonKind::Stalemate;
        }
        if term.contains("agreement") || term.contains("agreed") || term.contains("mutual") {
            return DrawReasonKind::Agreement;
        }
        if term.contains("time forfeit")
            || term.contains("timeout")
            || term.contains("time out")
            || term.contains("out of time")
        {
            return DrawReasonKind::TimeoutVsInsufficientMaterial;
        }
    }

    pgn.map(classify_draw_reason_from_pgn)
        .unwrap_or(DrawReasonKind::Unknown)
}

fn detect_checkmate_from_game_bytes(moves: &[u8], fen: Option<&str>) -> bool {
    let start_pos = if let Some(fen_str) = fen {
        if let Ok(fen_obj) = Fen::from_ascii(fen_str.as_bytes()) {
            fen_obj
                .into_position(CastlingMode::Chess960)
                .unwrap_or_else(|_| Chess::default())
        } else {
            Chess::default()
        }
    } else {
        Chess::default()
    };

    let Ok(mainline_moves) = extract_main_line_moves(moves, Some(start_pos.clone())) else {
        return false;
    };
    let mut pos = start_pos;
    for mv in mainline_moves {
        pos.play_unchecked(&mv);
    }
    pos.is_checkmate()
}

fn detect_draw_reason_from_game_bytes(moves: &[u8], fen: Option<&str>) -> DrawReasonKind {
    let start_pos = if let Some(fen_str) = fen {
        if let Ok(fen_obj) = Fen::from_ascii(fen_str.as_bytes()) {
            fen_obj
                .into_position(CastlingMode::Chess960)
                .unwrap_or_else(|_| Chess::default())
        } else {
            Chess::default()
        }
    } else {
        Chess::default()
    };

    let Ok(mainline_moves) = extract_main_line_moves(moves, Some(start_pos.clone())) else {
        return DrawReasonKind::Unknown;
    };
    let mut pos = start_pos;
    for mv in mainline_moves {
        pos.play_unchecked(&mv);
    }

    if pos.is_stalemate() {
        return DrawReasonKind::Stalemate;
    }
    if pos.is_insufficient_material() {
        return DrawReasonKind::InsufficientMaterial;
    }
    DrawReasonKind::Unknown
}

fn classify_unknown_reason_fallback(site: &str, time_control: Option<&str>, ply_count: Option<i32>) -> OutcomeReasonKind {
    let plies = ply_count.unwrap_or(0).max(0);
    if plies > 0 && plies <= 12 {
        return OutcomeReasonKind::Abandon;
    }

    let tc = time_control.unwrap_or("").trim();
    let tc_kind = get_time_control(site, tc);
    match tc_kind {
        TimeControlFilter::Bullet | TimeControlFilter::Blitz | TimeControlFilter::Rapid => {
            OutcomeReasonKind::Timeout
        }
        TimeControlFilter::Classical => {
            if plies > 0 && plies <= 20 {
                OutcomeReasonKind::Abandon
            } else {
                OutcomeReasonKind::ResignForfeit
            }
        }
        TimeControlFilter::Any => OutcomeReasonKind::ResignForfeit,
    }
}

fn clamp_eval_cp_for_intensity(cp: i32) -> i32 {
    cp.clamp(-1200, 1200)
}

fn is_decisive_tail_for_side(scores: &[i32], idx: usize) -> bool {
    if idx >= scores.len() {
        return false;
    }
    let side = scores[idx].signum();
    if side == 0 {
        return false;
    }

    let tail = &scores[idx..];
    if tail.is_empty() {
        return false;
    }

    let stable = tail
        .iter()
        .filter(|cp| cp.signum() == side && cp.abs() >= 250)
        .count();
    let last_abs = tail.last().copied().unwrap_or(0).abs();

    stable * 5 >= tail.len() * 4 && last_abs >= 450
}

fn classify_game_intensity_from_scores(raw_scores: &[i32]) -> IntensityKind {
    if raw_scores.len() < 4 {
        return IntensityKind::Calm;
    }

    let scores: Vec<i32> = raw_scores
        .iter()
        .map(|cp| clamp_eval_cp_for_intensity(*cp))
        .collect();
    let n = scores.len();

    let mut near_equal = 0usize;
    let mut max_abs = 0i32;
    for cp in &scores {
        if cp.abs() <= 120 {
            near_equal += 1;
        }
        max_abs = max_abs.max(cp.abs());
    }
    let near_equal_ratio = (near_equal as f64) / (n as f64);

    let mut max_jump = 0i32;
    let mut max_jump_idx = 0usize;
    let mut big_jump_count = 0usize;
    let mut medium_jump_count = 0usize;
    let mut lead_changes = 0usize;
    let mut severe_lead_changes = 0usize;

    for i in 1..n {
        let prev = scores[i - 1];
        let cur = scores[i];
        let jump = (cur - prev).abs();

        if jump > max_jump {
            max_jump = jump;
            max_jump_idx = i;
        }
        if jump >= 500 {
            big_jump_count += 1;
        }
        if jump >= 300 {
            medium_jump_count += 1;
        }

        let prev_sign = prev.signum();
        let cur_sign = cur.signum();
        if prev_sign != 0
            && cur_sign != 0
            && prev_sign != cur_sign
            && prev.abs() >= 150
            && cur.abs() >= 150
        {
            lead_changes += 1;
            if prev.abs() >= 300 && cur.abs() >= 300 {
                severe_lead_changes += 1;
            }
        }
    }

    let early_cut = ((n as f64) * 0.45).floor() as usize;
    let late_cut = ((n as f64) * 0.65).floor() as usize;
    let decisive_after_max_jump = is_decisive_tail_for_side(&scores, max_jump_idx);
    let medium_jump_ratio = (medium_jump_count as f64) / ((n - 1) as f64);
    let last_abs = scores.last().copied().unwrap_or(0).abs();
    let gifted_from_equal = if max_jump_idx > 0 {
        let prev_abs = scores[max_jump_idx - 1].abs();
        let cur_abs = scores[max_jump_idx].abs();
        prev_abs <= 120 && cur_abs >= 180
    } else {
        false
    };

    // Regalada: early gift/blunder, then mostly conversion and little back-and-forth.
    if max_jump_idx <= early_cut
        && decisive_after_max_jump
        && lead_changes <= 1
        && severe_lead_changes == 0
        && medium_jump_ratio <= 0.35
        && (
            // Hard blunder gift.
            (max_jump >= 550 && (last_abs >= 450 || max_abs >= 700))
            // Softer but clear early gift from equality (e.g. ~-2.0 around move 8).
            || (max_jump >= 180 && gifted_from_equal && last_abs >= 320)
        )
    {
        return IntensityKind::Gifted;
    }

    // Salvaje: multiple large swings and clear handovers.
    if lead_changes >= 2 && (big_jump_count >= 2 || severe_lead_changes >= 1) {
        return IntensityKind::Wild;
    }

    // Subita: one defining blow after normal play, then game mostly decided.
    if max_jump >= 620
        && decisive_after_max_jump
        && big_jump_count <= 2
        && max_jump_idx > early_cut
    {
        return IntensityKind::Sudden;
    }

    // Al limite: long equality and a decisive late critical moment.
    if near_equal_ratio >= 0.48 && max_jump_idx >= late_cut && max_jump >= 380 {
        return IntensityKind::Edge;
    }

    // Equilibrada: mostly around equality, no violent shifts.
    if near_equal_ratio >= 0.62
        && max_jump < 420
        && lead_changes <= 1
        && severe_lead_changes == 0
        && medium_jump_ratio <= 0.30
        && max_abs <= 450
    {
        return IntensityKind::Balanced;
    }

    // Tranquila: stable flow with low volatility and little tactical drama.
    if max_jump < 280
        && big_jump_count == 0
        && lead_changes <= 1
        && medium_jump_ratio <= 0.18
        && max_abs <= 520
    {
        return IntensityKind::Calm;
    }

    IntensityKind::Intense
}

fn role_tactical_value(role: Role) -> i32 {
    match role {
        Role::Pawn => 1,
        Role::Knight | Role::Bishop => 3,
        Role::Rook => 5,
        Role::Queen => 9,
        Role::King => 100,
    }
}

fn is_square_defended_by(board: &shakmaty::Board, side: Color, target: shakmaty::Square) -> bool {
    for from in board.by_color(side) {
        if board.attacks_from(from).contains(target) {
            return true;
        }
    }
    false
}

fn is_tactical_fork(after: &Chess, from_sq: shakmaty::Square, attacker: Color) -> bool {
    let board = after.board();
    let defender = attacker.other();
    let attacked = board.attacks_from(from_sq) & board.by_color(defender);

    let mut target_count: u32 = 0;
    let mut king_targets: u32 = 0;
    let mut major_minor_targets: u32 = 0; // N/B/R/Q
    let mut high_value_targets: u32 = 0; // R/Q
    let mut loose_targets: u32 = 0; // target is not defended by its own side
    let mut loose_major_minor: u32 = 0; // loose N/B/R/Q
    let mut pawn_targets: u32 = 0;

    for sq in attacked {
        let Some(piece) = board.piece_at(sq) else {
            continue;
        };
        target_count += 1;
        let defended = is_square_defended_by(board, defender, sq);
        if !defended {
            loose_targets += 1;
        }

        match piece.role {
            Role::King => {
                king_targets += 1;
            }
            Role::Knight | Role::Bishop => {
                major_minor_targets += 1;
                if !defended {
                    loose_major_minor += 1;
                }
            }
            Role::Rook | Role::Queen => {
                major_minor_targets += 1;
                high_value_targets += 1;
                if !defended {
                    loose_major_minor += 1;
                }
            }
            Role::Pawn => {
                pawn_targets += 1;
            }
        }
    }

    if target_count < 2 {
        return false;
    }

    // Check + valuable piece is a valid tactical fork.
    if king_targets > 0 && major_minor_targets > 0 {
        return true;
    }

    // Two+ valuable targets with at least one vulnerable target.
    if major_minor_targets >= 2 && (loose_major_minor > 0 || high_value_targets > 0) {
        return true;
    }

    // Pawn-only "double attacks" are forks only if they are actually loose gains.
    if pawn_targets >= 2 && major_minor_targets == 0 && king_targets == 0 {
        return loose_targets >= 2;
    }

    // Mixed cases: require at least one vulnerable target.
    major_minor_targets > 0 && loose_targets > 0
}

fn count_double_attack_targets(board: &shakmaty::Board, from_sq: shakmaty::Square, defender: Color) -> (u32, i32) {
    let attacked = board.attacks_from(from_sq) & board.by_color(defender);
    let mut count: u32 = 0;
    let mut sum_value: i32 = 0;
    for sq in attacked {
        if let Some(piece) = board.piece_at(sq) {
            count += 1;
            sum_value += role_tactical_value(piece.role);
        }
    }
    (count, sum_value)
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
struct ForkOpportunity {
    role: Role,
    mv: Move,
    targets: u32,
    target_value: i32,
}

#[allow(dead_code)]
fn detect_actual_and_best_fork(pos: &Chess, actual: &Move) -> (Option<Role>, Option<ForkOpportunity>) {
    let mut actual_fork_role: Option<Role> = None;
    let mut best_opportunity: Option<ForkOpportunity> = None;

    for cand in pos.legal_moves() {
        let mut after = pos.clone();
        after.play_unchecked(&cand);

        let to = cand.to();
        let role_after = after
            .board()
            .piece_at(to)
            .map(|p| p.role)
            .unwrap_or(cand.role());

        let (targets, target_value) = count_double_attack_targets(after.board(), to, after.turn());
        if targets < 2 {
            continue;
        }

        if cand == *actual {
            actual_fork_role = Some(role_after);
        }

        let replace_best = match &best_opportunity {
            Some(best) => targets > best.targets || (targets == best.targets && target_value > best.target_value),
            None => true,
        };
        if replace_best {
            best_opportunity = Some(ForkOpportunity {
                role: role_after,
                mv: cand.clone(),
                targets,
                target_value,
            });
        }
    }

    (actual_fork_role, best_opportunity)
}

#[allow(dead_code)]
fn inc_role_bucket(
    role: Role,
    pawn: &mut u32,
    knight: &mut u32,
    bishop: &mut u32,
    rook: &mut u32,
    queen: &mut u32,
    king: &mut u32,
) {
    match role {
        Role::Pawn => *pawn += 1,
        Role::Knight => *knight += 1,
        Role::Bishop => *bishop += 1,
        Role::Rook => *rook += 1,
        Role::Queen => *queen += 1,
        Role::King => *king += 1,
    }
}

#[allow(dead_code)]
fn start_position_from_fen(fen: Option<&str>) -> Chess {
    if let Some(fen_str) = fen {
        if let Ok(fen_obj) = Fen::from_ascii(fen_str.as_bytes()) {
            return fen_obj
                .into_position(CastlingMode::Chess960)
                .unwrap_or_else(|_| Chess::default());
        }
    }
    Chess::default()
}

#[allow(dead_code)]
fn accumulate_game_forks(
    stats: &mut ForkStats,
    moves_blob: &[u8],
    fen: Option<&str>,
    profile_color: Color,
) {
    let start_pos = start_position_from_fen(fen);
    let Ok(mainline_moves) = extract_main_line_moves(moves_blob, Some(start_pos.clone())) else {
        return;
    };
    let mut pos = start_pos;

    for actual in mainline_moves {
        let mover = pos.turn();
        let (actual_fork_role, best_opportunity) = detect_actual_and_best_fork(&pos, &actual);

        if mover == profile_color {
            if let Some(role) = actual_fork_role {
                stats.found_count += 1;
                inc_role_bucket(
                    role,
                    &mut stats.found_pawn_count,
                    &mut stats.found_knight_count,
                    &mut stats.found_bishop_count,
                    &mut stats.found_rook_count,
                    &mut stats.found_queen_count,
                    &mut stats.found_king_count,
                );
            } else if let Some(best) = best_opportunity {
                stats.missed_count += 1;
                inc_role_bucket(
                    best.role,
                    &mut stats.missed_pawn_count,
                    &mut stats.missed_knight_count,
                    &mut stats.missed_bishop_count,
                    &mut stats.missed_rook_count,
                    &mut stats.missed_queen_count,
                    &mut stats.missed_king_count,
                );
            }
        } else if let Some(role) = actual_fork_role {
            inc_role_bucket(
                role,
                &mut stats.allowed_pawn_count,
                &mut stats.allowed_knight_count,
                &mut stats.allowed_bishop_count,
                &mut stats.allowed_rook_count,
                &mut stats.allowed_queen_count,
                &mut stats.allowed_king_count,
            );
        }

        pos.play_unchecked(&actual);
        if pos.is_game_over() {
            break;
        }
    }
}

fn role_to_piece_key(role: Role) -> &'static str {
    match role {
        Role::Pawn => "pawn",
        Role::Knight => "knight",
        Role::Bishop => "bishop",
        Role::Rook => "rook",
        Role::Queen => "queen",
        Role::King => "king",
    }
}

fn parse_piece_filter(piece: Option<&str>) -> Option<Role> {
    let Some(piece) = piece else {
        return None;
    };
    let normalized = piece.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "pawn" => Some(Role::Pawn),
        "knight" => Some(Role::Knight),
        "bishop" => Some(Role::Bishop),
        "rook" => Some(Role::Rook),
        "queen" => Some(Role::Queen),
        "king" => Some(Role::King),
        _ => None,
    }
}

#[allow(dead_code)]
fn accumulate_missed_fork_puzzles(
    out: &mut Vec<(String, String, String, Role)>,
    seen: &mut HashSet<String>,
    moves_blob: &[u8],
    fen: Option<&str>,
    profile_color: Color,
    piece_filter: Option<Role>,
) {
    let start_pos = start_position_from_fen(fen);
    let Ok(mainline_moves) = extract_main_line_moves(moves_blob, Some(start_pos.clone())) else {
        return;
    };
    let mut pos = start_pos;

    for actual in mainline_moves {
        let mover = pos.turn();
        if mover == profile_color {
            let (actual_fork_role, best_opportunity) = detect_actual_and_best_fork(&pos, &actual);
            if actual_fork_role.is_none() {
                if let Some(best) = best_opportunity {
                    if piece_filter.map(|f| f == best.role).unwrap_or(true) {
                        let fen_before =
                            Fen::from_position(pos.clone(), EnPassantMode::Legal).to_string();
                        let san = SanPlus::from_move(pos.clone(), &best.mv).to_string();
                        let solution_uci = best.mv.to_uci(CastlingMode::Standard).to_string();
                        let dedupe_key = format!("{fen_before}|{solution_uci}");
                        if seen.insert(dedupe_key) {
                            out.push((fen_before, san, solution_uci, best.role));
                        }
                    }
                }
            }
        }

        pos.play_unchecked(&actual);
        if pos.is_game_over() {
            break;
        }
    }
}

fn build_missed_fork_puzzles_pgn(entries: &[MissedForkOccurrenceV1]) -> String {
    let mut out = String::new();
    for (idx, entry) in entries.iter().enumerate() {
        let piece_tag = entry.piece.as_str();
        let is_black_to_move = entry.fen.split_whitespace().nth(1).unwrap_or("w") == "b";
        let movetext = format_pgn_movetext_from_san(&entry.pv_san, is_black_to_move);
        out.push_str(&format!(r#"[Event "Missed fork {}"]"#, idx + 1));
        out.push('\n');
        out.push_str(r#"[Site "Obsidian Chess Studio"]"#);
        out.push('\n');
        out.push_str(r#"[Date "????.??.??"]"#);
        out.push('\n');
        out.push_str(r#"[Round "-"]"#);
        out.push('\n');
        out.push_str(r#"[White "Puzzle"]"#);
        out.push('\n');
        out.push_str(r#"[Black "?"]"#);
        out.push('\n');
        out.push_str(r#"[Result "*"]"#);
        out.push('\n');
        out.push_str(&format!(r#"[FEN "{}"]"#, entry.fen));
        out.push('\n');
        out.push_str(&format!(r#"[Solution "{movetext}"]"#));
        out.push('\n');
        out.push_str(r#"[Themes "fork,missedFork"]"#);
        out.push('\n');
        out.push_str(&format!(r#"[OpeningTags "missed-fork,piece:{piece_tag}"]"#));
        out.push('\n');
        out.push('\n');
        out.push_str(&movetext);
        out.push('\n');
        out.push('\n');
    }
    out
}

#[allow(dead_code)]
fn collect_missed_fork_ply_rows(
    out: &mut Vec<(u32, Role)>,
    moves_blob: &[u8],
    fen: Option<&str>,
    profile_color: Color,
    piece_filter: Option<Role>,
) {
    let start_pos = start_position_from_fen(fen);
    let Ok(mainline_moves) = extract_main_line_moves(moves_blob, Some(start_pos.clone())) else {
        return;
    };
    let mut pos = start_pos;
    let mut ply: u32 = 0;

    for actual in mainline_moves {
        if pos.turn() == profile_color {
            let (actual_fork_role, best_opportunity) = detect_actual_and_best_fork(&pos, &actual);
            if actual_fork_role.is_none() {
                if let Some(best) = best_opportunity {
                    if piece_filter.map(|f| f == best.role).unwrap_or(true) {
                        out.push((ply, best.role));
                    }
                }
            }
        }

        pos.play_unchecked(&actual);
        ply += 1;
        if pos.is_game_over() {
            break;
        }
    }
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

fn intensity_key(s: &str) -> &'static str {
    match s.trim().to_lowercase().as_str() {
        "calm" => "calm",
        "balanced" => "balanced",
        "edge" => "edge",
        "intense" => "intense",
        "sudden" => "sudden",
        "wild" => "wild",
        "gifted" => "gifted",
        _ => "",
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

pub fn compute_profile_phase_accuracy(
    app: AppHandle,
    db: &mut SqliteConnection,
    profile_id: &str,
    filters: &PlayerStatsFilters,
) -> Result<Vec<PhaseAccuracyBucket>> {
    ensure_phase_stats_present(app.clone(), db, profile_id)?;

    let Some(profile_player_id) = load_or_infer_profile_player_id(db)? else {
        return Ok(vec![
            PhaseAccuracyBucket { phase: "opening".to_string(), avg_accuracy: None, count: 0 },
            PhaseAccuracyBucket { phase: "middlegame".to_string(), avg_accuracy: None, count: 0 },
            PhaseAccuracyBucket { phase: "endgame".to_string(), avg_accuracy: None, count: 0 },
        ]);
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

    let mut filtered: Vec<(Row, Option<i64>)> = Vec::new();
    filtered.reserve(rows.len());
    for r in rows {
        if r.result.as_deref().is_none() {
            continue;
        }

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
        filtered.push((r, ts));
    }

    if let Some(date_range) = &filters.date_range {
        if !filtered.is_empty() {
            let mut max_date: Option<i64> = None;
            for (_r, ts) in &filtered {
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

                filtered.retain(|(_r, ts)| ts.map(|t| t >= earliest).unwrap_or(false));
            }
        }
    }

    let ids: Vec<String> = filtered.iter().map(|(r, _)| r.game_id.to_string()).collect();
    if ids.is_empty() {
        return Ok(vec![
            PhaseAccuracyBucket { phase: "opening".to_string(), avg_accuracy: None, count: 0 },
            PhaseAccuracyBucket { phase: "middlegame".to_string(), avg_accuracy: None, count: 0 },
            PhaseAccuracyBucket { phase: "endgame".to_string(), avg_accuracy: None, count: 0 },
        ]);
    }

    let phase_by_id: std::collections::HashMap<String, String> = filtered
        .into_iter()
        .map(|(r, _)| (r.game_id.to_string(), phase_key(&r.win_phase).to_string()))
        .collect();

    let mut stats_rows = analysis_db_get_game_stats_bulk(
        app.clone(),
        ids.clone(),
        Some(profile_id.to_string()),
    )?;
    if stats_rows.is_empty() && !profile_id.trim().is_empty() {
        stats_rows = analysis_db_get_game_stats_bulk(app, ids, None)?;
    }

    let mut opening_sum = 0.0f64;
    let mut middlegame_sum = 0.0f64;
    let mut endgame_sum = 0.0f64;
    let mut opening_count: u32 = 0;
    let mut middlegame_count: u32 = 0;
    let mut endgame_count: u32 = 0;

    for s in stats_rows {
        let Some(phase) = phase_by_id.get(&s.game_id) else {
            continue;
        };
        match phase.as_str() {
            "opening" => {
                opening_sum += s.accuracy;
                opening_count += 1;
            }
            "middlegame" => {
                middlegame_sum += s.accuracy;
                middlegame_count += 1;
            }
            _ => {
                endgame_sum += s.accuracy;
                endgame_count += 1;
            }
        }
    }

    Ok(vec![
        PhaseAccuracyBucket {
            phase: "opening".to_string(),
            avg_accuracy: if opening_count > 0 { Some(opening_sum / opening_count as f64) } else { None },
            count: opening_count,
        },
        PhaseAccuracyBucket {
            phase: "middlegame".to_string(),
            avg_accuracy: if middlegame_count > 0 {
                Some(middlegame_sum / middlegame_count as f64)
            } else {
                None
            },
            count: middlegame_count,
        },
        PhaseAccuracyBucket {
            phase: "endgame".to_string(),
            avg_accuracy: if endgame_count > 0 { Some(endgame_sum / endgame_count as f64) } else { None },
            count: endgame_count,
        },
    ])
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
          g.Termination,
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

pub fn compute_profile_outcome_accuracy(
    app: AppHandle,
    db: &mut SqliteConnection,
    profile_id: &str,
    filters: &PlayerStatsFilters,
) -> Result<OutcomeAccuracyStats> {
    ensure_phase_stats_present(app.clone(), db, profile_id)?;

    let Some(profile_player_id) = load_or_infer_profile_player_id(db)? else {
        return Ok(OutcomeAccuracyStats {
            won_avg_accuracy: None,
            drawn_avg_accuracy: None,
            lost_avg_accuracy: None,
            won_count: 0,
            drawn_count: 0,
            lost_count: 0,
        });
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
          s.Name AS site
        FROM Games g
        INNER JOIN Sites s ON s.ID = g.SiteID
        INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
        WHERE g.WhiteID = ?1 OR g.BlackID = ?1
        "#,
    )
    .bind::<Integer, _>(profile_player_id)
    .load(db)?;

    let mut filtered: Vec<(Row, Option<i64>)> = Vec::new();
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
        filtered.push((r, ts));
    }

    if let Some(date_range) = &filters.date_range {
        if !filtered.is_empty() {
            let mut max_date: Option<i64> = None;
            for (_r, ts) in &filtered {
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

                filtered.retain(|(_r, ts)| ts.map(|t| t >= earliest).unwrap_or(false));
            }
        }
    }

    let mut outcome_by_game_id = std::collections::HashMap::<String, GameOutcome>::new();
    let mut ids: Vec<String> = Vec::new();
    for (r, _ts) in filtered {
        let Some(result) = r.result.as_deref() else {
            continue;
        };
        let is_player_white = r.white_id == profile_player_id;
        let Some(outcome) = GameOutcome::from_str(result, is_player_white) else {
            continue;
        };
        let gid = r.game_id.to_string();
        ids.push(gid.clone());
        outcome_by_game_id.insert(gid, outcome);
    }

    if ids.is_empty() {
        return Ok(OutcomeAccuracyStats {
            won_avg_accuracy: None,
            drawn_avg_accuracy: None,
            lost_avg_accuracy: None,
            won_count: 0,
            drawn_count: 0,
            lost_count: 0,
        });
    }

    let mut stats_rows = analysis_db_get_game_stats_bulk(
        app.clone(),
        ids.clone(),
        Some(profile_id.to_string()),
    )?;
    if stats_rows.is_empty() && !profile_id.trim().is_empty() {
        stats_rows = analysis_db_get_game_stats_bulk(app, ids, None)?;
    }

    let mut won_sum = 0.0f64;
    let mut drawn_sum = 0.0f64;
    let mut lost_sum = 0.0f64;
    let mut won_count: u32 = 0;
    let mut drawn_count: u32 = 0;
    let mut lost_count: u32 = 0;

    for s in stats_rows {
        let Some(outcome) = outcome_by_game_id.get(&s.game_id) else {
            continue;
        };
        match outcome {
            GameOutcome::Won => {
                won_sum += s.accuracy;
                won_count += 1;
            }
            GameOutcome::Drawn => {
                drawn_sum += s.accuracy;
                drawn_count += 1;
            }
            GameOutcome::Lost => {
                lost_sum += s.accuracy;
                lost_count += 1;
            }
        }
    }

    Ok(OutcomeAccuracyStats {
        won_avg_accuracy: if won_count > 0 {
            Some(won_sum / (won_count as f64))
        } else {
            None
        },
        drawn_avg_accuracy: if drawn_count > 0 {
            Some(drawn_sum / (drawn_count as f64))
        } else {
            None
        },
        lost_avg_accuracy: if lost_count > 0 {
            Some(lost_sum / (lost_count as f64))
        } else {
            None
        },
        won_count,
        drawn_count,
        lost_count,
    })
}

pub fn compute_profile_fork_stats(
    app: AppHandle,
    db: &mut SqliteConnection,
    profile_id: &str,
    filters: &PlayerStatsFilters,
) -> Result<ForkStats> {
    ensure_phase_stats_present(app.clone(), db, profile_id)?;

    let mut out = ForkStats {
        found_count: 0,
        missed_count: 0,
        found_pawn_count: 0,
        found_knight_count: 0,
        found_bishop_count: 0,
        found_rook_count: 0,
        found_queen_count: 0,
        found_king_count: 0,
        missed_pawn_count: 0,
        missed_knight_count: 0,
        missed_bishop_count: 0,
        missed_rook_count: 0,
        missed_queen_count: 0,
        missed_king_count: 0,
        allowed_pawn_count: 0,
        allowed_knight_count: 0,
        allowed_bishop_count: 0,
        allowed_rook_count: 0,
        allowed_queen_count: 0,
        allowed_king_count: 0,
    };

    let Some(profile_player_id) = load_or_infer_profile_player_id(db)? else {
        return Ok(out);
    };

    #[derive(QueryableByName)]
    struct Row {
        #[diesel(sql_type = Nullable<Text>, column_name = "Date")]
        date: Option<String>,
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
        #[diesel(sql_type = Text, column_name = "Extra")]
        extra: String,
    }

    let rows: Vec<Row> = sql_query(
        r#"
        SELECT
          g.Date,
          g.TimeControl,
          g.WhiteID,
          g.BlackID,
          g.WhiteElo,
          g.BlackElo,
          s.Name AS site,
          gas.Extra AS Extra
        FROM Games g
        INNER JOIN Sites s ON s.ID = g.SiteID
        INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
        WHERE g.WhiteID = ?1 OR g.BlackID = ?1
        "#,
    )
    .bind::<Integer, _>(profile_player_id)
    .load(db)?;

    let mut filtered: Vec<(Row, Option<i64>)> = Vec::new();
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
        filtered.push((r, ts));
    }

    if let Some(date_range) = &filters.date_range {
        if !filtered.is_empty() {
            let mut max_date: Option<i64> = None;
            for (_r, ts) in &filtered {
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

                filtered.retain(|(_r, ts)| ts.map(|t| t >= earliest).unwrap_or(false));
            }
        }
    }

    for (r, _ts) in filtered {
        // Fork stats are computed when a game is analyzed and stored in GameAnalysisStats.Extra.
        let Ok(extra_v) = serde_json::from_str::<Value>(&r.extra) else {
            continue;
        };
        let Some(f) = forks_extra_from_json_value(&extra_v) else {
            continue;
        };

        out.found_count += f.found.total;
        out.missed_count += f.missed.total;
        out.found_pawn_count += f.found.by_piece.pawn;
        out.found_knight_count += f.found.by_piece.knight;
        out.found_bishop_count += f.found.by_piece.bishop;
        out.found_rook_count += f.found.by_piece.rook;
        out.found_queen_count += f.found.by_piece.queen;
        out.found_king_count += f.found.by_piece.king;

        out.missed_pawn_count += f.missed.by_piece.pawn;
        out.missed_knight_count += f.missed.by_piece.knight;
        out.missed_bishop_count += f.missed.by_piece.bishop;
        out.missed_rook_count += f.missed.by_piece.rook;
        out.missed_queen_count += f.missed.by_piece.queen;
        out.missed_king_count += f.missed.by_piece.king;

        out.allowed_pawn_count += f.allowed.pawn;
        out.allowed_knight_count += f.allowed.knight;
        out.allowed_bishop_count += f.allowed.bishop;
        out.allowed_rook_count += f.allowed.rook;
        out.allowed_queen_count += f.allowed.queen;
        out.allowed_king_count += f.allowed.king;
    }

    Ok(out)
}

pub fn generate_profile_missed_fork_puzzles(
    app: AppHandle,
    db: &mut SqliteConnection,
    profile_id: &str,
    filters: &PlayerStatsFilters,
    piece: Option<&str>,
) -> Result<ForkPuzzleGeneration> {
    ensure_phase_stats_present(app.clone(), db, profile_id)?;

    let Some(profile_player_id) = load_or_infer_profile_player_id(db)? else {
        return Ok(ForkPuzzleGeneration {
            count: 0,
            pgn: String::new(),
        });
    };

    let piece_filter_key = parse_piece_filter(piece)
        .map(role_to_piece_key)
        .map(|s| s.to_string());

    #[derive(QueryableByName)]
    struct Row {
        #[diesel(sql_type = Nullable<Text>, column_name = "Date")]
        date: Option<String>,
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
        #[diesel(sql_type = Text, column_name = "Extra")]
        extra: String,
    }

    let rows: Vec<Row> = sql_query(
        r#"
        SELECT
          g.Date,
          g.TimeControl,
          g.WhiteID,
          g.BlackID,
          g.WhiteElo,
          g.BlackElo,
          s.Name AS site,
          gas.Extra AS Extra
        FROM Games g
        INNER JOIN Sites s ON s.ID = g.SiteID
        INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
        WHERE g.WhiteID = ?1 OR g.BlackID = ?1
        "#,
    )
    .bind::<Integer, _>(profile_player_id)
    .load(db)?;

    let mut filtered: Vec<(Row, Option<i64>)> = Vec::new();
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
        filtered.push((r, ts));
    }

    if let Some(date_range) = &filters.date_range {
        if !filtered.is_empty() {
            let mut max_date: Option<i64> = None;
            for (_r, ts) in &filtered {
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

                filtered.retain(|(_r, ts)| ts.map(|t| t >= earliest).unwrap_or(false));
            }
        }
    }

    let mut puzzles: Vec<MissedForkOccurrenceV1> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for (r, _ts) in filtered {
        let Ok(extra_v) = serde_json::from_str::<Value>(&r.extra) else {
            continue;
        };
        let Some(f) = forks_extra_from_json_value(&extra_v) else {
            continue;
        };

        for occ in f.missed_occurrences {
            if occ.pv_san.is_empty() {
                continue;
            }
            if piece_filter_key
                .as_deref()
                .map(|k| k == occ.piece.as_str())
                .unwrap_or(true)
            {
                let pv_key = if occ.pv_uci.is_empty() {
                    continue;
                } else {
                    occ.pv_uci.join(" ")
                };
                let dedupe_key = format!("{}|{}", occ.fen, pv_key);
                if seen.insert(dedupe_key) {
                    puzzles.push(occ);
                }
            }
        }
    }

    let pgn = build_missed_fork_puzzles_pgn(&puzzles);
    Ok(ForkPuzzleGeneration {
        count: puzzles.len() as u32,
        pgn,
    })
}

pub fn get_profile_missed_fork_games(
    app: AppHandle,
    db: &mut SqliteConnection,
    profile_id: &str,
    filters: &PlayerStatsFilters,
    piece: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<MissedForkGameRow>> {
    ensure_phase_stats_present(app.clone(), db, profile_id)?;

    let Some(profile_player_id) = load_or_infer_profile_player_id(db)? else {
        return Ok(vec![]);
    };

    let Some(piece_key) = parse_piece_filter(Some(piece)).map(role_to_piece_key) else {
        return Ok(vec![]);
    };

    let limit = limit.clamp(1, 500) as usize;
    let offset = offset as usize;

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
        #[diesel(sql_type = Text, column_name = "Extra")]
        extra: String,
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
          pw.Name AS white_name,
          pb.Name AS black_name,
          gas.Extra AS Extra
        FROM Games g
        INNER JOIN Sites s ON s.ID = g.SiteID
        INNER JOIN Players pw ON pw.ID = g.WhiteID
        INNER JOIN Players pb ON pb.ID = g.BlackID
        INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
        WHERE g.WhiteID = ?1 OR g.BlackID = ?1
        "#,
    )
    .bind::<Integer, _>(profile_player_id)
    .load(db)?;

    let mut filtered: Vec<(Row, Option<i64>)> = Vec::new();
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
        filtered.push((r, ts));
    }

    if let Some(date_range) = &filters.date_range {
        if !filtered.is_empty() {
            let mut max_date: Option<i64> = None;
            for (_r, ts) in &filtered {
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

                filtered.retain(|(_r, ts)| ts.map(|t| t >= earliest).unwrap_or(false));
            }
        }
    }

    let mut all_rows: Vec<(Option<i64>, MissedForkGameRow)> = Vec::new();
    for (r, ts) in filtered {
        let Ok(extra_v) = serde_json::from_str::<Value>(&r.extra) else {
            continue;
        };
        let Some(f) = forks_extra_from_json_value(&extra_v) else {
            continue;
        };

        for occ in f.missed_occurrences {
            if occ.piece != piece_key {
                continue;
            }
            all_rows.push((
                ts,
                MissedForkGameRow {
                    game_id: r.game_id,
                    date: r.date.clone(),
                    site: r.site.clone().unwrap_or_default(),
                    white: r.white_name.clone().unwrap_or_else(|| "?".to_string()),
                    black: r.black_name.clone().unwrap_or_else(|| "?".to_string()),
                    result: r.result.clone(),
                    ply: occ.ply,
                    piece: occ.piece,
                    engine_line_comment: {
                        if occ.pv_san.is_empty() {
                            None
                        } else {
                            let line = occ.pv_san.join(" ");
                            let fork_part = if let Some(fork_ply) = occ.fork_ply_in_pv {
                                format!("Fork appears at PV ply {}. ", fork_ply + 1)
                            } else {
                                String::new()
                            };
                            let gain_part = match (occ.best_eval_cp, occ.alt_eval_cp, occ.gain_cp) {
                                (Some(best_cp), Some(alt_cp), Some(gain_cp)) => {
                                    format!("Best eval: {best_cp}cp, line 2 eval: {alt_cp}cp, gain: {gain_cp:+}cp. ")
                                }
                                _ => String::new(),
                            };
                            let alt_part = if occ.alt_pv_san.is_empty() {
                                String::new()
                            } else {
                                format!("Line 2: {}.", occ.alt_pv_san.join(" "))
                            };
                            let msg = format!("Engine PV: {line}. {fork_part}{gain_part}{alt_part}").trim().to_string();
                            Some(msg)
                        }
                    },
                },
            ));
        }
    }

    all_rows.sort_by(|a, b| b.0.cmp(&a.0));
    let page = all_rows.into_iter().skip(offset).take(limit).map(|(_, r)| r).collect();
    Ok(page)
}

pub fn get_profile_intensity_games(
    app: AppHandle,
    db: &mut SqliteConnection,
    profile_id: &str,
    filters: &PlayerStatsFilters,
    intensity: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<IntensityGameRow>> {
    ensure_phase_stats_present(app.clone(), db, profile_id)?;

    let Some(profile_player_id) = load_or_infer_profile_player_id(db)? else {
        return Ok(vec![]);
    };

    let intensity_norm = intensity_key(intensity).to_string();
    if intensity_norm.is_empty() {
        return Ok(vec![]);
    }

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
          bp.Name AS black_name
        FROM Games g
        INNER JOIN Sites s ON s.ID = g.SiteID
        LEFT JOIN Players wp ON wp.ID = g.WhiteID
        LEFT JOIN Players bp ON bp.ID = g.BlackID
        INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
        WHERE g.WhiteID = ?1 OR g.BlackID = ?1
        "#,
    )
    .bind::<Integer, _>(profile_player_id)
    .load(db)?;

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

    let ids: Vec<String> = filtered
        .iter()
        .map(|(r, _site, _ts)| r.game_id.to_string())
        .collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }

    let mut analyzed_rows =
        analysis_db_get_analyzed_games_bulk(app.clone(), ids.clone(), Some(profile_id.to_string()))?;
    if analyzed_rows.is_empty() && !profile_id.trim().is_empty() {
        analyzed_rows = analysis_db_get_analyzed_games_bulk(app, ids, None)?;
    }
    let analyzed_map: std::collections::HashMap<String, String> = analyzed_rows
        .into_iter()
        .map(|r| (r.game_id, r.analyzed_pgn))
        .collect();

    let mut matched: Vec<(Row, String)> = Vec::new();
    for (r, site, _ts) in filtered {
        let game_id = r.game_id.to_string();
        let Some(analyzed_pgn) = analyzed_map.get(&game_id) else {
            continue;
        };
        let scores = extract_eval_scores_from_analyzed_pgn(analyzed_pgn);
        let kind = classify_game_intensity_from_scores(&scores);
        if kind.as_str() == intensity_norm {
            matched.push((r, site));
        }
    }

    matched.sort_by(|(a, _), (b, _)| b.game_id.cmp(&a.game_id));

    let start = offset.max(0) as usize;
    let end = start.saturating_add(limit as usize).min(matched.len());
    if start >= matched.len() {
        return Ok(vec![]);
    }

    let mut out: Vec<IntensityGameRow> = Vec::new();
    for (r, site) in matched.into_iter().skip(start).take(end - start) {
        out.push(IntensityGameRow {
            game_id: r.game_id,
            date: r.date,
            site,
            white: r.white_name.unwrap_or_else(|| r.white_id.to_string()),
            black: r.black_name.unwrap_or_else(|| r.black_id.to_string()),
            result: r.result,
            intensity: intensity_norm.clone(),
        });
    }

    Ok(out)
}

pub fn compute_profile_outcome_reason_breakdown(
    app: AppHandle,
    db: &mut SqliteConnection,
    profile_id: &str,
    filters: &PlayerStatsFilters,
) -> Result<OutcomeReasonBreakdown> {
    ensure_phase_stats_present(app.clone(), db, profile_id)?;

    let Some(profile_player_id) = load_or_infer_profile_player_id(db)? else {
        return Ok(OutcomeReasonBreakdown {
            won_checkmate_count: 0,
            won_timeout_count: 0,
            won_abandon_count: 0,
            won_resign_forfeit_count: 0,
            lost_checkmate_count: 0,
            lost_timeout_count: 0,
            lost_abandon_count: 0,
            lost_resign_forfeit_count: 0,
            drawn_agreement_count: 0,
            drawn_fifty_move_rule_count: 0,
            drawn_timeout_vs_insufficient_material_count: 0,
            drawn_insufficient_material_count: 0,
            drawn_repetition_count: 0,
            drawn_stalemate_count: 0,
        });
    };

    #[derive(QueryableByName)]
    struct Row {
        #[diesel(sql_type = Integer, column_name = "game_id")]
        game_id: i32,
        #[diesel(sql_type = Nullable<Text>, column_name = "Date")]
        date: Option<String>,
        #[diesel(sql_type = Nullable<Text>, column_name = "Result")]
        result: Option<String>,
        #[diesel(sql_type = Nullable<Text>, column_name = "Termination")]
        termination: Option<String>,
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
        #[diesel(sql_type = diesel::sql_types::Binary, column_name = "Moves")]
        moves: Vec<u8>,
        #[diesel(sql_type = Nullable<Text>, column_name = "FEN")]
        fen: Option<String>,
        #[diesel(sql_type = Nullable<Integer>, column_name = "PlyCount")]
        ply_count: Option<i32>,
    }

    let rows: Vec<Row> = sql_query(
        r#"
        SELECT
          g.ID AS game_id,
          g.Date,
          g.Result,
          g.Termination,
          g.TimeControl,
          g.WhiteID,
          g.BlackID,
          g.WhiteElo,
          g.BlackElo,
          s.Name AS site,
          g.Moves,
          g.FEN,
          g.PlyCount
        FROM Games g
        INNER JOIN Sites s ON s.ID = g.SiteID
        INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
        WHERE g.WhiteID = ?1 OR g.BlackID = ?1
        "#,
    )
    .bind::<Integer, _>(profile_player_id)
    .load(db)?;

    let mut filtered: Vec<(Row, Option<i64>)> = Vec::new();
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
        filtered.push((r, ts));
    }

    if let Some(date_range) = &filters.date_range {
        if !filtered.is_empty() {
            let mut max_date: Option<i64> = None;
            for (_r, ts) in &filtered {
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

                filtered.retain(|(_r, ts)| ts.map(|t| t >= earliest).unwrap_or(false));
            }
        }
    }

    let mut outcome_by_game_id = std::collections::HashMap::<String, GameOutcome>::new();
    let mut termination_by_game_id = std::collections::HashMap::<String, Option<String>>::new();
    let mut checkmate_by_game_id = std::collections::HashMap::<String, bool>::new();
    let mut draw_state_reason_by_game_id = std::collections::HashMap::<String, DrawReasonKind>::new();
    let mut fallback_meta_by_game_id =
        std::collections::HashMap::<String, (String, Option<String>, Option<i32>)>::new();
    let mut ids: Vec<String> = Vec::new();
    for (r, _ts) in filtered {
        let Some(result) = r.result.as_deref() else {
            continue;
        };
        let is_player_white = r.white_id == profile_player_id;
        let Some(outcome) = GameOutcome::from_str(result, is_player_white) else {
            continue;
        };
        let gid = r.game_id.to_string();
        ids.push(gid.clone());
        outcome_by_game_id.insert(gid, outcome);
        termination_by_game_id.insert(r.game_id.to_string(), r.termination.clone());
        checkmate_by_game_id.insert(
            r.game_id.to_string(),
            detect_checkmate_from_game_bytes(&r.moves, r.fen.as_deref()),
        );
        draw_state_reason_by_game_id.insert(
            r.game_id.to_string(),
            detect_draw_reason_from_game_bytes(&r.moves, r.fen.as_deref()),
        );
        fallback_meta_by_game_id.insert(
            r.game_id.to_string(),
            (r.site.clone().unwrap_or_default(), r.time_control.clone(), r.ply_count),
        );
    }

    if ids.is_empty() {
        return Ok(OutcomeReasonBreakdown {
            won_checkmate_count: 0,
            won_timeout_count: 0,
            won_abandon_count: 0,
            won_resign_forfeit_count: 0,
            lost_checkmate_count: 0,
            lost_timeout_count: 0,
            lost_abandon_count: 0,
            lost_resign_forfeit_count: 0,
            drawn_agreement_count: 0,
            drawn_fifty_move_rule_count: 0,
            drawn_timeout_vs_insufficient_material_count: 0,
            drawn_insufficient_material_count: 0,
            drawn_repetition_count: 0,
            drawn_stalemate_count: 0,
        });
    }

    let mut analyzed_rows =
        analysis_db_get_analyzed_games_bulk(app.clone(), ids.clone(), Some(profile_id.to_string()))?;
    if analyzed_rows.is_empty() && !profile_id.trim().is_empty() {
        analyzed_rows = analysis_db_get_analyzed_games_bulk(app, ids, None)?;
    }

    let mut out = OutcomeReasonBreakdown {
        won_checkmate_count: 0,
        won_timeout_count: 0,
        won_abandon_count: 0,
        won_resign_forfeit_count: 0,
        lost_checkmate_count: 0,
        lost_timeout_count: 0,
        lost_abandon_count: 0,
        lost_resign_forfeit_count: 0,
        drawn_agreement_count: 0,
        drawn_fifty_move_rule_count: 0,
        drawn_timeout_vs_insufficient_material_count: 0,
        drawn_insufficient_material_count: 0,
        drawn_repetition_count: 0,
        drawn_stalemate_count: 0,
    };

    let analyzed_map: std::collections::HashMap<String, String> = analyzed_rows
        .into_iter()
        .map(|r| (r.game_id, r.analyzed_pgn))
        .collect();

    // Count every analyzed game and keep totals consistent with W/D/L stats.
    for (game_id, outcome) in outcome_by_game_id {
        match outcome {
            GameOutcome::Won | GameOutcome::Lost => {
                let parsed = analyzed_map
                    .get(&game_id)
                    .map(|pgn| {
                        classify_outcome_reason(
                            termination_by_game_id
                                .get(&game_id)
                                .and_then(|v| v.as_deref()),
                            Some(pgn),
                        )
                    })
                    .unwrap_or_else(|| {
                        classify_outcome_reason(
                            termination_by_game_id
                                .get(&game_id)
                                .and_then(|v| v.as_deref()),
                            None,
                        )
                    });
                let reason = if matches!(parsed, OutcomeReasonKind::Unknown) {
                    if checkmate_by_game_id.get(&game_id).copied().unwrap_or(false) {
                        OutcomeReasonKind::Checkmate
                    } else {
                        let (site, tc, plies) = fallback_meta_by_game_id
                            .get(&game_id)
                            .cloned()
                            .unwrap_or_else(|| (String::new(), None, None));
                        classify_unknown_reason_fallback(&site, tc.as_deref(), plies)
                    }
                } else {
                    parsed
                };
                match (outcome, reason) {
                    (GameOutcome::Won, OutcomeReasonKind::Checkmate) => out.won_checkmate_count += 1,
                    (GameOutcome::Won, OutcomeReasonKind::Timeout) => out.won_timeout_count += 1,
                    (GameOutcome::Won, OutcomeReasonKind::Abandon) => out.won_abandon_count += 1,
                    (GameOutcome::Won, OutcomeReasonKind::ResignForfeit) => out.won_resign_forfeit_count += 1,
                    (GameOutcome::Lost, OutcomeReasonKind::Checkmate) => out.lost_checkmate_count += 1,
                    (GameOutcome::Lost, OutcomeReasonKind::Timeout) => out.lost_timeout_count += 1,
                    (GameOutcome::Lost, OutcomeReasonKind::Abandon) => out.lost_abandon_count += 1,
                    (GameOutcome::Lost, OutcomeReasonKind::ResignForfeit) => out.lost_resign_forfeit_count += 1,
                    _ => {}
                }
            }
            GameOutcome::Drawn => {
                let parsed = analyzed_map
                    .get(&game_id)
                    .map(|pgn| {
                        classify_draw_reason(
                            termination_by_game_id
                                .get(&game_id)
                                .and_then(|v| v.as_deref()),
                            Some(pgn),
                        )
                    })
                    .unwrap_or_else(|| {
                        classify_draw_reason(
                            termination_by_game_id
                                .get(&game_id)
                                .and_then(|v| v.as_deref()),
                            None,
                        )
                    });
                let reason = if matches!(parsed, DrawReasonKind::Unknown) {
                    let by_position = draw_state_reason_by_game_id
                        .get(&game_id)
                        .copied()
                        .unwrap_or(DrawReasonKind::Unknown);
                    if matches!(by_position, DrawReasonKind::Unknown) {
                        DrawReasonKind::Agreement
                    } else {
                        by_position
                    }
                } else {
                    parsed
                };

                match reason {
                    DrawReasonKind::Agreement => out.drawn_agreement_count += 1,
                    DrawReasonKind::FiftyMoveRule => out.drawn_fifty_move_rule_count += 1,
                    DrawReasonKind::TimeoutVsInsufficientMaterial => {
                        out.drawn_timeout_vs_insufficient_material_count += 1
                    }
                    DrawReasonKind::InsufficientMaterial => out.drawn_insufficient_material_count += 1,
                    DrawReasonKind::Repetition => out.drawn_repetition_count += 1,
                    DrawReasonKind::Stalemate => out.drawn_stalemate_count += 1,
                    DrawReasonKind::Unknown => out.drawn_agreement_count += 1,
                }
            }
        }
    }

    Ok(out)
}

pub fn compute_profile_intensity_breakdown(
    app: AppHandle,
    db: &mut SqliteConnection,
    profile_id: &str,
    filters: &PlayerStatsFilters,
) -> Result<IntensityBreakdown> {
    ensure_phase_stats_present(app.clone(), db, profile_id)?;

    let Some(profile_player_id) = load_or_infer_profile_player_id(db)? else {
        return Ok(IntensityBreakdown {
            calm_count: 0,
            balanced_count: 0,
            edge_count: 0,
            intense_count: 0,
            sudden_count: 0,
            wild_count: 0,
            gifted_count: 0,
        });
    };

    #[derive(QueryableByName)]
    struct Row {
        #[diesel(sql_type = Integer, column_name = "game_id")]
        game_id: i32,
        #[diesel(sql_type = Nullable<Text>, column_name = "Date")]
        date: Option<String>,
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
    }

    let rows: Vec<Row> = sql_query(
        r#"
        SELECT
          g.ID AS game_id,
          g.Date,
          g.TimeControl,
          g.WhiteID,
          g.BlackID,
          g.WhiteElo,
          g.BlackElo,
          s.Name AS site
        FROM Games g
        INNER JOIN Sites s ON s.ID = g.SiteID
        INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
        WHERE g.WhiteID = ?1 OR g.BlackID = ?1
        "#,
    )
    .bind::<Integer, _>(profile_player_id)
    .load(db)?;

    let mut filtered: Vec<(Row, Option<i64>)> = Vec::new();
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
        filtered.push((r, ts));
    }

    if let Some(date_range) = &filters.date_range {
        if !filtered.is_empty() {
            let mut max_date: Option<i64> = None;
            for (_r, ts) in &filtered {
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

                filtered.retain(|(_r, ts)| ts.map(|t| t >= earliest).unwrap_or(false));
            }
        }
    }

    let ids: Vec<String> = filtered
        .into_iter()
        .map(|(r, _ts)| r.game_id.to_string())
        .collect();

    if ids.is_empty() {
        return Ok(IntensityBreakdown {
            calm_count: 0,
            balanced_count: 0,
            edge_count: 0,
            intense_count: 0,
            sudden_count: 0,
            wild_count: 0,
            gifted_count: 0,
        });
    }

    let mut analyzed_rows =
        analysis_db_get_analyzed_games_bulk(app.clone(), ids.clone(), Some(profile_id.to_string()))?;
    if analyzed_rows.is_empty() && !profile_id.trim().is_empty() {
        analyzed_rows = analysis_db_get_analyzed_games_bulk(app, ids, None)?;
    }

    let mut out = IntensityBreakdown {
        calm_count: 0,
        balanced_count: 0,
        edge_count: 0,
        intense_count: 0,
        sudden_count: 0,
        wild_count: 0,
        gifted_count: 0,
    };

    for row in analyzed_rows {
        let scores = extract_eval_scores_from_analyzed_pgn(&row.analyzed_pgn);
        let intensity = classify_game_intensity_from_scores(&scores);
        match intensity {
            IntensityKind::Calm => out.calm_count += 1,
            IntensityKind::Balanced => out.balanced_count += 1,
            IntensityKind::Edge => out.edge_count += 1,
            IntensityKind::Intense => out.intense_count += 1,
            IntensityKind::Sudden => out.sudden_count += 1,
            IntensityKind::Wild => out.wild_count += 1,
            IntensityKind::Gifted => out.gifted_count += 1,
        }
    }

    Ok(out)
}

pub fn compute_profile_intensity_outcomes(
    app: AppHandle,
    db: &mut SqliteConnection,
    profile_id: &str,
    filters: &PlayerStatsFilters,
) -> Result<Vec<IntensityOutcomeBucket>> {
    ensure_phase_stats_present(app.clone(), db, profile_id)?;

    let Some(profile_player_id) = load_or_infer_profile_player_id(db)? else {
        return Ok(vec![
            IntensityOutcomeBucket {
                intensity: IntensityKind::Calm.as_str().to_string(),
                won: 0,
                drawn: 0,
                lost: 0,
            },
            IntensityOutcomeBucket {
                intensity: IntensityKind::Balanced.as_str().to_string(),
                won: 0,
                drawn: 0,
                lost: 0,
            },
            IntensityOutcomeBucket {
                intensity: IntensityKind::Edge.as_str().to_string(),
                won: 0,
                drawn: 0,
                lost: 0,
            },
            IntensityOutcomeBucket {
                intensity: IntensityKind::Intense.as_str().to_string(),
                won: 0,
                drawn: 0,
                lost: 0,
            },
            IntensityOutcomeBucket {
                intensity: IntensityKind::Sudden.as_str().to_string(),
                won: 0,
                drawn: 0,
                lost: 0,
            },
            IntensityOutcomeBucket {
                intensity: IntensityKind::Wild.as_str().to_string(),
                won: 0,
                drawn: 0,
                lost: 0,
            },
            IntensityOutcomeBucket {
                intensity: IntensityKind::Gifted.as_str().to_string(),
                won: 0,
                drawn: 0,
                lost: 0,
            },
        ]);
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
          s.Name AS site
        FROM Games g
        INNER JOIN Sites s ON s.ID = g.SiteID
        INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
        WHERE g.WhiteID = ?1 OR g.BlackID = ?1
        "#,
    )
    .bind::<Integer, _>(profile_player_id)
    .load(db)?;

    let mut filtered: Vec<(Row, Option<i64>)> = Vec::new();
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
        filtered.push((r, ts));
    }

    if let Some(date_range) = &filters.date_range {
        if !filtered.is_empty() {
            let mut max_date: Option<i64> = None;
            for (_r, ts) in &filtered {
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

                filtered.retain(|(_r, ts)| ts.map(|t| t >= earliest).unwrap_or(false));
            }
        }
    }

    let mut outcome_by_game_id = std::collections::HashMap::<String, GameOutcome>::new();
    let mut ids: Vec<String> = Vec::new();
    for (r, _ts) in filtered {
        let Some(result) = r.result.as_deref() else {
            continue;
        };
        let is_player_white = r.white_id == profile_player_id;
        let Some(outcome) = GameOutcome::from_str(result, is_player_white) else {
            continue;
        };
        let gid = r.game_id.to_string();
        ids.push(gid.clone());
        outcome_by_game_id.insert(gid, outcome);
    }

    if ids.is_empty() {
        return Ok(vec![
            IntensityOutcomeBucket {
                intensity: IntensityKind::Calm.as_str().to_string(),
                won: 0,
                drawn: 0,
                lost: 0,
            },
            IntensityOutcomeBucket {
                intensity: IntensityKind::Balanced.as_str().to_string(),
                won: 0,
                drawn: 0,
                lost: 0,
            },
            IntensityOutcomeBucket {
                intensity: IntensityKind::Edge.as_str().to_string(),
                won: 0,
                drawn: 0,
                lost: 0,
            },
            IntensityOutcomeBucket {
                intensity: IntensityKind::Intense.as_str().to_string(),
                won: 0,
                drawn: 0,
                lost: 0,
            },
            IntensityOutcomeBucket {
                intensity: IntensityKind::Sudden.as_str().to_string(),
                won: 0,
                drawn: 0,
                lost: 0,
            },
            IntensityOutcomeBucket {
                intensity: IntensityKind::Wild.as_str().to_string(),
                won: 0,
                drawn: 0,
                lost: 0,
            },
            IntensityOutcomeBucket {
                intensity: IntensityKind::Gifted.as_str().to_string(),
                won: 0,
                drawn: 0,
                lost: 0,
            },
        ]);
    }

    let mut analyzed_rows =
        analysis_db_get_analyzed_games_bulk(app.clone(), ids.clone(), Some(profile_id.to_string()))?;
    if analyzed_rows.is_empty() && !profile_id.trim().is_empty() {
        analyzed_rows = analysis_db_get_analyzed_games_bulk(app, ids, None)?;
    }

    let mut by_key = std::collections::HashMap::<&'static str, (u32, u32, u32)>::new();
    by_key.insert(IntensityKind::Calm.as_str(), (0, 0, 0));
    by_key.insert(IntensityKind::Balanced.as_str(), (0, 0, 0));
    by_key.insert(IntensityKind::Edge.as_str(), (0, 0, 0));
    by_key.insert(IntensityKind::Intense.as_str(), (0, 0, 0));
    by_key.insert(IntensityKind::Sudden.as_str(), (0, 0, 0));
    by_key.insert(IntensityKind::Wild.as_str(), (0, 0, 0));
    by_key.insert(IntensityKind::Gifted.as_str(), (0, 0, 0));

    for row in analyzed_rows {
        let Some(outcome) = outcome_by_game_id.get(&row.game_id) else {
            continue;
        };
        let scores = extract_eval_scores_from_analyzed_pgn(&row.analyzed_pgn);
        let intensity = classify_game_intensity_from_scores(&scores);
        if let Some((won, drawn, lost)) = by_key.get_mut(intensity.as_str()) {
            match outcome {
                GameOutcome::Won => *won += 1,
                GameOutcome::Drawn => *drawn += 1,
                GameOutcome::Lost => *lost += 1,
            }
        }
    }

    let order = [
        IntensityKind::Calm,
        IntensityKind::Balanced,
        IntensityKind::Edge,
        IntensityKind::Intense,
        IntensityKind::Sudden,
        IntensityKind::Wild,
        IntensityKind::Gifted,
    ];
    let mut out: Vec<IntensityOutcomeBucket> = Vec::with_capacity(order.len());
    for kind in order {
        let key = kind.as_str();
        let (won, drawn, lost) = by_key.get(key).copied().unwrap_or((0, 0, 0));
        out.push(IntensityOutcomeBucket {
            intensity: key.to_string(),
            won,
            drawn,
            lost,
        });
    }

    Ok(out)
}

pub fn compute_profile_intensity_accuracy(
    app: AppHandle,
    db: &mut SqliteConnection,
    profile_id: &str,
    filters: &PlayerStatsFilters,
) -> Result<Vec<IntensityAccuracyBucket>> {
    ensure_phase_stats_present(app.clone(), db, profile_id)?;

    let Some(profile_player_id) = load_or_infer_profile_player_id(db)? else {
        return Ok(vec![
            IntensityAccuracyBucket { intensity: IntensityKind::Calm.as_str().to_string(), avg_accuracy: None, count: 0 },
            IntensityAccuracyBucket { intensity: IntensityKind::Balanced.as_str().to_string(), avg_accuracy: None, count: 0 },
            IntensityAccuracyBucket { intensity: IntensityKind::Edge.as_str().to_string(), avg_accuracy: None, count: 0 },
            IntensityAccuracyBucket { intensity: IntensityKind::Intense.as_str().to_string(), avg_accuracy: None, count: 0 },
            IntensityAccuracyBucket { intensity: IntensityKind::Sudden.as_str().to_string(), avg_accuracy: None, count: 0 },
            IntensityAccuracyBucket { intensity: IntensityKind::Wild.as_str().to_string(), avg_accuracy: None, count: 0 },
            IntensityAccuracyBucket { intensity: IntensityKind::Gifted.as_str().to_string(), avg_accuracy: None, count: 0 },
        ]);
    };

    #[derive(QueryableByName)]
    struct Row {
        #[diesel(sql_type = Integer, column_name = "game_id")]
        game_id: i32,
        #[diesel(sql_type = Nullable<Text>, column_name = "Date")]
        date: Option<String>,
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
    }

    let rows: Vec<Row> = sql_query(
        r#"
        SELECT
          g.ID AS game_id,
          g.Date,
          g.TimeControl,
          g.WhiteID,
          g.BlackID,
          g.WhiteElo,
          g.BlackElo,
          s.Name AS site
        FROM Games g
        INNER JOIN Sites s ON s.ID = g.SiteID
        INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
        WHERE g.WhiteID = ?1 OR g.BlackID = ?1
        "#,
    )
    .bind::<Integer, _>(profile_player_id)
    .load(db)?;

    let mut filtered: Vec<(Row, Option<i64>)> = Vec::new();
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
        filtered.push((r, ts));
    }

    if let Some(date_range) = &filters.date_range {
        if !filtered.is_empty() {
            let mut max_date: Option<i64> = None;
            for (_r, ts) in &filtered {
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

                filtered.retain(|(_r, ts)| ts.map(|t| t >= earliest).unwrap_or(false));
            }
        }
    }

    let ids: Vec<String> = filtered
        .into_iter()
        .map(|(r, _ts)| r.game_id.to_string())
        .collect();

    if ids.is_empty() {
        return Ok(vec![
            IntensityAccuracyBucket { intensity: IntensityKind::Calm.as_str().to_string(), avg_accuracy: None, count: 0 },
            IntensityAccuracyBucket { intensity: IntensityKind::Balanced.as_str().to_string(), avg_accuracy: None, count: 0 },
            IntensityAccuracyBucket { intensity: IntensityKind::Edge.as_str().to_string(), avg_accuracy: None, count: 0 },
            IntensityAccuracyBucket { intensity: IntensityKind::Intense.as_str().to_string(), avg_accuracy: None, count: 0 },
            IntensityAccuracyBucket { intensity: IntensityKind::Sudden.as_str().to_string(), avg_accuracy: None, count: 0 },
            IntensityAccuracyBucket { intensity: IntensityKind::Wild.as_str().to_string(), avg_accuracy: None, count: 0 },
            IntensityAccuracyBucket { intensity: IntensityKind::Gifted.as_str().to_string(), avg_accuracy: None, count: 0 },
        ]);
    }

    let mut analyzed_rows =
        analysis_db_get_analyzed_games_bulk(app.clone(), ids.clone(), Some(profile_id.to_string()))?;
    if analyzed_rows.is_empty() && !profile_id.trim().is_empty() {
        analyzed_rows = analysis_db_get_analyzed_games_bulk(app.clone(), ids.clone(), None)?;
    }

    let mut stats_rows =
        analysis_db_get_game_stats_bulk(app.clone(), ids.clone(), Some(profile_id.to_string()))?;
    if stats_rows.is_empty() && !profile_id.trim().is_empty() {
        stats_rows = analysis_db_get_game_stats_bulk(app, ids, None)?;
    }
    let accuracy_by_id: std::collections::HashMap<String, f64> = stats_rows
        .into_iter()
        .map(|s| (s.game_id, s.accuracy))
        .collect();

    let mut sums = std::collections::HashMap::<&'static str, (f64, u32)>::new();
    sums.insert(IntensityKind::Calm.as_str(), (0.0, 0));
    sums.insert(IntensityKind::Balanced.as_str(), (0.0, 0));
    sums.insert(IntensityKind::Edge.as_str(), (0.0, 0));
    sums.insert(IntensityKind::Intense.as_str(), (0.0, 0));
    sums.insert(IntensityKind::Sudden.as_str(), (0.0, 0));
    sums.insert(IntensityKind::Wild.as_str(), (0.0, 0));
    sums.insert(IntensityKind::Gifted.as_str(), (0.0, 0));

    for row in analyzed_rows {
        let Some(acc) = accuracy_by_id.get(&row.game_id) else {
            continue;
        };
        let scores = extract_eval_scores_from_analyzed_pgn(&row.analyzed_pgn);
        let kind = classify_game_intensity_from_scores(&scores);
        if let Some((sum, cnt)) = sums.get_mut(kind.as_str()) {
            *sum += *acc;
            *cnt += 1;
        }
    }

    let order = [
        IntensityKind::Calm,
        IntensityKind::Balanced,
        IntensityKind::Edge,
        IntensityKind::Intense,
        IntensityKind::Sudden,
        IntensityKind::Wild,
        IntensityKind::Gifted,
    ];
    let mut out: Vec<IntensityAccuracyBucket> = Vec::with_capacity(order.len());
    for kind in order {
        let key = kind.as_str();
        let (sum, count) = sums.get(key).copied().unwrap_or((0.0, 0));
        out.push(IntensityAccuracyBucket {
            intensity: key.to_string(),
            avg_accuracy: if count > 0 { Some(sum / (count as f64)) } else { None },
            count,
        });
    }

    Ok(out)
}
