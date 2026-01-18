//! player_match_planner.rs
//!
//! Backend-only opponent modeling + match planning with Stockfish.
//!
//! Core requirements implemented:
//! - Opponent move modeling is trained from the PROFILE DB `Games.Moves` BLOB.
//! - Analysis DB (`analysis.db3`) is optional and used only as a fallback move source
//!   (or later as evaluation/tag support).
//! - The planner builds a bounded variation "book" using:
//!   - our candidate moves from Stockfish MultiPV
//!   - opponent replies from a learned policy π(move | position, context)
//!   - expected value (EV) computed by sampling opponent replies + quick eval.
//!
//! Notes:
//! - Comments are in English per repository preference.
//! - This module is backend-only and intended to be called via Tauri commands.

use std::collections::{HashMap, VecDeque};
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::str::FromStr;

use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike, Utc, Weekday};
use log::{debug, info, warn};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use shakmaty::{
    fen::Fen,
    san::SanPlus,
    uci::UciMove,
    CastlingMode,
    Chess,
    EnPassantMode,
    Position, // REQUIRED: provides turn(), legal_moves(), play(), play_unchecked()
};
use specta::Type;
use tauri::{path::BaseDirectory, AppHandle, Manager, State};

use crate::chess::engine_path::resolve_engine_path;
use crate::chess::process::{parse_uci_attrs, EngineProcess};
use crate::chess::types::{EngineOption, EngineOptions, GoMode, ScoreValue};
use crate::error::{Error, Result};
use crate::AppState;

// -----------------------------
// Public API (types + command)
// -----------------------------

/// Limits passed to the engine. Use either depth or time (or both).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineLimits {
    pub depth: Option<u32>,
    pub time_ms: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineLine {
    pub bestmove_uci: String,
    /// Centipawns from White's perspective.
    pub score_cp: i32,
    /// Principal variation (UCI).
    pub pv_uci: Vec<String>,
}

/// Match inputs we care about: when, time-control, colors, and starting position.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MatchContext {
    /// Match start datetime (UTC) as milliseconds since epoch.
    pub match_start_utc_ms: i64,
    /// Time control string (e.g. "300+0", "180+2").
    pub time_control: String,
    /// Our Elo (used to bucket the opponent model context).
    pub our_elo: i32,
    /// Target player id (from profile DB Players.ID).
    pub target_player_id: i64,
    /// Our color for the match.
    pub our_color: PlayerColor,
    /// Starting position (FEN) or "startpos".
    pub start_fen: String,
}

/// Planning controls and safety bounds.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanOptions {
    pub horizon_plies: usize,
    pub opponent_top_k: usize,
    pub min_branch_prob: f64,
    pub max_nodes: usize,

    pub our_multipv: usize,
    pub quick_eval_limits: EngineLimits,
    pub candidate_limits: EngineLimits,

    pub backoff_k: f64,
    pub smoothing_alpha: f64,
}

