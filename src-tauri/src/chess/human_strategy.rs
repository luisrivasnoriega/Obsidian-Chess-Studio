//! Human-style strategic move selection with engine safety guardrails.
//!
//! This module ranks engine candidate moves (MultiPV lines) using practical,
//! human-oriented heuristics:
//! - damage opponent pawn structure
//! - increase pressure on loose pawns
//! - gain space and restrict piece mobility
//! - occupy open/semi-open files (especially central files)
//! - create kingside wing clamps (for example h-pawn expansion)
//!
//! The selector never trusts heuristics alone. It compares every candidate to
//! engine evaluation and applies guardrails so selected moves remain objectively
//! playable (not strategically pretty but tactically lost).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use shakmaty::{
    fen::Fen, san::SanPlus, uci::UciMove, Board, CastlingMode, Chess, Color, Move, Position, Role,
    Square,
};
use specta::Type;

use crate::error::Error;

use super::types::{BestMoves, ScoreValue};

/// Runtime knobs for the strategic selector.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HumanStrategicConfig {
    /// Maximum centipawn drop allowed vs engine top move in the normal path.
    pub max_engine_drop_cp: i32,
    /// Maximum disadvantage (from side to move perspective) allowed in the normal path.
    pub max_absolute_disadvantage_cp: i32,
    /// Maximum disadvantage allowed in "last resort" high-conviction strategic picks.
    pub last_resort_disadvantage_cp: i32,
    /// Minimum strategic score needed for non-top-engine moves.
    pub min_strategic_score: f32,
    /// Higher threshold required to allow "last resort" concessions.
    pub high_conviction_threshold: f32,
}

impl Default for HumanStrategicConfig {
    fn default() -> Self {
        Self {
            // Conservative defaults: keep engine safety first.
            max_engine_drop_cp: 55,
            max_absolute_disadvantage_cp: 35,
            last_resort_disadvantage_cp: 70,
            min_strategic_score: 0.45,
            high_conviction_threshold: 0.82,
        }
    }
}

/// Input payload for strategic move selection.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HumanStrategicRequest {
    pub fen: String,
    pub moves: Vec<String>,
    /// Candidate lines from engine MultiPV for the current position.
    pub candidates: Vec<BestMoves>,
    /// Optional override for guardrail and style thresholds.
    pub config: Option<HumanStrategicConfig>,
}

/// Recognized practical motifs for a candidate move.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StrategicMotif {
    DamagedPawnStructure,
    WeakPawnPressure,
    SpaceGain,
    OpenFilePressure,
    CentralKingPressure,
    PieceRestriction,
    WingClamp,
}

/// Component scores used to build the final strategic score.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct HumanStrategicComponents {
    pub pawn_structure_damage: f32,
    pub weak_pawn_pressure: f32,
    pub space_gain: f32,
    pub open_file_pressure: f32,
    pub central_king_pressure: f32,
    pub piece_restriction: f32,
    pub wing_clamp: f32,
}

/// Phase-3 macro strategic axes used for richer style explanation and ranking.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct HumanStrategicMacroComponents {
    pub pawn_structure: f32,
    pub space: f32,
    pub piece_quality: f32,
    pub king_safety: f32,
    pub initiative: f32,
    pub attack: f32,
    pub counterplay: f32,
    pub prophylaxis: f32,
    pub conversion: f32,
    pub endgame_transition: f32,
    pub practical_pressure: f32,
    pub plan_coherence: f32,
}

/// Ranked candidate move with engine and strategic metadata.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HumanStrategicCandidate {
    pub uci: String,
    pub san: String,
    pub pv_uci_line: Vec<String>,
    pub engine_rank: usize,
    pub engine_cp: i32,
    pub engine_drop_cp: i32,
    pub strategic_score: f32,
    pub macro_strategic_score: f32,
    pub final_score: f32,
    pub passes_guardrail: bool,
    pub is_last_resort: bool,
    pub motifs: Vec<StrategicMotif>,
    pub components: HumanStrategicComponents,
    pub macro_components: HumanStrategicMacroComponents,
}

/// Final selection plus full ranked candidate list.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HumanStrategicSelection {
    pub selected_uci: String,
    pub selected_san: String,
    pub selected_engine_cp: i32,
    pub selected_engine_drop_cp: i32,
    pub selected_strategic_score: f32,
    pub selected_is_last_resort: bool,
    pub best_engine_uci: String,
    pub best_engine_cp: i32,
    pub candidates: Vec<HumanStrategicCandidate>,
}

/// Pick a strategic move under engine guardrails.
pub fn pick_human_strategic_move(
    request: HumanStrategicRequest,
) -> Result<HumanStrategicSelection, Error> {
    let cfg = request.config.unwrap_or_default();

    let root = build_position(&request.fen, &request.moves)?;
    let mover = root.turn();
    let opponent = mover.other();
    let perspective_sign = mover_perspective_sign(mover);
    if request.candidates.is_empty() {
        return Err(Error::InvalidInput(
            "No engine candidates were provided".to_string(),
        ));
    }

    // Deduplicate by first UCI move and keep the strongest score per move.
    let mut by_move: HashMap<String, (i32, i32, Vec<String>)> = HashMap::new(); // uci -> (cp_white, cp_from_mover, pv)
    for line in &request.candidates {
        let Some(uci) = line.uci_moves.first() else {
            continue;
        };
        if uci.trim().is_empty() {
            continue;
        }
        let cp_white = score_value_to_cp(&line.score.value);
        let cp_mover = cp_white * perspective_sign;
        let pv = line
            .uci_moves
            .iter()
            .filter(|m| !m.trim().is_empty())
            .take(10)
            .cloned()
            .collect::<Vec<_>>();
        by_move
            .entry(uci.clone())
            .and_modify(|prev| {
                if cp_mover > prev.1 {
                    *prev = (cp_white, cp_mover, pv.clone());
                }
            })
            .or_insert((cp_white, cp_mover, pv));
    }

    if by_move.is_empty() {
        return Err(Error::InvalidInput(
            "Engine candidates did not contain playable UCI moves".to_string(),
        ));
    }

    let mut ranked_engine: Vec<(String, i32, i32, Vec<String>)> = by_move
        .into_iter()
        .map(|(uci, (cp_white, cp_mover, pv))| (uci, cp_white, cp_mover, pv))
        .collect();
    ranked_engine.sort_by(|a, b| b.2.cmp(&a.2));

    let best_engine_uci = ranked_engine
        .first()
        .map(|x| x.0.clone())
        .ok_or_else(|| Error::InvalidInput("No ranked engine move found".to_string()))?;
    let best_engine_cp_white = ranked_engine
        .first()
        .map(|x| x.1)
        .ok_or_else(|| Error::InvalidInput("No ranked engine score found".to_string()))?;
    let best_engine_cp_mover = ranked_engine
        .first()
        .map(|x| x.2)
        .ok_or_else(|| Error::InvalidInput("No ranked engine score found".to_string()))?;

    let mut candidates: Vec<HumanStrategicCandidate> = Vec::new();
    let mut seen_ucis: HashSet<String> = HashSet::new();

    for (engine_rank, (uci, engine_cp_white, engine_cp_mover, pv_line)) in ranked_engine.into_iter().enumerate() {
        if !seen_ucis.insert(uci.clone()) {
            continue;
        }
        let uci_move = UciMove::from_ascii(uci.as_bytes())?;
        let mv = uci_move.to_move(&root)?;

        let mut after = root.clone();
        let san = SanPlus::from_move_and_play_unchecked(&mut after, &mv).to_string();

        let components = score_components(&root, &after, &mv);
        let macro_components = score_macro_components(&root, &after, &mv, &components);
        let base_strategic_score = aggregate_strategic_score(&components);
        let macro_strategic_score = aggregate_macro_strategic_score(&macro_components);
        let pv_tail: &[String] = if pv_line.len() > 1 { &pv_line[1..] } else { &[] };
        let pv_projection = project_pv_from_after(&after, pv_tail);
        let transition_to_endgame = score_transition_to_endgame_pv(
            root.board(),
            after.board(),
            pv_projection.end.board(),
            mover,
            opponent,
            pv_projection.plies_applied,
        );
        let tension_management = score_tension_management_pv(
            root.board(),
            after.board(),
            pv_projection.end.board(),
            mover,
            opponent,
            &mv,
            pv_projection.plies_applied,
        );
        let strategic_score = (base_strategic_score * 0.62
            + macro_strategic_score * 0.38
            + transition_to_endgame * 0.08
            + tension_management * 0.07)
            .clamp(0.0, 1.0);
        let engine_drop_cp = (best_engine_cp_mover - engine_cp_mover).max(0);

        let (passes_guardrail, is_last_resort) = passes_guardrail(
            engine_cp_mover,
            best_engine_cp_mover,
            engine_drop_cp,
            engine_rank,
            strategic_score,
            cfg,
        );

        let engine_quality = (1.0
            - (engine_drop_cp as f32 / (cfg.max_engine_drop_cp + 20).max(1) as f32))
        .clamp(0.0, 1.0);
        let practical_bonus = if engine_drop_cp <= cfg.max_engine_drop_cp && strategic_score >= 0.75 {
            0.03
        } else {
            0.0
        };
        // Extra emphasis for structure-break / file-opening plans that remain inside guardrails.
        let aggressive_break_bonus =
            if engine_drop_cp <= cfg.max_engine_drop_cp + 10 && strategic_score >= 0.30 {
                (components.pawn_structure_damage * 0.08
                    + components.open_file_pressure * 0.06
                    + components.central_king_pressure * 0.04)
                    .min(0.14)
            } else {
                0.0
            };
        // Keep objective eval slightly dominant, but allow strategic profile to steer practical choices.
        let mut final_score =
            strategic_score * 0.45 + engine_quality * 0.55 + practical_bonus + aggressive_break_bonus;
        if !passes_guardrail {
            final_score -= 1.0;
        }

        candidates.push(HumanStrategicCandidate {
            uci,
            san,
            pv_uci_line: pv_line,
            engine_rank,
            engine_cp: engine_cp_white,
            engine_drop_cp,
            strategic_score,
            macro_strategic_score,
            final_score,
            passes_guardrail,
            is_last_resort,
            motifs: motifs_from_components(&components),
            components,
            macro_components,
        });
    }

    if candidates.is_empty() {
        return Err(Error::InvalidInput(
            "No legal candidate move could be built from engine lines".to_string(),
        ));
    }

    candidates.sort_by(|a, b| {
        b.final_score
            .partial_cmp(&a.final_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.strategic_score
                    .partial_cmp(&a.strategic_score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| (b.engine_cp * perspective_sign).cmp(&(a.engine_cp * perspective_sign)))
    });

    let selected = candidates
        .iter()
        .filter(|c| c.passes_guardrail)
        .max_by(|a, b| {
            a.final_score
                .partial_cmp(&b.final_score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    a.strategic_score
                        .partial_cmp(&b.strategic_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        })
        .or_else(|| {
            // Guardrail rejected everything: fallback to engine top move.
            candidates.iter().min_by_key(|c| c.engine_rank)
        })
        .ok_or_else(|| Error::InvalidInput("No candidate was selectable".to_string()))?
        .clone();

    Ok(HumanStrategicSelection {
        selected_uci: selected.uci.clone(),
        selected_san: selected.san.clone(),
        selected_engine_cp: selected.engine_cp,
        selected_engine_drop_cp: selected.engine_drop_cp,
        selected_strategic_score: selected.strategic_score,
        selected_is_last_resort: selected.is_last_resort,
        best_engine_uci,
        best_engine_cp: best_engine_cp_white,
        candidates,
    })
}

#[derive(Debug, Clone)]
struct PvProjection {
    end: Chess,
    plies_applied: usize,
}

fn build_position(fen: &str, moves: &[String]) -> Result<Chess, Error> {
    let fen: Fen = Fen::from_ascii(fen.as_bytes())?;
    let mut pos: Chess = match fen.into_position(CastlingMode::Chess960) {
        Ok(p) => p,
        Err(e) => e.ignore_too_much_material()?,
    };
    for m in moves {
        let u = UciMove::from_ascii(m.as_bytes())?;
        let mv = u.to_move(&pos)?;
        pos.play_unchecked(&mv);
    }
    Ok(pos)
}

fn score_value_to_cp(value: &ScoreValue) -> i32 {
    match value {
        ScoreValue::Cp(v) => *v,
        ScoreValue::Mate(v) => {
            if *v > 0 {
                20_000 - v.abs() * 100
            } else {
                -20_000 + v.abs() * 100
            }
        }
    }
}

fn project_pv_from_after(start: &Chess, pv_tail: &[String]) -> PvProjection {
    let mut pos = start.clone();
    let mut plies_applied = 0usize;

    for uci_txt in pv_tail.iter().take(8) {
        let Ok(uci) = UciMove::from_ascii(uci_txt.as_bytes()) else {
            break;
        };
        let Ok(mv) = uci.to_move(&pos) else {
            break;
        };
        pos.play_unchecked(&mv);
        plies_applied += 1;
    }

    PvProjection {
        end: pos,
        plies_applied,
    }
}

fn score_transition_to_endgame_pv(
    before: &Board,
    after_first: &Board,
    pv_end: &Board,
    mover: Color,
    opponent: Color,
    plies: usize,
) -> f32 {
    if plies < 2 {
        return 0.0;
    }

    let pieces_before = non_king_piece_total(before);
    let pieces_after = non_king_piece_total(pv_end);
    let traded = (pieces_before - pieces_after).max(0) as f32;

    let queens_before = has_queen(before, Color::White) || has_queen(before, Color::Black);
    let queens_after = has_queen(pv_end, Color::White) || has_queen(pv_end, Color::Black);
    let queen_trade = queens_before && !queens_after;

    if traded < 1.0 && !queen_trade {
        return 0.0;
    }

    let material_edge = material_balance_cp(pv_end, mover, opponent) as f32;
    let own_files = pawn_file_counts(pv_end, mover);
    let opp_files = pawn_file_counts(pv_end, opponent);
    let structure_edge = (isolated_pawns_from_file_counts(&opp_files) - isolated_pawns_from_file_counts(&own_files))
        .max(0) as f32
        + (doubled_pawns(&opp_files) - doubled_pawns(&own_files)).max(0) as f32;

    let king_activity_edge = (king_activity_index(pv_end, mover) - king_activity_index(pv_end, opponent)).max(0.0);
    let file_pressure_gain = (heavy_piece_file_pressure(pv_end, mover, &own_files, &opp_files)
        - heavy_piece_file_pressure(after_first, mover, &pawn_file_counts(after_first, mover), &pawn_file_counts(after_first, opponent)))
    .max(0.0);

    let mut value = normalize(traded, 8.0) * 0.34
        + normalize(material_edge.max(0.0), 220.0) * 0.24
        + normalize(structure_edge, 3.0) * 0.18
        + normalize(king_activity_edge, 1.0) * 0.14
        + file_pressure_gain * 0.10;
    if queen_trade {
        value += 0.18;
    }
    if material_edge < -80.0 {
        value *= 0.55;
    }

    normalize(value, 1.35)
}

fn score_tension_management_pv(
    before: &Board,
    after_first: &Board,
    pv_end: &Board,
    mover: Color,
    opponent: Color,
    mv: &Move,
    plies: usize,
) -> f32 {
    if plies == 0 {
        return 0.0;
    }

    let tension_before = central_tension_pairs(before) as f32;
    if tension_before <= 0.0 {
        return 0.0;
    }

    let tension_after = central_tension_pairs(after_first) as f32;
    let tension_end = central_tension_pairs(pv_end) as f32;
    let immediate_release = (tension_before - tension_after).max(0.0);
    let eventual_release = (tension_before - tension_end).max(0.0);

    let pressure_gain =
        (king_ring_pressure(pv_end, mover, opponent) - king_ring_pressure(after_first, mover, opponent)).max(0.0);
    let local_gain =
        (local_attack_balance(pv_end, mover, opponent) - local_attack_balance(after_first, mover, opponent)).max(0.0);

    let keep_tension_value = if immediate_release <= 0.2 {
        normalize(tension_after, tension_before.max(1.0)) * 0.42 + normalize(pressure_gain, 1.0) * 0.34
    } else {
        0.0
    };
    let release_tension_value = if immediate_release > 0.2 {
        normalize(eventual_release, tension_before.max(1.0)) * 0.14
            + normalize(pressure_gain, 1.0) * 0.44
            + normalize(local_gain, 2.2) * 0.28
    } else {
        0.0
    };

    let mut value = keep_tension_value.max(release_tension_value);
    if mv.role() == Role::Pawn {
        if let Some((file, _)) = square_to_coords(mv.to()) {
            if file == 3 || file == 4 {
                value += 0.08;
            }
        }
    }

    normalize(value, 1.2)
}

fn passes_guardrail(
    engine_cp_mover: i32,
    best_engine_cp_mover: i32,
    engine_drop_cp: i32,
    engine_rank: usize,
    strategic_score: f32,
    cfg: HumanStrategicConfig,
) -> (bool, bool) {
    // Always keep top-engine move available as a safe baseline.
    if engine_rank == 0 {
        return (true, false);
    }

    // Never pick lines that are clearly much worse than the top candidate.
    if engine_drop_cp > cfg.max_engine_drop_cp + 20 {
        return (false, false);
    }

    // Avoid objectively lost tactical lines.
    if engine_cp_mover <= -9000 {
        return (false, false);
    }
    if engine_cp_mover <= -250 {
        return (false, false);
    }

    // If top engine line is around equality, do not allow going to clearly worse positions.
    let dynamic_disadv_limit = if best_engine_cp_mover >= 120 {
        cfg.last_resort_disadvantage_cp
    } else if best_engine_cp_mover >= 60 {
        cfg.max_absolute_disadvantage_cp + 10
    } else {
        cfg.max_absolute_disadvantage_cp
    };

    let base_rank_limit = if strategic_score >= cfg.min_strategic_score + 0.20 {
        3
    } else {
        2
    };
    let drop_rank_bonus = if engine_drop_cp <= cfg.max_engine_drop_cp.saturating_sub(15) {
        1
    } else {
        0
    };
    let normal_rank_limit = base_rank_limit + drop_rank_bonus;

    if engine_drop_cp <= cfg.max_engine_drop_cp
        && engine_cp_mover >= -dynamic_disadv_limit
        && strategic_score >= cfg.min_strategic_score
        && engine_rank <= normal_rank_limit
    {
        return (true, false);
    }

    if engine_drop_cp <= cfg.max_engine_drop_cp + 15
        && engine_cp_mover >= -cfg.last_resort_disadvantage_cp
        && strategic_score >= cfg.high_conviction_threshold
        && engine_rank <= 2
    {
        return (true, true);
    }

    (false, false)
}

#[inline]
fn mover_perspective_sign(mover: Color) -> i32 {
    if mover == Color::White { 1 } else { -1 }
}

fn aggregate_strategic_score(c: &HumanStrategicComponents) -> f32 {
    (0.25 * c.pawn_structure_damage
        + 0.15 * c.weak_pawn_pressure
        + 0.10 * c.space_gain
        + 0.13 * c.open_file_pressure
        + 0.28 * c.central_king_pressure
        + 0.07 * c.piece_restriction
        + 0.02 * c.wing_clamp)
        .clamp(0.0, 1.0)
}

fn aggregate_macro_strategic_score(c: &HumanStrategicMacroComponents) -> f32 {
    (0.09 * c.pawn_structure
        + 0.07 * c.space
        + 0.11 * c.piece_quality
        + 0.15 * c.king_safety
        + 0.11 * c.initiative
        + 0.15 * c.attack
        + 0.08 * c.counterplay
        + 0.07 * c.prophylaxis
        + 0.06 * c.conversion
        + 0.05 * c.endgame_transition
        + 0.05 * c.practical_pressure
        + 0.01 * c.plan_coherence)
        .clamp(0.0, 1.0)
}

fn score_macro_components(
    before: &Chess,
    after: &Chess,
    mv: &Move,
    legacy: &HumanStrategicComponents,
) -> HumanStrategicMacroComponents {
    let mover = before.turn();
    let opponent = mover.other();

    let outpost_control = score_outpost_control(before.board(), after.board(), mover, opponent, mv);
    let color_complex_weakness = score_color_complex_weakness(before.board(), after.board(), mover, opponent);
    let bad_piece_detection = score_bad_piece_detection(before.board(), after.board(), mover, opponent);
    let piece_coordination = score_piece_coordination(before.board(), after.board(), mover, opponent);
    let prophylaxis = score_prophylaxis(before.board(), after.board(), mover, opponent, mv);
    let trade_favorability = score_trade_favorability(before.board(), after.board(), mover, opponent, mv);
    let counterplay_initiative = score_counterplay_initiative(before.board(), after.board(), mover, opponent, mv);
    let central_break_initiative = score_central_break_initiative(before.board(), after.board(), mover, opponent, mv);
    let infiltration_tension = score_infiltration_tension(before.board(), after.board(), mover, opponent, mv);
    let king_attack_complexity = score_king_attack_complexity(before.board(), after.board(), mover, opponent, mv);
    let king_net_setup = score_king_net_setup(before.board(), after.board(), mover, opponent, mv);
    let piece_lift_assault = score_piece_lift_assault(before.board(), after.board(), mover, opponent, mv);
    let local_attack_superiority =
        score_local_attack_superiority(before.board(), after.board(), mover, opponent, mv);
    let initiative_compensation =
        score_initiative_compensation(before.board(), after.board(), mover, opponent, mv);
    let pawn_avalanche = score_pawn_avalanche(before.board(), after.board(), mover, opponent, mv);

    let material_edge_after = material_balance_cp(after.board(), mover, opponent) as f32;
    let king_activity_edge =
        (king_activity_index(after.board(), mover) - king_activity_index(after.board(), opponent)).max(0.0);
    let queen_trade = (has_queen(before.board(), Color::White) || has_queen(before.board(), Color::Black))
        && !has_queen(after.board(), Color::White)
        && !has_queen(after.board(), Color::Black);
    let queen_trade_signal = if queen_trade { 1.0 } else { 0.0 };

    let pawn_structure =
        (legacy.pawn_structure_damage * 0.56 + legacy.weak_pawn_pressure * 0.24 + trade_favorability * 0.20)
            .clamp(0.0, 1.0);
    let space = (legacy.space_gain * 0.72 + outpost_control * 0.28).clamp(0.0, 1.0);
    let piece_quality = (legacy.piece_restriction * 0.36
        + outpost_control * 0.24
        + bad_piece_detection * 0.24
        + piece_coordination * 0.16)
        .clamp(0.0, 1.0);
    let king_safety = (legacy.central_king_pressure * 0.58
        + color_complex_weakness * 0.24
        + king_net_setup * 0.18)
        .clamp(0.0, 1.0);
    let initiative = (counterplay_initiative * 0.30
        + initiative_compensation * 0.24
        + central_break_initiative * 0.26
        + infiltration_tension * 0.20)
        .clamp(0.0, 1.0);
    let attack = (king_attack_complexity * 0.31
        + piece_lift_assault * 0.20
        + local_attack_superiority * 0.24
        + legacy.central_king_pressure * 0.25)
        .clamp(0.0, 1.0);
    let counterplay =
        (counterplay_initiative * 0.56 + infiltration_tension * 0.18 + trade_favorability * 0.26).clamp(0.0, 1.0);
    let prophylaxis =
        (prophylaxis * 0.66 + legacy.wing_clamp * 0.16 + legacy.piece_restriction * 0.18).clamp(0.0, 1.0);
    let conversion = (pawn_avalanche * 0.44
        + trade_favorability * 0.24
        + legacy.open_file_pressure * 0.18
        + normalize(material_edge_after.max(0.0), 220.0) * 0.14)
        .clamp(0.0, 1.0);
    let endgame_transition = (trade_favorability * 0.52
        + normalize(king_activity_edge, 1.0) * 0.20
        + normalize(material_edge_after.max(0.0), 220.0) * 0.16
        + queen_trade_signal * 0.12)
        .clamp(0.0, 1.0);
    let practical_pressure = (local_attack_superiority * 0.33
        + king_attack_complexity * 0.27
        + counterplay_initiative * 0.20
        + initiative_compensation * 0.20)
        .clamp(0.0, 1.0);
    let plan_coherence = (prophylaxis * 0.30
        + outpost_control * 0.19
        + central_break_initiative * 0.20
        + piece_coordination * 0.16
        + trade_favorability * 0.15)
        .clamp(0.0, 1.0);

    HumanStrategicMacroComponents {
        pawn_structure,
        space,
        piece_quality,
        king_safety,
        initiative,
        attack,
        counterplay,
        prophylaxis,
        conversion,
        endgame_transition,
        practical_pressure,
        plan_coherence,
    }
}

fn motifs_from_components(c: &HumanStrategicComponents) -> Vec<StrategicMotif> {
    let mut motifs = Vec::new();
    if c.pawn_structure_damage >= 0.25 {
        motifs.push(StrategicMotif::DamagedPawnStructure);
    }
    if c.weak_pawn_pressure >= 0.25 {
        motifs.push(StrategicMotif::WeakPawnPressure);
    }
    if c.space_gain >= 0.25 {
        motifs.push(StrategicMotif::SpaceGain);
    }
    if c.open_file_pressure >= 0.20 {
        motifs.push(StrategicMotif::OpenFilePressure);
    }
    if c.central_king_pressure >= 0.20 {
        motifs.push(StrategicMotif::CentralKingPressure);
    }
    if c.piece_restriction >= 0.25 {
        motifs.push(StrategicMotif::PieceRestriction);
    }
    if c.wing_clamp >= 0.25 {
        motifs.push(StrategicMotif::WingClamp);
    }
    motifs
}

fn score_components(before: &Chess, after: &Chess, mv: &Move) -> HumanStrategicComponents {
    let mover = before.turn();
    let opponent = mover.other();

    let mut pawn_structure_damage = score_pawn_structure_damage(before.board(), after.board(), mover);
    let mut weak_pawn_pressure =
        score_weak_pawn_pressure(before.board(), after.board(), mover, opponent, mv);
    let mut space_gain = score_space_gain(before.board(), after.board(), mover);
    let mut open_file_pressure =
        score_open_file_pressure(before.board(), after.board(), mover, opponent);
    let mut central_king_pressure =
        score_central_king_pressure(before.board(), after.board(), mover, opponent);
    let mut piece_restriction = score_piece_restriction(before.board(), after.board(), opponent);
    let mut wing_clamp = score_wing_clamp(after.board(), mv, mover, opponent, piece_restriction);
    let structure_break = score_structural_break_plan(before.board(), after.board(), mv, mover, opponent);
    let decoy_king_line = score_decoy_king_line_break(before.board(), after.board(), mv, mover, opponent);
    let king_attack_complexity =
        score_king_attack_complexity(before.board(), after.board(), mover, opponent, mv);
    let sacrificial_complexity =
        score_sacrificial_complexity(before.board(), after.board(), mover, opponent, mv);
    let pawn_avalanche = score_pawn_avalanche(before.board(), after.board(), mover, opponent, mv);
    let central_break_initiative =
        score_central_break_initiative(before.board(), after.board(), mover, opponent, mv);
    let infiltration_tension =
        score_infiltration_tension(before.board(), after.board(), mover, opponent, mv);
    let king_net_setup = score_king_net_setup(before.board(), after.board(), mover, opponent, mv);
    let counterplay_initiative =
        score_counterplay_initiative(before.board(), after.board(), mover, opponent, mv);
    let piece_lift_assault = score_piece_lift_assault(before.board(), after.board(), mover, opponent, mv);
    let local_attack_superiority =
        score_local_attack_superiority(before.board(), after.board(), mover, opponent, mv);
    let initiative_compensation =
        score_initiative_compensation(before.board(), after.board(), mover, opponent, mv);
    let outpost_control = score_outpost_control(before.board(), after.board(), mover, opponent, mv);
    let color_complex_weakness = score_color_complex_weakness(before.board(), after.board(), mover, opponent);
    let bad_piece_detection = score_bad_piece_detection(before.board(), after.board(), mover, opponent);
    let piece_coordination = score_piece_coordination(before.board(), after.board(), mover, opponent);
    let prophylaxis = score_prophylaxis(before.board(), after.board(), mover, opponent, mv);
    let trade_favorability = score_trade_favorability(before.board(), after.board(), mover, opponent, mv);

    // Strategic-aggressive plans:
    // - structural concessions to damage the pawn shell and open files (...Nxb4, ...Bxa3)
    // - initiative sacrifices and king-ring pressure (Bxh7 / Bxh2 patterns)
    pawn_structure_damage =
        (pawn_structure_damage
            + structure_break * 0.75
            + decoy_king_line * 0.25
            + sacrificial_complexity * 0.18
            + central_break_initiative * 0.28
            + pawn_avalanche * 0.12
            + trade_favorability * 0.16
            + prophylaxis * 0.05)
        .clamp(0.0, 1.0);
    weak_pawn_pressure =
        (weak_pawn_pressure
            + structure_break * 0.28
            + king_attack_complexity * 0.42
            + pawn_avalanche * 0.15
            + king_net_setup * 0.22
            + counterplay_initiative * 0.08
            + local_attack_superiority * 0.10
            + initiative_compensation * 0.12
            + color_complex_weakness * 0.20
            + prophylaxis * 0.15
            + trade_favorability * 0.06)
            .clamp(0.0, 1.0);
    open_file_pressure =
        (open_file_pressure
            + structure_break * 0.55
            + central_break_initiative * 0.45
            + infiltration_tension * 0.20
            + counterplay_initiative * 0.22
            + piece_lift_assault * 0.20
            + initiative_compensation * 0.18
            + trade_favorability * 0.18
            + prophylaxis * 0.10)
            .clamp(0.0, 1.0);
    central_king_pressure = (central_king_pressure
        + decoy_king_line * 0.70
        + king_attack_complexity * 0.90
        + sacrificial_complexity * 0.68
        + central_break_initiative * 0.42
        + infiltration_tension * 0.45
        + king_net_setup * 0.58
        + counterplay_initiative * 0.48
        + piece_lift_assault * 0.44
        + local_attack_superiority * 0.62
        + initiative_compensation * 0.54
        + color_complex_weakness * 0.56
        + piece_coordination * 0.24
        + outpost_control * 0.12
        + trade_favorability * 0.12)
        .clamp(0.0, 1.0);
    piece_restriction =
        (piece_restriction
            + structure_break * 0.24
            + king_attack_complexity * 0.28
            + pawn_avalanche * 0.38
            + infiltration_tension * 0.55
            + king_net_setup * 0.26
            + counterplay_initiative * 0.24
            + local_attack_superiority * 0.30
            + initiative_compensation * 0.26
            + outpost_control * 0.38
            + bad_piece_detection * 0.46
            + piece_coordination * 0.22
            + prophylaxis * 0.14)
            .clamp(0.0, 1.0);
    space_gain =
        (space_gain
            + king_attack_complexity * 0.14
            + pawn_avalanche * 0.78
            + infiltration_tension * 0.15
            + king_net_setup * 0.10
            + counterplay_initiative * 0.05
            + piece_lift_assault * 0.08
            + initiative_compensation * 0.04
            + outpost_control * 0.28
            + piece_coordination * 0.08
            + prophylaxis * 0.10)
            .clamp(0.0, 1.0);
    wing_clamp =
        (wing_clamp
            + king_attack_complexity * 0.18
            + king_net_setup * 0.32
            + counterplay_initiative * 0.12
            + piece_lift_assault * 0.14
            + local_attack_superiority * 0.12
            + initiative_compensation * 0.10
            + prophylaxis * 0.18
            + color_complex_weakness * 0.10)
            .clamp(0.0, 1.0);

    HumanStrategicComponents {
        pawn_structure_damage,
        weak_pawn_pressure,
        space_gain,
        open_file_pressure,
        central_king_pressure,
        piece_restriction,
        wing_clamp,
    }
}

fn score_pawn_structure_damage(before: &Board, after: &Board, mover: Color) -> f32 {
    let opponent = mover.other();

    let opp_before_files = pawn_file_counts(before, opponent);
    let opp_after_files = pawn_file_counts(after, opponent);

    let islands_delta =
        (pawn_islands(&opp_after_files) - pawn_islands(&opp_before_files)).max(0) as f32;
    let doubled_delta = (doubled_pawns(&opp_after_files) - doubled_pawns(&opp_before_files)).max(0) as f32;
    let isolated_delta =
        (isolated_pawns(after, opponent, &opp_after_files) - isolated_pawns(before, opponent, &opp_before_files))
            .max(0) as f32;
    let fixed_delta =
        (fixed_pawns_by_enemy_pawns(after, opponent, mover) - fixed_pawns_by_enemy_pawns(before, opponent, mover))
            .max(0) as f32;

    normalize(islands_delta * 0.45 + doubled_delta * 0.30 + isolated_delta * 0.25 + fixed_delta * 0.35, 2.6)
}

fn score_weak_pawn_pressure(
    before: &Board,
    after: &Board,
    mover: Color,
    opponent: Color,
    mv: &Move,
) -> f32 {
    let global_before = loose_pawns_under_attack(before, mover, opponent) as f32;
    let global_after = loose_pawns_under_attack(after, mover, opponent) as f32;
    let direct = direct_loose_pawn_attacks_from_move(after, mv, opponent) as f32;
    let delta = (global_after - global_before).max(0.0);
    normalize(delta * 0.70 + direct * 0.90, 2.5)
}

fn score_space_gain(before: &Board, after: &Board, mover: Color) -> f32 {
    let advanced_delta = (advanced_pawns(after, mover) - advanced_pawns(before, mover)).max(0) as f32;
    let center_delta = (central_control(after, mover) - central_control(before, mover)).max(0) as f32;
    normalize(advanced_delta * 0.60 + center_delta * 0.35, 3.0)
}

fn score_open_file_pressure(before: &Board, after: &Board, mover: Color, opponent: Color) -> f32 {
    let before_own = pawn_file_counts(before, mover);
    let before_opp = pawn_file_counts(before, opponent);
    let after_own = pawn_file_counts(after, mover);
    let after_opp = pawn_file_counts(after, opponent);

    let pressure_delta = (heavy_piece_file_pressure(after, mover, &after_own, &after_opp)
        - heavy_piece_file_pressure(before, mover, &before_own, &before_opp))
    .max(0.0);

    let d_file_delta =
        (heavy_piece_pressure_on_file(after, mover, &after_own, &after_opp, 3)
            - heavy_piece_pressure_on_file(before, mover, &before_own, &before_opp, 3))
        .max(0.0);
    let e_file_delta =
        (heavy_piece_pressure_on_file(after, mover, &after_own, &after_opp, 4)
            - heavy_piece_pressure_on_file(before, mover, &before_own, &before_opp, 4))
        .max(0.0);

    normalize(pressure_delta + (d_file_delta + e_file_delta) * 0.50, 2.2)
}

fn score_central_king_pressure(before: &Board, after: &Board, mover: Color, opponent: Color) -> f32 {
    let before_own = pawn_file_counts(before, mover);
    let before_opp = pawn_file_counts(before, opponent);
    let after_own = pawn_file_counts(after, mover);
    let after_opp = pawn_file_counts(after, opponent);

    let delta = (central_king_pressure(after, mover, opponent, &after_own, &after_opp)
        - central_king_pressure(before, mover, opponent, &before_own, &before_opp))
    .max(0.0);
    normalize(delta, 1.8)
}

fn score_piece_restriction(before: &Board, after: &Board, opponent: Color) -> f32 {
    let mobility_delta = (pseudo_mobility(before, opponent) - pseudo_mobility(after, opponent)).max(0) as f32;
    let knight_delta = (knight_freedom(before, opponent) - knight_freedom(after, opponent)).max(0) as f32;
    ((mobility_delta / 9.0) + (knight_delta / 5.0)).clamp(0.0, 1.0)
}

fn score_wing_clamp(
    after: &Board,
    mv: &Move,
    mover: Color,
    opponent: Color,
    piece_restriction: f32,
) -> f32 {
    if mv.role() != Role::Pawn {
        return 0.0;
    }
    let Some((file, _)) = square_to_coords(mv.to()) else {
        return 0.0;
    };
    if file != 0 && file != 1 && file != 6 && file != 7 {
        return 0.0;
    }

    let mut score: f32 = 0.45;
    let attacked_knights = count_attacked_knights_from_square(after, mv.to(), opponent);
    if attacked_knights > 0 {
        score += 0.35;
    }
    if piece_restriction > 0.25 {
        score += 0.20;
    }
    if is_square_attacked_by(after, mover, king_square(after, opponent).unwrap_or(mv.to())) {
        score += 0.10;
    }
    score.clamp(0.0, 1.0)
}

fn score_structural_break_plan(
    before: &Board,
    after: &Board,
    mv: &Move,
    mover: Color,
    opponent: Color,
) -> f32 {
    // Focus on aggressive practical ideas: piece captures that invite a pawn recapture,
    // dragging edge pawns and reshaping the structure.
    if mv.role() == Role::Pawn {
        return 0.0;
    }
    let Some(captured) = before.piece_at(mv.to()) else {
        return 0.0;
    };
    if captured.color != opponent || captured.role != Role::Pawn {
        return 0.0;
    }

    let Some((to_file, to_rank)) = square_to_coords(mv.to()) else {
        return 0.0;
    };
    if to_file != 0 && to_file != 1 && to_file != 6 && to_file != 7 {
        return 0.0;
    }

    let own_files = pawn_file_counts(before, mover);
    let opp_before = pawn_file_counts(before, opponent);
    let opp_after = pawn_file_counts(after, opponent);
    let mut best: f32 = 0.0;

    // Generic wing-pawn break signal (works for ideas like ...Bxa3):
    // removing the edge pawn often leaves the adjacent pawn as a chronic weakness
    // and opens practical entry squares/files.
    if (to_file == 0 || to_file == 7) && opp_before[to_file] > opp_after[to_file] {
        let adjacent_file = if to_file == 0 { 1 } else { 6 };
        let mut leverage = 0.26f32;
        let islands_delta = (pawn_islands(&opp_after) - pawn_islands(&opp_before)).max(0) as f32;
        let isolated_delta =
            (isolated_pawns_from_file_counts(&opp_after) - isolated_pawns_from_file_counts(&opp_before)).max(0)
                as f32;
        leverage += islands_delta * 0.28 + isolated_delta * 0.24;
        if opp_after[adjacent_file] > 0 && opp_after[to_file] == 0 {
            leverage += 0.32;
        }
        if own_files[to_file] == 0 {
            leverage += 0.18;
        }
        best = best.max(normalize(leverage, 0.95));
    }

    let recapture_sources = pawn_recapture_source_files(before, to_file, to_rank, opponent);
    if recapture_sources.is_empty() {
        return best;
    }
    for src_file in recapture_sources {
        let mut virtual_opp = opp_after;
        if virtual_opp[src_file] == 0 {
            continue;
        }
        virtual_opp[src_file] = virtual_opp[src_file].saturating_sub(1);
        virtual_opp[to_file] = virtual_opp[to_file].saturating_add(1);

        let islands_delta = (pawn_islands(&virtual_opp) - pawn_islands(&opp_before)).max(0) as f32;
        let doubled_delta = (doubled_pawns(&virtual_opp) - doubled_pawns(&opp_before)).max(0) as f32;
        let isolated_delta =
            (isolated_pawns_from_file_counts(&virtual_opp) - isolated_pawns_from_file_counts(&opp_before)).max(0)
                as f32;

        let mut leverage = islands_delta * 0.30 + doubled_delta * 0.22 + isolated_delta * 0.26;

        // Typical ...Nxb4-type pattern: edge pawn gets dragged away from its file.
        if (src_file == 0 && to_file == 1) || (src_file == 7 && to_file == 6) {
            leverage += 0.34;
        }

        // If the source file becomes empty from opponent pawns, that file becomes easier to pressure.
        if (src_file == 0 || src_file == 7) && own_files[src_file] == 0 && virtual_opp[src_file] == 0 {
            leverage += 0.24;
        }

        // Reward semi-open pressure against the recapturing pawn.
        if own_files[to_file] == 0 && virtual_opp[to_file] > 0 {
            leverage += 0.12;
        }

        best = best.max(normalize(leverage, 1.25));
    }

    best
}

fn score_decoy_king_line_break(
    before: &Board,
    after: &Board,
    mv: &Move,
    mover: Color,
    opponent: Color,
) -> f32 {
    if mv.role() == Role::Pawn {
        return 0.0;
    }
    let Some(captured) = before.piece_at(mv.to()) else {
        return 0.0;
    };
    if captured.color != opponent || captured.role != Role::Pawn {
        return 0.0;
    }

    let Some((to_file, to_rank)) = square_to_coords(mv.to()) else {
        return 0.0;
    };
    let recapture_sources = pawn_recapture_source_files(before, to_file, to_rank, opponent);
    if recapture_sources.is_empty() {
        return 0.0;
    }

    let Some(opp_king) = king_square(after, opponent) else {
        return 0.0;
    };
    let Some((king_file, king_rank)) = square_to_coords(opp_king) else {
        return 0.0;
    };

    if !same_diagonal((to_file, to_rank), (king_file, king_rank)) {
        return 0.0;
    }

    // Check whether a bishop can realistically use the destination square as a follow-up lever.
    let bishops = after.bishops() & after.by_color(mover);
    let mut bishop_support = false;
    for sq in bishops {
        let Some((bf, br)) = square_to_coords(sq) else {
            continue;
        };
        if !same_diagonal((bf, br), (to_file, to_rank)) {
            continue;
        }
        if is_diagonal_path_clear(after, (bf, br), (to_file, to_rank)) {
            bishop_support = true;
            break;
        }
    }
    if !bishop_support {
        return 0.0;
    }

    let chebyshev = (king_file as i32 - to_file as i32)
        .abs()
        .max((king_rank as i32 - to_rank as i32).abs()) as f32;
    let proximity = (1.0 - ((chebyshev - 1.0) / 4.0).clamp(0.0, 1.0)).clamp(0.0, 1.0);
    let wing_bonus = if to_file == 1 || to_file == 6 { 0.16 } else { 0.10 };
    normalize(0.55 + 0.30 * proximity + wing_bonus, 1.15)
}

fn score_king_attack_complexity(
    before: &Board,
    after: &Board,
    attacker: Color,
    defender: Color,
    mv: &Move,
) -> f32 {
    let Some(king_sq_after) = king_square(after, defender) else {
        return 0.0;
    };
    let Some((king_file, king_rank)) = square_to_coords(king_sq_after) else {
        return 0.0;
    };

    // Focus on practically difficult king attacks against usually castled kings.
    let king_in_wing_zone = king_file <= 1 || king_file >= 6;
    if !king_in_wing_zone {
        return 0.0;
    }

    let pressure_before = king_ring_pressure(before, attacker, defender);
    let pressure_after = king_ring_pressure(after, attacker, defender);
    let pressure_gain = (pressure_after - pressure_before).max(0.0);

    let direct_check = is_square_attacked_by(after, attacker, king_sq_after);
    let mut forcing_targets = 0;
    for df in [-1i32, 0, 1] {
        for dr in [-1i32, 0, 1] {
            if df == 0 && dr == 0 {
                continue;
            }
            let nf = king_file as i32 + df;
            let nr = king_rank as i32 + dr;
            if !(0..=7).contains(&nf) || !(0..=7).contains(&nr) {
                continue;
            }
            let Some(sq) = coords_to_square(nf as usize, nr as usize) else {
                continue;
            };
            if is_square_attacked_by(after, attacker, sq) && !is_square_defended_by(after, defender, sq) {
                forcing_targets += 1;
            }
        }
    }

    let queen_knight_coord = queen_knight_coordination(after, attacker, king_sq_after) as f32;
    let move_is_king_zone_capture = if let Some((to_file, _)) = square_to_coords(mv.to()) {
        to_file == 6 || to_file == 7 || to_file == 0 || to_file == 1
    } else {
        false
    };

    let mut score: f32 = 0.0;
    score += pressure_gain * 0.95;
    score += forcing_targets as f32 * 0.13;
    score += queen_knight_coord * 0.10;
    if direct_check {
        score += 0.22;
    }
    if move_is_king_zone_capture {
        score += 0.12;
    }

    normalize(score, 1.7)
}

fn score_sacrificial_complexity(
    before: &Board,
    after: &Board,
    attacker: Color,
    defender: Color,
    mv: &Move,
) -> f32 {
    let moved_value = role_value(mv.role()) as i32;
    let captured_value = before
        .piece_at(mv.to())
        .map(|p| role_value(p.role) as i32)
        .unwrap_or(0);
    let material_investment = (moved_value - captured_value).max(0) as f32;
    if material_investment < 180.0 {
        return 0.0;
    }

    let under_enemy_fire = is_square_attacked_by(after, defender, mv.to());
    if !under_enemy_fire {
        return 0.0;
    }
    let lightly_defended = !is_square_defended_by(after, attacker, mv.to());

    let attack_gain =
        (king_ring_pressure(after, attacker, defender) - king_ring_pressure(before, attacker, defender)).max(0.0);

    let direct_king_attack = king_square(after, defender)
        .map(|k| is_square_attacked_by(after, attacker, k))
        .unwrap_or(false);

    let mut score = normalize(material_investment, 420.0) * 0.35 + normalize(attack_gain, 1.0) * 0.60;
    if direct_king_attack {
        score += 0.18;
    }
    if lightly_defended {
        score += 0.12;
    }

    normalize(score, 1.2)
}

fn score_pawn_avalanche(
    before: &Board,
    after: &Board,
    mover: Color,
    opponent: Color,
    mv: &Move,
) -> f32 {
    if mv.role() != Role::Pawn {
        return 0.0;
    }

    let before_passed = passed_pawns(before, mover, opponent);
    let after_passed = passed_pawns(after, mover, opponent);

    let delta_count = (after_passed.len() as i32 - before_passed.len() as i32).max(0) as f32;
    let before_adv = passed_advance_score(&before_passed, mover);
    let after_adv = passed_advance_score(&after_passed, mover);
    let delta_adv = (after_adv - before_adv).max(0.0);
    let before_conn = connected_passed_count(&before_passed);
    let after_conn = connected_passed_count(&after_passed);
    let delta_conn = after_conn.saturating_sub(before_conn) as f32;

    let mut value = delta_count * 0.40 + delta_adv * 0.45 + delta_conn * 0.40;
    if after_passed.iter().any(|&(_, rank)| is_near_promotion_rank(mover, rank)) {
        value += 0.25;
    }
    normalize(value, 2.0)
}

fn score_central_break_initiative(
    before: &Board,
    after: &Board,
    mover: Color,
    opponent: Color,
    mv: &Move,
) -> f32 {
    let Some((to_file, to_rank)) = square_to_coords(mv.to()) else {
        return 0.0;
    };
    if to_file != 3 && to_file != 4 {
        return 0.0;
    }

    let captured_is_pawn = before
        .piece_at(mv.to())
        .map(|p| p.color == opponent && p.role == Role::Pawn)
        .unwrap_or(false);
    let central_pawn_thrust = if mv.role() == Role::Pawn {
        if let Some(from_sq) = mv.from() {
            if let Some((from_file, from_rank)) = square_to_coords(from_sq) {
                let forward = if mover == Color::White {
                    to_rank > from_rank
                } else {
                    to_rank < from_rank
                };
                from_file == to_file && forward
            } else {
                false
            }
        } else {
            false
        }
    } else {
        false
    };

    if !captured_is_pawn && !central_pawn_thrust {
        return 0.0;
    }

    let moved_value = role_value(mv.role()) as f32;
    let investment = (moved_value - 100.0).max(0.0);
    let mut value: f32 = 0.0;
    if captured_is_pawn {
        value += normalize(investment, 500.0) * 0.35;
    } else if central_pawn_thrust {
        value += 0.22;
    }

    let own_after = pawn_file_counts(after, mover);
    let opp_after = pawn_file_counts(after, opponent);
    let own_before = pawn_file_counts(before, mover);
    let opp_before = pawn_file_counts(before, opponent);

    let central_open_gain = (heavy_piece_pressure_on_file(after, mover, &own_after, &opp_after, to_file)
        - heavy_piece_pressure_on_file(before, mover, &own_before, &opp_before, to_file))
    .max(0.0);
    value += central_open_gain * 0.45;

    let king_pressure_gain =
        (king_ring_pressure(after, mover, opponent) - king_ring_pressure(before, mover, opponent)).max(0.0);
    value += king_pressure_gain * 0.45;

    if central_pawn_thrust {
        let attacked_targets = attacked_valuable_targets_from_square(after, mv.to(), opponent) as f32;
        value += attacked_targets * 0.10;

        if is_square_defended_by(after, mover, mv.to()) {
            value += 0.10;
        }

        if (mover == Color::White && to_rank >= 4) || (mover == Color::Black && to_rank <= 3) {
            value += 0.08;
        }

        if let Some(opp_king_sq) = king_square(after, opponent) {
            if let Some((king_file, _)) = square_to_coords(opp_king_sq) {
                if (king_file as i32 - to_file as i32).abs() <= 2 {
                    value += 0.10;
                }
            }
        }
    }

    if (mv.role() == Role::Rook || mv.role() == Role::Queen)
        && ((mover == Color::White && to_rank >= 4) || (mover == Color::Black && to_rank <= 3))
    {
        value += 0.16;
    }

    normalize(value, 1.25)
}

fn score_infiltration_tension(
    before: &Board,
    after: &Board,
    mover: Color,
    opponent: Color,
    mv: &Move,
) -> f32 {
    if mv.role() == Role::Pawn || mv.role() == Role::King {
        return 0.0;
    }
    let Some((to_file, to_rank)) = square_to_coords(mv.to()) else {
        return 0.0;
    };
    let advanced = if mover == Color::White { to_rank >= 4 } else { to_rank <= 3 };
    if !advanced {
        return 0.0;
    }

    let defended = is_square_defended_by(after, mover, mv.to());
    let under_fire = is_square_attacked_by(after, opponent, mv.to());
    if under_fire && !defended {
        return 0.0;
    }

    let mobility_drop = (pseudo_mobility(before, opponent) - pseudo_mobility(after, opponent)).max(0) as f32;
    let knight_drop = (knight_freedom(before, opponent) - knight_freedom(after, opponent)).max(0) as f32;
    let attack_gain =
        (king_ring_pressure(after, mover, opponent) - king_ring_pressure(before, mover, opponent)).max(0.0);
    let attacked_targets = attacked_valuable_targets_from_square(after, mv.to(), opponent) as f32;

    let mut value = normalize(mobility_drop, 10.0) * 0.28
        + normalize(knight_drop, 5.0) * 0.18
        + normalize(attack_gain, 1.10) * 0.34
        + attacked_targets * 0.12;

    if defended {
        value += 0.10;
    }
    if under_fire {
        value += 0.05;
    }
    if mv.role() == Role::Rook && (to_file <= 1 || to_file >= 6) {
        value += 0.10;
    }

    normalize(value, 1.20)
}

fn score_king_net_setup(
    before: &Board,
    after: &Board,
    mover: Color,
    defender: Color,
    mv: &Move,
) -> f32 {
    if mv.role() == Role::Pawn || mv.role() == Role::King {
        return 0.0;
    }

    let Some(king_sq) = king_square(after, defender) else {
        return 0.0;
    };
    let Some((king_file, king_rank)) = square_to_coords(king_sq) else {
        return 0.0;
    };
    if king_file > 1 && king_file < 6 {
        return 0.0;
    }

    let Some((to_file, to_rank)) = square_to_coords(mv.to()) else {
        return 0.0;
    };
    let chebyshev =
        (king_file as i32 - to_file as i32).abs().max((king_rank as i32 - to_rank as i32).abs()) as f32;
    if chebyshev > 3.0 {
        return 0.0;
    }

    let defended = is_square_defended_by(after, mover, mv.to());
    let under_fire = is_square_attacked_by(after, defender, mv.to());
    if under_fire && !defended {
        return 0.0;
    }

    let ring_before = undefended_ring_targets(before, mover, defender, king_sq) as f32;
    let ring_after = undefended_ring_targets(after, mover, defender, king_sq) as f32;
    let ring_gain = (ring_after - ring_before).max(0.0);

    let targets = attacked_valuable_targets_from_square(after, mv.to(), defender) as f32;
    let near_king_bonus = normalize(3.0 - chebyshev, 3.0);
    let mut value = ring_gain * 0.42 + targets * 0.11 + near_king_bonus * 0.24;

    if mv.role() == Role::Queen && (to_file <= 1 || to_file >= 6) {
        value += 0.20;
    }
    if mv.role() == Role::Knight && chebyshev <= 2.0 {
        value += 0.14;
    }
    if mv.role() == Role::Bishop && same_diagonal((to_file, to_rank), (king_file, king_rank)) {
        value += 0.14;
    }
    if defended {
        value += 0.08;
    }
    if under_fire {
        value += 0.04;
    }

    normalize(value, 1.25)
}

fn score_counterplay_initiative(
    before: &Board,
    after: &Board,
    mover: Color,
    opponent: Color,
    mv: &Move,
) -> f32 {
    let Some(opp_king_sq) = king_square(after, opponent) else {
        return 0.0;
    };
    let Some((to_file, to_rank)) = square_to_coords(mv.to()) else {
        return 0.0;
    };
    let Some((opp_king_file, opp_king_rank)) = square_to_coords(opp_king_sq) else {
        return 0.0;
    };

    let own_pressure_before = king_ring_pressure(before, mover, opponent);
    let own_pressure_after = king_ring_pressure(after, mover, opponent);
    let own_gain = (own_pressure_after - own_pressure_before).max(0.0);
    if own_gain <= 0.0 {
        return 0.0;
    }

    let enemy_pressure_before = king_ring_pressure(before, opponent, mover);
    let ring_before = undefended_ring_targets(before, mover, opponent, opp_king_sq) as f32;
    let ring_after = undefended_ring_targets(after, mover, opponent, opp_king_sq) as f32;
    let ring_gain = (ring_after - ring_before).max(0.0);

    let before_own_files = pawn_file_counts(before, mover);
    let before_opp_files = pawn_file_counts(before, opponent);
    let after_own_files = pawn_file_counts(after, mover);
    let after_opp_files = pawn_file_counts(after, opponent);
    let file_pressure_gain = (heavy_piece_file_pressure(after, mover, &after_own_files, &after_opp_files)
        - heavy_piece_file_pressure(before, mover, &before_own_files, &before_opp_files))
    .max(0.0);

    let attacked_targets = attacked_valuable_targets_from_square(after, mv.to(), opponent) as f32;
    let chebyshev = (opp_king_file as i32 - to_file as i32)
        .abs()
        .max((opp_king_rank as i32 - to_rank as i32).abs()) as f32;
    let near_king = normalize((4.0 - chebyshev).max(0.0), 4.0);

    let mut value: f32 = own_gain * 0.42
        + ring_gain * 0.26
        + file_pressure_gain * 0.20
        + attacked_targets * 0.08
        + near_king * 0.12;

    if enemy_pressure_before > own_pressure_before + 0.15 {
        value += 0.20;
    }
    if (mv.role() == Role::Rook || mv.role() == Role::Queen)
        && ((mover == Color::White && to_rank >= 4) || (mover == Color::Black && to_rank <= 3))
    {
        value += 0.14;
    }
    if is_square_defended_by(after, mover, mv.to()) {
        value += 0.08;
    }

    normalize(value, 1.35)
}

fn score_piece_lift_assault(
    before: &Board,
    after: &Board,
    mover: Color,
    defender: Color,
    mv: &Move,
) -> f32 {
    if mv.role() != Role::Rook && mv.role() != Role::Queen {
        return 0.0;
    }
    let Some(from_sq) = mv.from() else {
        return 0.0;
    };
    let Some((from_file, from_rank)) = square_to_coords(from_sq) else {
        return 0.0;
    };
    let Some((to_file, to_rank)) = square_to_coords(mv.to()) else {
        return 0.0;
    };
    let Some(king_sq) = king_square(after, defender) else {
        return 0.0;
    };
    let Some((king_file, king_rank)) = square_to_coords(king_sq) else {
        return 0.0;
    };

    let from_back_rank = (mover == Color::White && from_rank == 0) || (mover == Color::Black && from_rank == 7);
    let advanced = (mover == Color::White && to_rank >= 3) || (mover == Color::Black && to_rank <= 4);
    let lateral_shift = from_file != to_file;
    if !advanced {
        return 0.0;
    }

    let chebyshev = (king_file as i32 - to_file as i32)
        .abs()
        .max((king_rank as i32 - to_rank as i32).abs()) as f32;
    if chebyshev > 4.0 {
        return 0.0;
    }

    let ring_before = undefended_ring_targets(before, mover, defender, king_sq) as f32;
    let ring_after = undefended_ring_targets(after, mover, defender, king_sq) as f32;
    let ring_gain = (ring_after - ring_before).max(0.0);
    let pressure_gain = (king_ring_pressure(after, mover, defender) - king_ring_pressure(before, mover, defender))
        .max(0.0);
    let attacked_targets = attacked_valuable_targets_from_square(after, mv.to(), defender) as f32;

    let mut value: f32 =
        ring_gain * 0.30 + pressure_gain * 0.46 + attacked_targets * 0.08 + normalize(4.0 - chebyshev, 4.0) * 0.18;
    if from_back_rank {
        value += 0.14;
    }
    if lateral_shift {
        value += 0.08;
    }
    if is_square_defended_by(after, mover, mv.to()) {
        value += 0.10;
    }

    normalize(value, 1.30)
}

fn score_local_attack_superiority(
    before: &Board,
    after: &Board,
    mover: Color,
    defender: Color,
    mv: &Move,
) -> f32 {
    let before_balance = local_attack_balance(before, mover, defender);
    let after_balance = local_attack_balance(after, mover, defender);
    let delta = (after_balance - before_balance).max(0.0);
    if delta <= 0.0 {
        return 0.0;
    }

    let direct_check = king_square(after, defender)
        .map(|k| is_square_attacked_by(after, mover, k))
        .unwrap_or(false);

    let mut value = delta * 0.60 + normalize(after_balance, 2.4) * 0.25;
    if direct_check {
        value += 0.12;
    }
    if attacked_valuable_targets_from_square(after, mv.to(), defender) >= 2 {
        value += 0.08;
    }
    if is_square_defended_by(after, mover, mv.to()) {
        value += 0.08;
    }

    normalize(value, 1.20)
}

fn score_initiative_compensation(
    before: &Board,
    after: &Board,
    mover: Color,
    opponent: Color,
    mv: &Move,
) -> f32 {
    let material_before = material_balance_cp(before, mover, opponent);
    if material_before > -80 {
        return 0.0;
    }

    let pressure_gain =
        (king_ring_pressure(after, mover, opponent) - king_ring_pressure(before, mover, opponent)).max(0.0);
    let local_gain = (local_attack_balance(after, mover, opponent) - local_attack_balance(before, mover, opponent))
        .max(0.0);
    let mobility_gain = (pseudo_mobility(after, mover) - pseudo_mobility(before, mover)).max(0) as f32;

    let before_own_files = pawn_file_counts(before, mover);
    let before_opp_files = pawn_file_counts(before, opponent);
    let after_own_files = pawn_file_counts(after, mover);
    let after_opp_files = pawn_file_counts(after, opponent);
    let file_gain = (heavy_piece_file_pressure(after, mover, &after_own_files, &after_opp_files)
        - heavy_piece_file_pressure(before, mover, &before_own_files, &before_opp_files))
    .max(0.0);

    let check_bonus = king_square(after, opponent)
        .map(|k| is_square_attacked_by(after, mover, k))
        .unwrap_or(false);
    let defended = is_square_defended_by(after, mover, mv.to());

    let mut value: f32 = normalize(-material_before as f32, 700.0) * 0.24
        + normalize(pressure_gain, 1.20) * 0.34
        + normalize(local_gain, 2.20) * 0.28
        + normalize(mobility_gain, 14.0) * 0.16
        + file_gain * 0.12;

    if check_bonus {
        value += 0.12;
    }
    if defended {
        value += 0.08;
    }
    if attacked_valuable_targets_from_square(after, mv.to(), opponent) >= 2 {
        value += 0.08;
    }

    normalize(value, 1.20)
}

fn score_outpost_control(before: &Board, after: &Board, mover: Color, opponent: Color, mv: &Move) -> f32 {
    if mv.role() != Role::Knight && mv.role() != Role::Bishop {
        return 0.0;
    }

    let destination = outpost_square_value(after, mover, opponent, mv.role(), mv.to());
    if destination <= 0.0 {
        return 0.0;
    }

    let origin = mv
        .from()
        .and_then(|sq| Some(outpost_square_value(before, mover, opponent, mv.role(), sq)))
        .unwrap_or(0.0);

    (destination - origin).max(0.0)
}

fn outpost_square_value(board: &Board, mover: Color, opponent: Color, role: Role, sq: Square) -> f32 {
    let Some((file, rank)) = square_to_coords(sq) else {
        return 0.0;
    };
    if !is_enemy_territory(mover, rank) {
        return 0.0;
    }

    let attacked_by_enemy_pawn = is_square_attacked_by_pawn(board, opponent, sq);
    let stability = if attacked_by_enemy_pawn { 0.18 } else { 0.72 };
    let pawn_absence = outpost_enemy_pawn_absence(board, opponent, file, rank);
    let king_proximity = king_square(board, opponent)
        .and_then(square_to_coords)
        .map(|(kf, kr)| {
            let chebyshev =
                (kf as i32 - file as i32).abs().max((kr as i32 - rank as i32).abs()) as f32;
            normalize((5.0 - chebyshev).max(0.0), 5.0)
        })
        .unwrap_or(0.0);
    let targets = normalize(attacked_valuable_targets_from_square(board, sq, opponent) as f32, 4.0);
    let piece_factor = if role == Role::Knight { 1.0 } else { 0.86 };

    (stability * 0.38 + pawn_absence * 0.27 + king_proximity * 0.20 + targets * 0.15)
        .mul_add(piece_factor, 0.0)
        .clamp(0.0, 1.0)
}

fn score_color_complex_weakness(before: &Board, after: &Board, mover: Color, opponent: Color) -> f32 {
    let before_pressure = color_complex_pressure(before, mover, opponent);
    let after_pressure = color_complex_pressure(after, mover, opponent);
    (after_pressure - before_pressure).max(0.0)
}

fn color_complex_pressure(board: &Board, attacker: Color, defender: Color) -> f32 {
    let Some(king_sq) = king_square(board, defender) else {
        return 0.0;
    };
    let Some((king_file, king_rank)) = square_to_coords(king_sq) else {
        return 0.0;
    };

    let (def_has_dark_bishop, def_has_light_bishop) = bishop_color_presence(board, defender);
    let mut weak_dark = 0.0f32;
    let mut weak_light = 0.0f32;
    let mut access_dark = 0.0f32;
    let mut access_light = 0.0f32;

    for df in -2i32..=2 {
        for dr in -2i32..=2 {
            if df == 0 && dr == 0 {
                continue;
            }
            let nf = king_file as i32 + df;
            let nr = king_rank as i32 + dr;
            if !(0..=7).contains(&nf) || !(0..=7).contains(&nr) {
                continue;
            }
            let Some(sq) = coords_to_square(nf as usize, nr as usize) else {
                continue;
            };

            let attacked = is_square_attacked_by(board, attacker, sq);
            let defended = is_square_defended_by(board, defender, sq);
            if !attacked {
                continue;
            }
            let weak_weight = if defended { 0.55 } else { 1.0 };
            let minor_access = minor_attackers_on_square(board, attacker, sq) as f32;
            let is_dark = (nf + nr) % 2 == 0;

            if is_dark {
                weak_dark += weak_weight;
                access_dark += minor_access;
            } else {
                weak_light += weak_weight;
                access_light += minor_access;
            }
        }
    }

    let dark_absence = if def_has_dark_bishop { 0.35 } else { 1.0 };
    let light_absence = if def_has_light_bishop { 0.35 } else { 1.0 };

    let dark_score = weak_dark * (0.55 + 0.30 * dark_absence + 0.15 * normalize(access_dark, 8.0));
    let light_score = weak_light * (0.55 + 0.30 * light_absence + 0.15 * normalize(access_light, 8.0));

    normalize(dark_score.max(light_score), 7.0)
}

fn score_bad_piece_detection(before: &Board, after: &Board, mover: Color, opponent: Color) -> f32 {
    let own_before = bad_piece_index(before, mover, opponent);
    let own_after = bad_piece_index(after, mover, opponent);
    let opp_before = bad_piece_index(before, opponent, mover);
    let opp_after = bad_piece_index(after, opponent, mover);

    let own_improvement = (own_before - own_after).max(0.0);
    let opp_worsening = (opp_after - opp_before).max(0.0);
    normalize(own_improvement * 0.72 + opp_worsening * 0.58, 1.2)
}

fn bad_piece_index(board: &Board, color: Color, opponent: Color) -> f32 {
    let own_pawns = pawn_file_counts(board, color);
    let mut penalties = 0.0f32;
    let mut piece_count = 0.0f32;

    for from in board.by_color(color) {
        let Some(piece) = board.piece_at(from) else {
            continue;
        };
        if piece.role == Role::Pawn || piece.role == Role::King {
            continue;
        }
        piece_count += 1.0;

        let mobility = piece_mobility_non_friendly(board, color, from) as f32;
        let baseline = role_mobility_baseline(piece.role);
        let mut penalty = if baseline > 0.0 {
            ((baseline - mobility).max(0.0) / baseline).clamp(0.0, 1.0)
        } else {
            0.0
        };

        if piece.role == Role::Bishop && mobility <= 2.0 {
            penalty += 0.18;
        }
        if piece.role == Role::Knight && mobility <= 2.0 {
            penalty += 0.14;
        }
        if piece.role == Role::Rook {
            if let Some((file, _)) = square_to_coords(from) {
                if own_pawns[file] > 0 {
                    penalty += 0.16;
                }
            }
            if mobility <= 3.0 {
                penalty += 0.12;
            }
        }
        if piece.role == Role::Queen && mobility <= 5.0 {
            penalty += 0.08;
        }
        if attacked_valuable_targets_from_square(board, from, opponent) == 0 {
            penalty += 0.10;
        }

        penalties += penalty.clamp(0.0, 1.6);
    }

    if piece_count == 0.0 {
        0.0
    } else {
        (penalties / piece_count).clamp(0.0, 1.6)
    }
}

fn score_piece_coordination(before: &Board, after: &Board, mover: Color, opponent: Color) -> f32 {
    let before_idx = piece_coordination_index(before, mover, opponent);
    let after_idx = piece_coordination_index(after, mover, opponent);
    (after_idx - before_idx).max(0.0)
}

fn piece_coordination_index(board: &Board, side: Color, opponent: Color) -> f32 {
    let Some(opp_king) = king_square(board, opponent) else {
        return 0.0;
    };
    let Some((king_file, king_rank)) = square_to_coords(opp_king) else {
        return 0.0;
    };

    let ring_attackers = pieces_attacking_king_ring(board, side, king_file, king_rank) as f32;
    let defended_units = defended_major_minor_count(board, side) as f32;
    let near_king_supported = near_king_supported_count(board, side, opponent) as f32;
    let qn_coord = queen_knight_coordination(board, side, opp_king) as f32;

    normalize(
        ring_attackers * 0.24 + defended_units * 0.14 + near_king_supported * 0.12 + qn_coord * 0.22,
        3.6,
    )
}

fn score_prophylaxis(before: &Board, after: &Board, mover: Color, opponent: Color, mv: &Move) -> f32 {
    let opp_threat_before = threat_index(before, opponent, mover);
    let opp_threat_after = threat_index(after, opponent, mover);
    let threat_reduction = (opp_threat_before - opp_threat_after).max(0.0);

    let break_before = opponent_break_options(before, opponent, mover);
    let break_after = opponent_break_options(after, opponent, mover);
    let break_reduction = (break_before - break_after).max(0.0);

    let own_plan_gain =
        (king_ring_pressure(after, mover, opponent) - king_ring_pressure(before, mover, opponent)).max(0.0);
    let own_plan_drop =
        (king_ring_pressure(before, mover, opponent) - king_ring_pressure(after, mover, opponent)).max(0.0);

    let mut value = threat_reduction * 0.56 + break_reduction * 0.30 + own_plan_gain * 0.20;
    if mv.role() == Role::Pawn {
        if let Some((file, _)) = square_to_coords(mv.to()) {
            if (file <= 1 || file >= 6) && break_reduction > 0.0 {
                value += 0.10;
            }
        }
    }
    if own_plan_drop > own_plan_gain + 0.20 {
        value *= 0.65;
    }

    normalize(value, 1.45)
}

fn score_trade_favorability(before: &Board, after: &Board, mover: Color, opponent: Color, mv: &Move) -> f32 {
    let Some(captured_piece) = before.piece_at(mv.to()) else {
        return 0.0;
    };
    if captured_piece.color != opponent {
        return 0.0;
    }

    let captured_value = role_value(captured_piece.role) as f32;
    let moved_value = role_value(mv.role()) as f32;
    let investment_penalty = (moved_value - captured_value).max(0.0);
    if investment_penalty > 180.0 && !is_square_defended_by(after, mover, mv.to()) {
        return 0.0;
    }

    let material_before = material_balance_cp(before, mover, opponent) as f32;
    let material_after = material_balance_cp(after, mover, opponent) as f32;
    let material_gain = material_after - material_before;
    let pressure_gain =
        (king_ring_pressure(after, mover, opponent) - king_ring_pressure(before, mover, opponent)).max(0.0);
    let local_gain =
        (local_attack_balance(after, mover, opponent) - local_attack_balance(before, mover, opponent)).max(0.0);

    let defender_removed_bonus = king_square(before, opponent)
        .and_then(square_to_coords)
        .and_then(|(kf, kr)| square_to_coords(mv.to()).map(|(tf, tr)| (kf, kr, tf, tr)))
        .map(|(kf, kr, tf, tr)| {
            let chebyshev = (kf as i32 - tf as i32).abs().max((kr as i32 - tr as i32).abs());
            if chebyshev <= 2 { 0.20 } else { 0.0 }
        })
        .unwrap_or(0.0);

    let mut value = normalize((captured_value + material_gain * 0.90 - investment_penalty * 0.55).max(0.0), 720.0)
        * 0.46
        + normalize(pressure_gain, 1.10) * 0.30
        + normalize(local_gain, 2.20) * 0.18
        + defender_removed_bonus;
    if captured_piece.role == Role::Queen && material_before >= 0.0 {
        value += 0.10;
    }

    normalize(value, 1.25)
}

fn king_ring_pressure(board: &Board, attacker: Color, defender: Color) -> f32 {
    let Some(king_sq) = king_square(board, defender) else {
        return 0.0;
    };
    let Some((king_file, king_rank)) = square_to_coords(king_sq) else {
        return 0.0;
    };

    let attacked_by_attacker = attacked_coords(board, attacker);
    let attacked_by_defender = attacked_coords(board, defender);
    let mut ring_attack = 0;
    let mut ring_defense = 0;

    for df in [-1i32, 0, 1] {
        for dr in [-1i32, 0, 1] {
            if df == 0 && dr == 0 {
                continue;
            }
            let nf = king_file as i32 + df;
            let nr = king_rank as i32 + dr;
            if !(0..=7).contains(&nf) || !(0..=7).contains(&nr) {
                continue;
            }
            if attacked_by_attacker.contains(&(nf as usize, nr as usize)) {
                ring_attack += 1;
            }
            if attacked_by_defender.contains(&(nf as usize, nr as usize)) {
                ring_defense += 1;
            }
        }
    }

    let attacking_pieces = pieces_attacking_king_ring(board, attacker, king_file, king_rank) as f32;
    ring_attack as f32 * 0.12 + attacking_pieces * 0.18 - ring_defense as f32 * 0.06
}

fn pieces_attacking_king_ring(board: &Board, side: Color, king_file: usize, king_rank: usize) -> i32 {
    let mut count = 0;
    for from in board.by_color(side) {
        let Some(piece) = board.piece_at(from) else {
            continue;
        };
        if piece.role == Role::Pawn || piece.role == Role::King {
            continue;
        }
        let mut touches_ring = false;
        for to in board.attacks_from(from) {
            let Some((tf, tr)) = square_to_coords(to) else {
                continue;
            };
            if (tf as i32 - king_file as i32).abs() <= 1 && (tr as i32 - king_rank as i32).abs() <= 1 {
                touches_ring = true;
                break;
            }
        }
        if touches_ring {
            count += 1;
        }
    }
    count
}

fn undefended_ring_targets(board: &Board, attacker: Color, defender: Color, king_sq: Square) -> i32 {
    let Some((king_file, king_rank)) = square_to_coords(king_sq) else {
        return 0;
    };
    let mut count = 0;
    for df in [-1i32, 0, 1] {
        for dr in [-1i32, 0, 1] {
            if df == 0 && dr == 0 {
                continue;
            }
            let nf = king_file as i32 + df;
            let nr = king_rank as i32 + dr;
            if !(0..=7).contains(&nf) || !(0..=7).contains(&nr) {
                continue;
            }
            let Some(sq) = coords_to_square(nf as usize, nr as usize) else {
                continue;
            };
            if is_square_attacked_by(board, attacker, sq) && !is_square_defended_by(board, defender, sq) {
                count += 1;
            }
        }
    }
    count
}

fn local_attack_balance(board: &Board, attacker: Color, defender: Color) -> f32 {
    let Some(king_sq) = king_square(board, defender) else {
        return 0.0;
    };
    let Some((king_file, king_rank)) = square_to_coords(king_sq) else {
        return 0.0;
    };

    let attackers = pieces_attacking_king_ring(board, attacker, king_file, king_rank) as f32;
    let defenders = pieces_attacking_king_ring(board, defender, king_file, king_rank) as f32;
    let undefended = undefended_ring_targets(board, attacker, defender, king_sq) as f32;

    attackers * 0.46 + undefended * 0.30 - defenders * 0.24
}

fn queen_knight_coordination(board: &Board, side: Color, target_king: Square) -> i32 {
    let queen_squares = board.queens() & board.by_color(side);
    let knight_squares = board.knights() & board.by_color(side);
    if queen_squares.is_empty() || knight_squares.is_empty() {
        return 0;
    }
    let Some((kf, kr)) = square_to_coords(target_king) else {
        return 0;
    };

    let mut queen_near = false;
    for q in queen_squares {
        for to in board.attacks_from(q) {
            let Some((tf, tr)) = square_to_coords(to) else {
                continue;
            };
            if (tf as i32 - kf as i32).abs() <= 2 && (tr as i32 - kr as i32).abs() <= 2 {
                queen_near = true;
                break;
            }
        }
        if queen_near {
            break;
        }
    }

    let mut knight_near = false;
    for n in knight_squares {
        for to in board.attacks_from(n) {
            let Some((tf, tr)) = square_to_coords(to) else {
                continue;
            };
            if (tf as i32 - kf as i32).abs() <= 2 && (tr as i32 - kr as i32).abs() <= 2 {
                knight_near = true;
                break;
            }
        }
        if knight_near {
            break;
        }
    }

    if queen_near && knight_near {
        2
    } else if queen_near || knight_near {
        1
    } else {
        0
    }
}

fn role_value(role: Role) -> u16 {
    match role {
        Role::Pawn => 100,
        Role::Knight => 320,
        Role::Bishop => 330,
        Role::Rook => 500,
        Role::Queen => 900,
        Role::King => 20_000,
    }
}

fn material_balance_cp(board: &Board, side: Color, opponent: Color) -> i32 {
    fn material_for(board: &Board, color: Color) -> i32 {
        let mut total = 0i32;
        for sq in board.by_color(color) {
            let Some(piece) = board.piece_at(sq) else {
                continue;
            };
            if piece.role == Role::King {
                continue;
            }
            total += role_value(piece.role) as i32;
        }
        total
    }
    material_for(board, side) - material_for(board, opponent)
}

fn non_king_piece_total(board: &Board) -> i32 {
    let mut total = 0;
    for side in [Color::White, Color::Black] {
        for sq in board.by_color(side) {
            let Some(piece) = board.piece_at(sq) else {
                continue;
            };
            if piece.role != Role::King {
                total += 1;
            }
        }
    }
    total
}

fn has_queen(board: &Board, side: Color) -> bool {
    !(board.queens() & board.by_color(side)).is_empty()
}

fn central_tension_pairs(board: &Board) -> i32 {
    let mut pairs = 0;
    let white_pawns = board.pawns() & board.by_color(Color::White);
    for sq in white_pawns {
        let Some((file, rank)) = square_to_coords(sq) else {
            continue;
        };
        if !(2..=5).contains(&file) || !(2..=5).contains(&rank) {
            continue;
        }
        for df in [-1i32, 1] {
            let nf = file as i32 + df;
            let nr = rank as i32 + 1;
            if !(0..=7).contains(&nf) || !(0..=7).contains(&nr) {
                continue;
            }
            if has_pawn_at(board, Color::Black, nf as usize, nr as usize) {
                pairs += 1;
            }
        }
    }
    pairs
}

fn king_activity_index(board: &Board, side: Color) -> f32 {
    let Some(king_sq) = king_square(board, side) else {
        return 0.0;
    };
    let Some((f, r)) = square_to_coords(king_sq) else {
        return 0.0;
    };
    let center_dist = ((f as i32 - 3).abs().min((f as i32 - 4).abs())
        + (r as i32 - 3).abs().min((r as i32 - 4).abs())) as f32;
    (1.0 - (center_dist / 6.0)).clamp(0.0, 1.0)
}

fn is_enemy_territory(color: Color, rank: usize) -> bool {
    if color == Color::White {
        rank >= 4
    } else {
        rank <= 3
    }
}

fn is_square_attacked_by_pawn(board: &Board, side: Color, target: Square) -> bool {
    let pawns = board.pawns() & board.by_color(side);
    for from in pawns {
        if board.attacks_from(from).contains(target) {
            return true;
        }
    }
    false
}

fn outpost_enemy_pawn_absence(board: &Board, opponent: Color, file: usize, rank: usize) -> f32 {
    let mut challengers = 0.0f32;
    let pawns = board.pawns() & board.by_color(opponent);
    for sq in pawns {
        let Some((pf, pr)) = square_to_coords(sq) else {
            continue;
        };
        if (pf as i32 - file as i32).abs() != 1 {
            continue;
        }
        let can_challenge = if opponent == Color::White {
            pr <= rank
        } else {
            pr >= rank
        };
        if can_challenge {
            challengers += 1.0;
        }
    }
    (1.0 - (challengers / 2.0)).clamp(0.0, 1.0)
}

fn bishop_color_presence(board: &Board, side: Color) -> (bool, bool) {
    let bishops = board.bishops() & board.by_color(side);
    let mut has_dark = false;
    let mut has_light = false;
    for sq in bishops {
        let Some((file, rank)) = square_to_coords(sq) else {
            continue;
        };
        if (file + rank) % 2 == 0 {
            has_dark = true;
        } else {
            has_light = true;
        }
    }
    (has_dark, has_light)
}

fn minor_attackers_on_square(board: &Board, side: Color, target: Square) -> i32 {
    let mut count = 0;
    for from in board.by_color(side) {
        let Some(piece) = board.piece_at(from) else {
            continue;
        };
        if piece.role != Role::Knight && piece.role != Role::Bishop {
            continue;
        }
        if board.attacks_from(from).contains(target) {
            count += 1;
        }
    }
    count
}

fn piece_mobility_non_friendly(board: &Board, side: Color, from: Square) -> i32 {
    let mut mobility = 0;
    for to in board.attacks_from(from) {
        if !board.by_color(side).contains(to) {
            mobility += 1;
        }
    }
    mobility
}

fn role_mobility_baseline(role: Role) -> f32 {
    match role {
        Role::Knight => 4.0,
        Role::Bishop => 7.0,
        Role::Rook => 8.0,
        Role::Queen => 12.0,
        _ => 0.0,
    }
}

fn defended_major_minor_count(board: &Board, side: Color) -> i32 {
    let mut count = 0;
    for sq in board.by_color(side) {
        let Some(piece) = board.piece_at(sq) else {
            continue;
        };
        if piece.role == Role::Pawn || piece.role == Role::King {
            continue;
        }
        if is_square_defended_by(board, side, sq) {
            count += 1;
        }
    }
    count
}

fn near_king_supported_count(board: &Board, side: Color, defender: Color) -> i32 {
    let Some(king_sq) = king_square(board, defender) else {
        return 0;
    };
    let Some((kf, kr)) = square_to_coords(king_sq) else {
        return 0;
    };

    let mut count = 0;
    for sq in board.by_color(side) {
        let Some(piece) = board.piece_at(sq) else {
            continue;
        };
        if piece.role == Role::Pawn || piece.role == Role::King {
            continue;
        }
        let Some((f, r)) = square_to_coords(sq) else {
            continue;
        };
        let chebyshev = (f as i32 - kf as i32).abs().max((r as i32 - kr as i32).abs());
        if chebyshev <= 3 && is_square_defended_by(board, side, sq) {
            count += 1;
        }
    }
    count
}

fn threat_index(board: &Board, attacker: Color, defender: Color) -> f32 {
    let attacker_files = pawn_file_counts(board, attacker);
    let defender_files = pawn_file_counts(board, defender);
    let king_pressure = central_king_pressure(board, attacker, defender, &attacker_files, &defender_files);
    let ring_pressure = king_ring_pressure(board, attacker, defender);
    let loose_pawns = loose_pawns_under_attack(board, attacker, defender) as f32;
    ring_pressure * 0.95 + king_pressure * 0.60 + loose_pawns * 0.18
}

fn opponent_break_options(board: &Board, side: Color, enemy: Color) -> f32 {
    let pawns = board.pawns() & board.by_color(side);
    let step = if side == Color::White { 1i32 } else { -1i32 };
    let mut score = 0.0f32;

    for from in pawns {
        let Some((file, rank)) = square_to_coords(from) else {
            continue;
        };
        let next_rank = rank as i32 + step;
        if !(0..=7).contains(&next_rank) {
            continue;
        }
        let Some(next_sq) = coords_to_square(file, next_rank as usize) else {
            continue;
        };

        if board.piece_at(next_sq).is_none() {
            if (2..=5).contains(&file) {
                score += 1.0;
            } else if file == 1 || file == 6 {
                score += 0.6;
            }
        }

        for df in [-1i32, 1] {
            let nf = file as i32 + df;
            if !(0..=7).contains(&nf) {
                continue;
            }
            let Some(capture_sq) = coords_to_square(nf as usize, next_rank as usize) else {
                continue;
            };
            if matches!(board.piece_at(capture_sq), Some(p) if p.color == enemy && p.role == Role::Pawn) {
                score += 0.4;
            }
        }
    }

    score
}

fn passed_pawns(board: &Board, color: Color, opponent: Color) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let pawns = board.pawns() & board.by_color(color);
    for sq in pawns {
        let Some((file, rank)) = square_to_coords(sq) else {
            continue;
        };
        if is_passed_pawn(board, color, opponent, file, rank) {
            out.push((file, rank));
        }
    }
    out
}

fn is_passed_pawn(board: &Board, color: Color, opponent: Color, file: usize, rank: usize) -> bool {
    let opp_pawns = board.pawns() & board.by_color(opponent);
    for sq in opp_pawns {
        let Some((of, orank)) = square_to_coords(sq) else {
            continue;
        };
        if (of as i32 - file as i32).abs() > 1 {
            continue;
        }
        let blocks = if color == Color::White {
            orank >= rank
        } else {
            orank <= rank
        };
        if blocks {
            return false;
        }
    }
    true
}

fn passed_advance_score(passers: &[(usize, usize)], color: Color) -> f32 {
    passers
        .iter()
        .map(|&(_, rank)| if color == Color::White { rank as f32 } else { (7 - rank) as f32 })
        .sum::<f32>()
        / 7.0
}

fn connected_passed_count(passers: &[(usize, usize)]) -> usize {
    let mut count = 0usize;
    for (i, (file, _rank)) in passers.iter().enumerate() {
        if passers
            .iter()
            .enumerate()
            .any(|(j, (of, _))| i != j && (*of as i32 - *file as i32).abs() == 1)
        {
            count += 1;
        }
    }
    count / 2
}

fn is_near_promotion_rank(color: Color, rank: usize) -> bool {
    if color == Color::White {
        rank >= 5
    } else {
        rank <= 2
    }
}

fn normalize(value: f32, cap: f32) -> f32 {
    if cap <= 0.0 {
        return 0.0;
    }
    (value / cap).clamp(0.0, 1.0)
}

fn pawn_recapture_source_files(
    board: &Board,
    target_file: usize,
    target_rank: usize,
    side: Color,
) -> Vec<usize> {
    let Some(from_rank) = (if side == Color::White {
        target_rank.checked_sub(1)
    } else if target_rank < 7 {
        Some(target_rank + 1)
    } else {
        None
    }) else {
        return Vec::new();
    };

    let mut files = Vec::new();
    if target_file > 0 && has_pawn_at(board, side, target_file - 1, from_rank) {
        files.push(target_file - 1);
    }
    if target_file < 7 && has_pawn_at(board, side, target_file + 1, from_rank) {
        files.push(target_file + 1);
    }
    files
}

fn has_pawn_at(board: &Board, color: Color, file: usize, rank: usize) -> bool {
    let Some(square) = coords_to_square(file, rank) else {
        return false;
    };
    matches!(
        board.piece_at(square),
        Some(piece) if piece.color == color && piece.role == Role::Pawn
    )
}

fn isolated_pawns_from_file_counts(file_counts: &[u8; 8]) -> i32 {
    let mut isolated = 0i32;
    for file in 0..8 {
        let count = file_counts[file] as i32;
        if count == 0 {
            continue;
        }
        let left_has = file > 0 && file_counts[file - 1] > 0;
        let right_has = file < 7 && file_counts[file + 1] > 0;
        if !left_has && !right_has {
            isolated += count;
        }
    }
    isolated
}

fn same_diagonal(a: (usize, usize), b: (usize, usize)) -> bool {
    if a.0 > 7 || a.1 > 7 || b.0 > 7 || b.1 > 7 {
        return false;
    }
    (a.0 as i32 - b.0 as i32).abs() == (a.1 as i32 - b.1 as i32).abs()
}

fn is_diagonal_path_clear(board: &Board, from: (usize, usize), to: (usize, usize)) -> bool {
    if from.0 > 7 || from.1 > 7 || to.0 > 7 || to.1 > 7 {
        return false;
    }
    if from == to {
        return true;
    }
    if !same_diagonal(from, to) {
        return false;
    }

    let step_file = if to.0 > from.0 { 1i32 } else { -1i32 };
    let step_rank = if to.1 > from.1 { 1i32 } else { -1i32 };
    let Some(mut file) = (from.0 as i32).checked_add(step_file) else {
        return false;
    };
    let Some(mut rank) = (from.1 as i32).checked_add(step_rank) else {
        return false;
    };

    while file != to.0 as i32 || rank != to.1 as i32 {
        if !(0..=7).contains(&file) || !(0..=7).contains(&rank) {
            return false;
        }
        let uf = file as usize;
        let ur = rank as usize;
        if let Some(square) = coords_to_square(uf, ur) {
            if board.piece_at(square).is_some() {
                return false;
            }
        }
        let Some(next_file) = file.checked_add(step_file) else {
            return false;
        };
        let Some(next_rank) = rank.checked_add(step_rank) else {
            return false;
        };
        file = next_file;
        rank = next_rank;
    }

    true
}

fn coords_to_square(file: usize, rank: usize) -> Option<Square> {
    if file > 7 || rank > 7 {
        return None;
    }
    let file_c = b'a'.checked_add(file as u8)? as char;
    let rank_c = b'1'.checked_add(rank as u8)? as char;
    let name = format!("{file_c}{rank_c}");
    name.parse::<Square>().ok()
}

fn square_to_coords(square: Square) -> Option<(usize, usize)> {
    let s = square.to_string();
    let b = s.as_bytes();
    if b.len() != 2 {
        return None;
    }
    if !(b'a'..=b'h').contains(&b[0]) || !(b'1'..=b'8').contains(&b[1]) {
        return None;
    }
    Some(((b[0] - b'a') as usize, (b[1] - b'1') as usize))
}

fn pawn_file_counts(board: &Board, color: Color) -> [u8; 8] {
    let mut files = [0u8; 8];
    let pawns = board.pawns() & board.by_color(color);
    for sq in pawns {
        if let Some((file, _)) = square_to_coords(sq) {
            files[file] = files[file].saturating_add(1);
        }
    }
    files
}

fn pawn_islands(file_counts: &[u8; 8]) -> i32 {
    let mut islands = 0;
    for i in 0..8 {
        if file_counts[i] > 0 && (i == 0 || file_counts[i - 1] == 0) {
            islands += 1;
        }
    }
    islands
}

fn doubled_pawns(file_counts: &[u8; 8]) -> i32 {
    file_counts
        .iter()
        .map(|c| (*c as i32 - 1).max(0))
        .sum()
}

fn isolated_pawns(board: &Board, color: Color, file_counts: &[u8; 8]) -> i32 {
    let mut isolated = 0;
    let pawns = board.pawns() & board.by_color(color);
    for sq in pawns {
        let Some((file, _)) = square_to_coords(sq) else {
            continue;
        };
        let left_has = file > 0 && file_counts[file - 1] > 0;
        let right_has = file < 7 && file_counts[file + 1] > 0;
        if !left_has && !right_has {
            isolated += 1;
        }
    }
    isolated
}

fn fixed_pawns_by_enemy_pawns(board: &Board, target: Color, blocker: Color) -> i32 {
    let blocker_pawns = board.pawns() & board.by_color(blocker);
    let mut blocker_coords = HashSet::new();
    for sq in blocker_pawns {
        if let Some(c) = square_to_coords(sq) {
            blocker_coords.insert(c);
        }
    }

    let target_pawns = board.pawns() & board.by_color(target);
    let step: i32 = if target == Color::White { 1 } else { -1 };
    let mut fixed = 0;

    for sq in target_pawns {
        let Some((file, rank)) = square_to_coords(sq) else {
            continue;
        };
        let next_rank = rank as i32 + step;
        if !(0..=7).contains(&next_rank) {
            continue;
        }
        if blocker_coords.contains(&(file, next_rank as usize)) {
            fixed += 1;
        }
    }

    fixed
}

fn is_square_attacked_by(board: &Board, side: Color, target: Square) -> bool {
    for from in board.by_color(side) {
        if board.attacks_from(from).contains(target) {
            return true;
        }
    }
    false
}

fn is_square_defended_by(board: &Board, side: Color, target: Square) -> bool {
    is_square_attacked_by(board, side, target)
}

fn loose_pawns_under_attack(board: &Board, attacker: Color, defender: Color) -> i32 {
    let mut count = 0;
    let pawns = board.pawns() & board.by_color(defender);
    for sq in pawns {
        if !is_square_defended_by(board, defender, sq) && is_square_attacked_by(board, attacker, sq) {
            count += 1;
        }
    }
    count
}

fn direct_loose_pawn_attacks_from_move(board: &Board, mv: &Move, defender: Color) -> i32 {
    let mut count = 0;
    let attacked = board.attacks_from(mv.to()) & (board.pawns() & board.by_color(defender));
    for sq in attacked {
        if !is_square_defended_by(board, defender, sq) {
            count += 1;
        }
    }
    count
}

fn advanced_pawns(board: &Board, color: Color) -> i32 {
    let mut count = 0;
    let pawns = board.pawns() & board.by_color(color);
    for sq in pawns {
        let Some((_, rank)) = square_to_coords(sq) else {
            continue;
        };
        if (color == Color::White && rank >= 3) || (color == Color::Black && rank <= 4) {
            count += 1;
        }
    }
    count
}

fn central_control(board: &Board, color: Color) -> i32 {
    let mut attacked_coords: HashSet<(usize, usize)> = HashSet::new();
    for from in board.by_color(color) {
        for to in board.attacks_from(from) {
            let Some((file, rank)) = square_to_coords(to) else {
                continue;
            };
            // c4..f5 rectangle
            if (2..=5).contains(&file) && (3..=4).contains(&rank) {
                attacked_coords.insert((file, rank));
            }
        }
    }
    attacked_coords.len() as i32
}

fn heavy_piece_file_pressure(board: &Board, color: Color, own_pawns: &[u8; 8], opp_pawns: &[u8; 8]) -> f32 {
    let mut score = 0.0;
    for from in board.by_color(color) {
        let Some(piece) = board.piece_at(from) else {
            continue;
        };
        if piece.role != Role::Rook && piece.role != Role::Queen {
            continue;
        }
        let Some((file, _)) = square_to_coords(from) else {
            continue;
        };
        if own_pawns[file] == 0 {
            score += if opp_pawns[file] == 0 { 1.0 } else { 0.65 };
            if file == 3 || file == 4 {
                score += 0.25;
            }
        }
    }
    score
}

fn heavy_piece_pressure_on_file(
    board: &Board,
    color: Color,
    own_pawns: &[u8; 8],
    opp_pawns: &[u8; 8],
    target_file: usize,
) -> f32 {
    let mut score = 0.0;
    for from in board.by_color(color) {
        let Some(piece) = board.piece_at(from) else {
            continue;
        };
        if piece.role != Role::Rook && piece.role != Role::Queen {
            continue;
        }
        let Some((file, _)) = square_to_coords(from) else {
            continue;
        };
        if file != target_file {
            continue;
        }
        if own_pawns[file] == 0 {
            score += if opp_pawns[file] == 0 { 1.0 } else { 0.70 };
        }
    }
    score
}

fn king_square(board: &Board, color: Color) -> Option<Square> {
    let kings = board.kings() & board.by_color(color);
    for sq in kings {
        return Some(sq);
    }
    None
}

fn central_king_pressure(
    board: &Board,
    attacker: Color,
    defender: Color,
    attacker_pawns: &[u8; 8],
    defender_pawns: &[u8; 8],
) -> f32 {
    let Some(king_sq) = king_square(board, defender) else {
        return 0.0;
    };
    let Some((king_file, king_rank)) = square_to_coords(king_sq) else {
        return 0.0;
    };
    let king_is_central = king_file == 3 || king_file == 4;
    let king_is_wing = king_file <= 1 || king_file >= 6;
    let mut score = if king_is_central {
        0.30
    } else if king_is_wing {
        0.22
    } else {
        0.12
    };
    score += heavy_piece_pressure_on_file(board, attacker, attacker_pawns, defender_pawns, king_file) * 0.60;

    if king_is_wing {
        let flank_file = if king_file >= 6 { 6 } else { 1 };
        score += heavy_piece_pressure_on_file(board, attacker, attacker_pawns, defender_pawns, flank_file) * 0.35;
    }

    let attacked_by_attacker = attacked_coords(board, attacker);
    let mut ring_hits = 0;
    for df in [-1i32, 0, 1] {
        for dr in [-1i32, 0, 1] {
            if df == 0 && dr == 0 {
                continue;
            }
            let nf = king_file as i32 + df;
            let nr = king_rank as i32 + dr;
            if !(0..=7).contains(&nf) || !(0..=7).contains(&nr) {
                continue;
            }
            if attacked_by_attacker.contains(&(nf as usize, nr as usize)) {
                ring_hits += 1;
            }
        }
    }
    score + ring_hits as f32 * if king_is_wing { 0.08 } else { 0.06 }
}

fn attacked_coords(board: &Board, color: Color) -> HashSet<(usize, usize)> {
    let mut coords = HashSet::new();
    for from in board.by_color(color) {
        for to in board.attacks_from(from) {
            if let Some(c) = square_to_coords(to) {
                coords.insert(c);
            }
        }
    }
    coords
}

fn pseudo_mobility(board: &Board, color: Color) -> i32 {
    let mut mobility = 0;
    for from in board.by_color(color) {
        for to in board.attacks_from(from) {
            if !board.by_color(color).contains(to) {
                mobility += 1;
            }
        }
    }
    mobility
}

fn knight_freedom(board: &Board, color: Color) -> i32 {
    let knights = board.knights() & board.by_color(color);
    let mut freedom = 0;
    for from in knights {
        for to in board.attacks_from(from) {
            if !board.by_color(color).contains(to) {
                freedom += 1;
            }
        }
    }
    freedom
}

fn count_attacked_knights_from_square(board: &Board, from: Square, defender: Color) -> i32 {
    let mut count = 0;
    let attacked = board.attacks_from(from) & (board.knights() & board.by_color(defender));
    for _ in attacked {
        count += 1;
    }
    count
}

fn attacked_valuable_targets_from_square(board: &Board, from: Square, defender: Color) -> i32 {
    let mut score = 0;
    for sq in board.attacks_from(from) {
        let Some(piece) = board.piece_at(sq) else {
            continue;
        };
        if piece.color != defender {
            continue;
        }
        score += match piece.role {
            Role::Pawn => 1,
            Role::Knight | Role::Bishop => 2,
            Role::Rook => 3,
            Role::Queen => 4,
            Role::King => 2,
        };
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chess::types::{BestMoves, Score, ScoreValue};
    use shakmaty::san::San;

    fn line(uci: &str, cp_white: i32, multipv: u16) -> BestMoves {
        BestMoves {
            score: Score {
                value: ScoreValue::Cp(cp_white),
                wdl: None,
            },
            uci_moves: vec![uci.to_string()],
            san_moves: Vec::new(),
            multipv,
            depth: 20,
            nodes: 100_000,
            nps: 1_000_000,
        }
    }

    fn uci_moves(list: &[&str]) -> Vec<String> {
        list.iter().map(|m| (*m).to_string()).collect()
    }

    fn build_position_from_san(start_fen: &str, sans: &[&str]) -> Chess {
        let fen: Fen = Fen::from_ascii(start_fen.as_bytes()).expect("valid FEN");
        let mut pos: Chess = match fen.into_position(CastlingMode::Chess960) {
            Ok(p) => p,
            Err(e) => e
                .ignore_too_much_material()
                .expect("position should be recoverable"),
        };
        for san_txt in sans {
            let san = San::from_ascii(san_txt.as_bytes()).expect("valid SAN");
            let mv = san.to_move(&pos).expect("legal SAN move");
            pos.play_unchecked(&mv);
        }
        pos
    }

    #[test]
    fn strategic_profile_prefers_nxb4_break_plan_in_reference_position() {
        let fen = "r1b1r1k1/pp3ppp/2n1p3/2b2q2/1PPpN3/P3PN2/2Q2PPP/R3KB1R b KQ b3 0 13";
        let request = HumanStrategicRequest {
            fen: fen.to_string(),
            moves: Vec::new(),
            // Engine-like candidate set: ...Bf8 is slightly safer in cp,
            // while ...Nxb4 is a practical structural break.
            candidates: vec![
                line("c5f8", 20, 1),
                line("c6b4", 59, 2),
                line("c5e7", 38, 3),
                line("c5b6", 44, 4),
            ],
            config: Some(HumanStrategicConfig {
                max_engine_drop_cp: 65,
                max_absolute_disadvantage_cp: 65,
                last_resort_disadvantage_cp: 80,
                min_strategic_score: 0.40,
                high_conviction_threshold: 0.78,
            }),
        };

        let selection = pick_human_strategic_move(request).expect("selector should return a move");
        assert_eq!(selection.selected_uci, "c6b4");
    }

    #[test]
    fn greek_gift_shape_increases_king_attack_complexity_components() {
        let fen = "1rbr2k1/3n1ppp/ppp1p3/2P5/1P1PB3/q3PN2/3B1PPP/3Q1RK1 w - - 1 17";
        let root = build_position(fen, &[]).expect("valid position");
        let uci_move = UciMove::from_ascii(b"e4h7").expect("valid uci");
        let mv = uci_move.to_move(&root).expect("legal move");
        let mut after = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after, &mv);

        let c = score_components(&root, &after, &mv);
        let strategic = aggregate_strategic_score(&c);
        assert!(c.central_king_pressure >= 0.28);
        assert!(strategic >= 0.18);
    }

    #[test]
    fn wing_capture_shape_increases_structure_break_components() {
        // Position after 11.a3 in Aronian-Carlsen (Norway Chess 2017),
        // where Black considers the thematic ...Bxa3.
        let moves = vec![
            "d2d4", "d7d5", "c2c4", "c7c6", "g1f3", "g8f6", "b1c3", "e7e6", "e2e3", "a7a6",
            "b2b3", "f8b4", "c1d2", "b8d7", "f1d3", "e8g8", "e1g1", "d8e7", "d3c2", "f8d8",
            "a2a3",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
        let root = build_position(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &moves,
        )
        .expect("valid reconstructed position");
        let uci_move = UciMove::from_ascii(b"b4a3").expect("valid uci");
        let mv = uci_move.to_move(&root).expect("legal move");
        let mut after = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after, &mv);

        let c = score_components(&root, &after, &mv);
        assert!(c.pawn_structure_damage >= 0.22 || c.open_file_pressure >= 0.18);
    }

    #[test]
    fn vorobiov_nxf2_increases_sacrifice_and_king_complexity() {
        // Position before 12...Nxf2 in Antal-Vorobiov, La Roda 2017.
        let root = build_position(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &uci_moves(&[
                "e2e4", "c7c5", "g1f3", "e7e6", "b2b3", "b8c6", "c1b2", "d7d5", "e4d5", "e6d5",
                "f1b5", "g8f6", "e1g1", "f8e7", "f3e5", "d8c7", "f1e1", "e8g8", "h2h3", "f6e4",
                "b5c6", "b7c6", "d2d3",
            ]),
        )
        .expect("valid reconstructed position");

        let nxf2 = UciMove::from_ascii(b"e4f2").expect("valid uci");
        let quiet = UciMove::from_ascii(b"e4d6").expect("valid uci");
        let nxf2_mv = nxf2.to_move(&root).expect("legal move");
        let quiet_mv = quiet.to_move(&root).expect("legal move");

        let mut after_nxf2 = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_nxf2, &nxf2_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let nxf2_c = score_components(&root, &after_nxf2, &nxf2_mv);
        let quiet_c = score_components(&root, &after_quiet, &quiet_mv);

        assert!(nxf2_c.central_king_pressure > quiet_c.central_king_pressure);
        assert!(nxf2_c.weak_pawn_pressure > quiet_c.weak_pawn_pressure);
    }

    #[test]
    fn vorobiov_d4_deflection_scores_as_practical_complexity() {
        // Position before 17...d4 in Antal-Vorobiov.
        let root = build_position(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &uci_moves(&[
                "e2e4", "c7c5", "g1f3", "e7e6", "b2b3", "b8c6", "c1b2", "d7d5", "e4d5", "e6d5",
                "f1b5", "g8f6", "e1g1", "f8e7", "f3e5", "d8c7", "f1e1", "e8g8", "h2h3", "f6e4",
                "b5c6", "b7c6", "d2d3", "e4f2", "g1f2", "e7h4", "g2g3", "f7f6", "g3h4", "f6e5",
                "f2g2", "e5e4", "e1e3",
            ]),
        )
        .expect("valid reconstructed position");

        let d4 = UciMove::from_ascii(b"d5d4").expect("valid uci");
        let quiet = UciMove::from_ascii(b"c7d6").expect("valid uci");
        let d4_mv = d4.to_move(&root).expect("legal move");
        let quiet_mv = quiet.to_move(&root).expect("legal move");

        let mut after_d4 = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_d4, &d4_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let d4_c = score_components(&root, &after_d4, &d4_mv);
        let quiet_c = score_components(&root, &after_quiet, &quiet_mv);
        let d4_s = aggregate_strategic_score(&d4_c);
        let quiet_s = aggregate_strategic_score(&quiet_c);
        assert!(d4_c.piece_restriction >= quiet_c.piece_restriction);
        assert!(d4_s > quiet_s);
    }

    #[test]
    fn vorobiov_bxh3_shapes_high_king_attack_pressure() {
        // Reconstruct with SAN to preserve the exact game sequence before 18...Bxh3+.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "e4", "c5", "Nf3", "e6", "b3", "Nc6", "Bb2", "d5", "exd5", "exd5", "Bb5", "Nf6",
                "O-O", "Be7", "Ne5", "Qc7", "Re1", "O-O", "h3", "Ne4", "Bxc6", "bxc6", "d3",
                "Nxf2", "Kxf2", "Bh4+", "g3", "f6", "gxh4", "fxe5+", "Kg2", "e4", "Re3", "d4",
                "Rxe4",
            ],
        );

        let bxh3_san = San::from_ascii(b"Bxh3+").expect("valid SAN");
        let quiet_san = San::from_ascii(b"Qd6").expect("valid SAN");
        let bxh3_mv = bxh3_san.to_move(&root).expect("legal SAN move");
        let quiet_mv = quiet_san.to_move(&root).expect("legal SAN move");

        let mut after_bxh3 = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_bxh3, &bxh3_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let sac_c = score_components(&root, &after_bxh3, &bxh3_mv);
        let quiet_c = score_components(&root, &after_quiet, &quiet_mv);
        let sac_s = aggregate_strategic_score(&sac_c);
        let quiet_s = aggregate_strategic_score(&quiet_c);

        assert!(sac_c.central_king_pressure > quiet_c.central_king_pressure);
        assert!(sac_s > quiet_s);
    }

    #[test]
    fn kramnik_c4_break_scores_above_quiet_setup() {
        // Position before 14...c4 in Kramnik-Harikrishna (Gashimov Memorial 2017).
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7", "d3", "b5",
                "Bb3", "d6", "a3", "O-O", "Nc3", "Nb8", "Ne2", "Nbd7", "c3", "Bb7", "Ng3", "c5",
                "Re1", "Rc8", "Nf5",
            ],
        );
        let c4_mv = San::from_ascii(b"c4")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"Re8")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_c4 = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_c4, &c4_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let c4_c = score_components(&root, &after_c4, &c4_mv);
        let q_c = score_components(&root, &after_quiet, &quiet_mv);
        let c4_s = aggregate_strategic_score(&c4_c);
        let q_s = aggregate_strategic_score(&q_c);

        assert!(c4_c.pawn_structure_damage >= q_c.pawn_structure_damage);
        assert!(c4_c.open_file_pressure >= q_c.open_file_pressure);
        assert!(c4_s > q_s);
    }

    #[test]
    fn kramnik_rxe5_scores_as_dynamic_central_break() {
        // Position before 25.Rxe5.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7", "d3", "b5",
                "Bb3", "d6", "a3", "O-O", "Nc3", "Nb8", "Ne2", "Nbd7", "c3", "Bb7", "Ng3", "c5",
                "Re1", "Rc8", "Nf5", "c4", "dxc4", "Bxe4", "Nxe7+", "Qxe7", "cxb5", "axb5",
                "Bg5", "Nc5", "Ba2", "h6", "Bh4", "g5", "Bg3", "Bh7", "Qe2", "Kg7", "Rad1",
                "Nfe4", "Rd5", "f5",
            ],
        );
        let sac_mv = San::from_ascii(b"Rxe5")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"h3")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_sac = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_sac, &sac_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let sac_c = score_components(&root, &after_sac, &sac_mv);
        let quiet_c = score_components(&root, &after_quiet, &quiet_mv);
        let sac_s = aggregate_strategic_score(&sac_c);
        let quiet_s = aggregate_strategic_score(&quiet_c);

        assert!(sac_c.central_king_pressure >= quiet_c.central_king_pressure);
        assert!(sac_c.open_file_pressure >= quiet_c.open_file_pressure);
        assert!(sac_s > quiet_s);
    }

    #[test]
    fn kramnik_c6_pawn_avalanche_scores_above_quiet_bishop_move() {
        // Position before 37.c6.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7", "d3", "b5",
                "Bb3", "d6", "a3", "O-O", "Nc3", "Nb8", "Ne2", "Nbd7", "c3", "Bb7", "Ng3", "c5",
                "Re1", "Rc8", "Nf5", "c4", "dxc4", "Bxe4", "Nxe7+", "Qxe7", "cxb5", "axb5",
                "Bg5", "Nc5", "Ba2", "h6", "Bh4", "g5", "Bg3", "Bh7", "Qe2", "Kg7", "Rad1",
                "Nfe4", "Rd5", "f5", "Rxe5", "dxe5", "Bxe5+", "Nf6", "Qxb5", "Ne4", "Bd4",
                "Rfd8", "h3", "Rb8", "Qe2", "Bg8", "Bb1", "Qb7", "b4", "Re8", "c4", "Qc6",
                "Qb2", "Rbd8", "c5", "Qe6", "b5", "Kf8",
            ],
        );
        let avalanche_mv = San::from_ascii(b"c6")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"h4")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_avalanche = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_avalanche, &avalanche_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let a_c = score_components(&root, &after_avalanche, &avalanche_mv);
        let q_c = score_components(&root, &after_quiet, &quiet_mv);
        let a_s = aggregate_strategic_score(&a_c);
        let q_s = aggregate_strategic_score(&q_c);

        assert!(a_c.piece_restriction >= q_c.piece_restriction);
        assert!(a_s > q_s);
    }

    #[test]
    fn rapport_nxd5_scores_as_long_term_initiative_investment() {
        // Position before 15...Nxd5 in Praggnanandhaa-Rapport, UzChess Cup 2025.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "d4", "Nf6", "c4", "g6", "f3", "Bg7", "e4", "d6", "Nc3", "O-O", "Nge2", "a6",
                "Be3", "Nbd7", "Qd2", "b5", "h4", "h5", "O-O-O", "e5", "d5", "Nb6", "Bxb6",
                "cxb6", "cxb5", "axb5", "Kb1", "b4", "Nb5",
            ],
        );

        let sac_mv = San::from_ascii(b"Nxd5")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"Kh7")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_sac = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_sac, &sac_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let sac_c = score_components(&root, &after_sac, &sac_mv);
        let quiet_c = score_components(&root, &after_quiet, &quiet_mv);
        let sac_s = aggregate_strategic_score(&sac_c);
        let quiet_s = aggregate_strategic_score(&quiet_c);

        assert!(sac_c.central_king_pressure >= quiet_c.central_king_pressure);
        assert!(sac_s > quiet_s);
    }

    #[test]
    fn rapport_ra4_infiltration_scores_above_waiting_rook_move() {
        // Position before 17...Ra4.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "d4", "Nf6", "c4", "g6", "f3", "Bg7", "e4", "d6", "Nc3", "O-O", "Nge2", "a6",
                "Be3", "Nbd7", "Qd2", "b5", "h4", "h5", "O-O-O", "e5", "d5", "Nb6", "Bxb6",
                "cxb6", "cxb5", "axb5", "Kb1", "b4", "Nb5", "Nxd5", "exd5", "Bf5+", "Ka1",
            ],
        );

        let ra4_mv = San::from_ascii(b"Ra4")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"Ra7")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_ra4 = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_ra4, &ra4_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let ra4_c = score_components(&root, &after_ra4, &ra4_mv);
        let quiet_c = score_components(&root, &after_quiet, &quiet_mv);

        assert!(ra4_c.piece_restriction >= quiet_c.piece_restriction);
    }

    #[test]
    fn rapport_e4_break_scores_above_waiting_rook_slide() {
        // Position before 20...e4.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "d4", "Nf6", "c4", "g6", "f3", "Bg7", "e4", "d6", "Nc3", "O-O", "Nge2", "a6",
                "Be3", "Nbd7", "Qd2", "b5", "h4", "h5", "O-O-O", "e5", "d5", "Nb6", "Bxb6",
                "cxb6", "cxb5", "axb5", "Kb1", "b4", "Nb5", "Nxd5", "exd5", "Bf5+", "Ka1",
                "Ra4", "Nc1", "Qd7", "Bc4", "Rc8", "Qe2",
            ],
        );

        let break_mv = San::from_ascii(b"e4")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"Ra5")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_break = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_break, &break_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let b_c = score_components(&root, &after_break, &break_mv);
        let q_c = score_components(&root, &after_quiet, &quiet_mv);
        let b_s = aggregate_strategic_score(&b_c);
        let q_s = aggregate_strategic_score(&q_c);

        assert!(b_s > q_s);
    }

    #[test]
    fn rapport_bc2_quiet_crush_scores_above_passive_queen_regroup() {
        // Position before 23...Bc2.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "d4", "Nf6", "c4", "g6", "f3", "Bg7", "e4", "d6", "Nc3", "O-O", "Nge2", "a6",
                "Be3", "Nbd7", "Qd2", "b5", "h4", "h5", "O-O-O", "e5", "d5", "Nb6", "Bxb6",
                "cxb6", "cxb5", "axb5", "Kb1", "b4", "Nb5", "Nxd5", "exd5", "Bf5+", "Ka1",
                "Ra4", "Nc1", "Qd7", "Bc4", "Rc8", "Qe2", "e4", "Bb3", "exf3", "gxf3", "Ra5",
                "Bc4",
            ],
        );

        let crush_mv = San::from_ascii(b"Bc2")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"Qa7")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_crush = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_crush, &crush_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let crush_c = score_components(&root, &after_crush, &crush_mv);
        let quiet_c = score_components(&root, &after_quiet, &quiet_mv);
        assert!(crush_c.piece_restriction >= quiet_c.piece_restriction);
    }

    #[test]
    fn erdogmus_nh4_king_net_setup_scores_above_waiting_rook_move() {
        // Position before 20...Nh4 in Aditya Mittal-Erdogmus, Grand Swiss 2025.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "c4", "e6", "Nc3", "d5", "d4", "dxc4", "e4", "c5", "d5", "exd5", "exd5", "Bd6",
                "Bxc4", "Ne7", "h3", "O-O", "Nf3", "Nd7", "O-O", "Nb6", "b3", "Nxc4", "bxc4",
                "Ng6", "Ne4", "Bf5", "Nxd6", "Qxd6", "Qb3", "b6", "a4", "a5", "Re1", "Rfe8",
                "Be3", "h6", "Ra2", "Be4", "Nd2",
            ],
        );

        let net_mv = UciMove::from_ascii(b"g6h4")
            .expect("valid uci")
            .to_move(&root)
            .expect("legal move");
        let quiet_mv = San::from_ascii(b"Rac8")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_net = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_net, &net_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let net_c = score_components(&root, &after_net, &net_mv);
        let quiet_c = score_components(&root, &after_quiet, &quiet_mv);
        let net_s = aggregate_strategic_score(&net_c);
        let quiet_s = aggregate_strategic_score(&quiet_c);

        assert!(net_c.central_king_pressure >= quiet_c.central_king_pressure);
        assert!(net_s > quiet_s);
    }

    #[test]
    fn erdogmus_qg6_lift_scores_above_immediate_pawn_recapture() {
        // Position before 21...Qg6.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "c4", "e6", "Nc3", "d5", "d4", "dxc4", "e4", "c5", "d5", "exd5", "exd5", "Bd6",
                "Bxc4", "Ne7", "h3", "O-O", "Nf3", "Nd7", "O-O", "Nb6", "b3", "Nxc4", "bxc4",
                "Ng6", "Ne4", "Bf5", "Nxd6", "Qxd6", "Qb3", "b6", "a4", "a5", "Re1", "Rfe8",
                "Be3", "h6", "Ra2", "Be4", "Nd2", "Nh4", "Bxc5",
            ],
        );

        let lift_mv = San::from_ascii(b"Qg6")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"Qd7")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_lift = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_lift, &lift_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let lift_c = score_components(&root, &after_lift, &lift_mv);
        let quiet_c = score_components(&root, &after_quiet, &quiet_mv);
        let lift_s = aggregate_strategic_score(&lift_c);
        let quiet_s = aggregate_strategic_score(&quiet_c);

        assert!(lift_s > quiet_s);
    }

    #[test]
    fn erdogmus_bxh3_conversion_scores_above_quiet_bishop_slide() {
        // Position before 23...Bxh3.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "c4", "e6", "Nc3", "d5", "d4", "dxc4", "e4", "c5", "d5", "exd5", "exd5", "Bd6",
                "Bxc4", "Ne7", "h3", "O-O", "Nf3", "Nd7", "O-O", "Nb6", "b3", "Nxc4", "bxc4",
                "Ng6", "Ne4", "Bf5", "Nxd6", "Qxd6", "Qb3", "b6", "a4", "a5", "Re1", "Rfe8",
                "Be3", "h6", "Ra2", "Be4", "Nd2", "Nh4", "Bxc5", "Qg6", "g3", "Bg2", "Be7",
            ],
        );

        let sac_mv = San::from_ascii(b"Bxh3")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = UciMove::from_ascii(b"a8a7")
            .expect("valid uci")
            .to_move(&root)
            .expect("legal move");

        let mut after_sac = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_sac, &sac_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let sac_c = score_components(&root, &after_sac, &sac_mv);
        let quiet_c = score_components(&root, &after_quiet, &quiet_mv);
        let sac_s = aggregate_strategic_score(&sac_c);
        let quiet_s = aggregate_strategic_score(&quiet_c);

        assert!(sac_c.central_king_pressure >= quiet_c.central_king_pressure);
        assert!(sac_s > quiet_s);
    }

    #[test]
    fn salem_qb6_counterplay_resource_scores_above_premature_e5() {
        // Position before 17...Qb6 in Tran-Salem, World Cup 2025.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6", "h3", "e6",
                "g4", "Be7", "g5", "Nfd7", "Bg2", "Nc6", "h4", "O-O", "b3", "Re8", "Bb2",
                "Bf8", "Qd2", "Nxd4", "Qxd4", "b5", "O-O-O", "Bb7", "Kb1", "Rc8", "f4",
            ],
        );

        let counter_mv = San::from_ascii(b"Qb6")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"h6")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_counter = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_counter, &counter_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let c = score_components(&root, &after_counter, &counter_mv);
        let q = score_components(&root, &after_quiet, &quiet_mv);
        let c_s = aggregate_strategic_score(&c);
        let q_s = aggregate_strategic_score(&q);

        assert!(c_s > q_s);
    }

    #[test]
    fn salem_rc3_rook_lift_scores_above_passive_queen_retreat() {
        // Position before 26...Rc3.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6", "h3", "e6",
                "g4", "Be7", "g5", "Nfd7", "Bg2", "Nc6", "h4", "O-O", "b3", "Re8", "Bb2",
                "Bf8", "Qd2", "Nxd4", "Qxd4", "b5", "O-O-O", "Bb7", "Kb1", "Rc8", "f4", "Qb6",
                "Qd2", "Nc5", "f5", "b4", "Na4", "Nxa4", "bxa4", "Bc6", "g6", "fxg6", "fxg6",
                "Bxa4", "Rc1", "hxg6", "h5", "gxh5", "Rxh5",
            ],
        );

        let lift_mv = San::from_ascii(b"Rc3")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"Qd8")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_lift = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_lift, &lift_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let lift_c = score_components(&root, &after_lift, &lift_mv);
        let quiet_c = score_components(&root, &after_quiet, &quiet_mv);
        let lift_s = aggregate_strategic_score(&lift_c);
        let quiet_s = aggregate_strategic_score(&quiet_c);

        assert!(lift_c.piece_restriction >= quiet_c.piece_restriction);
        assert!(lift_s > quiet_s);
    }

    #[test]
    fn salem_bxc2_intermezzo_scores_above_waiting_rook_move() {
        // Position before 28...Bxc2+.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6", "h3", "e6",
                "g4", "Be7", "g5", "Nfd7", "Bg2", "Nc6", "h4", "O-O", "b3", "Re8", "Bb2",
                "Bf8", "Qd2", "Nxd4", "Qxd4", "b5", "O-O-O", "Bb7", "Kb1", "Rc8", "f4", "Qb6",
                "Qd2", "Nc5", "f5", "b4", "Na4", "Nxa4", "bxa4", "Bc6", "g6", "fxg6", "fxg6",
                "Bxa4", "Rc1", "hxg6", "h5", "gxh5", "Rxh5", "Rc3", "Qg5", "Qe3", "Qh4",
            ],
        );

        let tactical_mv = San::from_ascii(b"Bxc2+")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"Re7")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_tactical = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_tactical, &tactical_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let t = score_components(&root, &after_tactical, &tactical_mv);
        let q = score_components(&root, &after_quiet, &quiet_mv);
        let t_s = aggregate_strategic_score(&t);
        let q_s = aggregate_strategic_score(&q);

        assert!(t.central_king_pressure >= q.central_king_pressure);
        assert!(t_s > q_s);
    }

    #[test]
    fn giri_rh5_rook_lift_scores_above_quiet_development() {
        // Position before 15.Rh5 in Giri-Wei Yi, Global Chess League 2025.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "d4", "Nf6", "Nf3", "d5", "c3", "c5", "dxc5", "e6", "Be3", "Nc6", "b4", "Be7",
                "g3", "Ng4", "Bd4", "e5", "h3", "exd4", "hxg4", "dxc3", "Nxc3", "Nxb4", "Qa4+",
                "Nc6", "Rd1", "Bxc5", "Nxd5", "Be6",
            ],
        );

        let lift_mv = San::from_ascii(b"Rh5")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"Bg2")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_lift = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_lift, &lift_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let lift_c = score_components(&root, &after_lift, &lift_mv);
        let quiet_c = score_components(&root, &after_quiet, &quiet_mv);
        let lift_s = aggregate_strategic_score(&lift_c);
        let quiet_s = aggregate_strategic_score(&quiet_c);

        assert!(lift_c.central_king_pressure >= quiet_c.central_king_pressure);
        assert!(lift_s > quiet_s);
    }

    #[test]
    fn giri_qe4_switch_scores_above_quiet_bishop_retreat() {
        // Position before 17.Qe4.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "d4", "Nf6", "Nf3", "d5", "c3", "c5", "dxc5", "e6", "Be3", "Nc6", "b4", "Be7",
                "g3", "Ng4", "Bd4", "e5", "h3", "exd4", "hxg4", "dxc3", "Nxc3", "Nxb4", "Qa4+",
                "Nc6", "Rd1", "Bxc5", "Nxd5", "Be6", "Rh5", "Rc8", "Bh3", "g6",
            ],
        );

        let attack_mv = San::from_ascii(b"Qe4")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"Bg2")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_attack = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_attack, &attack_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let a = score_components(&root, &after_attack, &attack_mv);
        let q = score_components(&root, &after_quiet, &quiet_mv);
        let a_s = aggregate_strategic_score(&a);
        let q_s = aggregate_strategic_score(&q);

        assert!(a.central_king_pressure >= q.central_king_pressure);
        assert!(a_s > q_s);
    }

    #[test]
    fn giri_ng5_attack_superiority_scores_above_queen_retreat() {
        // Position before 20.Ng5.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "d4", "Nf6", "Nf3", "d5", "c3", "c5", "dxc5", "e6", "Be3", "Nc6", "b4", "Be7",
                "g3", "Ng4", "Bd4", "e5", "h3", "exd4", "hxg4", "dxc3", "Nxc3", "Nxb4", "Qa4+",
                "Nc6", "Rd1", "Bxc5", "Nxd5", "Be6", "Rh5", "Rc8", "Bh3", "g6", "Qe4", "Kf8",
                "Qf4", "Qa5+", "Kf1", "gxh5",
            ],
        );

        let attack_mv = San::from_ascii(b"Ng5")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"Qe3")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_attack = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_attack, &attack_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let a = score_components(&root, &after_attack, &attack_mv);
        let q = score_components(&root, &after_quiet, &quiet_mv);
        let a_s = aggregate_strategic_score(&a);
        let q_s = aggregate_strategic_score(&q);

        assert!(a.central_king_pressure >= q.central_king_pressure);
        assert!(a_s > q_s);
    }

    #[test]
    fn dubov_dxe5_precision_break_scores_above_material_grab() {
        // Position before 14.dxe5 in Dubov-Meier, World Cup 2025.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "e4", "e5", "Nc3", "Nf6", "Bc4", "Nxe4", "Qh5", "Nd6", "Bb3", "Nc6", "Nb5",
                "g6", "Qf3", "Nf5", "Qd5", "Nh6", "d4", "d6", "Bxh6", "Be6", "Qf3", "Bxb3",
                "Bxf8", "Bc4", "Bg7", "Bxb5",
            ],
        );

        let precise_mv = San::from_ascii(b"dxe5")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let mut after_precise = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_precise, &precise_mv);

        let p = score_components(&root, &after_precise, &precise_mv);
        let p_s = aggregate_strategic_score(&p);
        assert!(p_s >= 0.08);
        assert!(p.central_king_pressure >= 0.08 || p.open_file_pressure >= 0.08);
    }

    #[test]
    fn dubov_nxe5_compensation_scores_above_quiet_queen_retreat() {
        // Position before 21.Nxe5.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "e4", "e5", "Nc3", "Nf6", "Bc4", "Nxe4", "Qh5", "Nd6", "Bb3", "Nc6", "Nb5",
                "g6", "Qf3", "Nf5", "Qd5", "Nh6", "d4", "d6", "Bxh6", "Be6", "Qf3", "Bxb3",
                "Bxf8", "Bc4", "Bg7", "Bxb5", "dxe5", "Rg8", "Bf6", "Nxe5", "Bxe5", "Qe7",
                "O-O-O", "Bc6", "Qc3", "dxe5", "Nf3", "f6", "Rhe1", "Kf8",
            ],
        );

        let comp_mv = San::from_ascii(b"Nxe5")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"Qb3")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_comp = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_comp, &comp_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let c = score_components(&root, &after_comp, &comp_mv);
        let q = score_components(&root, &after_quiet, &quiet_mv);
        let c_s = aggregate_strategic_score(&c);
        let q_s = aggregate_strategic_score(&q);

        assert!(c.central_king_pressure >= q.central_king_pressure);
        assert!(c_s > q_s);
    }

    #[test]
    fn dubov_qc4_forcing_conversion_scores_above_slow_switch() {
        // Position before 24.Qc4+.
        let root = build_position_from_san(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            &[
                "e4", "e5", "Nc3", "Nf6", "Bc4", "Nxe4", "Qh5", "Nd6", "Bb3", "Nc6", "Nb5",
                "g6", "Qf3", "Nf5", "Qd5", "Nh6", "d4", "d6", "Bxh6", "Be6", "Qf3", "Bxb3",
                "Bxf8", "Bc4", "Bg7", "Bxb5", "dxe5", "Rg8", "Bf6", "Nxe5", "Bxe5", "Qe7",
                "O-O-O", "Bc6", "Qc3", "dxe5", "Nf3", "f6", "Rhe1", "Kf8", "Nxe5", "fxe5",
                "Rxe5", "Qf6", "Re8+", "Kf7",
            ],
        );

        let force_mv = San::from_ascii(b"Qc4+")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");
        let quiet_mv = San::from_ascii(b"Qb3")
            .expect("valid SAN")
            .to_move(&root)
            .expect("legal SAN");

        let mut after_force = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_force, &force_mv);
        let mut after_quiet = root.clone();
        SanPlus::from_move_and_play_unchecked(&mut after_quiet, &quiet_mv);

        let f = score_components(&root, &after_force, &force_mv);
        let q = score_components(&root, &after_quiet, &quiet_mv);
        let f_s = aggregate_strategic_score(&f);
        let q_s = aggregate_strategic_score(&q);

        assert!(f.central_king_pressure >= q.central_king_pressure);
        assert!(f_s > q_s);
    }
}