impl PlanOptions {
    fn validate(&self) -> Result<()> {
        if self.opponent_top_k == 0 {
            return Err(Error::PackageManager("opponentTopK must be >= 1".to_string()));
        }
        if self.our_multipv == 0 {
            return Err(Error::PackageManager("ourMultipv must be >= 1".to_string()));
        }
        if self.max_nodes == 0 {
            return Err(Error::PackageManager("maxNodes must be >= 1".to_string()));
        }
        if !self.min_branch_prob.is_finite() || self.min_branch_prob < 0.0 || self.min_branch_prob > 1.0 {
            return Err(Error::PackageManager(
                "minBranchProb must be a finite value in [0, 1]".to_string(),
            ));
        }
        if !self.smoothing_alpha.is_finite() || self.smoothing_alpha < 0.0 {
            return Err(Error::PackageManager(
                "smoothingAlpha must be a finite value >= 0".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantBook {
    pub root_node_id: u64,
    pub nodes: Vec<BookNode>,
    pub edges: Vec<BookEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookNode {
    pub id: u64,
    pub fen: String,
    pub ply_from_root: usize,
    pub side_to_move: PlayerColor,
    pub reach_prob: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookEdge {
    pub from: u64,
    pub to: u64,
    pub uci: String,
    pub prob: f64,
    pub kind: EdgeKind,
    pub ev_cp_from_our_perspective: Option<f64>,
    pub predicted_prob: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EdgeKind {
    OurMove,
    OpponentMove,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PlayerColor {
    White,
    Black,
}

impl PlayerColor {
    pub fn opposite(self) -> PlayerColor {
        match self {
            PlayerColor::White => PlayerColor::Black,
            PlayerColor::Black => PlayerColor::White,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlannerBuildBookRequest {
    pub profile_id: String,
    pub engine_path: String,
    /// Extra UCI options to apply (e.g. Hash, SyzygyPath). MultiPV is managed by the planner.
    pub uci_options: Vec<EngineOption>,
    pub ctx: MatchContext,
    pub opts: PlanOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlannerBuildPgnRequest {
    pub profile_id: String,
    pub engine_path: String,
    /// Extra UCI options to apply (e.g. Hash, SyzygyPath). MultiPV is managed by the planner.
    pub uci_options: Vec<EngineOption>,
    pub ctx: MatchContext,
    pub opts: PlanOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlannerBuildPgnResponse {
    pub pgn: String,
}

#[tauri::command]
#[specta::specta]
pub async fn planner_build_variant_book(
    app: AppHandle,
    _state: State<'_, AppState>,
    req: PlannerBuildBookRequest,
) -> Result<VariantBook> {
    let profile_id = req.profile_id.trim().to_string();
    if profile_id.is_empty() {
        return Err(Error::PackageManager("profile_id is required".to_string()));
    }

    let core_db_path = profile_db_path(&app, &profile_id)?;
    let analysis_db_path = analysis_db_path(&app)?;

    let engine_path = resolve_engine_path(&req.engine_path, &app);
    let engine = PlannerEngine::new(engine_path, req.uci_options);

    info!(
        "planner_build_variant_book: profile_id={} target_player_id={} our_color={:?} time_control={} our_elo={} start_fen={} opts={{horizon_plies={} opponent_top_k={} min_branch_prob={} max_nodes={} our_multipv={} quick={:?} candidate={:?} backoff_k={} smoothing_alpha={}}}",
        profile_id,
        req.ctx.target_player_id,
        req.ctx.our_color,
        req.ctx.time_control,
        req.ctx.our_elo,
        req.ctx.start_fen,
        req.opts.horizon_plies,
        req.opts.opponent_top_k,
        req.opts.min_branch_prob,
        req.opts.max_nodes,
        req.opts.our_multipv,
        req.opts.quick_eval_limits,
        req.opts.candidate_limits,
        req.opts.backoff_k,
        req.opts.smoothing_alpha,
    );

    let mut planner = PlayerMatchPlanner::new(core_db_path, analysis_db_path, engine, profile_id)?;
    planner.build_book(req.ctx, req.opts).await
}

#[tauri::command]
#[specta::specta]
pub async fn planner_build_variant_pgn(
    app: AppHandle,
    _state: State<'_, AppState>,
    req: PlannerBuildPgnRequest,
) -> Result<PlannerBuildPgnResponse> {
    let profile_id = req.profile_id.trim().to_string();
    if profile_id.is_empty() {
        return Err(Error::PackageManager("profile_id is required".to_string()));
    }

    let core_db_path = profile_db_path(&app, &profile_id)?;
    let analysis_db_path = analysis_db_path(&app)?;

    let engine_path = resolve_engine_path(&req.engine_path, &app);
    let engine = PlannerEngine::new(engine_path, req.uci_options);

    let mut planner = PlayerMatchPlanner::new(core_db_path, analysis_db_path, engine, profile_id)?;
    let target_name = planner.lookup_player_name(req.ctx.target_player_id).unwrap_or_else(|| {
        format!("Opponent({})", req.ctx.target_player_id)
    });

    info!(
        "planner_build_variant_pgn: target_player_id={} target_name={} start_fen={} horizon_plies={}",
        req.ctx.target_player_id,
        target_name,
        req.ctx.start_fen,
        req.opts.horizon_plies
    );

    let book = planner.build_book(req.ctx.clone(), req.opts.clone()).await?;
    let pgn = variant_book_to_pgn(&book, &req.ctx, &target_name, req.opts.horizon_plies)?;
    Ok(PlannerBuildPgnResponse { pgn })
}

// -----------------------------
// Planner internals
// -----------------------------

fn hash_u64<T: Hash>(v: &T) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    v.hash(&mut h);
    h.finish()
}

/// Core DB row we need from Games table.
#[derive(Debug, Clone)]
struct GameRow {
    id: i64,
    date: Option<String>,
    utc_time: Option<String>,
    white_id: i64,
    black_id: i64,
    white_elo: Option<i32>,
    black_elo: Option<i32>,
    time_control: Option<String>,
    start_fen: Option<String>,
    moves_blob: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct ContextKey {
    time_control_bucket: u8,
    opponent_elo_bucket: i16,
    weekday: u8,
    hour_bucket: u8,
    target_color: u8,
    ply_bucket: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct PolicyKey {
    state_hash: u64,
    ctx: ContextKey,
}

#[derive(Debug, Default, Clone)]
struct MoveCounter {
    total: u32,
    counts: HashMap<String, u32>, // UCI -> count
}

#[derive(Debug, Default)]
struct PolicyModel {
    exact: HashMap<PolicyKey, MoveCounter>,
    backoff: HashMap<PolicyKey, MoveCounter>,
    /// Context-agnostic exact counts keyed by exact state hash.
    exact_global: HashMap<u64, MoveCounter>,
    /// Context-agnostic backoff counts keyed by abstract state hash.
    backoff_global: HashMap<u64, MoveCounter>,
}

/// Lightweight UCI runner used by the planner.
/// This version spawns a process per query; we add caches to reduce pressure.
struct PlannerEngine {
    path: PathBuf,
    uci_options: Vec<EngineOption>,
}

impl PlannerEngine {
    fn new(path: PathBuf, uci_options: Vec<EngineOption>) -> Self {
        Self { path, uci_options }
    }

    async fn multipv(&mut self, fen: &str, limits: EngineLimits, multipv: usize) -> Result<Vec<EngineLine>> {
        let go = to_go_mode(limits);

        let mut extra = self.uci_options.clone();
        upsert_uci_option(&mut extra, "MultiPV", &multipv.to_string());
        // Planner loops a lot; single-thread is safer to avoid thrashing.
        upsert_uci_option(&mut extra, "Threads", "1");

        let options = EngineOptions {
            fen: fen.to_string(),
            moves: vec![],
            extra_options: extra,
        };

        let (mut proc, mut reader) = EngineProcess::new(self.path.clone()).await?;
        proc.set_options(options.clone()).await?;
        proc.go(&go).await?;

        let mut last_best: Vec<crate::chess::types::BestMoves> = Vec::new();

        while let Ok(Some(line)) = reader.next_line().await {
            match vampirc_uci::parse_one(&line) {
                vampirc_uci::UciMessage::Info(attrs) => {
                    if let Ok(best_moves) = parse_uci_attrs(attrs, &options.fen.parse()?, &options.moves) {
                        let multipv_idx = best_moves.multipv;
                        let cur_depth = best_moves.depth;

                        if multipv_idx as usize == proc.best_moves.len() + 1 {
                            proc.best_moves.push(best_moves);

                            if multipv_idx == proc.real_multipv {
                                if proc.best_moves.iter().all(|x| x.depth == cur_depth) && cur_depth >= proc.last_depth {
                                    last_best = proc.best_moves.clone();
                                    proc.last_depth = cur_depth;
                                }
                                proc.best_moves.clear();
                            }
                        }
                    }
                }
                vampirc_uci::UciMessage::BestMove { .. } => break,
                _ => {}
            }
        }

        let mut out: Vec<EngineLine> = Vec::new();
        for bm in last_best {
            let score_cp = score_to_cp(&bm.score.value);
            let pv_uci = bm.uci_moves.clone();
            let bestmove_uci = pv_uci.first().cloned().unwrap_or_default();
            if bestmove_uci.is_empty() {
                continue;
            }
            out.push(EngineLine {
                bestmove_uci,
                score_cp,
                pv_uci,
            });
        }

        Ok(out)
    }

    async fn eval_cp(&mut self, fen: &str, limits: EngineLimits) -> Result<i32> {
        let lines = self.multipv(fen, limits, 1).await?;
        Ok(lines.first().map(|l| l.score_cp).unwrap_or(0))
    }
}

struct PlayerMatchPlanner {
    core_db: Connection,
    analysis_db: Option<Connection>,
    engine: PlannerEngine,
    profile_id: String,

    models: HashMap<i64, PolicyModel>,
    eval_cache: HashMap<u64, i32>,
    multipv_cache: HashMap<(u64, u32, u32, usize), Vec<EngineLine>>,
    policy_cache: HashMap<(i64, u64, ContextKey), OpponentPolicy>,
}

impl PlayerMatchPlanner {
    fn new(
        core_db_path: PathBuf,
        analysis_db_path: PathBuf,
        engine: PlannerEngine,
        profile_id: String,
    ) -> Result<Self> {
        let core_db = Connection::open(core_db_path)?;
        let analysis_db = if analysis_db_path.exists() {
            match Connection::open_with_flags(analysis_db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
                Ok(c) => Some(c),
                Err(_) => None,
            }
        } else {
            None
        };
        Ok(Self {
            core_db,
            analysis_db,
            engine,
            profile_id,
            models: HashMap::new(),
            eval_cache: HashMap::new(),
            multipv_cache: HashMap::new(),
            policy_cache: HashMap::new(),
        })
    }

    pub async fn build_book(&mut self, ctx: MatchContext, opts: PlanOptions) -> Result<VariantBook> {
        opts.validate()?;

        let target_name = self
            .lookup_player_name(ctx.target_player_id)
            .unwrap_or_else(|| format!("Opponent({})", ctx.target_player_id));
        info!(
            "PlayerMatchPlanner.build_book: profile_id={} target_player_id={} target_name={}",
            self.profile_id, ctx.target_player_id, target_name
        );

        self.ensure_model_trained(ctx.target_player_id)?;

        // If we start from a mid-game FEN, we must keep the ply buckets aligned with training,
        // which uses the ply index from the game start. We derive a base ply from the FEN's fullmove+turn.
        let base_ply_from_start = if ctx.start_fen.trim().eq_ignore_ascii_case("startpos") {
            0usize
        } else {
            ply_index_from_fen(&ctx.start_fen).unwrap_or(0)
        };
        info!(
            "PlayerMatchPlanner.build_book: start_fen_ply_base={} (start_fen={})",
            base_ply_from_start, ctx.start_fen
        );

        let start_pos = chess_from_fen_or_start(&ctx.start_fen)?;
        let root_fen_full = normalize_fen(&start_pos)?;
        let root_key = state_key_from_fen(&root_fen_full);
        let root_node_id = hash_u64(&root_key);

        let opponent_color = ctx.our_color.opposite();

        let dt = utc_ms_to_naive(ctx.match_start_utc_ms);
        let match_weekday = dt.date().weekday();
        let match_hour = dt.time().hour() as u8;

        let time_control_bucket = bucket_time_control(&ctx.time_control);
        let opponent_elo_bucket = bucket_elo(ctx.our_elo);

        let root_side_to_move = if start_pos.turn() == shakmaty::Color::White {
            PlayerColor::White
        } else {
            PlayerColor::Black
        };

        let mut nodes: Vec<BookNode> = Vec::new();
        let mut edges: Vec<BookEdge> = Vec::new();
        let mut node_index: HashMap<u64, usize> = HashMap::new();

        node_index.insert(root_node_id, 0);
        nodes.push(BookNode {
            id: root_node_id,
            fen: root_fen_full.clone(),
            ply_from_root: 0,
            side_to_move: root_side_to_move,
            reach_prob: 1.0,
        });

        let mut q: VecDeque<u64> = VecDeque::new();
        q.push_back(root_node_id);

        #[derive(Default)]
        struct BuildStats {
            popped: usize,
            expanded_our: usize,
            expanded_opp: usize,
            pruned_horizon: usize,
            pruned_reach: usize,
            node_cap_hits: usize,
        }
        let mut stats = BuildStats::default();

        while let Some(nid) = q.pop_front() {
            stats.popped += 1;
            if nodes.len() >= opts.max_nodes {
                stats.node_cap_hits += 1;
                break;
            }

            let nidx = *node_index.get(&nid).unwrap();
            let node = nodes[nidx].clone();

            if node.ply_from_root >= opts.horizon_plies {
                stats.pruned_horizon += 1;
                continue;
            }
            if node.reach_prob < opts.min_branch_prob {
                stats.pruned_reach += 1;
                continue;
            }

            let pos = chess_from_fen_or_start(&node.fen)?;
            let side = node.side_to_move;

            let ply_from_start = base_ply_from_start.saturating_add(node.ply_from_root);

            let ctx_key = ContextKey {
                time_control_bucket,
                opponent_elo_bucket,
                weekday: weekday_to_u8(match_weekday),
                hour_bucket: bucket_hour(match_hour),
                target_color: color_to_u8(opponent_color),
                ply_bucket: bucket_ply(ply_from_start),
            };

            if side == ctx.our_color {
                stats.expanded_our += 1;
                let our_edges = self
                    .expand_our_turn(ctx.target_player_id, &pos, ctx.our_color, ctx_key, ply_from_start, &opts)
                    .await?;

                for e in our_edges {
                    if !node_index.contains_key(&e.to) {
                        let to_fen = apply_uci_and_fen(&pos, &e.uci)?;
                        let to_pos = chess_from_fen_or_start(&to_fen)?;
                        let to_side = if to_pos.turn() == shakmaty::Color::White {
                            PlayerColor::White
                        } else {
                            PlayerColor::Black
                        };

                        node_index.insert(e.to, nodes.len());
                        nodes.push(BookNode {
                            id: e.to,
                            fen: to_fen,
                            ply_from_root: node.ply_from_root + 1,
                            side_to_move: to_side,
                            reach_prob: node.reach_prob,
                        });
                        q.push_back(e.to);
                    }
                    edges.push(e);
                }
            } else {
                stats.expanded_opp += 1;
                let opp_edges = self
                    .expand_opponent_turn(ctx.target_player_id, &pos, ctx_key, ply_from_start, &opts, node.reach_prob)
                    .await?;

                for e in opp_edges {
                    let reach = node.reach_prob * e.prob;
                    if reach < opts.min_branch_prob {
                        continue;
                    }

                    if !node_index.contains_key(&e.to) {
                        let to_fen = apply_uci_and_fen(&pos, &e.uci)?;
                        let to_pos = chess_from_fen_or_start(&to_fen)?;
                        let to_side = if to_pos.turn() == shakmaty::Color::White {
                            PlayerColor::White
                        } else {
                            PlayerColor::Black
                        };

                        node_index.insert(e.to, nodes.len());
                        nodes.push(BookNode {
                            id: e.to,
                            fen: to_fen,
                            ply_from_root: node.ply_from_root + 1,
                            side_to_move: to_side,
                            reach_prob: reach,
                        });
                        q.push_back(e.to);
                    }
                    edges.push(e);
                }
            }
        }

        info!(
            "PlayerMatchPlanner.build_book.done: nodes={} edges={} popped={} expanded_our={} expanded_opp={} pruned_horizon={} pruned_reach={} node_cap_hits={}",
            nodes.len(),
            edges.len(),
            stats.popped,
            stats.expanded_our,
            stats.expanded_opp,
            stats.pruned_horizon,
            stats.pruned_reach,
            stats.node_cap_hits
        );

        Ok(VariantBook {
            root_node_id,
            nodes,
            edges,
        })
    }

    fn ensure_model_trained(&mut self, target_player_id: i64) -> Result<()> {
        if self.models.contains_key(&target_player_id) {
            debug!("ensure_model_trained: cache hit target_player_id={}", target_player_id);
            return Ok(());
        }
        let profile_id = self.profile_id.clone();
        let name = self.lookup_player_name(target_player_id).unwrap_or_else(|| "?".to_string());
        info!(
            "ensure_model_trained: training target_player_id={} name={} profile_id={}",
            target_player_id, name, profile_id
        );
        let model = self.train_model_for_player_scoped(&profile_id, target_player_id)?;
        info!(
            "ensure_model_trained.done: target_player_id={} exact_states={} backoff_states={} exact_global_states={} backoff_global_states={}",
            target_player_id,
            model.exact.len(),
            model.backoff.len(),
            model.exact_global.len(),
            model.backoff_global.len(),
        );
        self.models.insert(target_player_id, model);
        Ok(())
    }

    fn lookup_player_name(&self, player_id: i64) -> Option<String> {
        self.core_db
            .query_row(
                "SELECT Name FROM Players WHERE ID = ?1",
                params![player_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    fn train_model_for_player_scoped(&mut self, profile_id: &str, target_player_id: i64) -> Result<PolicyModel> {
        let mut model = PolicyModel::default();

        let target_name = self
            .lookup_player_name(target_player_id)
            .unwrap_or_else(|| format!("Opponent({})", target_player_id));
        info!(
            "train_model_for_player_scoped.start: profile_id={} target_player_id={} target_name={}",
            profile_id, target_player_id, target_name
        );

        #[derive(Default)]
        struct TrainStats {
            games_total: u64,
            games_with_moves_blob: u64,
            games_decoded_blob_pgn: u64,
            games_decoded_blob_soup: u64,
            games_fallback_analysis_pgn: u64,
            games_skipped_no_moves: u64,
            plies_total: u64,
            plies_for_target: u64,
        }
        let mut stats = TrainStats::default();

        let mut stmt = self.core_db.prepare(
            r#"
            SELECT
                ID, Date, UTCTime, WhiteID, BlackID, WhiteElo, BlackElo, TimeControl, FEN, Moves
            FROM Games
            WHERE WhiteID = ?1 OR BlackID = ?1
            "#,
        )?;

        let rows = stmt.query_map(params![target_player_id], |r| {
            Ok(GameRow {
                id: r.get(0)?,
                date: r.get(1)?,
                utc_time: r.get(2)?,
                white_id: r.get(3)?,
                black_id: r.get(4)?,
                white_elo: r.get(5)?,
                black_elo: r.get(6)?,
                time_control: r.get(7)?,
                start_fen: r.get(8)?,
                moves_blob: r.get(9)?,
            })
        })?;

        for row_res in rows {
            let row = row_res?;
            stats.games_total += 1;
            if row.moves_blob.as_deref().is_some_and(|b| !b.is_empty()) {
                stats.games_with_moves_blob += 1;
            }

            let target_color = if row.white_id == target_player_id {
                PlayerColor::White
            } else if row.black_id == target_player_id {
                PlayerColor::Black
            } else {
                continue;
            };

            let opp_elo = if target_color == PlayerColor::White {
                row.black_elo.unwrap_or(0)
            } else {
                row.white_elo.unwrap_or(0)
            };

            let time_control_str = row.time_control.clone().unwrap_or_else(|| "unknown".to_string());

            let dt = parse_game_datetime_utc(row.date.as_deref(), row.utc_time.as_deref());
            let weekday = weekday_to_u8(dt.date().weekday());
            let hour_bucket = bucket_hour(dt.time().hour() as u8);

            let start_fen = row.start_fen.clone().unwrap_or_else(|| "startpos".to_string());
            let mut pos = chess_from_fen_or_start(&start_fen)?;

            // PRIMARY move source: Games.Moves BLOB from profile DB.
            // We attempt to extract UCI/SAN tokens from a mixed binary/text encoding.
            let (mut uci_seq, mut source) = decode_moves_blob_to_uci_sequence(row.moves_blob.as_deref(), &pos);

            // Optional fallback: analyzed PGN if BLOB extraction yields nothing.
            if uci_seq.is_empty() {
                if let Some(pgn_text) = self.load_analyzed_pgn_best_effort(profile_id, row.id)? {
                    if let Ok(tokens) = parse_pgn_san_tokens(&pgn_text) {
                        if let Ok(v) = pgn_tokens_to_uci_sequence(&pos, &tokens) {
                            uci_seq = v;
                            source = MovesSource::AnalysisPgn;
                        }
                    }
                }
            }

            if uci_seq.is_empty() {
                stats.games_skipped_no_moves += 1;
                continue;
            }

            match source {
                MovesSource::BlobPgn => stats.games_decoded_blob_pgn += 1,
                MovesSource::BlobSoup => stats.games_decoded_blob_soup += 1,
                MovesSource::AnalysisPgn => stats.games_fallback_analysis_pgn += 1,
                MovesSource::None => {}
            }

            for (ply, uci_str) in uci_seq.into_iter().enumerate() {
                stats.plies_total += 1;
                let side_to_move = if pos.turn() == shakmaty::Color::White {
                    PlayerColor::White
                } else {
                    PlayerColor::Black
                };

                let mv = match uci_to_move(&pos, &uci_str) {
                    Ok(m) => m,
                    Err(_) => break,
                };

                let uci_norm = mv.to_uci(CastlingMode::Standard).to_string();

                if side_to_move == target_color {
                    stats.plies_for_target += 1;
                    let ctx_key = ContextKey {
                        time_control_bucket: bucket_time_control(&time_control_str),
                        opponent_elo_bucket: bucket_elo(opp_elo),
                        weekday,
                        hour_bucket,
                        target_color: color_to_u8(target_color),
                        ply_bucket: bucket_ply(ply),
                    };

                    let exact_state_hash = pos_state_hash(&pos)?;
                    let backoff_state_hash = hash_u64(&abstract_state_signature(&pos, ply));

                    let pk_exact = PolicyKey {
                        state_hash: exact_state_hash,
                        ctx: ctx_key,
                    };
                    let pk_backoff = PolicyKey {
                        state_hash: backoff_state_hash,
                        ctx: ctx_key,
                    };

                    bump_counter(model.exact.entry(pk_exact).or_default(), &uci_norm);
                    bump_counter(model.backoff.entry(pk_backoff).or_default(), &uci_norm);
                    bump_counter(model.exact_global.entry(exact_state_hash).or_default(), &uci_norm);
                    bump_counter(model.backoff_global.entry(backoff_state_hash).or_default(), &uci_norm);
                }

                // Training is best-effort: skip any game that becomes inconsistent.
                pos = match pos.play(&mv) {
                    Ok(p) => p,
                    Err(_) => break,
                };
            }
        }

        info!(
            "train_model_for_player_scoped.done: games_total={} games_with_moves_blob={} decoded_blob_pgn={} decoded_blob_soup={} fallback_analysis_pgn={} skipped_no_moves={} plies_total={} plies_for_target={} exact_states={} backoff_states={}",
            stats.games_total,
            stats.games_with_moves_blob,
            stats.games_decoded_blob_pgn,
            stats.games_decoded_blob_soup,
            stats.games_fallback_analysis_pgn,
            stats.games_skipped_no_moves,
            stats.plies_total,
            stats.plies_for_target,
            model.exact.len(),
            model.backoff.len(),
        );

        Ok(model)
    }

    fn load_analyzed_pgn_best_effort(&self, profile_id: &str, game_id: i64) -> Result<Option<String>> {
        let Some(db) = self.analysis_db.as_ref() else {
            return Ok(None);
        };

        // Some installs may have (profile_id, game_id), others only (game_id).
        // Try the profile_id query first; on error, fallback to game_id-only.
        let q1 = db.query_row(
            r#"
            SELECT analyzed_pgn
            FROM game_analysis
            WHERE profile_id = ?1 AND game_id = ?2 AND analyzed_pgn IS NOT NULL
            "#,
            params![profile_id, game_id.to_string()],
            |r| r.get::<_, String>(0),
        ).optional();

        match q1 {
            Ok(v) => Ok(v),
            Err(_) => {
                let q2 = db
                    .query_row(
                    r#"
                    SELECT analyzed_pgn
                    FROM game_analysis
                    WHERE game_id = ?1 AND analyzed_pgn IS NOT NULL
                    "#,
                    params![game_id.to_string()],
                    |r| r.get::<_, String>(0),
                )
                    .optional();
                match q2 {
                    Ok(v) => Ok(v),
                    Err(_) => Ok(None),
                }
            }
        }
    }

    async fn expand_opponent_turn(
        &mut self,
        target_player_id: i64,
        pos: &Chess,
        ctx_key: ContextKey,
        ply_from_start: usize,
        opts: &PlanOptions,
        parent_reach_prob: f64,
    ) -> Result<Vec<BookEdge>> {
        let fen_full = normalize_fen(pos)?;
        let from_id = hash_u64(&state_key_from_fen(&fen_full));

        let exact_state_hash = pos_state_hash(pos)?;
        let policy = self.get_opponent_policy(target_player_id, pos, exact_state_hash, ctx_key, ply_from_start, opts)?;

        if policy.used_uniform && ply_from_start <= 12 {
            warn!(
                "expand_opponent_turn: UNIFORM policy (no data) target_player_id={} ply={} exact_total={} backoff_total={} lambda={:.3}",
                target_player_id, ply_from_start, policy.exact_total, policy.backoff_total, policy.lambda
            );
        } else if parent_reach_prob >= 0.999 && ply_from_start <= 12 {
            info!(
                "expand_opponent_turn: target_player_id={} ply={} exact_total={} backoff_total={} lambda={:.3}",
                target_player_id, ply_from_start, policy.exact_total, policy.backoff_total, policy.lambda
            );
            let top_dbg: Vec<String> = policy
                .moves
                .iter()
                .take(5)
                .map(|(uci, p, c)| format!("{uci} p={:.3} c={c}", p))
                .collect();
            info!("expand_opponent_turn.top: {}", top_dbg.join(" | "));
        }

        let mut top: Vec<(String, f64, u32)> = policy.moves.into_iter().take(opts.opponent_top_k).collect();

        let mut edges = Vec::new();
        for (uci, raw_p, _count) in top.drain(..) {
            let to_fen = apply_uci_and_fen(pos, &uci)?;
            let to_id = hash_u64(&state_key_from_fen(&to_fen));
            // Keep `raw_p` as the actual model probability (do NOT renormalize within topK),
            // otherwise `min_branch_prob` becomes misleading and can admit low-probability moves.
            let prob = raw_p;
            let reach = parent_reach_prob * raw_p;
            if reach < opts.min_branch_prob {
                continue;
            }

            edges.push(BookEdge {
                from: from_id,
                to: to_id,
                uci,
                prob,
                kind: EdgeKind::OpponentMove,
                ev_cp_from_our_perspective: None,
                predicted_prob: Some(raw_p),
            });
        }

        Ok(edges)
    }

    async fn expand_our_turn(
        &mut self,
        target_player_id: i64,
        pos: &Chess,
        our_color: PlayerColor,
        ctx_key: ContextKey,
        ply_from_start: usize,
        opts: &PlanOptions,
    ) -> Result<Vec<BookEdge>> {
        let fen_full = normalize_fen(pos)?;
        let from_id = hash_u64(&state_key_from_fen(&fen_full));

        let lines = self.cached_multipv(&fen_full, opts.candidate_limits, opts.our_multipv).await?;

        let mut scored: Vec<(String, f64)> = Vec::new();
        for line in lines {
            let our_uci = line.bestmove_uci.clone();
            let pos_after_our = apply_uci_and_pos(pos, &our_uci)?;

            let exact_hash_after_our = pos_state_hash(&pos_after_our)?;

            // Reply context at ply+1 (critical for backoff correctness).
            let mut reply_ctx = ctx_key;
            reply_ctx.ply_bucket = bucket_ply(ply_from_start + 1);

            let opponent_policy = self.get_opponent_policy(
                target_player_id,
                &pos_after_our,
                exact_hash_after_our,
                reply_ctx,
                ply_from_start + 1,
                opts,
            )?;

            if opponent_policy.used_uniform && ply_from_start <= 11 {
                warn!(
                    "expand_our_turn: UNIFORM policy for opponent replies target_player_id={} ply={} our_uci={} exact_total={} backoff_total={} lambda={:.3}",
                    target_player_id,
                    ply_from_start + 1,
                    our_uci,
                    opponent_policy.exact_total,
                    opponent_policy.backoff_total,
                    opponent_policy.lambda
                );
            }

            let mut ev_white: f64 = 0.0;
            let mut mass: f64 = 0.0;

            for (opp_uci, p, _count) in opponent_policy.moves.into_iter().take(opts.opponent_top_k) {
                let pos_after_reply = apply_uci_and_pos(&pos_after_our, &opp_uci)?;
                let fen_after_reply = normalize_fen(&pos_after_reply)?;
                let score_cp_white = self.cached_eval_cp(&fen_after_reply, opts.quick_eval_limits).await? as f64;
                ev_white += p * score_cp_white;
                mass += p;
            }

            if mass > 0.0 && mass < 0.999 {
                ev_white /= mass;
            }

            let ev_our = score_from_our_perspective(ev_white, our_color);
            scored.push((our_uci, ev_our));
        }

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let mut edges = Vec::new();
        if let Some((best_uci, best_ev)) = scored.into_iter().next() {
            let to_fen = apply_uci_and_fen(pos, &best_uci)?;
            let to_id = hash_u64(&state_key_from_fen(&to_fen));

            edges.push(BookEdge {
                from: from_id,
                to: to_id,
                uci: best_uci,
                prob: 1.0,
                kind: EdgeKind::OurMove,
                ev_cp_from_our_perspective: Some(best_ev),
                predicted_prob: None,
            });
        }

        Ok(edges)
    }

    async fn cached_eval_cp(&mut self, fen: &str, limits: EngineLimits) -> Result<i32> {
        let key = hash_u64(&state_key_from_fen(fen));
        if let Some(v) = self.eval_cache.get(&key) {
            return Ok(*v);
        }
        let s = self.engine.eval_cp(fen, limits).await?;
        self.eval_cache.insert(key, s);
        Ok(s)
    }

    async fn cached_multipv(&mut self, fen: &str, limits: EngineLimits, multipv: usize) -> Result<Vec<EngineLine>> {
        let fen_key = hash_u64(&state_key_from_fen(fen));
        let d = limits.depth.unwrap_or(0);
        let t = limits.time_ms.unwrap_or(0);
        let cache_key = (fen_key, d, t, multipv);

        if let Some(v) = self.multipv_cache.get(&cache_key) {
            return Ok(v.clone());
        }

        let lines = self.engine.multipv(fen, limits, multipv).await?;
        self.multipv_cache.insert(cache_key, lines.clone());
        Ok(lines)
    }

    fn get_opponent_policy(
        &mut self,
        target_player_id: i64,
        pos: &Chess,
        exact_state_hash: u64,
        ctx_key: ContextKey,
        ply_from_start: usize,
        opts: &PlanOptions,
    ) -> Result<OpponentPolicy> {
        let cache_key = (target_player_id, exact_state_hash, ctx_key);
        if let Some(v) = self.policy_cache.get(&cache_key) {
            return Ok(v.clone());
        }

        let model = self
            .models
            .get(&target_player_id)
            .ok_or_else(|| Error::PackageManager("Model not trained".to_string()))?;

        let backoff_hash = hash_u64(&abstract_state_signature(pos, ply_from_start));

        let pk_exact = PolicyKey { state_hash: exact_state_hash, ctx: ctx_key };
        let pk_backoff = PolicyKey { state_hash: backoff_hash, ctx: ctx_key };

        let exact_counter_ctx = model.exact.get(&pk_exact);
        let backoff_counter_ctx = model.backoff.get(&pk_backoff);
        let exact_counter_global = model.exact_global.get(&exact_state_hash);
        let backoff_counter_global = model.backoff_global.get(&backoff_hash);

        let exact_total_ctx = exact_counter_ctx.map(|c| c.total).unwrap_or(0);
        let backoff_total_ctx = backoff_counter_ctx.map(|c| c.total).unwrap_or(0);
        let exact_total_global = exact_counter_global.map(|c| c.total).unwrap_or(0);
        let backoff_total_global = backoff_counter_global.map(|c| c.total).unwrap_or(0);

        let legal_uci = legal_moves_uci(pos);

        let p_exact_ctx = probs_from_counter(exact_counter_ctx, &legal_uci, opts.smoothing_alpha);
        let p_backoff_ctx = probs_from_counter(backoff_counter_ctx, &legal_uci, opts.smoothing_alpha);
        let p_exact_global = probs_from_counter(exact_counter_global, &legal_uci, opts.smoothing_alpha);
        let p_backoff_global = probs_from_counter(backoff_counter_global, &legal_uci, opts.smoothing_alpha);

        // Context key includes several buckets (time, elo, weekday/hour, ply). That can fragment the data too much.
        // We therefore blend context-specific counts with context-agnostic counts, preferring context only when it is well-sampled.
        const CTX_BLEND_K: f64 = 200.0;
        let w_exact_ctx = if exact_total_global == 0 {
            1.0
        } else {
            (exact_total_ctx as f64) / (exact_total_ctx as f64 + CTX_BLEND_K)
        };
        let w_backoff_ctx = if backoff_total_global == 0 {
            1.0
        } else {
            (backoff_total_ctx as f64) / (backoff_total_ctx as f64 + CTX_BLEND_K)
        };

        let mut p_exact: HashMap<String, f64> = HashMap::new();
        let mut p_backoff: HashMap<String, f64> = HashMap::new();
        for uci in &legal_uci {
            let pe = w_exact_ctx * p_exact_ctx.get(uci).copied().unwrap_or(0.0)
                + (1.0 - w_exact_ctx) * p_exact_global.get(uci).copied().unwrap_or(0.0);
            let pb = w_backoff_ctx * p_backoff_ctx.get(uci).copied().unwrap_or(0.0)
                + (1.0 - w_backoff_ctx) * p_backoff_global.get(uci).copied().unwrap_or(0.0);
            p_exact.insert(uci.clone(), pe);
            p_backoff.insert(uci.clone(), pb);
        }

        let effective_exact_n = w_exact_ctx * (exact_total_ctx as f64) + (1.0 - w_exact_ctx) * (exact_total_global as f64);
        let lambda = effective_exact_n / (effective_exact_n + opts.backoff_k.max(1.0));

        let mut mixed: Vec<(String, f64)> = Vec::with_capacity(legal_uci.len());
        for uci in &legal_uci {
            let pe = *p_exact.get(uci).unwrap_or(&0.0);
            let pb = *p_backoff.get(uci).unwrap_or(&0.0);
            mixed.push((uci.clone(), lambda * pe + (1.0 - lambda) * pb));
        }

        let z: f64 = mixed.iter().map(|(_, p)| p).sum();
        let mut used_uniform = (exact_total_ctx == 0 && exact_total_global == 0) && (backoff_total_ctx == 0 && backoff_total_global == 0);
        if z > 0.0 {
            for (_, p) in mixed.iter_mut() {
                *p /= z;
            }
        } else if !mixed.is_empty() {
            let uniform_p = 1.0 / mixed.len() as f64;
            for (_, p) in mixed.iter_mut() {
                *p = uniform_p;
            }
            used_uniform = true;
        }

        mixed.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let mut with_counts: Vec<(String, f64, u32)> = Vec::new();
        for (uci, p) in mixed {
            let c = exact_counter_global
                .and_then(|ec| ec.counts.get(&uci).copied())
                .or_else(|| exact_counter_ctx.and_then(|ec| ec.counts.get(&uci).copied()))
                .unwrap_or(0);
            with_counts.push((uci, p, c));
        }

        let policy = OpponentPolicy {
            moves: with_counts,
            exact_total: exact_total_global,
            backoff_total: backoff_total_global,
            lambda,
            used_uniform,
        };

        // Keep log visibility at the root-ish area where debugging is most valuable.
        if ply_from_start <= 12 {
            debug!(
                "get_opponent_policy: ply={} legal_moves={} exact_total(ctx/global)={}/{} backoff_total(ctx/global)={}/{} lambda={:.3} used_uniform={} ctx={:?}",
                ply_from_start,
                legal_uci.len(),
                exact_total_ctx,
                exact_total_global,
                backoff_total_ctx,
                backoff_total_global,
                lambda,
                used_uniform,
                ctx_key
            );
        }

        self.policy_cache.insert(cache_key, policy.clone());
        Ok(policy)
    }
}

#[derive(Debug, Clone)]
struct OpponentPolicy {
    moves: Vec<(String, f64, u32)>,
    exact_total: u32,
    backoff_total: u32,
    lambda: f64,
    used_uniform: bool,
}

// -----------------------------
// Helpers: engine + scoring
// -----------------------------

fn score_to_cp(v: &ScoreValue) -> i32 {
    match *v {
        ScoreValue::Cp(x) => x,
        ScoreValue::Mate(m) => {
            if m >= 0 { 100_000 } else { -100_000 }
        }
    }
}

fn to_go_mode(limits: EngineLimits) -> GoMode {
    if let Some(d) = limits.depth {
        return GoMode::Depth(d);
    }
    if let Some(ms) = limits.time_ms {
        return GoMode::Time(ms);
    }
    GoMode::Depth(12)
}

fn upsert_uci_option(opts: &mut Vec<EngineOption>, name: &str, value: &str) {
    if let Some(o) = opts.iter_mut().find(|o| o.name.eq_ignore_ascii_case(name)) {
        o.value = value.to_string();
    } else {
        opts.push(EngineOption {
            name: name.to_string(),
            value: value.to_string(),
        });
    }
}

fn score_from_our_perspective(score_cp_white: f64, our_color: PlayerColor) -> f64 {
    match our_color {
        PlayerColor::White => score_cp_white,
        PlayerColor::Black => -score_cp_white,
    }
}

// -----------------------------
// Helpers: PGN output
// -----------------------------

fn variant_book_to_pgn(book: &VariantBook, ctx: &MatchContext, opponent_name: &str, max_plies: usize) -> Result<String> {
    let start_pos = chess_from_fen_or_start(&ctx.start_fen)?;
    let our_name = "OurSide";
    let (white, black) = match ctx.our_color {
        PlayerColor::White => (our_name, opponent_name),
        PlayerColor::Black => (opponent_name, our_name),
    };

    let dt = utc_ms_to_naive(ctx.match_start_utc_ms);
    let date = format!("{:04}.{:02}.{:02}", dt.year(), dt.month(), dt.day());
    let utc_time = format!("{:02}:{:02}:{:02}", dt.hour(), dt.minute(), dt.second());

    let start_fen_norm = normalize_fen(&start_pos)?;
    let is_startpos = ctx.start_fen.trim().is_empty() || ctx.start_fen.trim().eq_ignore_ascii_case("startpos");

    let mut out = String::new();
    out.push_str("[Event \"OCS Planner Book\"]\n");
    out.push_str("[Site \"Obsidian Chess Studio\"]\n");
    out.push_str(&format!("[Date \"{date}\"]\n"));
    out.push_str(&format!("[UTCTime \"{utc_time}\"]\n"));
    out.push_str(&format!("[TimeControl \"{}\"]\n", ctx.time_control));
    out.push_str(&format!("[White \"{}\"]\n", escape_pgn_tag_value(white)));
    out.push_str(&format!("[Black \"{}\"]\n", escape_pgn_tag_value(black)));
    if !is_startpos {
        out.push_str("[SetUp \"1\"]\n");
        out.push_str(&format!("[FEN \"{}\"]\n", escape_pgn_tag_value(&start_fen_norm)));
    }
    out.push('\n');

    let node_by_id: HashMap<u64, &BookNode> = book.nodes.iter().map(|n| (n.id, n)).collect();
    let mut edges_by_from: HashMap<u64, Vec<&BookEdge>> = HashMap::new();
    for e in &book.edges {
        edges_by_from.entry(e.from).or_default().push(e);
    }

    let mut visited: HashSet<(u64, usize)> = HashSet::new();
    let moves = write_pgn_from_node(
        book.root_node_id,
        &start_pos,
        ctx.our_color,
        &node_by_id,
        &edges_by_from,
        &mut visited,
        0,
        true,
        max_plies,
    )?;

    out.push_str(moves.trim());
    if !moves.trim().is_empty() {
        out.push(' ');
    }
    out.push_str("*\n");
    Ok(out)
}

fn escape_pgn_tag_value(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn write_pgn_from_node(
    node_id: u64,
    pos: &Chess,
    our_color: PlayerColor,
    node_by_id: &HashMap<u64, &BookNode>,
    edges_by_from: &HashMap<u64, Vec<&BookEdge>>,
    visited: &mut HashSet<(u64, usize)>,
    ply: usize,
    at_variation_start: bool,
    max_plies: usize,
) -> Result<String> {
    if ply >= max_plies {
        return Ok(String::new());
    }

    if !visited.insert((node_id, ply)) {
        return Ok(String::new());
    }

    let side_to_move = node_by_id
        .get(&node_id)
        .map(|n| n.side_to_move)
        .unwrap_or_else(|| {
            if pos.turn() == shakmaty::Color::White {
                PlayerColor::White
            } else {
                PlayerColor::Black
            }
        });

    let mut edges = edges_by_from.get(&node_id).cloned().unwrap_or_default();
    if edges.is_empty() {
        visited.remove(&(node_id, ply));
        return Ok(String::new());
    }

    let mut out = String::new();
    match side_to_move == our_color {
        true => {
            edges.retain(|e| matches!(e.kind, EdgeKind::OurMove));
            if let Some(edge) = edges.first() {
                let (token, next_pos) = edge_to_pgn_token(edge, pos, ply, at_variation_start)?;
                out.push_str(&token);
                if let Some(ev) = edge.ev_cp_from_our_perspective {
                    out.push_str(&format!(" {{{}}}", format_ev_cp(ev)));
                }

                if let Some(next_id) = edges_by_from.get(&edge.to).map(|_| edge.to) {
                    let rest = write_pgn_from_node(
                        next_id,
                        &next_pos,
                        our_color,
                        node_by_id,
                        edges_by_from,
                        visited,
                        ply + 1,
                        false,
                        max_plies,
                    )?;
                    if !rest.trim().is_empty() {
                        out.push(' ');
                        out.push_str(rest.trim());
                    }
                }
            }
        }
        false => {
            edges.retain(|e| matches!(e.kind, EdgeKind::OpponentMove));
            edges.sort_by(|a, b| b.prob.partial_cmp(&a.prob).unwrap_or(std::cmp::Ordering::Equal));
            let (main, vars) = edges.split_first().unwrap();

            let (token, next_pos) = edge_to_pgn_token(main, pos, ply, at_variation_start)?;
            out.push_str(&token);
            out.push_str(&format!(" {{{}}}", format_prob(main.prob)));

            for v in vars {
                let var_str = write_variation(v, pos, our_color, node_by_id, edges_by_from, visited, ply, max_plies)?;
                if !var_str.trim().is_empty() {
                    out.push_str(" (");
                    out.push_str(var_str.trim());
                    out.push(')');
                }
            }

            let rest = write_pgn_from_node(
                main.to,
                &next_pos,
                our_color,
                node_by_id,
                edges_by_from,
                visited,
                ply + 1,
                false,
                max_plies,
            )?;
            if !rest.trim().is_empty() {
                out.push(' ');
                out.push_str(rest.trim());
            }
        }
    }

    visited.remove(&(node_id, ply));
    Ok(out)
}

fn write_variation(
    edge: &BookEdge,
    pos: &Chess,
    our_color: PlayerColor,
    node_by_id: &HashMap<u64, &BookNode>,
    edges_by_from: &HashMap<u64, Vec<&BookEdge>>,
    visited: &mut HashSet<(u64, usize)>,
    ply: usize,
    max_plies: usize,
) -> Result<String> {
    let (token, next_pos) = edge_to_pgn_token(edge, pos, ply, true)?;
    let mut out = String::new();
    out.push_str(&token);
    out.push_str(&format!(" {{{}}}", format_prob(edge.prob)));

    let rest = write_pgn_from_node(
        edge.to,
        &next_pos,
        our_color,
        node_by_id,
        edges_by_from,
        visited,
        ply + 1,
        false,
        max_plies,
    )?;
    if !rest.trim().is_empty() {
        out.push(' ');
        out.push_str(rest.trim());
    }
    Ok(out)
}

fn edge_to_pgn_token(edge: &BookEdge, pos: &Chess, ply: usize, at_variation_start: bool) -> Result<(String, Chess)> {
    let mv = uci_to_move(pos, &edge.uci)?;
    let mut next = pos.clone();
    let san = SanPlus::from_move_and_play_unchecked(&mut next, &mv).to_string();

    let move_no = (ply / 2) + 1;
    let side_to_move = if pos.turn() == shakmaty::Color::White {
        PlayerColor::White
    } else {
        PlayerColor::Black
    };

    let token = match side_to_move {
        PlayerColor::White => format!("{move_no}. {san}"),
        PlayerColor::Black => {
            if at_variation_start {
                format!("{move_no}... {san}")
            } else {
                san
            }
        }
    };

    Ok((token, next))
}

fn format_prob(p: f64) -> String {
    if !p.is_finite() {
        return "p=?".to_string();
    }
    format!("p={:.3}", p.max(0.0))
}

fn format_ev_cp(ev: f64) -> String {
    if !ev.is_finite() {
        return "ev=?".to_string();
    }
    if ev >= 0.0 {
        format!("ev=+{:.0}cp", ev)
    } else {
        format!("ev={:.0}cp", ev)
    }
}

// -----------------------------
// Helpers: chess
// -----------------------------

fn chess_from_fen_or_start(fen: &str) -> Result<Chess> {
    if fen.trim().is_empty() || fen.trim().eq_ignore_ascii_case("startpos") {
        return Ok(Chess::default());
    }
    let fen = Fen::from_ascii(fen.trim().as_bytes())?;
    // Standard chess by default.
    let pos = fen.into_position(CastlingMode::Standard)?;
    Ok(pos)
}

fn normalize_fen(pos: &Chess) -> Result<String> {
    let fen = Fen::from_position(pos.clone(), EnPassantMode::Legal);
    Ok(fen.to_string())
}

/// Removes halfmove/fullmove from FEN to avoid state fragmentation.
fn state_key_from_fen(fen_full: &str) -> String {
    let parts: Vec<&str> = fen_full.split_whitespace().collect();
    let a = parts.get(0).copied().unwrap_or("");
    let b = parts.get(1).copied().unwrap_or("");
    let c = parts.get(2).copied().unwrap_or("-");
    let d = parts.get(3).copied().unwrap_or("-");
    format!("{a} {b} {c} {d}")
}

/// Best-effort ply index from a FEN that includes the fullmove number.
///
/// Returns the ply count from the start position:
/// - startpos at move 1, white to move => 0
/// - startpos at move 1, black to move => 1
/// - move N, white to move => (N-1)*2
/// - move N, black to move => (N-1)*2 + 1
fn ply_index_from_fen(fen: &str) -> Option<usize> {
    let parts: Vec<&str> = fen.split_whitespace().collect();
    if parts.len() < 6 {
        return None;
    }
    let turn = parts.get(1)?.trim();
    let fullmove = parts.get(5)?.trim().parse::<usize>().ok()?;
    if fullmove == 0 {
        return Some(0);
    }
    let base = (fullmove - 1).saturating_mul(2);
    let add = if turn.eq_ignore_ascii_case("b") { 1 } else { 0 };
    Some(base + add)
}

fn pos_state_hash(pos: &Chess) -> Result<u64> {
    let fen_full = normalize_fen(pos)?;
    Ok(hash_u64(&state_key_from_fen(&fen_full)))
}

fn san_to_move(pos: &Chess, san: &str) -> Result<shakmaty::Move> {
    let cleaned = sanitize_san(san);
    let sp = SanPlus::from_str(&cleaned)?;
    // shakmaty 0.27: SanPlus has .san, but we keep compatibility.
    Ok(sp.san.to_move(pos)?)
}

#[allow(dead_code)]
fn san_to_uci(pos: &Chess, san: &str) -> Result<String> {
    let mv = san_to_move(pos, san)?;
    Ok(mv.to_uci(CastlingMode::Standard).to_string())
}

fn uci_to_move(pos: &Chess, uci: &str) -> Result<shakmaty::Move> {
    let um = UciMove::from_str(uci)?;
    Ok(um.to_move(pos)?)
}

fn apply_uci_and_pos(pos: &Chess, uci: &str) -> Result<Chess> {
    let mv = uci_to_move(pos, uci)?;
    let mut next = pos.clone();
    next.play_unchecked(&mv);
    Ok(next)
}

fn apply_uci_and_fen(pos: &Chess, uci: &str) -> Result<String> {
    let next = apply_uci_and_pos(pos, uci)?;
    normalize_fen(&next)
}

fn legal_moves_uci(pos: &Chess) -> Vec<String> {
    pos.legal_moves()
        .into_iter()
        .map(|mv| mv.to_uci(CastlingMode::Standard).to_string())
        .collect()
}

fn abstract_state_signature(pos: &Chess, ply: usize) -> String {
    let fen = Fen::from_position(pos.clone(), EnPassantMode::Legal).to_string();
    let parts: Vec<&str> = fen.split_whitespace().collect();
    let placement = parts.get(0).copied().unwrap_or("");
    let turn = parts.get(1).copied().unwrap_or("w");
    let castling = parts.get(2).copied().unwrap_or("-");
    let ep = parts.get(3).copied().unwrap_or("-");

    // Pawn-only placement shape.
    let mut pawn_map = String::with_capacity(64);
    for ch in placement.chars() {
        match ch {
            'P' | 'p' | '/' | '1'..='8' => pawn_map.push(ch),
            _ => pawn_map.push('1'),
        }
    }

    // Piece counts.
    let mut w = [0u8; 6];
    let mut b = [0u8; 6];
    for ch in placement.chars() {
        match ch {
            'P' => w[0] += 1,
            'N' => w[1] += 1,
            'B' => w[2] += 1,
            'R' => w[3] += 1,
            'Q' => w[4] += 1,
            'K' => w[5] += 1,
            'p' => b[0] += 1,
            'n' => b[1] += 1,
            'b' => b[2] += 1,
            'r' => b[3] += 1,
            'q' => b[4] += 1,
            'k' => b[5] += 1,
            _ => {}
        }
    }

    format!(
        "t={turn}|c={castling}|ep={ep}|pawn={pawn_map}|w={:?}|b={:?}|plyb={}",
        w,
        b,
        bucket_ply(ply)
    )
}

// -----------------------------
// Moves decoding (profile DB)

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MovesSource {
    None,
    BlobPgn,
    BlobSoup,
    AnalysisPgn,
}
// -----------------------------

/// Best-effort decoder for `Games.Moves` BLOB.
///
/// Your hex sample shows 0xFC markers (rendered as "ü" by some viewers) and embedded ASCII like "[%clk ...]".
/// We try PGN parsing first; if that fails we do a robust extraction:
/// - Convert BLOB into an ASCII "soup" where non-ASCII bytes become whitespace.
/// - Remove bracket tags like "[%clk ...]".
/// - Extract tokens that look like UCI or SAN and validate them against the current position.
///
/// If your `Moves` is fully binary (no ASCII SAN/UCI present), this will yield empty and you should
/// plug in your real serializer/decoder here.
fn decode_moves_blob_to_uci_sequence(moves_blob: Option<&[u8]>, start_pos: &Chess) -> (Vec<String>, MovesSource) {
    let Some(bytes) = moves_blob else { return (Vec::new(), MovesSource::None); };
    if bytes.is_empty() { return (Vec::new(), MovesSource::None); }

    if let Some(seq) = decode_moves_blob_as_pgn(bytes, start_pos) {
        return (seq, MovesSource::BlobPgn);
    }

    let soup = blob_to_ascii_soup(bytes);
    let seq = extract_uci_from_ascii_soup(&soup, start_pos);
    if seq.is_empty() {
        (seq, MovesSource::None)
    } else {
        (seq, MovesSource::BlobSoup)
    }
}

fn decode_moves_blob_as_pgn(bytes: &[u8], start_pos: &Chess) -> Option<Vec<String>> {
    let mut text = match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => String::from_utf8_lossy(bytes).to_string(),
    };
    if text.as_bytes().contains(&0) {
        text = text.replace('\0', " ");
    }

    let tokens = parse_pgn_san_tokens(&text).ok()?;
    let uci_seq = pgn_tokens_to_uci_sequence(start_pos, &tokens).ok()?;
    if uci_seq.is_empty() { None } else { Some(uci_seq) }
}

/// Keep printable ASCII; treat everything else (including 0xFC) as whitespace separators.
fn blob_to_ascii_soup(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for &b in bytes {
        let ch = match b {
            b'\n' | b'\r' | b'\t' | b' ' => ' ',
            0x21..=0x7E => b as char,
            _ => ' ',
        };
        out.push(ch);
    }
    out
}

/// Extracts UCI moves by walking the position and validating each candidate token.
/// Supports either UCI tokens directly or SAN tokens convertible via shakmaty.
fn extract_uci_from_ascii_soup(s: &str, start_pos: &Chess) -> Vec<String> {
    let mut pos = start_pos.clone();
    let mut out: Vec<String> = Vec::new();

    let mut in_bracket_tag = false;

    for raw in s.split_whitespace() {
        let t = raw.trim();
        if t.is_empty() { continue; }

        // Skip result markers.
        if t == "1-0" || t == "0-1" || t == "1/2-1/2" || t == "*" {
            continue;
        }

        // Skip bracket tags like "[%clk ...]" and PGN headers like "[Event ...]".
        if t.starts_with('[') {
            in_bracket_tag = true;
        }
        if in_bracket_tag {
            if t.ends_with(']') {
                in_bracket_tag = false;
            }
            continue;
        }

        // Skip move numbers.
        if is_move_number_token(t) {
            continue;
        }

        // Clean punctuation for SAN.
        let t = strip_leading_move_number_prefix(t);
        if t.is_empty() {
            continue;
        }
        let cleaned = sanitize_san(t);
        if cleaned.is_empty() { continue; }

        // If it matches UCI shape, try UCI first.
        if looks_like_uci(&cleaned) {
            if let Ok(mv) = uci_to_move(&pos, &cleaned) {
                let u = mv.to_uci(CastlingMode::Standard).to_string();
                pos.play_unchecked(&mv);
                out.push(u);
                continue;
            }
        }

        // Otherwise try SAN.
        if let Ok(mv) = san_to_move(&pos, &cleaned) {
            let u = mv.to_uci(CastlingMode::Standard).to_string();
            pos.play_unchecked(&mv);
            out.push(u);
            continue;
        }
    }

    out
}

fn looks_like_uci(t: &str) -> bool {
    let bytes = t.as_bytes();
    if bytes.len() != 4 && bytes.len() != 5 {
        return false;
    }
    let f1 = bytes[0];
    let r1 = bytes[1];
    let f2 = bytes[2];
    let r2 = bytes[3];

    let file_ok = |b: u8| (b'a'..=b'h').contains(&b);
    let rank_ok = |b: u8| (b'1'..=b'8').contains(&b);

    if !(file_ok(f1) && rank_ok(r1) && file_ok(f2) && rank_ok(r2)) {
        return false;
    }
    if bytes.len() == 5 {
        matches!(bytes[4], b'q' | b'r' | b'b' | b'n')
    } else {
        true
    }
}

fn pgn_tokens_to_uci_sequence(start_pos: &Chess, tokens: &[String]) -> Result<Vec<String>> {
    let mut pos = start_pos.clone();
    let mut out = Vec::with_capacity(tokens.len());

    for t in tokens {
        let cleaned = sanitize_san(t);
        if cleaned.is_empty() {
            continue;
        }

        let mv = if looks_like_uci(&cleaned) {
            uci_to_move(&pos, &cleaned).or_else(|_| san_to_move(&pos, &cleaned))
        } else {
            san_to_move(&pos, &cleaned).or_else(|_| uci_to_move(&pos, &cleaned))
        };
        let Ok(mv) = mv else { break; };

        let uci = mv.to_uci(CastlingMode::Standard).to_string();
        pos.play_unchecked(&mv);
        out.push(uci);
    }

    Ok(out)
}

// -----------------------------
// Helpers: policy
// -----------------------------

fn bump_counter(counter: &mut MoveCounter, uci: &str) {
    counter.total = counter.total.saturating_add(1);
    *counter.counts.entry(uci.to_string()).or_insert(0) += 1;
}

fn probs_from_counter(counter: Option<&MoveCounter>, legal_moves: &[String], alpha: f64) -> HashMap<String, f64> {
    let mut out: HashMap<String, f64> = HashMap::new();
    if legal_moves.is_empty() {
        return out;
    }
    let n_legal = legal_moves.len() as f64;
    let alpha = alpha.max(0.0);

    let (total, counts) = if let Some(c) = counter {
        (c.total as f64, Some(&c.counts))
    } else {
        (0.0, None)
    };

    // If alpha is 0 and there is no data, fall back to uniform probability.
    if total <= 0.0 && alpha <= 0.0 {
        let p = 1.0 / n_legal;
        for uci in legal_moves {
            out.insert(uci.clone(), p);
        }
        return out;
    }

    let denom = total + alpha * n_legal;
    if denom <= 0.0 {
        let p = 1.0 / n_legal;
        for uci in legal_moves {
            out.insert(uci.clone(), p);
        }
        return out;
    }

    for uci in legal_moves {
        let c = counts.and_then(|m| m.get(uci)).copied().unwrap_or(0) as f64;
        let p = (c + alpha) / denom;
        out.insert(uci.clone(), p);
    }
    out
}

// -----------------------------
// Helpers: context
// -----------------------------

fn bucket_time_control(tc: &str) -> u8 {
    let s = tc.trim();
    let base = s
        .split('+')
        .next()
        .and_then(|x| x.parse::<i32>().ok())
        .unwrap_or(-1);

    if base < 0 {
        255
    } else if base <= 180 {
        0
    } else if base <= 600 {
        1
    } else if base <= 1800 {
        2
    } else {
        3
    }
}

fn bucket_elo(elo: i32) -> i16 {
    ((elo / 100).clamp(-30, 60)) as i16
}

fn weekday_to_u8(wd: Weekday) -> u8 {
    match wd {
        Weekday::Mon => 0,
        Weekday::Tue => 1,
        Weekday::Wed => 2,
        Weekday::Thu => 3,
        Weekday::Fri => 4,
        Weekday::Sat => 5,
        Weekday::Sun => 6,
    }
}

fn bucket_hour(h: u8) -> u8 {
    (h / 4).min(5)
}

fn bucket_ply(ply: usize) -> u8 {
    ((ply / 4).min(63)) as u8
}

fn color_to_u8(c: PlayerColor) -> u8 {
    match c {
        PlayerColor::White => 0,
        PlayerColor::Black => 1,
    }
}

// -----------------------------
// Helpers: PGN + datetime
// -----------------------------

fn parse_pgn_san_tokens(pgn: &str) -> Result<Vec<String>> {
    // Drop headers (lines starting with '[') until first blank line.
    let mut body = String::new();
    let mut in_headers = true;
    for line in pgn.lines() {
        let l = line.trim();
        if in_headers {
            if l.starts_with('[') {
                continue;
            }
            if l.is_empty() {
                in_headers = false;
                continue;
            }
            if !l.starts_with('[') {
                in_headers = false;
            }
        }
        if !in_headers {
            body.push_str(line);
            body.push(' ');
        }
    }

    let no_comments = strip_braced_sections(&body);
    let no_vars = strip_parenthesized_sections(&no_comments);

    let mut out = Vec::new();
    for raw in no_vars.split_whitespace() {
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        if t == "1-0" || t == "0-1" || t == "1/2-1/2" || t == "*" {
            continue;
        }
        if t.starts_with('$') && t[1..].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        if t.starts_with("[%") {
            continue;
        }
        if is_move_number_token(t) {
            continue;
        }
        let t = strip_leading_move_number_prefix(t);
        if t.is_empty() {
            continue;
        }
        let cleaned = sanitize_san(t);
        if cleaned.is_empty() {
            continue;
        }
        out.push(cleaned);
    }

    if out.is_empty() {
        return Err(Error::PackageManager("No SAN tokens found in analyzed PGN".to_string()));
    }
    Ok(out)
}

fn strip_braced_sections(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0u32;
    for ch in s.chars() {
        match ch {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            _ => {
                if depth == 0 {
                    out.push(ch);
                }
            }
        }
    }
    out
}

fn strip_parenthesized_sections(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0u32;
    for ch in s.chars() {
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ => {
                if depth == 0 {
                    out.push(ch);
                }
            }
        }
    }
    out
}

fn is_move_number_token(t: &str) -> bool {
    if let Some(idx) = t.find('.') {
        let (left, right) = t.split_at(idx);
        if left.chars().all(|c| c.is_ascii_digit()) {
            return right.chars().all(|c| c == '.');
        }
    }
    false
}

fn strip_leading_move_number_prefix(t: &str) -> &str {
    let bytes = t.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 || i >= bytes.len() || bytes[i] != b'.' {
        return t;
    }
    while i < bytes.len() && bytes[i] == b'.' {
        i += 1;
    }
    &t[i..]
}

fn sanitize_san(s: &str) -> String {
    let mut t = s.trim().to_string();
    while t.ends_with('!') || t.ends_with('?') {
        t.pop();
    }
    while t.ends_with(',') || t.ends_with(';') {
        t.pop();
    }
    t
}

fn parse_game_datetime_utc(date: Option<&str>, utc_time: Option<&str>) -> NaiveDateTime {
    let d = date
        .and_then(parse_date_best_effort)
        .unwrap_or_else(|| NaiveDate::from_ymd_opt(1970, 1, 1).unwrap());
    let t = utc_time
        .and_then(parse_time_best_effort)
        .unwrap_or_else(|| NaiveTime::from_hms_opt(0, 0, 0).unwrap());
    NaiveDateTime::new(d, t)
}

fn parse_date_best_effort(s: &str) -> Option<NaiveDate> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .or_else(|_| NaiveDate::parse_from_str(s, "%Y.%m.%d"))
        .or_else(|_| NaiveDate::parse_from_str(s, "%d/%m/%Y"))
        .ok()
}

fn parse_time_best_effort(s: &str) -> Option<NaiveTime> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    NaiveTime::parse_from_str(s, "%H:%M:%S")
        .or_else(|_| NaiveTime::parse_from_str(s, "%H:%M"))
        .ok()
}

fn utc_ms_to_naive(ms: i64) -> NaiveDateTime {
    let sec = ms / 1000;
    let nsec = ((ms % 1000).max(0) as u32) * 1_000_000;
    let dt = Utc.timestamp_opt(sec, nsec).single().unwrap_or_else(|| Utc::now());
    dt.naive_utc()
}

// -----------------------------
// Paths
// -----------------------------

fn profile_db_path(app: &AppHandle, profile_id: &str) -> Result<PathBuf> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::PackageManager(format!("Failed to resolve AppData dir: {}", e)))?;
    Ok(app_data.join("db").join(format!("profile_{}.db3", profile_id)))
}

fn analysis_db_path(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .resolve("analysis.db3", BaseDirectory::AppData)
        .map_err(|e| Error::PackageManager(format!("Failed to resolve analysis DB path: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pgn_san_tokens_strips_move_numbers_without_spaces() {
        let pgn = r#"[Event "Test"]

1.e4 e5 2.Nf3 Nc6 *
"#;
        let tokens = parse_pgn_san_tokens(pgn).unwrap();
        assert_eq!(tokens, vec!["e4", "e5", "Nf3", "Nc6"]);
    }

    #[test]
    fn decode_moves_blob_as_pgn_handles_null_bytes() {
        let pgn = "[Event \"Test\"]\n\n1. e4 e5 2. Nf3 Nc6 *";
        let mut bytes = Vec::new();
        for b in pgn.as_bytes() {
            bytes.push(*b);
            if *b == b' ' {
                bytes.push(0);
            }
        }

        let start = Chess::default();
        let seq = decode_moves_blob_as_pgn(&bytes, &start).unwrap();

        assert_eq!(seq, vec!["e2e4", "e7e5", "g1f3", "b8c6"]);
    }

    #[test]
    fn variant_book_to_pgn_orders_opponent_variations_by_probability() {
        let ctx = MatchContext {
            match_start_utc_ms: 1_700_000_000_000,
            time_control: "300+0".to_string(),
            our_elo: 1500,
            target_player_id: 42,
            our_color: PlayerColor::White,
            start_fen: "startpos".to_string(),
        };

        let book = VariantBook {
            root_node_id: 1,
            nodes: vec![
                BookNode {
                    id: 1,
                    fen: "startpos".to_string(),
                    ply_from_root: 0,
                    side_to_move: PlayerColor::White,
                    reach_prob: 1.0,
                },
                BookNode {
                    id: 2,
                    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -".to_string(),
                    ply_from_root: 1,
                    side_to_move: PlayerColor::Black,
                    reach_prob: 1.0,
                },
                BookNode {
                    id: 3,
                    fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -".to_string(),
                    ply_from_root: 2,
                    side_to_move: PlayerColor::White,
                    reach_prob: 0.7,
                },
                BookNode {
                    id: 4,
                    fen: "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -".to_string(),
                    ply_from_root: 2,
                    side_to_move: PlayerColor::White,
                    reach_prob: 0.3,
                },
            ],
            edges: vec![
                BookEdge {
                    from: 1,
                    to: 2,
                    uci: "e2e4".to_string(),
                    prob: 1.0,
                    kind: EdgeKind::OurMove,
                    ev_cp_from_our_perspective: Some(15.0),
                    predicted_prob: None,
                },
                BookEdge {
                    from: 2,
                    to: 3,
                    uci: "e7e5".to_string(),
                    prob: 0.7,
                    kind: EdgeKind::OpponentMove,
                    ev_cp_from_our_perspective: None,
                    predicted_prob: Some(0.7),
                },
                BookEdge {
                    from: 2,
                    to: 4,
                    uci: "c7c5".to_string(),
                    prob: 0.3,
                    kind: EdgeKind::OpponentMove,
                    ev_cp_from_our_perspective: None,
                    predicted_prob: Some(0.3),
                },
            ],
        };

        let pgn = variant_book_to_pgn(&book, &ctx, "Opponent(42)", 4).unwrap();

        let idx_main = pgn.find("e5").unwrap();
        let idx_var = pgn.find("(1... c5").unwrap();
        assert!(idx_main < idx_var, "Expected mainline before variations");
    }
}
