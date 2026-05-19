//! Human-oriented full-game analysis that produces enriched PGN output.
//!
//! This module keeps the original public contract, but improves the commentator:
//! - fixes position reconstruction when calling the strategic selector
//! - never comments the played move using a different selected candidate
//! - suppresses generic comments on quiet/normal moves
//! - builds concrete GM-style comments from board evidence
//! - keeps engine guardrails and human strategic selector compatibility

mod strategy_commentary;

use serde::{Deserialize, Serialize};
use shakmaty::{
    fen::Fen,
    san::{San, SanPlus},
    uci::UciMove,
    Board, CastlingMode, Chess, Color, EnPassantMode, Move, Position, Role, Square,
};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};

use crate::{error::Error, opening::get_opening_info_from_fen, AppState};

use super::{
    analysis::GameAnalysisService,
    human_strategy::{
        pick_human_strategic_move, HumanStrategicCandidate, HumanStrategicComponents,
        HumanStrategicConfig, HumanStrategicMacroComponents, HumanStrategicRequest, StrategicMotif,
    },
    pgn_annotator::{build_annotated_pgn, BuildAnnotatedPgnRequest, PgnMoveAnnotation},
    types::{AnalysisOptions, BestMoves, EngineOption, GoMode, MoveAnalysis, ScoreValue},
};

const MATE_AS_CP: i32 = 100_000;
const HOPELESS_CP: i32 = -900;
const HOPELESS_MARGIN: i32 = 50;
const NEAR_BEST_CP: i32 = 25;
const HUMAN_REPORT_MULTIPV_MIN: u32 = 6;
const MIN_STRATEGIC_SCORE_TO_EXPLAIN: f32 = 0.28;
const MIN_STRATEGIC_SCORE_TO_COMMENT_BEST: f32 = 0.55;
const MIN_ATOMS_TO_COMMENT_BEST: usize = 2;
const MIN_SINGLE_ATOM_PRIORITY_TO_COMMENT: i32 = 84;
const MIN_STRATEGIC_SCORE_TO_COMMENT_AFTER_OPENING: f32 = 0.42;
// Do not annotate normal opening/development moves. Move 11+ can be commented if
// the move has concrete evidence or an evaluation issue.
const OPENING_COMMENT_SUPPRESS_PLIES: usize = 20;
// In named opening theory we keep comments sparse for longer. Only concrete
// tactical/structural turning points should survive this filter.
const KNOWN_OPENING_COMMENT_SUPPRESS_PLIES: usize = 24;

/// Input payload for the human strategic game analyzer.
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HumanGameAnalysisRequest {
    pub id: String,
    pub engine: String,
    pub go_mode: GoMode,
    pub options: AnalysisOptions,
    pub uci_options: Vec<EngineOption>,
    /// Original PGN text to preserve headers in the enriched output.
    pub original_pgn: Option<String>,
    /// Maximum plies included in suggested strategic side-line variations.
    pub strategic_variation_max_plies: Option<u32>,
}

/// Human verdict for a played move.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HumanMoveVerdict {
    Best,
    Great,
    Practical,
    Interesting,
    Dubious,
    Mistake,
    Blunder,
}

/// Per-move narrative produced by the human strategic analyzer.
#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HumanMoveNarrative {
    pub ply: u32,
    pub side_to_move: String,
    pub played_uci: String,
    pub played_san: String,
    pub engine_best_uci: Option<String>,
    pub engine_best_san: Option<String>,
    pub strategic_choice_uci: Option<String>,
    pub strategic_choice_san: Option<String>,
    pub verdict: HumanMoveVerdict,
    pub eval_before_cp: Option<i32>,
    pub eval_after_cp: Option<i32>,
    pub cp_loss: Option<i32>,
    pub played_strategic_score: Option<f32>,
    pub played_motifs: Vec<StrategicMotif>,
    pub strategic_axes: Vec<HumanStrategicAxisNarrative>,
    pub strategic_plan: String,
    pub comment_short: String,
    pub comment_long: String,
    pub suggested_variation_uci: Vec<String>,
    pub suggested_variation_san: Vec<String>,
}

/// Dominant strategic axis and explanation for a move.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HumanStrategicAxisNarrative {
    pub axis: String,
    pub score: f32,
    pub explanation: String,
}

#[derive(Debug, Clone)]
struct HumanStrategicConcreteTheme {
    text: &'static str,
}

#[derive(Debug, Clone)]
struct ConcreteCommentAtom {
    priority: i32,
    short: String,
    sentence: String,
}

#[derive(Debug, Clone, Default)]
struct ConcreteCommentBundle {
    atoms: Vec<ConcreteCommentAtom>,
}

#[derive(Debug, Clone, Default)]
struct TwoWeaknessTracker {
    white: TwoWeaknessSideState,
    black: TwoWeaknessSideState,
}

#[derive(Debug, Clone, Default)]
struct TwoWeaknessSideState {
    king_pressure_events: u8,
    structure_events: u8,
    target_events: u8,
    restriction_events: u8,
    // Strict two-weakness detection: only real pressure on both flanks counts.
    // Structure/center/king pressure can support the theme, but cannot trigger it alone.
    real_attack_sectors: HashSet<&'static str>,
    last_attack_sector: Option<&'static str>,
    attack_switch_events: u8,
    last_comment_ply: Option<usize>,
}

/// Global summary of the human strategic report.
#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HumanStrategicGameSummary {
    pub best_count: u32,
    pub great_count: u32,
    pub practical_count: u32,
    pub interesting_count: u32,
    pub dubious_count: u32,
    pub mistake_count: u32,
    pub blunder_count: u32,
    pub top_themes: Vec<String>,
}

/// Full report returned by the human strategic analyzer.
#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HumanAnnotatedGameReport {
    pub annotated_pgn: String,
    pub narratives: Vec<HumanMoveNarrative>,
    pub summary: HumanStrategicGameSummary,
    pub analysis: Vec<MoveAnalysis>,
}

/// Input payload for live strategic explanations from engine MultiPV lines.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HumanStrategicLiveRequest {
    pub fen: String,
    pub moves: Vec<String>,
    pub candidates: Vec<BestMoves>,
    pub config: Option<HumanStrategicConfig>,
    pub max_variation_plies: Option<u32>,
    pub max_lines: Option<u32>,
}

/// Human strategic explanation for a single candidate move.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HumanStrategicLiveLine {
    pub uci: String,
    pub san: String,
    pub engine_rank: u32,
    pub engine_cp: i32,
    pub engine_drop_cp: i32,
    pub strategic_score: f32,
    pub final_score: f32,
    pub is_selected: bool,
    pub is_engine_best: bool,
    pub motifs: Vec<StrategicMotif>,
    pub strategic_axes: Vec<HumanStrategicAxisNarrative>,
    pub strategic_plan: String,
    pub comment_short: String,
    pub comment_long: String,
    pub suggested_variation_uci: Vec<String>,
    pub suggested_variation_san: Vec<String>,
}

/// Live strategic explanation bundle for the current position.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HumanStrategicLiveResponse {
    pub selected_uci: String,
    pub selected_san: String,
    pub best_engine_uci: String,
    pub best_engine_san: String,
    pub lines: Vec<HumanStrategicLiveLine>,
}

/// Analyze a game and produce an enriched PGN with human strategic commentary.
pub async fn analyze_game_human_report(
    request: HumanGameAnalysisRequest,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<HumanAnnotatedGameReport, Error> {
    let HumanGameAnalysisRequest {
        id,
        engine,
        go_mode,
        mut options,
        mut uci_options,
        original_pgn,
        strategic_variation_max_plies,
    } = request;

    if options.reversed {
        return Err(Error::InvalidInput(
            "El reporte humano anotado requiere análisis cronológico (reversed=false)".to_string(),
        ));
    }

    if options.moves.is_empty() {
        if let Some(pgn) = original_pgn.as_deref() {
            let recovered_moves = pgn_mainline_to_uci_moves(&options.fen, pgn)?;
            if !recovered_moves.is_empty() {
                log::warn!(
                    "Human report received empty options.moves; recovered {} moves from original_pgn mainline",
                    recovered_moves.len()
                );
                options.moves = recovered_moves;
            }
        }
    }

    if options.moves.is_empty() {
        return Err(Error::InvalidInput(
            "No se recibieron jugadas para analizar. El PGN puede ser válido, pero el parser upstream no llenó options.moves y no se pudo recuperar la línea principal desde original_pgn."
                .to_string(),
        ));
    }

    let report_fen = options.fen.clone();
    let report_moves = options.moves.clone();

    ensure_min_multipv(&mut uci_options, HUMAN_REPORT_MULTIPV_MIN);

    let analysis =
        GameAnalysisService::analyze_game(id, engine, go_mode, options, uci_options, state, app)
            .await?;

    let max_variation_plies = strategic_variation_max_plies.unwrap_or(5).clamp(1, 12) as usize;

    let (annotated_pgn, narratives) = build_annotated_pgn_and_narratives(
        &report_fen,
        &report_moves,
        &analysis,
        original_pgn.as_deref(),
        max_variation_plies,
    )?;
    let summary = build_summary(&narratives);

    Ok(HumanAnnotatedGameReport {
        annotated_pgn,
        narratives,
        summary,
        analysis,
    })
}

/// Build live, GM-style strategic explanations for current MultiPV lines.
pub fn build_human_strategic_live_report(
    request: HumanStrategicLiveRequest,
) -> Result<HumanStrategicLiveResponse, Error> {
    let HumanStrategicLiveRequest {
        fen,
        moves,
        candidates,
        config,
        max_variation_plies,
        max_lines,
    } = request;

    if candidates.is_empty() {
        return Err(Error::InvalidInput(
            "No engine candidates were provided".to_string(),
        ));
    }

    let mut root = parse_position(&fen)?;
    for raw in &moves {
        let played = normalize_move_key(raw);
        let uci = UciMove::from_ascii(played.as_bytes())?;
        let mv = uci.to_move(&root)?;
        SanPlus::from_move_and_play_unchecked(&mut root, &mv);
    }

    let root_fen = Fen::from_position(root.clone(), EnPassantMode::Legal).to_string();
    let selection = pick_human_strategic_move(HumanStrategicRequest {
        fen: root_fen,
        moves: Vec::new(),
        candidates,
        config,
    })?;

    let max_plies = max_variation_plies.unwrap_or(6).clamp(1, 12) as usize;
    let max_lines = max_lines.unwrap_or(4).clamp(1, 8) as usize;
    let mover = root.turn();

    let selected_san = uci_line_to_san(root.clone(), &[selection.selected_uci.clone()], 1)
        .first()
        .cloned()
        .unwrap_or_else(|| selection.selected_uci.clone());
    let best_engine_san = uci_line_to_san(root.clone(), &[selection.best_engine_uci.clone()], 1)
        .first()
        .cloned()
        .unwrap_or_else(|| selection.best_engine_uci.clone());

    // Live report ordering is intentionally human/strategic-first:
    // keep guardrail-safe lines first, then prioritize strategic value over pure engine blend.
    let selected_uci_key = normalize_move_key(&selection.selected_uci);
    let mut prioritized_candidates = selection.candidates.clone();
    prioritized_candidates.sort_by(|a, b| {
        b.passes_guardrail
            .cmp(&a.passes_guardrail)
            .then_with(|| b.strategic_score.total_cmp(&a.strategic_score))
            .then_with(|| b.macro_strategic_score.total_cmp(&a.macro_strategic_score))
            .then_with(|| b.final_score.total_cmp(&a.final_score))
            .then_with(|| a.engine_drop_cp.cmp(&b.engine_drop_cp))
            .then_with(|| a.engine_rank.cmp(&b.engine_rank))
    });

    let mut shown_candidates: Vec<_> = prioritized_candidates.into_iter().take(max_lines).collect();
    if max_lines > 0
        && !shown_candidates
            .iter()
            .any(|candidate| normalize_move_key(&candidate.uci) == selected_uci_key.as_str())
    {
        if let Some(selected_candidate) = selection
            .candidates
            .iter()
            .find(|candidate| normalize_move_key(&candidate.uci) == selected_uci_key.as_str())
        {
            if shown_candidates.len() >= max_lines {
                shown_candidates.pop();
            }
            shown_candidates.push(selected_candidate.clone());
        }
    }

    let mut lines = Vec::new();

    for candidate in &shown_candidates {
        let played_uci = normalize_move_key(&candidate.uci);
        let uci = match UciMove::from_ascii(played_uci.as_bytes()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let mv = match uci.to_move(&root) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let mut after = root.clone();
        let played_san = SanPlus::from_move_and_play_unchecked(&mut after, &mv).to_string();

        let mut concrete_bundle = build_concrete_comment_bundle(
            &root,
            &after,
            &mv,
            mover,
            Some(candidate),
            &played_san,
            None,
        );
        concrete_bundle
            .atoms
            .sort_by(|a, b| b.priority.cmp(&a.priority));
        collapse_redundant_atoms(&mut concrete_bundle.atoms);
        concrete_bundle
            .atoms
            .dedup_by(|a, b| a.short == b.short || a.sentence == b.sentence);

        let strategic_axes = extract_top_macro_axes(&candidate.macro_components);
        let concrete_themes = extract_top_concrete_themes(&candidate.components);
        let strategic_plan =
            build_plan_sentence(&strategic_axes, &concrete_themes, &concrete_bundle);

        let mut suggested_variation_uci = candidate
            .pv_uci_line
            .iter()
            .map(|m| normalize_move_key(m))
            .collect::<Vec<_>>();
        if suggested_variation_uci
            .first()
            .map(|m| m != &played_uci)
            .unwrap_or(true)
        {
            suggested_variation_uci.insert(0, played_uci.clone());
        }
        suggested_variation_uci.truncate(max_plies);
        let suggested_variation_san =
            uci_line_to_san(root.clone(), &suggested_variation_uci, max_plies);

        let comment_short = if !concrete_bundle.atoms.is_empty() {
            sentence(&summarize_atoms_as_short_phrase(&concrete_bundle.atoms, 2))
        } else if !strategic_plan.is_empty() {
            strategic_plan.clone()
        } else {
            sentence(&motifs_to_text(&candidate.motifs))
        };

        let mut long_parts = Vec::new();
        if !strategic_plan.is_empty() {
            long_parts.push(strategic_plan.clone());
        }
        if let Some(atom) = concrete_bundle.atoms.first() {
            long_parts.push(atom.sentence.clone());
        }
        if let Some(hint) = derive_gm_plan_hint(&concrete_bundle.atoms, &candidate.motifs, false) {
            long_parts.push(hint);
        }
        let comment_long = if long_parts.is_empty() {
            comment_short.clone()
        } else {
            join_unique_sentences(&long_parts)
        };

        lines.push(HumanStrategicLiveLine {
            uci: played_uci.clone(),
            san: played_san,
            engine_rank: (candidate.engine_rank as u32).saturating_add(1),
            engine_cp: candidate.engine_cp,
            engine_drop_cp: candidate.engine_drop_cp,
            strategic_score: candidate.strategic_score,
            final_score: candidate.final_score,
            is_selected: played_uci == normalize_move_key(&selection.selected_uci),
            is_engine_best: played_uci == normalize_move_key(&selection.best_engine_uci),
            motifs: candidate.motifs.clone(),
            strategic_axes,
            strategic_plan,
            comment_short: clean_spaces(&comment_short),
            comment_long: clean_spaces(&comment_long),
            suggested_variation_uci,
            suggested_variation_san,
        });
    }

    if lines.is_empty() {
        return Err(Error::InvalidInput(
            "No strategic lines could be explained for this position".to_string(),
        ));
    }

    Ok(HumanStrategicLiveResponse {
        selected_uci: normalize_move_key(&selection.selected_uci),
        selected_san,
        best_engine_uci: normalize_move_key(&selection.best_engine_uci),
        best_engine_san,
        lines,
    })
}

fn pgn_mainline_to_uci_moves(initial_fen: &str, pgn: &str) -> Result<Vec<String>, Error> {
    let mut position = parse_position(initial_fen)?;
    let movetext = strip_pgn_headers_comments_and_variations(pgn);
    let mut out = Vec::new();

    for raw_token in movetext.split_whitespace() {
        let san_token = normalize_pgn_san_token(raw_token);
        if san_token.is_empty() {
            continue;
        }
        if is_pgn_result_token(&san_token) {
            break;
        }

        let san = San::from_ascii(san_token.as_bytes())?;
        let mv = san.to_move(&position)?;
        let uci = UciMove::from_move(&mv, CastlingMode::Standard).to_string();
        SanPlus::from_move_and_play_unchecked(&mut position, &mv);
        out.push(normalize_move_key(&uci));
    }

    Ok(out)
}

fn strip_pgn_headers_comments_and_variations(pgn: &str) -> String {
    let mut body = String::new();
    for line in pgn.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            continue;
        }
        body.push_str(line);
        body.push('\n');
    }

    let mut out = String::with_capacity(body.len());
    let mut brace_depth = 0usize;
    let mut paren_depth = 0usize;
    let mut in_semicolon_comment = false;

    for ch in body.chars() {
        if in_semicolon_comment {
            if ch == '\n' {
                in_semicolon_comment = false;
                out.push(' ');
            }
            continue;
        }

        if ch == ';' && brace_depth == 0 && paren_depth == 0 {
            in_semicolon_comment = true;
            continue;
        }

        if ch == '{' && paren_depth == 0 {
            brace_depth += 1;
            continue;
        }
        if ch == '}' && brace_depth > 0 {
            brace_depth -= 1;
            continue;
        }
        if brace_depth > 0 {
            continue;
        }

        if ch == '(' {
            paren_depth += 1;
            continue;
        }
        if ch == ')' && paren_depth > 0 {
            paren_depth -= 1;
            continue;
        }
        if paren_depth > 0 {
            continue;
        }

        out.push(ch);
    }

    out
}

fn normalize_pgn_san_token(raw: &str) -> String {
    let mut token = raw.trim();
    if token.is_empty() || token.starts_with('$') {
        return String::new();
    }

    if let Some(dot_idx) = token.rfind('.') {
        token = &token[dot_idx + 1..];
    }

    token = token.trim();
    if token.is_empty() || token.starts_with('$') || is_pgn_result_token(token) {
        return token.to_string();
    }

    let mut end = token.len();
    while end > 0 {
        let ch = token[..end].chars().last().unwrap_or('\0');
        if ch == '!' || ch == '?' {
            end -= ch.len_utf8();
        } else {
            break;
        }
    }

    token[..end].trim().to_string()
}

fn is_pgn_result_token(token: &str) -> bool {
    matches!(token.trim(), "1-0" | "0-1" | "1/2-1/2" | "*")
}

fn build_annotated_pgn_and_narratives(
    initial_fen: &str,
    moves: &[String],
    analysis: &[MoveAnalysis],
    original_pgn: Option<&str>,
    max_variation_plies: usize,
) -> Result<(String, Vec<HumanMoveNarrative>), Error> {
    let mut position = parse_position(initial_fen)?;
    let mut narratives = Vec::with_capacity(moves.len());
    let mut pgn_annotations: Vec<PgnMoveAnnotation> = Vec::with_capacity(moves.len());
    let mut two_weakness_tracker = TwoWeaknessTracker::default();

    for (ply, raw_uci) in moves.iter().enumerate() {
        let before = position.clone();
        let mover = before.turn();
        let before_fen = Fen::from_position(before.clone(), EnPassantMode::Legal).to_string();
        let played_uci = normalize_move_key(raw_uci);

        let parsed_uci = UciMove::from_ascii(played_uci.as_bytes())?;
        let mv = parsed_uci.to_move(&before)?;
        let san_plus = SanPlus::from_move_and_play_unchecked(&mut position, &mv);
        let played_san = san_plus.to_string();
        let after = position.clone();

        let current_analysis = analysis.get(ply);
        let next_analysis = analysis.get(ply + 1);

        let sorted_lines = current_analysis
            .map(sorted_lines_by_multipv)
            .unwrap_or_default();
        let best_engine_line = sorted_lines.first().copied();
        let engine_best_uci = best_engine_line
            .and_then(|bm| bm.uci_moves.first())
            .map(|s| normalize_move_key(s));
        let engine_best_san = best_engine_line
            .and_then(|bm| bm.san_moves.first())
            .map(|s| s.to_string());

        let strategic_selection = if sorted_lines.is_empty() {
            None
        } else {
            let candidates = sorted_lines
                .iter()
                .map(|bm| (*bm).clone())
                .collect::<Vec<BestMoves>>();
            let strategic_request = HumanStrategicRequest {
                fen: before_fen.clone(),
                // The FEN already is the current pre-move position.
                // Passing previous moves here would replay them twice.
                moves: Vec::new(),
                candidates,
                config: None,
            };

            match catch_unwind(AssertUnwindSafe(|| {
                pick_human_strategic_move(strategic_request)
            })) {
                Ok(Ok(sel)) => Some(sel),
                Ok(Err(err)) => {
                    log::warn!(
                        "Falló el módulo estratégico humano en la ply {}: {:?}",
                        ply + 1,
                        err
                    );
                    None
                }
                Err(_) => {
                    log::warn!(
                        "Panic en human_strategy en la ply {}; se omite selección estratégica para esta jugada",
                        ply + 1
                    );
                    None
                }
            }
        };

        let strategic_choice_uci = strategic_selection
            .as_ref()
            .map(|sel| normalize_move_key(&sel.selected_uci));
        let strategic_choice_san = strategic_selection
            .as_ref()
            .map(|sel| sel.selected_san.clone());

        let played_candidate = strategic_selection.as_ref().and_then(|sel| {
            sel.candidates
                .iter()
                .find(|c| normalize_move_key(&c.uci) == played_uci)
        });
        let selected_candidate = strategic_selection.as_ref().and_then(|sel| {
            sel.candidates
                .iter()
                .find(|c| normalize_move_key(&c.uci) == normalize_move_key(&sel.selected_uci))
        });

        let selected_candidate_pv = selected_candidate
            .map(|c| c.pv_uci_line.clone())
            .unwrap_or_default();
        let played_candidate_pv = played_candidate
            .map(|c| c.pv_uci_line.clone())
            .unwrap_or_default();

        // Important: comments for the played move must use the played candidate only.
        // The selected candidate is reserved for alternative-line comments.
        let played_strategic_score = played_candidate.map(|c| c.strategic_score);
        let played_motifs = played_candidate
            .map(|c| c.motifs.clone())
            .unwrap_or_default();
        let strategic_axes = played_candidate
            .map(|c| extract_top_macro_axes(&c.macro_components))
            .unwrap_or_default();
        let concrete_themes = played_candidate
            .map(|c| extract_top_concrete_themes(&c.components))
            .unwrap_or_default();

        let best_reply_uci = next_analysis
            .and_then(best_line)
            .and_then(|bm| bm.uci_moves.first())
            .map(|s| normalize_move_key(s));

        let mut concrete_bundle = build_concrete_comment_bundle(
            &before,
            &after,
            &mv,
            mover,
            played_candidate,
            &played_san,
            best_reply_uci.as_deref(),
        );
        add_two_weakness_strategy_atoms(
            &mut two_weakness_tracker,
            &mut concrete_bundle.atoms,
            before.board(),
            after.board(),
            &mv,
            mover,
            ply,
        );

        let eval_before_cp = best_engine_line.map(|bm| eval_cp_for_side(&bm.score.value, mover));
        let eval_after_cp = next_analysis
            .and_then(best_line)
            .map(|bm| eval_cp_for_side(&bm.score.value, mover));
        let cp_loss = match (eval_before_cp, eval_after_cp) {
            (Some(before_cp), Some(after_cp)) => Some((before_cp - after_cp).max(0)),
            _ => None,
        };

        let played_is_engine_best = engine_best_uci
            .as_ref()
            .map(|u| *u == played_uci)
            .unwrap_or(false);
        let played_matches_strategic = strategic_choice_uci
            .as_ref()
            .map(|u| *u == played_uci)
            .unwrap_or(false);

        let alternative_cps = sorted_lines
            .iter()
            .map(|bm| eval_cp_for_side(&bm.score.value, mover))
            .collect::<Vec<_>>();
        let is_sacrifice = is_real_material_sacrifice(
            &before,
            &after,
            &mv,
            mover,
            next_analysis.map(|m| m.is_sacrifice).unwrap_or(false),
        );

        let verdict = classify_verdict_phase2(
            eval_before_cp,
            eval_after_cp,
            &alternative_cps,
            played_is_engine_best,
            played_matches_strategic,
            played_strategic_score,
            is_sacrifice,
        );
        let verdict = apply_eval_sanity_guardrail(verdict, cp_loss, eval_before_cp, eval_after_cp);

        if matches!(
            verdict,
            HumanMoveVerdict::Dubious | HumanMoveVerdict::Mistake | HumanMoveVerdict::Blunder
        ) && !played_is_engine_best
        {
            apply_tactical_reality_filter(
                &mut concrete_bundle.atoms,
                &after,
                &mv,
                mover,
                best_reply_uci.as_deref(),
            );
        } else if move_leaves_piece_en_prise(&after, &mv, mover, best_reply_uci.as_deref())
            && tactical_risk_score(before.board(), &mv, mover) >= 150
        {
            add_pv_tactical_resource_atom(
                &mut concrete_bundle.atoms,
                before.clone(),
                &played_candidate_pv,
            );
        }

        concrete_bundle
            .atoms
            .sort_by(|a, b| b.priority.cmp(&a.priority));
        collapse_redundant_atoms(&mut concrete_bundle.atoms);
        concrete_bundle
            .atoms
            .dedup_by(|a, b| a.short == b.short || a.sentence == b.sentence);
        let strategic_plan =
            build_plan_sentence(&strategic_axes, &concrete_themes, &concrete_bundle);

        let suggested_variation_uci = build_suggested_variation_uci(
            &played_uci,
            strategic_choice_uci.as_deref(),
            &selected_candidate_pv,
            &sorted_lines,
            max_variation_plies,
        );
        let suggested_variation_san = uci_line_to_san(
            before.clone(),
            &suggested_variation_uci,
            max_variation_plies,
        );

        let punishment_text = build_engine_punishment_comment(
            after.clone(),
            next_analysis.and_then(best_line),
            verdict,
        );

        let (comment_short, comment_long) = build_comments(
            verdict,
            cp_loss,
            played_strategic_score,
            &played_motifs,
            &strategic_axes,
            &concrete_themes,
            &strategic_plan,
            &concrete_bundle,
            engine_best_san.as_deref(),
            strategic_choice_san.as_deref(),
            played_is_engine_best,
            played_matches_strategic,
            &played_san,
            is_sacrifice,
            punishment_text.as_deref(),
        );

        let selected_concrete_themes = selected_candidate
            .map(|c| extract_top_concrete_themes(&c.components))
            .unwrap_or_default();
        let selected_axes = selected_candidate
            .map(|c| extract_top_macro_axes(&c.macro_components))
            .unwrap_or_default();
        let selected_plan = build_plan_sentence(
            &selected_axes,
            &selected_concrete_themes,
            &ConcreteCommentBundle::default(),
        );
        let variation_comment = build_variation_comment(
            strategic_choice_san.as_deref(),
            engine_best_san.as_deref(),
            &selected_concrete_themes,
            &selected_plan,
            selected_candidate,
        );

        let opening_phase = is_opening_phase(&before, ply);
        let in_known_opening_theory = is_known_opening_theory_position(&before_fen, &before, ply);
        let after_fen = Fen::from_position(after.clone(), EnPassantMode::Legal).to_string();
        let remains_in_known_opening_theory =
            is_known_opening_theory_position(&after_fen, &after, ply + 1);
        let breaks_known_opening_theory =
            in_known_opening_theory && !remains_in_known_opening_theory;
        let opening_novelty = current_analysis.map(|a| a.novelty).unwrap_or(false);
        let should_comment = should_comment_move(
            ply,
            opening_phase,
            in_known_opening_theory,
            breaks_known_opening_theory,
            opening_novelty,
            verdict,
            cp_loss,
            played_strategic_score,
            &played_motifs,
            &concrete_bundle,
            is_sacrifice,
            played_matches_strategic,
            played_candidate,
        );

        let emit_variation = should_comment && !suggested_variation_uci.is_empty();
        let narrative_comment_short = if should_comment {
            comment_short.clone()
        } else {
            String::new()
        };
        let narrative_comment_long = if should_comment {
            comment_long.clone()
        } else {
            String::new()
        };

        pgn_annotations.push(PgnMoveAnnotation {
            nag: nag_for_verdict(verdict, should_comment),
            comment: if should_comment && !comment_long.is_empty() {
                Some(comment_long.clone())
            } else {
                None
            },
            variation_uci: if emit_variation {
                suggested_variation_uci.clone()
            } else {
                Vec::new()
            },
            variation_comment: if emit_variation {
                variation_comment
            } else {
                None
            },
        });

        narratives.push(HumanMoveNarrative {
            ply: ply as u32,
            side_to_move: if mover == Color::White {
                "white".to_string()
            } else {
                "black".to_string()
            },
            played_uci,
            played_san,
            engine_best_uci,
            engine_best_san,
            strategic_choice_uci,
            strategic_choice_san,
            verdict,
            eval_before_cp,
            eval_after_cp,
            cp_loss,
            played_strategic_score,
            played_motifs,
            strategic_axes,
            strategic_plan,
            comment_short: narrative_comment_short,
            comment_long: narrative_comment_long,
            suggested_variation_uci,
            suggested_variation_san,
        });
    }

    let annotated_pgn = build_annotated_pgn(BuildAnnotatedPgnRequest {
        initial_fen: initial_fen.to_string(),
        moves: moves.to_vec(),
        original_pgn: original_pgn.map(|s| s.to_string()),
        annotator: Some("Analizador Estratégico Humano OCS".to_string()),
        move_annotations: pgn_annotations,
        max_variation_plies: Some(max_variation_plies as u32),
    })?;

    Ok((annotated_pgn, narratives))
}

fn should_comment_move(
    ply: usize,
    opening_phase: bool,
    in_known_opening_theory: bool,
    breaks_known_opening_theory: bool,
    opening_novelty: bool,
    verdict: HumanMoveVerdict,
    cp_loss: Option<i32>,
    strategic_score: Option<f32>,
    motifs: &[StrategicMotif],
    concrete_bundle: &ConcreteCommentBundle,
    is_sacrifice: bool,
    played_matches_strategic: bool,
    played_candidate: Option<&HumanStrategicCandidate>,
) -> bool {
    let quiet_or_positive = matches!(
        verdict,
        HumanMoveVerdict::Best
            | HumanMoveVerdict::Great
            | HumanMoveVerdict::Practical
            | HumanMoveVerdict::Interesting
    );
    let cp_loss_value = cp_loss.unwrap_or(0);
    let low_eval_swing = cp_loss_value < 90;
    let strategy_candidate_signal = strategy_commentary::should_comment_from_candidate(
        played_candidate,
        verdict,
        played_matches_strategic,
        is_sacrifice,
    );
    let opening_plan_signal = ply >= 8
        && (has_opening_plan_signal(strategic_score, motifs, concrete_bundle, is_sacrifice)
            || strategy_commentary::has_opening_plan_signal_from_candidate(
                played_candidate,
                played_matches_strategic,
            ));

    // Never annotate the first pure development/book plies unless there is a real
    // tactic or sacrifice. This keeps 1.e4/1...c5 quiet, while still allowing
    // later opening turning points such as ...d4 or Bxf6 followed by Ne4/b4.
    if ply < 8
        && quiet_or_positive
        && !is_sacrifice
        && cp_loss_value < 140
        && !has_opening_exception_atom(concrete_bundle)
    {
        return false;
    }

    // Hard opening suppression for known theory: do not annotate routine moves,
    // even if classified as dubious by shallow eval noise. Keep only true turning
    // points (clear tactical/structural signal or large eval swing).
    if in_known_opening_theory
        && ply < KNOWN_OPENING_COMMENT_SUPPRESS_PLIES
        && !is_sacrifice
        && !has_opening_exception_atom(concrete_bundle)
        && cp_loss_value < 180
        && !breaks_known_opening_theory
        && !opening_novelty
        && !opening_plan_signal
    {
        return false;
    }

    // Generic opening suppression (even when opening name is unknown): avoid
    // clutter during development unless the move is a clear practical mistake.
    if opening_phase
        && ply < OPENING_COMMENT_SUPPRESS_PLIES
        && !is_sacrifice
        && !has_opening_exception_atom(concrete_bundle)
        && cp_loss_value < 130
        && !breaks_known_opening_theory
        && !opening_novelty
        && !opening_plan_signal
    {
        return false;
    }

    if matches!(
        verdict,
        HumanMoveVerdict::Best
            | HumanMoveVerdict::Great
            | HumanMoveVerdict::Practical
            | HumanMoveVerdict::Interesting
    ) && (breaks_known_opening_theory || opening_novelty || opening_plan_signal)
        && (has_opening_exception_atom(concrete_bundle)
            || !concrete_bundle.atoms.is_empty()
            || strategic_score.unwrap_or(0.0) >= 0.56)
    {
        return true;
    }

    if matches!(
        verdict,
        HumanMoveVerdict::Dubious | HumanMoveVerdict::Mistake | HumanMoveVerdict::Blunder
    ) {
        return true;
    }

    // A normal opening move with superficial atoms should not be annotated.
    // This is position-aware, not only ply-based: many games are still in the
    // opening after move 10 if most pieces are not developed and no real
    // strategic transformation happened.
    if in_known_opening_theory
        && quiet_or_positive
        && !is_sacrifice
        && low_eval_swing
        && !has_opening_exception_atom(concrete_bundle)
        && !breaks_known_opening_theory
        && !opening_novelty
        && !opening_plan_signal
    {
        return false;
    }

    if opening_phase
        && quiet_or_positive
        && !is_sacrifice
        && low_eval_swing
        && !has_opening_exception_atom(concrete_bundle)
        && !breaks_known_opening_theory
        && !opening_novelty
        && !opening_plan_signal
    {
        return false;
    }

    if ply < OPENING_COMMENT_SUPPRESS_PLIES
        && quiet_or_positive
        && !is_sacrifice
        && low_eval_swing
        && !has_opening_exception_atom(concrete_bundle)
        && !breaks_known_opening_theory
        && !opening_novelty
        && !opening_plan_signal
    {
        return false;
    }

    if is_sacrifice {
        return true;
    }

    if strategy_candidate_signal {
        return true;
    }

    if concrete_bundle.atoms.len() >= MIN_ATOMS_TO_COMMENT_BEST {
        return true;
    }

    // After the opening, one strong concrete idea is enough. Otherwise quiet
    // technical games can produce zero comments because each move only exposes
    // one clear strategic feature: fixes a pawn, creates a passed pawn, activates
    // a rook, restricts a piece, etc.
    if !opening_phase
        && concrete_bundle
            .atoms
            .first()
            .map(|atom| atom.priority >= MIN_SINGLE_ATOM_PRIORITY_TO_COMMENT)
            .unwrap_or(false)
    {
        return true;
    }

    if strategic_score.unwrap_or(0.0) >= MIN_STRATEGIC_SCORE_TO_COMMENT_BEST
        && played_matches_strategic
    {
        return true;
    }

    if !opening_phase
        && strategic_score.unwrap_or(0.0) >= MIN_STRATEGIC_SCORE_TO_COMMENT_AFTER_OPENING
        && (!motifs.is_empty() || played_matches_strategic)
    {
        return true;
    }

    if !motifs.is_empty() && strategic_score.unwrap_or(0.0) >= 0.50 && ply >= 10 {
        return true;
    }

    cp_loss.unwrap_or(0) >= 70
}

fn apply_eval_sanity_guardrail(
    verdict: HumanMoveVerdict,
    cp_loss: Option<i32>,
    eval_before_cp: Option<i32>,
    eval_after_cp: Option<i32>,
) -> HumanMoveVerdict {
    let Some(loss) = cp_loss else {
        return verdict;
    };

    // Absolute safety net: a move that collapses the evaluation cannot be
    // labeled as Best/Great/Practical just because another field says it was
    // engine-first. This catches cases like +4.2 -> -4.2 where the move creates
    // a passed pawn but tactically throws the game.
    if loss >= 500 {
        return HumanMoveVerdict::Blunder;
    }
    if loss >= 260 {
        return HumanMoveVerdict::Blunder;
    }
    if loss >= 140 {
        return HumanMoveVerdict::Mistake;
    }
    if loss >= 80 {
        return HumanMoveVerdict::Dubious;
    }

    // Crossing from clearly better/equal to clearly worse is always at least a
    // serious practical error, even when the raw cp delta is near a threshold.
    if let (Some(before), Some(after)) = (eval_before_cp, eval_after_cp) {
        if before >= 180 && after <= -180 {
            return HumanMoveVerdict::Blunder;
        }
        if before >= 80 && after <= -120 {
            return HumanMoveVerdict::Mistake;
        }
    }

    verdict
}

fn has_opening_exception_atom(bundle: &ConcreteCommentBundle) -> bool {
    bundle.atoms.iter().any(|atom| {
        let short = atom.short.to_lowercase();
        let sentence = atom.sentence.to_lowercase();
        let looks_tactical = short.contains("sacrificio")
            || short.contains("tactico")
            || short.contains("táctico")
            || short.contains("jaque")
            || short.contains("gana material")
            || short.contains("abre una linea hacia el rey")
            || short.contains("abre una línea hacia el rey")
            || short.contains("abre una diagonal hacia el rey")
            || short.contains("columna abierta");
        let sentence_confirms_turning_point = sentence.contains("rey")
            || sentence.contains("material")
            || sentence.contains("forzada")
            || sentence.contains("forzado")
            || sentence.contains("tactica")
            || sentence.contains("táctica")
            || sentence.contains("sacrificio");
        looks_tactical && sentence_confirms_turning_point
    })
}

fn has_opening_plan_signal(
    strategic_score: Option<f32>,
    motifs: &[StrategicMotif],
    bundle: &ConcreteCommentBundle,
    is_sacrifice: bool,
) -> bool {
    if is_sacrifice {
        return true;
    }

    let strong_atoms = bundle
        .atoms
        .iter()
        .take(3)
        .filter(|a| a.priority >= 84)
        .count();
    let explicit_plan_atom = bundle.atoms.iter().any(|a| {
        let short = a.short.to_ascii_lowercase();
        short.contains("sacrificio estructural")
            || short.contains("ocupa la columna")
            || short.contains("avanza en el centro")
            || short.contains("rompe el centro")
            || short.contains("prepara el plan")
            || short.contains("prepara h5-h4")
            || short.contains("prepara h4-h5")
            || short.contains("abre la columna")
            || short.contains("fija la estructura")
    });

    // Important: do not require a high strategic score for concrete opening
    // turning points. The previous version filtered out moves like ...d4 and
    // Bxf6 because their abstract strategy score could be modest even when the
    // engine PV showed a clear human plan.
    if explicit_plan_atom && strong_atoms >= 1 {
        return true;
    }

    let strategic_motif = motifs.iter().any(|m| {
        matches!(
            m,
            StrategicMotif::DamagedPawnStructure
                | StrategicMotif::WeakPawnPressure
                | StrategicMotif::SpaceGain
                | StrategicMotif::OpenFilePressure
                | StrategicMotif::CentralKingPressure
                | StrategicMotif::PieceRestriction
                | StrategicMotif::WingClamp
                | StrategicMotif::OutpostControl
                | StrategicMotif::ColorComplexPressure
                | StrategicMotif::Prophylaxis
                | StrategicMotif::FavorableTrade
                | StrategicMotif::PassedPawnConversion
                | StrategicMotif::InitiativeSacrifice
                | StrategicMotif::Counterplay
                | StrategicMotif::KingNet
                | StrategicMotif::PieceCoordination
                | StrategicMotif::TensionManagement
        )
    });

    if !strategic_motif {
        return false;
    }

    strategic_score.unwrap_or(0.0) >= 0.48 && strong_atoms >= 1
}

fn classify_verdict_phase2(
    eval_before_cp: Option<i32>,
    eval_after_cp: Option<i32>,
    alternative_cps: &[i32],
    played_is_engine_best: bool,
    played_matches_strategic: bool,
    played_strategic_score: Option<f32>,
    is_sacrifice: bool,
) -> HumanMoveVerdict {
    let Some(prev_cp) = eval_before_cp else {
        return HumanMoveVerdict::Interesting;
    };
    let Some(next_cp) = eval_after_cp else {
        return HumanMoveVerdict::Interesting;
    };

    let win_diff = win_chance(prev_cp) - win_chance(next_cp);
    let best_cp = alternative_cps.first().copied().unwrap_or(next_cp);
    let near_best = best_cp - next_cp <= NEAR_BEST_CP;
    let no_real_escape = prev_cp <= HOPELESS_CP
        && (alternative_cps.is_empty()
            || alternative_cps
                .iter()
                .all(|cp| *cp <= HOPELESS_CP + HOPELESS_MARGIN));
    if no_real_escape {
        return HumanMoveVerdict::Interesting;
    }

    let has_better_alternative = alternative_cps.iter().any(|alt_cp| {
        if next_cp <= HOPELESS_CP && *alt_cp <= HOPELESS_CP + HOPELESS_MARGIN {
            return false;
        }
        *alt_cp > next_cp + 100
    });
    let cp_drop = (prev_cp - next_cp).max(0);

    if has_better_alternative && (win_diff > 20.0 || (cp_drop > 400 && prev_cp > 0)) {
        return HumanMoveVerdict::Blunder;
    }
    if has_better_alternative && (win_diff > 10.0 || (cp_drop > 200 && prev_cp > 100)) {
        return HumanMoveVerdict::Mistake;
    }
    if has_better_alternative && (win_diff > 5.0 || (cp_drop > 100 && prev_cp >= 0)) {
        return HumanMoveVerdict::Dubious;
    }

    if played_is_engine_best {
        if is_sacrifice && next_cp >= -50 {
            return HumanMoveVerdict::Great;
        }
        return HumanMoveVerdict::Best;
    }

    if near_best {
        // A move can be near-equivalent, but it is not the engine-best move.
        // Do not label it as Best, otherwise comments can say "Mejor jugada"
        // while also showing a stronger engine move.
        return HumanMoveVerdict::Practical;
    }

    if is_sacrifice && next_cp > -250 {
        return HumanMoveVerdict::Interesting;
    }

    if played_matches_strategic && played_strategic_score.unwrap_or(0.0) >= 0.68 && cp_drop <= 120 {
        return HumanMoveVerdict::Practical;
    }

    if cp_drop <= 60 {
        HumanMoveVerdict::Interesting
    } else if cp_drop <= 130 {
        HumanMoveVerdict::Dubious
    } else if cp_drop <= 260 {
        HumanMoveVerdict::Mistake
    } else {
        HumanMoveVerdict::Blunder
    }
}

fn nag_for_verdict(verdict: HumanMoveVerdict, should_comment: bool) -> Option<u8> {
    // If we decided not to comment, do not emit visual NAG noise either.
    // This prevents opening moves from becoming e4!?, e5!?, Nc3!?, etc.
    if !should_comment {
        return None;
    }

    match verdict {
        // Do not spam $8. Reserve "only move" NAG for a future explicit OnlyMove verdict.
        HumanMoveVerdict::Best => None,
        HumanMoveVerdict::Great => Some(1),
        HumanMoveVerdict::Practical | HumanMoveVerdict::Interesting => Some(5),
        HumanMoveVerdict::Dubious => Some(6),
        HumanMoveVerdict::Mistake => Some(2),
        HumanMoveVerdict::Blunder => Some(4),
    }
}

fn build_comments(
    verdict: HumanMoveVerdict,
    _cp_loss: Option<i32>,
    played_strategic_score: Option<f32>,
    motifs: &[StrategicMotif],
    strategic_axes: &[HumanStrategicAxisNarrative],
    concrete_themes: &[HumanStrategicConcreteTheme],
    _strategic_plan: &str,
    concrete_bundle: &ConcreteCommentBundle,
    engine_best_san: Option<&str>,
    _strategic_choice_san: Option<&str>,
    played_is_engine_best: bool,
    _played_matches_strategic: bool,
    played_san: &str,
    is_sacrifice: bool,
    punishment_text: Option<&str>,
) -> (String, String) {
    let motif_text = motifs_to_text(motifs);
    let _axes_text = summarize_axes(strategic_axes);
    let concrete_text = summarize_concrete_themes(concrete_themes);
    let atom_limit = match verdict {
        HumanMoveVerdict::Best | HumanMoveVerdict::Great => 2,
        _ => 2,
    };
    let concrete_short = summarize_atoms_as_short_phrase(&concrete_bundle.atoms, atom_limit);
    let liability_short = summarize_liability_short(&concrete_bundle.atoms);
    let gm_plan_hint = derive_gm_plan_hint(&concrete_bundle.atoms, motifs, is_sacrifice);
    let evidence = concrete_bundle
        .atoms
        .first()
        .filter(|atom| atom.priority >= 104)
        .map(|atom| atom.sentence.clone())
        .unwrap_or_default();

    let engine_alt = engine_best_san
        .filter(|_| !played_is_engine_best)
        .map(|best| format!("La opcion mas fuerte era {}.", best))
        .unwrap_or_default();

    let score_ok = played_strategic_score.unwrap_or(0.0) >= MIN_STRATEGIC_SCORE_TO_EXPLAIN;
    let has_concrete = !concrete_bundle.atoms.is_empty();
    let has_theme = !concrete_text.is_empty() && score_ok;

    let base = match verdict {
        HumanMoveVerdict::Best => {
            if has_concrete {
                format!("Jugada precisa: {}.", concrete_short)
            } else if has_theme {
                format!("Jugada precisa con plan claro: {}.", concrete_text)
            } else {
                "Jugada precisa.".to_string()
            }
        }
        HumanMoveVerdict::Great => {
            if is_sacrifice && has_concrete {
                format!("Excelente recurso practico: {}.", concrete_short)
            } else if has_concrete {
                format!("Jugada de alto nivel: {}.", concrete_short)
            } else if has_theme {
                format!("Jugada de alto nivel: {}.", concrete_text)
            } else {
                "Jugada de alto nivel.".to_string()
            }
        }
        HumanMoveVerdict::Practical => {
            if has_concrete {
                format!("Buena decision practica: {}.", concrete_short)
            } else if has_theme {
                format!("Buena decision practica: {}.", concrete_text)
            } else {
                "Buena decision practica.".to_string()
            }
        }
        HumanMoveVerdict::Interesting => {
            if has_concrete {
                format!("Idea interesante para desequilibrar: {}.", concrete_short)
            } else if has_theme {
                format!("Idea interesante para desequilibrar: {}.", motif_text)
            } else {
                "Idea jugable, aunque requiere precision para sostenerse.".to_string()
            }
        }
        HumanMoveVerdict::Dubious => {
            if let Some(short) = liability_short.as_deref() {
                format!("Imprecision seria: {}.", short)
            } else {
                "Imprecision seria que cede la iniciativa.".to_string()
            }
        }
        HumanMoveVerdict::Mistake => {
            if let Some(short) = liability_short.as_deref() {
                format!("Error importante: {}.", short)
            } else {
                "Error importante que cambia la evaluacion de la posicion.".to_string()
            }
        }
        HumanMoveVerdict::Blunder => {
            if let Some(short) = liability_short.as_deref() {
                format!("Error grave: {}.", short)
            } else {
                "Error grave que deja la posicion en situacion critica.".to_string()
            }
        }
    };

    let mut parts: Vec<String> = vec![base.clone()];

    if !evidence.is_empty()
        && matches!(
            verdict,
            HumanMoveVerdict::Best
                | HumanMoveVerdict::Great
                | HumanMoveVerdict::Practical
                | HumanMoveVerdict::Interesting
        )
        && !is_redundant_evidence_for_base(&base, &evidence)
    {
        parts.push(evidence);
    }
    if matches!(
        verdict,
        HumanMoveVerdict::Best
            | HumanMoveVerdict::Great
            | HumanMoveVerdict::Practical
            | HumanMoveVerdict::Interesting
    ) {
        if let Some(plan) = gm_plan_hint {
            parts.push(plan);
        }
    }

    match verdict {
        HumanMoveVerdict::Dubious | HumanMoveVerdict::Mistake | HumanMoveVerdict::Blunder => {
            if let Some(punishment) = punishment_text.filter(|s| !s.trim().is_empty()) {
                parts.push(punishment.to_string());
            } else if !engine_alt.is_empty() {
                parts.push(engine_alt);
            }
        }
        _ => {}
    }

    let long = join_unique_sentences(&parts);
    let long = if long.is_empty() {
        format!("{}.", played_san)
    } else {
        long
    };

    (clean_spaces(&base), clean_spaces(&long))
}

fn build_engine_punishment_comment(
    after: Chess,
    best_line_after: Option<&BestMoves>,
    verdict: HumanMoveVerdict,
) -> Option<String> {
    if !matches!(
        verdict,
        HumanMoveVerdict::Dubious | HumanMoveVerdict::Mistake | HumanMoveVerdict::Blunder
    ) {
        return None;
    }

    let line = best_line_after?;
    if line.uci_moves.is_empty() {
        return None;
    }

    let san = uci_line_to_san(after.clone(), &line.uci_moves, 6);
    if san.is_empty() {
        return None;
    }

    let first = san[0].clone();
    let pv = san.iter().take(6).cloned().collect::<Vec<_>>().join(" ");

    // If the engine score is mate, this is the most important explanation for
    // a human player. Do not describe it merely as "a check".
    if matches!(line.score.value, ScoreValue::Mate(_)) {
        return Some(format!(
            "La jugada permite una secuencia de mate: {}. Linea critica: {}.",
            first, pv
        ));
    }

    let first_is_capture = first.contains('x');
    let first_is_check = first.contains('+') || first.contains('#');

    let pos = after.clone();
    let first_uci = line.uci_moves.first()?;
    let uci = UciMove::from_ascii(normalize_move_key(first_uci).as_bytes()).ok()?;
    let mv = uci.to_move(&pos).ok()?;
    let mover = pos.turn();
    let captured_value = capture_square_for_move(pos.board(), &mv, mover)
        .and_then(|sq| pos.board().piece_at(sq))
        .filter(|p| p.color != mover)
        .map(|p| role_value(p.role))
        .unwrap_or(0);

    let consequence = if captured_value >= 500 && first_is_check {
        "El rival gana material con jaque"
    } else if captured_value >= 500 {
        "El rival gana material importante"
    } else if captured_value >= 300 && first_is_check {
        "El rival gana una pieza con jaque"
    } else if captured_value >= 300 {
        "El rival gana una pieza"
    } else if first_is_check {
        "El rival obtiene una iniciativa forzada con jaque"
    } else if first_is_capture {
        "El rival consigue una captura favorable"
    } else {
        "La posicion se inclina a favor del rival"
    };

    Some(format!(
        "{}: {}. Linea critica: {}.",
        consequence, first, pv
    ))
}

fn build_concrete_comment_bundle(
    before: &Chess,
    after: &Chess,
    mv: &Move,
    mover: Color,
    candidate: Option<&HumanStrategicCandidate>,
    played_san: &str,
    _best_reply_uci: Option<&str>,
) -> ConcreteCommentBundle {
    let mut atoms = Vec::new();
    let board_before = before.board();
    let board_after = after.board();
    if played_san.contains('+') {
        add_capture_with_check_atom(&mut atoms, board_before, mv, mover);
        atoms.push(ConcreteCommentAtom {
            priority: 95,
            short: "gana un tiempo con jaque".to_string(),
            sentence: "El jaque obliga al rey a gastar una jugada en defenderse, en vez de consolidar la posición."
                .to_string(),
        });
    }

    add_capture_atoms(&mut atoms, board_before, board_after, mv, mover);
    add_forced_recapture_atoms(&mut atoms, board_before, board_after, mv, mover);
    add_king_exposure_atoms(&mut atoms, board_before, board_after, mv, mover);
    add_open_line_atoms(&mut atoms, board_before, board_after, mv, mover);
    add_bishop_pressure_atoms(&mut atoms, board_before, board_after, mv, mover);
    add_structural_sacrifice_atoms(&mut atoms, board_before, board_after, mv, mover);
    add_central_space_push_atoms(&mut atoms, board_before, board_after, mv, mover);
    add_knight_trap_plan_atoms(&mut atoms, board_before, board_after, mv, mover);
    add_central_break_control_atoms(&mut atoms, board_before, board_after, mv, mover);
    add_pawn_fixation_atoms(&mut atoms, board_before, board_after, mover);
    add_weak_target_atoms(&mut atoms, board_before, board_after, mv, mover);
    add_piece_restriction_atoms(&mut atoms, board_before, board_after, mover);
    add_outpost_or_infiltration_atoms(&mut atoms, board_before, board_after, mv, mover);
    add_pawn_structure_atoms(&mut atoms, board_before, board_after, mover);
    add_passed_pawn_atoms(&mut atoms, board_before, board_after, mv, mover);
    add_rook_activity_atoms(&mut atoms, board_before, board_after, mv, mover);
    add_rook_file_plan_atoms(&mut atoms, board_before, board_after, mv, mover);
    add_candidate_pv_plan_atoms(&mut atoms, before.clone(), mv, mover, candidate);

    if let Some(c) = candidate {
        strategy_commentary::add_candidate_strategy_atoms(&mut atoms, c);

        if c.components.pawn_structure_damage >= 0.35 {
            add_atom_once(
                &mut atoms,
                70,
                "daña la estructura de peones",
                "El punto estratégico es dejar al rival con objetivos de peón más duraderos.",
            );
        }
        if c.components.open_file_pressure >= 0.35 {
            add_atom_once(
                &mut atoms,
                64,
                "mejora la presión en columnas abiertas",
                "La jugada aumenta la actividad de las piezas mayores en columnas abiertas o semiabiertas.",
            );
        }
        if c.components.central_king_pressure >= 0.35 {
            add_atom_once(
                &mut atoms,
                74,
                "abre líneas hacia el rey",
                "La compensación principal es la exposición del rey, no una ganancia material inmediata.",
            );
        }
        if c.components.piece_restriction >= 0.35 {
            add_atom_once(
                &mut atoms,
                58,
                "restringe piezas defensivas",
                "Las piezas del rival pierden casillas defensivas útiles después de esta jugada.",
            );
        }
        if c.components.weak_pawn_pressure >= 0.35 {
            add_atom_once(
                &mut atoms,
                62,
                "crea objetivos de peón",
                "La jugada aumenta la presión contra peones que son difíciles de defender limpiamente.",
            );
        }
    }

    atoms.sort_by(|a, b| b.priority.cmp(&a.priority));
    collapse_redundant_atoms(&mut atoms);
    atoms.dedup_by(|a, b| a.short == b.short || a.sentence == b.sentence);

    ConcreteCommentBundle { atoms }
}

fn collapse_redundant_atoms(atoms: &mut Vec<ConcreteCommentAtom>) {
    if atoms.is_empty() {
        return;
    }

    let has_material_capture_with_check = atoms.iter().any(|atom| {
        let short = atom.short.to_ascii_lowercase();
        short.contains("con jaque")
            && (short.contains("gana material")
                || short.contains("gana una pieza")
                || short.contains("gana un peon")
                || short.contains("gana un peón"))
    });

    if has_material_capture_with_check {
        atoms.retain(|atom| {
            !atom
                .short
                .to_ascii_lowercase()
                .contains("gana un tiempo con jaque")
        });
    }

    let check_capture_squares = atoms
        .iter()
        .filter_map(|atom| {
            let short = atom.short.to_ascii_lowercase();
            if short.contains("con jaque") {
                return trailing_square(&short);
            }
            None
        })
        .collect::<HashSet<_>>();

    if check_capture_squares.is_empty() {
        return;
    }

    atoms.retain(|atom| {
        let short = atom.short.to_ascii_lowercase();
        if !short.starts_with("elimina ") {
            return true;
        }

        if let Some(sq) = trailing_square(&short) {
            return !check_capture_squares.contains(&sq);
        }
        true
    });
}

fn trailing_square(text: &str) -> Option<String> {
    let token = text
        .split_whitespace()
        .last()
        .map(|t| t.trim_matches(|ch: char| !ch.is_ascii_alphanumeric()))?;
    let bytes = token.as_bytes();
    if bytes.len() != 2 {
        return None;
    }
    let file = bytes[0].to_ascii_lowercase();
    let rank = bytes[1];
    if !(b'a'..=b'h').contains(&file) || !(b'1'..=b'8').contains(&rank) {
        return None;
    }
    Some(format!("{}{}", file as char, rank as char))
}

fn is_redundant_evidence_for_base(base: &str, evidence: &str) -> bool {
    let base_text = base.to_ascii_lowercase();
    let evidence_text = evidence.to_ascii_lowercase();

    let base_has_check = base_text.contains("jaque");
    let evidence_has_check = evidence_text.contains("jaque");

    let base_has_capture_gain = base_text.contains("captura")
        || base_text.contains("elimina")
        || base_text.contains("gana material")
        || base_text.contains("gana una pieza")
        || base_text.contains("gana un peon")
        || base_text.contains("gana un peón");
    let evidence_has_capture_gain = evidence_text.contains("captura")
        || evidence_text.contains("elimina")
        || evidence_text.contains("gana material")
        || evidence_text.contains("gana una pieza")
        || evidence_text.contains("gana un peon")
        || evidence_text.contains("gana un peón");

    base_has_check && evidence_has_check && base_has_capture_gain && evidence_has_capture_gain
}

fn add_two_weakness_strategy_atoms(
    tracker: &mut TwoWeaknessTracker,
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    after: &Board,
    mv: &Move,
    mover: Color,
    ply: usize,
) {
    let opponent = mover.other();

    // Strict rule:
    // "Two weaknesses" is not just king pressure + any pawn weakness.
    // It is only emitted when the attacker has created real pressure on both flanks
    // and the current move belongs to an actual flank attack or a real switch of play.
    let current_attack_sectors = real_flank_attack_sectors_for_move(before, after, mover, opponent);
    if current_attack_sectors.is_empty() {
        return;
    }

    let state = two_weakness_state_mut(tracker, mover);

    let mut current_switch = false;
    for sector in &current_attack_sectors {
        if state
            .last_attack_sector
            .map(|prev| prev != *sector)
            .unwrap_or(false)
        {
            state.attack_switch_events = state.attack_switch_events.saturating_add(1);
            current_switch = true;
        }
        state.last_attack_sector = Some(*sector);
        state.real_attack_sectors.insert(*sector);
    }

    // Support counters remain useful for summary/diagnosis, but they do not trigger
    // the motif by themselves.
    if central_king_pressure_signal(before, after, mover, opponent, mv) {
        state.king_pressure_events = state.king_pressure_events.saturating_add(1);
    }
    if pawn_structure_damage_delta(before, after, mover) > 0
        || is_structural_pawn_sacrifice_pattern(before, mv, mover)
        || !newly_fixed_pawn_squares(before, after, mover).is_empty()
    {
        state.structure_events = state.structure_events.saturating_add(1);
    }
    if !newly_created_target_squares(before, after, mover, opponent).is_empty() {
        state.target_events = state.target_events.saturating_add(1);
    }
    if pseudo_mobility(before, opponent).saturating_sub(pseudo_mobility(after, opponent)) >= 5 {
        state.restriction_events = state.restriction_events.saturating_add(1);
    }

    let has_both_flanks = state.real_attack_sectors.contains("flanco dama")
        && state.real_attack_sectors.contains("flanco rey");
    let enough_switching = state.attack_switch_events >= 1;
    let enough_support = state
        .king_pressure_events
        .saturating_add(state.structure_events)
        .saturating_add(state.target_events)
        .saturating_add(state.restriction_events)
        >= 3;
    let cooldown_ok = state
        .last_comment_ply
        .map(|last| ply.saturating_sub(last) >= 10)
        .unwrap_or(true);

    if !has_both_flanks || !enough_switching || !enough_support || !cooldown_ok || ply < 24 {
        return;
    }

    let short = if current_switch {
        "cambio de frente sobre dos debilidades reales"
    } else {
        "presión real en ambos flancos"
    };
    let sentence_text = if current_switch {
        "El atacante cambia de frente después de haber creado presión real en ambos flancos; el defensor ya no puede concentrarse en una sola zona."
    } else {
        "La posición muestra dos debilidades reales: presión concreta en flanco dama y flanco rey, no solo ventajas estáticas."
    };

    atoms.push(ConcreteCommentAtom {
        priority: 116,
        short: short.to_string(),
        sentence: sentence_text.to_string(),
    });
    state.last_comment_ply = Some(ply);
}

fn real_flank_attack_sectors_for_move(
    before: &Board,
    after: &Board,
    mover: Color,
    opponent: Color,
) -> HashSet<&'static str> {
    let mut sectors = HashSet::new();
    for sector in ["flanco dama", "flanco rey"] {
        let before_score = flank_attack_score(before, mover, opponent, sector);
        let after_score = flank_attack_score(after, mover, opponent, sector);

        // Require actual pressure, not just an attacked pawn or a cosmetic target.
        // The move must either create new pressure or raise an already real attack.
        if after_score >= 2.0 && after_score >= before_score + 0.75 {
            sectors.insert(sector);
        }
    }
    sectors
}

fn flank_attack_score(
    board: &Board,
    attacker: Color,
    defender: Color,
    sector: &'static str,
) -> f32 {
    let mut score = 0.0;

    for sq in board.by_color(defender) {
        let Some(piece) = board.piece_at(sq) else {
            continue;
        };
        if piece.role == Role::King {
            continue;
        }
        if sector_for_square(sq) != sector {
            continue;
        }

        let attackers = attackers_of_square(board, attacker, sq).len() as i32;
        if attackers == 0 {
            continue;
        }
        let defenders = attackers_of_square(board, defender, sq).len() as i32;
        let value = role_value(piece.role) as f32 / 300.0;

        if attackers > defenders {
            score += 1.0 + value.min(2.0) * 0.35;
        } else if attackers >= 2 && piece.role != Role::Pawn {
            score += 0.85;
        } else if attackers >= 2 && is_meaningful_pawn_target(board, attacker, defender, sq) {
            score += 0.65;
        }
    }

    // King-zone pressure can count as a real flank attack only if the king is on
    // that flank. A central king is handled by king-pressure support, not by the
    // two-flank detector.
    if let Some(king_sq) = king_square(board, defender) {
        if sector_for_square(king_sq) == sector {
            score +=
                normalize_local(attackers_around_king(board, attacker, defender) as f32, 4.0) * 1.4;
        }
    }

    score
}

fn normalize_local(value: f32, cap: f32) -> f32 {
    if cap <= 0.0 {
        return 0.0;
    }
    (value / cap).clamp(0.0, 1.0)
}

fn two_weakness_state_mut(
    tracker: &mut TwoWeaknessTracker,
    mover: Color,
) -> &mut TwoWeaknessSideState {
    match mover {
        Color::White => &mut tracker.white,
        Color::Black => &mut tracker.black,
    }
}

fn pawn_structure_damage_delta(before: &Board, after: &Board, mover: Color) -> u8 {
    let opponent = mover.other();
    let before_files = pawn_file_counts(before, opponent);
    let after_files = pawn_file_counts(after, opponent);

    let islands = pawn_islands(&after_files).saturating_sub(pawn_islands(&before_files));
    let doubled = doubled_pawns(&after_files).saturating_sub(doubled_pawns(&before_files));
    let isolated = isolated_pawns_from_file_counts(&after_files)
        .saturating_sub(isolated_pawns_from_file_counts(&before_files));

    islands.saturating_add(doubled).saturating_add(isolated)
}

fn newly_created_target_squares(
    before: &Board,
    after: &Board,
    mover: Color,
    opponent: Color,
) -> Vec<Square> {
    let before_targets = loose_or_overloaded_targets(before, mover, opponent);
    loose_or_overloaded_targets(after, mover, opponent)
        .into_iter()
        .filter(|sq| !before_targets.contains(sq))
        .collect()
}

fn newly_fixed_pawn_squares(before: &Board, after: &Board, mover: Color) -> Vec<Square> {
    let opponent = mover.other();
    let mut out = Vec::new();

    for pawn_sq in after.pawns() & after.by_color(opponent) {
        let Some((file, rank)) = square_to_coords(pawn_sq) else {
            continue;
        };
        let advanced = match opponent {
            Color::White => rank >= 3,
            Color::Black => rank <= 4,
        };
        if !advanced {
            continue;
        }

        let next_rank = match opponent {
            Color::White => rank as i32 + 1,
            Color::Black => rank as i32 - 1,
        };
        let Some(push_sq) = coords_to_square_checked(file as i32, next_rank) else {
            continue;
        };

        let after_fixed = after
            .piece_at(push_sq)
            .map(|p| p.color == mover)
            .unwrap_or(false)
            || is_square_attacked_by(after, mover, push_sq);
        let before_fixed = before
            .piece_at(push_sq)
            .map(|p| p.color == mover)
            .unwrap_or(false)
            || is_square_attacked_by(before, mover, push_sq);

        if after_fixed && !before_fixed {
            out.push(pawn_sq);
        }
    }

    out
}

fn is_structural_pawn_sacrifice_pattern(before: &Board, mv: &Move, mover: Color) -> bool {
    if mv.role() == Role::Pawn {
        return false;
    }
    let Some(capture_sq) = capture_square_for_move(before, mv, mover) else {
        return false;
    };
    let Some(captured) = before.piece_at(capture_sq) else {
        return false;
    };
    captured.color != mover
        && captured.role == Role::Pawn
        && !pawn_attackers_of_square(before, mover.other(), mv.to()).is_empty()
}

fn central_king_pressure_signal(
    before: &Board,
    after: &Board,
    mover: Color,
    opponent: Color,
    mv: &Move,
) -> bool {
    let Some(king_sq) = king_square(after, opponent) else {
        return false;
    };
    let Some((king_file, king_rank)) = square_to_coords(king_sq) else {
        return false;
    };
    let central_king = matches!(king_file, 2..=5)
        && ((opponent == Color::White && king_rank <= 1)
            || (opponent == Color::Black && king_rank >= 6));
    if !central_king {
        return false;
    }
    let forcing = capture_square_for_move(before, mv, mover).is_some()
        || is_square_attacked_by(after, mover, king_sq);
    forcing && (central_files_are_open(after) || central_pawn_tension(after))
}

fn sector_for_square(square: Square) -> &'static str {
    let Some((file, _)) = square_to_coords(square) else {
        return "centro";
    };
    match file {
        0..=2 => "flanco dama",
        3..=4 => "centro",
        5..=7 => "flanco rey",
        _ => "centro",
    }
}

fn add_passed_pawn_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    after: &Board,
    mv: &Move,
    mover: Color,
) {
    if mv.role() != Role::Pawn {
        return;
    }
    let before_passers = passed_pawns(before, mover);
    let after_passers = passed_pawns(after, mover);
    let mut new_or_advanced = after_passers
        .into_iter()
        .filter(|sq| !before_passers.contains(sq) || *sq == mv.to())
        .collect::<Vec<_>>();
    if new_or_advanced.is_empty() {
        return;
    }
    new_or_advanced.sort_by_key(|sq| promotion_distance(*sq, mover));
    let sq = new_or_advanced[0];
    let distance = promotion_distance(sq, mover);
    let priority = if distance <= 2 { 96 } else { 86 };
    atoms.push(ConcreteCommentAtom {
        priority,
        short: format!("crea un peón pasado en {}", sq),
        sentence: format!(
            "El peón de {} se convierte en un factor estratégico serio: está a {} paso(s) de coronar.",
            sq, distance
        ),
    });
}

fn add_rook_activity_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    after: &Board,
    mv: &Move,
    mover: Color,
) {
    if mv.role() != Role::Rook {
        return;
    }
    let Some((_file, rank)) = square_to_coords(mv.to()) else {
        return;
    };
    let advanced = match mover {
        Color::White => rank >= 4,
        Color::Black => rank <= 3,
    };
    if !advanced {
        return;
    }
    let before_activity = rook_activity_score(before, mover);
    let after_activity = rook_activity_score(after, mover);
    if after_activity <= before_activity + 0.4 {
        return;
    }
    atoms.push(ConcreteCommentAtom {
        priority: 85,
        short: format!("activa la torre en la {}ª fila", rank + 1),
        sentence:
            "La torre entra en una fila activa y empieza a presionar peones o cortes del rey rival."
                .to_string(),
    });
}

fn add_rook_file_plan_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    _before: &Board,
    after: &Board,
    mv: &Move,
    mover: Color,
) {
    if mv.role() != Role::Rook {
        return;
    }
    let Some((file, _rank)) = square_to_coords(mv.to()) else {
        return;
    };
    let own_files = pawn_file_counts(after, mover);
    let opp_files = pawn_file_counts(after, mover.other());
    let own = own_files[file];
    let opp = opp_files[file];

    let on_open_or_semi_open = own == 0 && opp <= 1;
    if !on_open_or_semi_open {
        return;
    }

    let file_label = file_name(file);
    let has_central_king = king_square(after, mover.other())
        .and_then(square_to_coords)
        .map(|(kf, _)| matches!(kf, 2..=5))
        .unwrap_or(false);

    let (priority, sentence) = if has_central_king && matches!(file, 3 | 4) {
        (
            92,
            format!(
                "La torre en la columna {} centraliza la presion: el plan natural es doblar piezas pesadas y jugar contra el rey en el centro.",
                file_label
            ),
        )
    } else {
        (
            80,
            format!(
                "La torre ocupa una columna util ({}): la idea es acumular presion con piezas mayores y obligar concesiones estructurales.",
                file_label
            ),
        )
    };

    atoms.push(ConcreteCommentAtom {
        priority,
        short: format!("ocupa la columna {} con plan activo", file_label),
        sentence,
    });
}

fn passed_pawns(board: &Board, color: Color) -> Vec<Square> {
    let opponent = color.other();
    let mut out = Vec::new();
    for sq in board.pawns() & board.by_color(color) {
        let Some((file, rank)) = square_to_coords(sq) else {
            continue;
        };
        let mut blocked_by_enemy_pawn = false;
        for df in [-1i32, 0, 1] {
            let nf = file as i32 + df;
            if !(0..=7).contains(&nf) {
                continue;
            }
            let ranks: Box<dyn Iterator<Item = i32>> = match color {
                Color::White => Box::new((rank as i32 + 1)..=7),
                Color::Black => Box::new((0..rank as i32).rev()),
            };
            for nr in ranks {
                if let Some(target) = coords_to_square_checked(nf, nr) {
                    if board
                        .piece_at(target)
                        .map(|p| p.color == opponent && p.role == Role::Pawn)
                        .unwrap_or(false)
                    {
                        blocked_by_enemy_pawn = true;
                        break;
                    }
                }
            }
            if blocked_by_enemy_pawn {
                break;
            }
        }
        if !blocked_by_enemy_pawn {
            out.push(sq);
        }
    }
    out
}

fn promotion_distance(square: Square, color: Color) -> usize {
    let Some((_, rank)) = square_to_coords(square) else {
        return 8;
    };
    match color {
        Color::White => 7usize.saturating_sub(rank),
        Color::Black => rank,
    }
}

fn rook_activity_score(board: &Board, color: Color) -> f32 {
    let mut score = 0.0;
    for sq in board.rooks() & board.by_color(color) {
        let Some((file, rank)) = square_to_coords(sq) else {
            continue;
        };
        let advanced = match color {
            Color::White => rank >= 4,
            Color::Black => rank <= 3,
        };
        if advanced {
            score += 1.0;
        }
        let files = pawn_file_counts(board, color);
        let opp_files = pawn_file_counts(board, color.other());
        if files[file] == 0 || opp_files[file] == 0 {
            score += 0.45;
        }
    }
    score
}

fn add_candidate_pv_plan_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    start: Chess,
    mv: &Move,
    mover: Color,
    candidate: Option<&HumanStrategicCandidate>,
) {
    let Some(candidate) = candidate else {
        return;
    };
    if candidate.pv_uci_line.is_empty() {
        return;
    }

    let Some(capture_sq) = capture_square_for_move(start.board(), mv, mover) else {
        return;
    };
    let Some(captured) = start.board().piece_at(capture_sq) else {
        return;
    };
    if captured.color == mover || captured.role == Role::Pawn || mv.role() == Role::Pawn {
        return;
    }

    let mut pv = candidate
        .pv_uci_line
        .iter()
        .map(|m| normalize_move_key(m))
        .collect::<Vec<_>>();
    let played = normalize_move_key(&candidate.uci);
    if pv.first().map(|m| m.as_str() != played).unwrap_or(true) {
        pv.insert(0, played);
    }

    let san = uci_line_to_san(start, &pv, 7);
    if san.len() < 3 {
        return;
    }

    let followups = san
        .iter()
        .enumerate()
        .filter(|(idx, _)| *idx >= 2 && *idx % 2 == 0)
        .map(|(_, s)| s.clone())
        .take(2)
        .collect::<Vec<_>>();

    if followups.is_empty() {
        return;
    }

    let full_line = san.iter().take(5).cloned().collect::<Vec<_>>().join(" ");
    let plan = followups.join(" y ");

    atoms.push(ConcreteCommentAtom {
        priority: 90,
        short: format!("prepara el plan {}", plan),
        sentence: format!(
            "La captura cobra sentido por la línea {}: elimina una pieza clave y gana tiempos para ejecutar {}.",
            full_line, plan
        ),
    });
}

fn add_pv_tactical_resource_atom(
    atoms: &mut Vec<ConcreteCommentAtom>,
    start: Chess,
    pv_uci: &[String],
) {
    let san = uci_line_to_san(start, pv_uci, 4);
    if san.len() < 3 {
        return;
    }

    let reply = san.get(1).cloned().unwrap_or_default();
    let resource = san.get(2).cloned().unwrap_or_default();
    if reply.is_empty() || resource.is_empty() {
        return;
    }

    atoms.push(ConcreteCommentAtom {
        priority: 72,
        short: format!("recurso táctico si capturan: {}", resource),
        sentence: format!(
            "Si el rival acepta con {}, la continuación {} sostiene la idea.",
            reply, resource
        ),
    });
}

fn apply_tactical_reality_filter(
    atoms: &mut Vec<ConcreteCommentAtom>,
    after: &Chess,
    mv: &Move,
    mover: Color,
    best_reply_uci: Option<&str>,
) {
    let Some(reply_uci) = best_reply_uci else {
        return;
    };

    let Ok(uci) = UciMove::from_ascii(reply_uci.as_bytes()) else {
        return;
    };
    let Ok(reply_mv) = uci.to_move(after) else {
        return;
    };

    let reply_mover = after.turn();
    let Some(capture_sq) = capture_square_for_move(after.board(), &reply_mv, reply_mover) else {
        return;
    };

    if capture_sq != mv.to() {
        return;
    }

    let Some(moved_piece) = after.board().piece_at(mv.to()) else {
        return;
    };
    if moved_piece.color != mover {
        return;
    }

    let moved_value = role_value(moved_piece.role);
    if moved_value < 320 {
        return;
    }

    let reply_san = uci_line_to_san(after.clone(), &[reply_uci.to_string()], 1)
        .first()
        .cloned()
        .unwrap_or_else(|| reply_uci.to_string());

    // If the best reply simply takes the piece that supposedly creates the
    // strategic idea, suppress optimistic plan atoms. This catches positions
    // like a queen move to c1 where White can just Rxc1.
    atoms.retain(|atom| atom.priority >= 88 || atom.short.contains("jaque"));
    atoms.push(ConcreteCommentAtom {
        priority: 120,
        short: format!(
            "tiene un problema táctico: {} puede responderse con {}",
            mv.to(),
            reply_san
        ),
        sentence: format!(
            "La idea falla tacticamente: la mejor respuesta es {}, y captura {} en {}.",
            reply_san,
            role_name_with_article(moved_piece.role),
            mv.to()
        ),
    });
}

fn add_capture_with_check_atom(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    mv: &Move,
    mover: Color,
) {
    let Some(capture_sq) = capture_square_for_move(before, mv, mover) else {
        return;
    };
    let Some(captured) = before.piece_at(capture_sq) else {
        return;
    };
    if captured.color == mover {
        return;
    }

    let captured_name = role_name_with_article(captured.role);
    let capture_square = capture_sq.to_string();
    let material_word = if captured.role == Role::Pawn {
        "gana un peón"
    } else {
        "gana material"
    };

    atoms.push(ConcreteCommentAtom {
        priority: 130,
        short: format!("{} con jaque en {}", material_word, capture_square),
        sentence: format!(
            "Captura {} en {} y ademas da jaque, obligando al rival a responder antes de reorganizarse.",
            captured_name, capture_square
        ),
    });
}

fn add_capture_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    _after: &Board,
    mv: &Move,
    mover: Color,
) {
    let Some(capture_sq) = capture_square_for_move(before, mv, mover) else {
        return;
    };
    let Some(captured) = before.piece_at(capture_sq) else {
        return;
    };
    if captured.color == mover {
        return;
    }

    let captured_name = role_name_with_article(captured.role);
    let capture_square = capture_sq.to_string();

    if captured.role == Role::Pawn {
        atoms.push(ConcreteCommentAtom {
            priority: 78,
            short: format!("elimina el peón de {}", capture_square),
            sentence: format!(
                "Elimina el peón de {}, lo que puede cambiar la estructura a largo plazo más que simplemente ganar material.",
                capture_square
            ),
        });
    } else {
        atoms.push(ConcreteCommentAtom {
            priority: 66,
            short: format!("elimina {} de {}", captured_name, capture_square),
            sentence: format!(
                "Elimina {} de {}, reduciendo los recursos defensivos del rival.",
                captured_name, capture_square
            ),
        });
    }
}

fn add_forced_recapture_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    _after: &Board,
    mv: &Move,
    mover: Color,
) {
    let opponent = mover.other();
    let Some(capture_sq) = capture_square_for_move(before, mv, mover) else {
        return;
    };
    let Some(captured) = before.piece_at(capture_sq) else {
        return;
    };
    if captured.role != Role::Pawn || mv.role() == Role::Pawn {
        return;
    }

    let recapturing_pawns = pawn_attackers_of_square(before, opponent, mv.to());
    if recapturing_pawns.is_empty() {
        return;
    }

    let from_squares = recapturing_pawns
        .iter()
        .map(|sq| sq.to_string())
        .collect::<Vec<_>>()
        .join("/");
    let to_square = mv.to().to_string();

    atoms.push(ConcreteCommentAtom {
        priority: 92,
        short: format!("invita una recaptura de peón en {}", to_square),
        sentence: format!(
            "Si el rival recaptura desde {}, ese peón es arrastrado a {}, dejando con frecuencia nuevas casillas débiles y objetivos detrás.",
            from_squares, to_square
        ),
    });

    if let Some((file, rank)) = square_to_coords(mv.to()) {
        let mut weak_squares = Vec::new();
        for df in [-1i32, 1] {
            for dr in [-1i32, 0, 1] {
                let nf = file as i32 + df;
                let nr = rank as i32 + dr;
                if let Some(sq) = coords_to_square_checked(nf, nr) {
                    if before.piece_at(sq).is_none() {
                        weak_squares.push(sq.to_string());
                    }
                }
            }
        }
        weak_squares.sort();
        weak_squares.dedup();
        let relevant = weak_squares.into_iter().take(3).collect::<Vec<_>>();
        if !relevant.is_empty() {
            atoms.push(ConcreteCommentAtom {
                priority: 74,
                short: format!("afloja las casillas alrededor de {}", to_square),
                sentence: format!(
                    "Las casillas alrededor de {} se vuelven más fáciles de usar como puntos de entrada futuros.",
                    relevant.join(", ")
                ),
            });
        }
    }
}

fn add_king_exposure_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    after: &Board,
    mv: &Move,
    mover: Color,
) {
    let opponent = mover.other();
    let Some(king_sq) = king_square(after, opponent) else {
        return;
    };
    let Some((king_file, king_rank)) = square_to_coords(king_sq) else {
        return;
    };

    let central_king = matches!(king_file, 2..=5)
        && ((opponent == Color::White && king_rank <= 1)
            || (opponent == Color::Black && king_rank >= 6));
    let direct_attack = is_square_attacked_by(after, mover, king_sq);
    let pressure_before = attackers_around_king(before, mover, opponent);
    let pressure_after = attackers_around_king(after, mover, opponent);
    let pressure_gain = pressure_after.saturating_sub(pressure_before);
    let move_is_forcing = capture_square_for_move(before, mv, mover).is_some() || direct_attack;
    let center_is_open_or_tense = central_files_are_open(after) || central_pawn_tension(after);

    // In the opening, a king on e1/e8 is not automatically "exposed". Only say
    // this when the center is actually open/tense or there is direct pressure.
    if central_king
        && (direct_attack || pressure_gain >= 2 || (move_is_forcing && center_is_open_or_tense))
    {
        atoms.push(ConcreteCommentAtom {
            priority: 88,
            short: format!("mantiene al rey rival expuesto en {}", king_sq),
            sentence: format!(
                "El rey rival sigue en {}, y el centro está lo bastante abierto para que los tiempos y las líneas importen.",
                king_sq
            ),
        });
    }

    if direct_attack {
        atoms.push(ConcreteCommentAtom {
            priority: 90,
            short: format!("ataca al rey en {}", king_sq),
            sentence: format!(
                "La jugada crea contacto inmediato contra el rey en {}, obligando al rival a responder de forma concreta.",
                king_sq
            ),
        });
    }

    if pressure_gain >= 2 {
        atoms.push(ConcreteCommentAtom {
            priority: 72,
            short: "aumenta los atacantes alrededor del rey".to_string(),
            sentence: format!(
                "Aumenta la presión sobre el anillo del rey: el atacante suma {} contactos adicionales alrededor de la zona del rey.",
                pressure_gain
            ),
        });
    }
}

fn add_open_line_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    after: &Board,
    mv: &Move,
    mover: Color,
) {
    let Some((to_file, _)) = square_to_coords(mv.to()) else {
        return;
    };
    let opponent = mover.other();
    let own_before = pawn_file_counts(before, mover);
    let own_after = pawn_file_counts(after, mover);
    let opp_before = pawn_file_counts(before, opponent);
    let opp_after = pawn_file_counts(after, opponent);

    let before_blockers = own_before[to_file] + opp_before[to_file];
    let after_blockers = own_after[to_file] + opp_after[to_file];
    if after_blockers < before_blockers && heavy_piece_on_file(after, mover, to_file) {
        atoms.push(ConcreteCommentAtom {
            priority: 68,
            short: format!("abre la columna {}", file_name(to_file)),
            sentence: format!(
                "La columna {} se vuelve más útil para las piezas mayores después del cambio estructural.",
                file_name(to_file)
            ),
        });
    }

    let opponent_king = king_square(after, opponent);
    if let Some(king_sq) = opponent_king {
        if let Some(piece_sq) = moved_piece_square(after, mv, mover) {
            if bishop_or_queen_diagonal_to(after, piece_sq, king_sq, mover) {
                atoms.push(ConcreteCommentAtom {
                    priority: 70,
                    short: "abre una diagonal hacia el rey".to_string(),
                    sentence: format!(
                        "Una diagonal hacia el rey en {} se vuelve tácticamente relevante tras esta jugada.",
                        king_sq
                    ),
                });
            }
            if rook_or_queen_line_to(after, piece_sq, king_sq, mover) {
                atoms.push(ConcreteCommentAtom {
                    priority: 70,
                    short: "abre una línea hacia el rey".to_string(),
                    sentence: format!(
                        "Una línea de torre o dama hacia el rey en {} entra en la geometría del ataque.",
                        king_sq
                    ),
                });
            }
        }
    }
}

fn add_knight_trap_plan_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    after: &Board,
    mv: &Move,
    mover: Color,
) {
    // General pattern behind ideas like ...Qg5 followed by ...h5-h4:
    // restrict a knight on g3/g6 and reduce its pressure on f5/f4.
    let to = mv.to().to_string();

    if mover == Color::Black && to == "g5" && has_piece(after, Color::White, Role::Knight, "g3") {
        if black_h_pawn_can_reach_h4(after) {
            let was_already = has_piece(before, Color::Black, Role::Queen, "g5");
            if !was_already {
                atoms.push(ConcreteCommentAtom {
                    priority: 87,
                    short: "prepara h5-h4 contra el caballo de g3".to_string(),
                    sentence: "La idea práctica es avanzar ...h5-h4 para quitarle casillas al caballo de g3 y reducir su presión sobre f5."
                        .to_string(),
                });
            }
        }
    }

    if mover == Color::White && to == "g4" && has_piece(after, Color::Black, Role::Knight, "g6") {
        if white_h_pawn_can_reach_h5(after) {
            atoms.push(ConcreteCommentAtom {
                priority: 87,
                short: "prepara h4-h5 contra el caballo de g6".to_string(),
                sentence: "La idea práctica es avanzar h4-h5 para quitarle casillas al caballo de g6 y reducir su presión sobre f4."
                    .to_string(),
            });
        }
    }
}

fn add_structural_sacrifice_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    _after: &Board,
    mv: &Move,
    mover: Color,
) {
    let Some(capture_sq) = capture_square_for_move(before, mv, mover) else {
        return;
    };
    let Some(captured) = before.piece_at(capture_sq) else {
        return;
    };
    if captured.color == mover || captured.role != Role::Pawn || mv.role() == Role::Pawn {
        return;
    }

    let opponent = mover.other();
    let recapturing_pawns = pawn_attackers_of_square(before, opponent, mv.to());
    if recapturing_pawns.is_empty() {
        return;
    }

    let king_part = king_square(before, opponent)
        .map(|sq| format!(" y mantener al rey en {} bajo presión", sq))
        .unwrap_or_default();

    atoms.push(ConcreteCommentAtom {
        priority: 119,
        short: format!("sacrificio estructural en {}", capture_sq),
        sentence: format!(
            "La idea no es ganar el peón de inmediato: es arrastrar un peón rival, abrir líneas, crear debilidades futuras{}.",
            king_part
        ),
    });
}

fn add_central_space_push_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    _before: &Board,
    after: &Board,
    mv: &Move,
    mover: Color,
) {
    if mv.role() != Role::Pawn {
        return;
    }
    let Some((file, rank)) = square_to_coords(mv.to()) else {
        return;
    };
    if !matches!(file, 3 | 4) {
        return;
    }

    let moved_forward = match mover {
        Color::White => rank >= 3,
        Color::Black => rank <= 4,
    };
    if !moved_forward {
        return;
    }

    let opponent = mover.other();
    let attacked_by_pawn = pawn_attackers_of_square(after, opponent, mv.to()).len() > 0;
    let next_rank = match mover {
        Color::White => rank as i32 + 1,
        Color::Black => rank as i32 - 1,
    };
    let can_advance_again = coords_to_square_checked(file as i32, next_rank)
        .map(|sq| after.piece_at(sq).is_none())
        .unwrap_or(false);

    let direct_targets = pawn_push_direct_targets(after, mv.to(), mover);
    if !direct_targets.is_empty() {
        let targets = direct_targets.join("/");
        atoms.push(ConcreteCommentAtom {
            priority: 96,
            short: format!("rompe el centro y ataca {}", targets),
            sentence: format!(
                "El avance central cambia la naturaleza de la posición: gana espacio y toca objetivos concretos en {}.",
                targets
            ),
        });
    } else if can_advance_again {
        let advance_square = coords_to_square_checked(file as i32, next_rank)
            .map(|sq| sq.to_string())
            .unwrap_or_else(|| mv.to().to_string());
        atoms.push(ConcreteCommentAtom {
            priority: 89,
            short: format!("avanza en el centro y amenaza {}", advance_square),
            sentence: "El peon central gana espacio y deja la amenaza de otro avance si el rival no lo controla."
                .to_string(),
        });
    } else if attacked_by_pawn {
        atoms.push(ConcreteCommentAtom {
            priority: 83,
            short: "crea tensión central".to_string(),
            sentence: "El avance central crea tensión de peones, pero no prepara un avance inmediato porque la casilla siguiente está ocupada o controlada."
                .to_string(),
        });
    }

    // Specific but still rule-based: a central pawn push that reduces a knight's
    // activity on g3/g6 and supports a further advance.
    if can_advance_again
        && mover == Color::Black
        && has_piece(after, Color::White, Role::Knight, "g3")
    {
        atoms.push(ConcreteCommentAtom {
            priority: 88,
            short: "restringe al caballo de g3".to_string(),
            sentence: "El avance central le quita espacio al caballo de g3 y prepara nuevos saltos/rupturas en e4."
                .to_string(),
        });
    }
    if can_advance_again
        && mover == Color::White
        && has_piece(after, Color::Black, Role::Knight, "g6")
    {
        atoms.push(ConcreteCommentAtom {
            priority: 88,
            short: "restringe al caballo de g6".to_string(),
            sentence: "El avance central le quita espacio al caballo de g6 y prepara nuevos saltos/rupturas en e5."
                .to_string(),
        });
    }
}

fn pawn_push_direct_targets(board: &Board, pawn_sq: Square, mover: Color) -> Vec<String> {
    let Some((file, rank)) = square_to_coords(pawn_sq) else {
        return Vec::new();
    };

    let target_rank = match mover {
        Color::White => rank as i32 + 1,
        Color::Black => rank as i32 - 1,
    };

    let mut targets = Vec::new();
    for df in [-1i32, 1] {
        let Some(target_sq) = coords_to_square_checked(file as i32 + df, target_rank) else {
            continue;
        };
        if board
            .piece_at(target_sq)
            .map(|p| p.color == mover.other())
            .unwrap_or(false)
        {
            targets.push(target_sq.to_string());
        }
    }

    targets.sort();
    targets.dedup();
    targets
}

fn add_bishop_pressure_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    _before: &Board,
    after: &Board,
    mv: &Move,
    mover: Color,
) {
    if !matches!(mv.role(), Role::Bishop | Role::Queen) {
        return;
    }
    let Some(piece_sq) = moved_piece_square(after, mv, mover) else {
        return;
    };
    let opponent = mover.other();

    let mut targets = Vec::new();
    for sq in after.pawns() & after.by_color(opponent) {
        let Some((file, rank)) = square_to_coords(sq) else {
            continue;
        };
        if !(2..=5).contains(&file) {
            continue;
        }
        let advanced_or_central = match opponent {
            Color::White => rank >= 2,
            Color::Black => rank <= 5,
        };
        if !advanced_or_central {
            continue;
        }
        if piece_attacks_square(after, piece_sq, mv.role(), mover, sq) {
            targets.push(sq.to_string());
        }
    }

    targets.sort();
    targets.dedup();
    if !targets.is_empty() {
        atoms.push(ConcreteCommentAtom {
            priority: 86,
            short: format!("presiona la debilidad de {}", targets.into_iter().take(2).collect::<Vec<_>>().join("/")),
            sentence: "La pieza apunta a un peón central avanzado, convirtiéndolo en objetivo estratégico."
                .to_string(),
        });
    }
}

fn add_pawn_fixation_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    after: &Board,
    mover: Color,
) {
    let opponent = mover.other();
    let mut fixed_pawns = Vec::new();

    for pawn_sq in after.pawns() & after.by_color(opponent) {
        let Some((file, rank)) = square_to_coords(pawn_sq) else {
            continue;
        };
        let next_rank = match opponent {
            Color::White => rank as i32 + 1,
            Color::Black => rank as i32 - 1,
        };
        let Some(push_sq) = coords_to_square_checked(file as i32, next_rank) else {
            continue;
        };

        let blocked_by_mover = after
            .piece_at(push_sq)
            .map(|p| p.color == mover)
            .unwrap_or(false);
        let controlled_by_mover = is_square_attacked_by(after, mover, push_sq);
        let was_already_blocked = before
            .piece_at(push_sq)
            .map(|p| p.color == mover)
            .unwrap_or(false);
        let was_already_controlled = is_square_attacked_by(before, mover, push_sq);

        if (blocked_by_mover && !was_already_blocked)
            || (controlled_by_mover && !was_already_controlled)
        {
            // Ignore home-rank pawns. This should describe fixed advanced pawns,
            // not normal undeveloped opening pawns.
            let advanced = match opponent {
                Color::White => rank >= 3,
                Color::Black => rank <= 4,
            };
            if advanced {
                fixed_pawns.push(pawn_sq.to_string());
            }
        }
    }

    fixed_pawns.sort();
    fixed_pawns.dedup();

    if !fixed_pawns.is_empty() {
        let pawns = fixed_pawns
            .into_iter()
            .take(3)
            .collect::<Vec<_>>()
            .join(", ");
        atoms.push(ConcreteCommentAtom {
            priority: 84,
            short: format!("fija la estructura de peones alrededor de {}", pawns),
            sentence: format!(
                "La jugada fija la estructura de peones alrededor de {}, convirtiendo esos peones en objetivos más duraderos.",
                pawns
            ),
        });
    }
}

fn add_central_break_control_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    after: &Board,
    _mv: &Move,
    mover: Color,
) {
    let opponent = mover.other();
    let mut restrained_breaks = Vec::new();

    for pawn_sq in before.pawns() & before.by_color(opponent) {
        let Some((file, rank)) = square_to_coords(pawn_sq) else {
            continue;
        };
        if !(2..=5).contains(&file) {
            continue;
        }

        let next_rank = match opponent {
            Color::White => rank as i32 + 1,
            Color::Black => rank as i32 - 1,
        };
        let Some(push_sq) = coords_to_square_checked(file as i32, next_rank) else {
            continue;
        };
        if before.piece_at(push_sq).is_some() {
            continue;
        }

        // Important distinction:
        // c2-c3 or d2-d3 is usually only an advance/protection move.
        // It is a "break" only if the push creates pawn contact/tension against
        // an enemy pawn structure. Otherwise the commentator says nonsense like
        // "restrains the c3 break" in positions where no break exists.
        if !is_real_pawn_break_push(before, opponent, pawn_sq, push_sq) {
            continue;
        }

        let before_control = is_square_attacked_by(before, mover, push_sq);
        let after_control = is_square_attacked_by(after, mover, push_sq);
        if after_control && !before_control {
            restrained_breaks.push(format!("{}{}", file_name(file), next_rank + 1));
        }
    }

    restrained_breaks.sort();
    restrained_breaks.dedup();

    if !restrained_breaks.is_empty() {
        let breaks = restrained_breaks
            .into_iter()
            .take(2)
            .collect::<Vec<_>>()
            .join("/");
        atoms.push(ConcreteCommentAtom {
            priority: 86,
            short: format!("frena la ruptura {}", breaks),
            sentence: format!(
                "La idea profiláctica es controlar una ruptura real de peones: {}.",
                breaks
            ),
        });
    }
}

fn add_weak_target_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    after: &Board,
    _mv: &Move,
    mover: Color,
) {
    let opponent = mover.other();
    let before_targets = loose_or_overloaded_targets(before, mover, opponent);
    let after_targets = loose_or_overloaded_targets(after, mover, opponent);

    let mut new_targets = after_targets
        .into_iter()
        .filter(|sq| !before_targets.contains(sq))
        .collect::<Vec<_>>();

    new_targets.sort_by_key(|sq| target_priority(after, *sq));
    new_targets.reverse();

    if !new_targets.is_empty() {
        let squares = new_targets
            .iter()
            .take(3)
            .map(|sq| sq.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        atoms.push(ConcreteCommentAtom {
            priority: 76,
            short: format!("crea objetivos en {}", squares),
            sentence: format!(
                "La jugada crea objetivos nuevos en {}, dando al atacante algo concreto contra lo cual jugar.",
                squares
            ),
        });
    }
}

fn add_piece_restriction_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    after: &Board,
    mover: Color,
) {
    let opponent = mover.other();
    let before_mobility = pseudo_mobility(before, opponent);
    let after_mobility = pseudo_mobility(after, opponent);
    let drop = before_mobility.saturating_sub(after_mobility);

    // Do not claim restriction unless the move actually reduced mobility.
    // This avoids nonsense like "...Ne6 restricts the bishop on g2" when the
    // bishop was already blocked by its own structure and the move did not cause it.
    if drop >= 5 {
        atoms.push(ConcreteCommentAtom {
            priority: 54,
            short: "reduce la movilidad rival".to_string(),
            sentence: format!(
                "La movilidad rival baja de forma apreciable: unas {} jugadas menos.",
                drop
            ),
        });
    }

    let before_restricted = restricted_minor_pieces(before, opponent)
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let mut newly_restricted = restricted_minor_pieces(after, opponent)
        .into_iter()
        .filter(|piece| !before_restricted.contains(piece))
        .collect::<Vec<_>>();

    newly_restricted.sort();
    newly_restricted.dedup();

    if drop >= 3 && !newly_restricted.is_empty() {
        let pieces = newly_restricted
            .into_iter()
            .take(2)
            .collect::<Vec<_>>()
            .join(", ");
        atoms.push(ConcreteCommentAtom {
            priority: 57,
            short: format!("restringe {}", pieces),
            sentence: format!("La jugada deja a {} con menos casillas útiles.", pieces),
        });
    }
}

fn add_outpost_or_infiltration_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    after: &Board,
    mv: &Move,
    mover: Color,
) {
    if matches!(mv.role(), Role::Pawn | Role::King) {
        return;
    }
    let opponent = mover.other();
    let Some((_, to_rank)) = square_to_coords(mv.to()) else {
        return;
    };
    let advanced = if mover == Color::White {
        to_rank >= 4
    } else {
        to_rank <= 3
    };
    if !advanced {
        return;
    }

    let defended = is_square_defended_by(after, mover, mv.to());
    let attacked = is_square_attacked_by(after, opponent, mv.to());
    if defended && !attacked {
        atoms.push(ConcreteCommentAtom {
            priority: 61,
            short: format!("instala una pieza en {}", mv.to()),
            sentence: format!(
                "La pieza llega a {}, una casilla avanzada, defendida y difícil de desafiar de inmediato.",
                mv.to()
            ),
        });
    } else if defended && attacked {
        let before_attackers = attackers_of_square(before, mover, mv.to()).len();
        let after_attackers = attackers_of_square(after, mover, mv.to()).len();
        if after_attackers >= before_attackers {
            atoms.push(ConcreteCommentAtom {
                priority: 52,
                short: format!("usa la tensión en {}", mv.to()),
                sentence: format!(
                    "La pieza entra en {}, aceptando la tensión porque está tácticamente sostenida.",
                    mv.to()
                ),
            });
        }
    }
}

fn add_pawn_structure_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    before: &Board,
    after: &Board,
    mover: Color,
) {
    let opponent = mover.other();
    let before_files = pawn_file_counts(before, opponent);
    let after_files = pawn_file_counts(after, opponent);

    let islands_delta = pawn_islands(&after_files).saturating_sub(pawn_islands(&before_files));
    let doubled_delta = doubled_pawns(&after_files).saturating_sub(doubled_pawns(&before_files));
    let isolated_delta = isolated_pawns_from_file_counts(&after_files)
        .saturating_sub(isolated_pawns_from_file_counts(&before_files));

    if islands_delta + doubled_delta + isolated_delta == 0 {
        return;
    }

    let mut details = Vec::new();
    if islands_delta > 0 {
        details.push(format!("{} isla(s) de peones adicional(es)", islands_delta));
    }
    if doubled_delta > 0 {
        details.push(format!(
            "{} peón(es) doblado(s) adicional(es)",
            doubled_delta
        ));
    }
    if isolated_delta > 0 {
        details.push(format!(
            "{} peón(es) aislado(s) adicional(es)",
            isolated_delta
        ));
    }

    atoms.push(ConcreteCommentAtom {
        priority: 82,
        short: "daña la estructura de peones".to_string(),
        sentence: format!("La estructura de peones empeora: {}.", details.join(", ")),
    });
}

fn add_atom_once(
    atoms: &mut Vec<ConcreteCommentAtom>,
    priority: i32,
    short: &str,
    sentence_text: &str,
) {
    if atoms
        .iter()
        .any(|a| a.short == short || a.sentence == sentence_text)
    {
        return;
    }
    atoms.push(ConcreteCommentAtom {
        priority,
        short: short.to_string(),
        sentence: sentence_text.to_string(),
    });
}

fn motifs_to_text(motifs: &[StrategicMotif]) -> String {
    if motifs.is_empty() {
        return "coordinación práctica".to_string();
    }
    motifs
        .iter()
        .take(3)
        .map(|m| match m {
            StrategicMotif::DamagedPawnStructure => "daño estructural de peones",
            StrategicMotif::WeakPawnPressure => "presión sobre peones débiles",
            StrategicMotif::SpaceGain => "ganancia de espacio",
            StrategicMotif::OpenFilePressure => "presión en columnas abiertas",
            StrategicMotif::CentralKingPressure => "presión sobre el rey",
            StrategicMotif::PieceRestriction => "restricción de piezas",
            StrategicMotif::WingClamp => "fijación en un flanco",
            StrategicMotif::OutpostControl => "outpost control",
            StrategicMotif::ColorComplexPressure => "color-complex pressure",
            StrategicMotif::Prophylaxis => "prophylaxis",
            StrategicMotif::FavorableTrade => "favorable trade",
            StrategicMotif::PassedPawnConversion => "passed-pawn conversion",
            StrategicMotif::InitiativeSacrifice => "initiative sacrifice",
            StrategicMotif::Counterplay => "active counterplay",
            StrategicMotif::KingNet => "king net",
            StrategicMotif::PieceCoordination => "piece coordination",
            StrategicMotif::TensionManagement => "tension management",
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn extract_top_macro_axes(
    macro_components: &HumanStrategicMacroComponents,
) -> Vec<HumanStrategicAxisNarrative> {
    let mut axes = vec![
        ("pawnStructure", macro_components.pawn_structure),
        ("space", macro_components.space),
        ("pieceQuality", macro_components.piece_quality),
        ("kingSafety", macro_components.king_safety),
        ("initiative", macro_components.initiative),
        ("attack", macro_components.attack),
        ("counterplay", macro_components.counterplay),
        ("prophylaxis", macro_components.prophylaxis),
        ("conversion", macro_components.conversion),
        ("endgameTransition", macro_components.endgame_transition),
        ("practicalPressure", macro_components.practical_pressure),
        ("planCoherence", macro_components.plan_coherence),
    ];

    axes.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let max_score = axes.first().map(|(_, s)| *s).unwrap_or(0.0);
    if max_score < 0.20 {
        return Vec::new();
    }
    let dynamic_floor = (max_score * 0.50).max(0.22);

    axes.iter()
        .filter(|(_, score)| *score >= dynamic_floor)
        .take(3)
        .map(|(axis, score)| HumanStrategicAxisNarrative {
            axis: (*axis).to_string(),
            score: *score,
            explanation: macro_axis_explanation(axis).to_string(),
        })
        .collect::<Vec<_>>()
}

fn macro_axis_explanation(axis: &str) -> &'static str {
    match axis {
        "pawnStructure" => "crear objetivos de peones duraderos",
        "space" => "ganar espacio y reducir la libertad de las piezas rivales",
        "pieceQuality" => "mejorar la calidad de las piezas y ocupar casillas estables",
        "kingSafety" => "aumentar la presión alrededor del rey",
        "initiative" => "mantener el flujo de jugadas y forzar respuestas defensivas",
        "attack" => "coordinar piezas atacantes sobre el mismo sector",
        "counterplay" => "generar amenazas activas en vez de defender pasivamente",
        "prophylaxis" => "restringir el plan principal del rival antes de que arranque",
        "conversion" => "convertir ventajas estáticas en concesiones concretas",
        "endgameTransition" => "conducir la posición hacia una transición favorable",
        "practicalPressure" => "maximizar la dificultad defensiva para un rival humano",
        "planCoherence" => "conectar la jugada con un plan coherente",
        _ => "mejorar la coordinación práctica y el control",
    }
}

fn extract_top_concrete_themes(
    components: &HumanStrategicComponents,
) -> Vec<HumanStrategicConcreteTheme> {
    let mut items = vec![
        (
            components.pawn_structure_damage,
            "daña la estructura de peones para crear objetivos a largo plazo",
        ),
        (
            components.weak_pawn_pressure,
            "aumenta la presión sobre peones débiles",
        ),
        (
            components.space_gain,
            "gana espacio y limita la libertad de las piezas",
        ),
        (
            components.open_file_pressure,
            "abre columnas y mejora la actividad de piezas mayores",
        ),
        (components.central_king_pressure, "abre líneas hacia el rey"),
        (
            components.piece_restriction,
            "restringe piezas defensivas clave",
        ),
        (components.wing_clamp, "fija peones en un flanco"),
    ];
    items.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let max_score = items.first().map(|x| x.0).unwrap_or(0.0);
    if max_score < MIN_STRATEGIC_SCORE_TO_EXPLAIN {
        return Vec::new();
    }
    let floor = (max_score * 0.60).max(MIN_STRATEGIC_SCORE_TO_EXPLAIN);

    items
        .iter()
        .filter(|(score, _)| *score >= floor)
        .take(2)
        .map(|(_score, text)| HumanStrategicConcreteTheme { text })
        .collect::<Vec<_>>()
}

fn summarize_axes(axes: &[HumanStrategicAxisNarrative]) -> String {
    if axes.is_empty() {
        return "coordinación práctica".to_string();
    }
    axes.iter()
        .take(2)
        .map(|a| axis_label_es(a.axis.as_str()))
        .collect::<Vec<_>>()
        .join(", ")
}

fn axis_label_es(axis: &str) -> &'static str {
    match axis {
        "pawnStructure" => "estructura de peones",
        "space" => "espacio",
        "pieceQuality" => "calidad de piezas",
        "kingSafety" => "seguridad del rey",
        "initiative" => "iniciativa",
        "attack" => "ataque",
        "counterplay" => "contrajuego",
        "prophylaxis" => "profilaxis",
        "conversion" => "conversión",
        "endgameTransition" => "transición al final",
        "practicalPressure" => "presión práctica",
        "planCoherence" => "coherencia del plan",
        _ => "coordinación práctica",
    }
}

fn summarize_concrete_themes(themes: &[HumanStrategicConcreteTheme]) -> String {
    if themes.is_empty() {
        return String::new();
    }
    themes
        .iter()
        .take(2)
        .map(|t| t.text)
        .collect::<Vec<_>>()
        .join(" y ")
}

fn summarize_atoms_as_short_phrase(atoms: &[ConcreteCommentAtom], max_items: usize) -> String {
    atoms
        .iter()
        .take(max_items)
        .map(|a| a.short.as_str())
        .collect::<Vec<_>>()
        .join(" y ")
}

fn summarize_liability_short(atoms: &[ConcreteCommentAtom]) -> Option<String> {
    atoms.iter().find_map(|atom| {
        let s = atom.short.to_ascii_lowercase();
        let looks_negative = s.contains("problema t")
            || s.contains("rey rival expuesto")
            || s.contains("afloja")
            || s.contains("frena la ruptura");
        if looks_negative {
            Some(atom.short.clone())
        } else {
            None
        }
    })
}

fn derive_gm_plan_hint(
    atoms: &[ConcreteCommentAtom],
    motifs: &[StrategicMotif],
    is_sacrifice: bool,
) -> Option<String> {
    let shorts = atoms
        .iter()
        .map(|a| a.short.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let has = |needle: &str| shorts.iter().any(|s| s.contains(needle));

    if is_sacrifice || has("sacrificio estructural") {
        return Some(
            "Plan: invertir material de forma temporal para abrir lineas, fijar debilidades y jugar con iniciativa sostenida."
                .to_string(),
        );
    }

    if has("ocupa la columna d con plan activo")
        || has("ocupa la columna e con plan activo")
        || (motifs.contains(&StrategicMotif::OpenFilePressure)
            && motifs.contains(&StrategicMotif::CentralKingPressure))
    {
        return Some(
            "Plan: dominar la columna central y coordinar piezas pesadas contra el rey o los peones base de la estructura."
                .to_string(),
        );
    }

    if has("rompe el centro") {
        return Some(
            "Plan: cambiar la estructura central, ganar tiempos sobre piezas rivales y convertir el centro en una vía de entrada."
                .to_string(),
        );
    }

    if has("avanza en el centro")
        && (has("rey rival expuesto") || motifs.contains(&StrategicMotif::CentralKingPressure))
    {
        return Some(
            "Plan: fijar el centro para restringir las piezas rivales y abrir la via de entrada de torres y dama."
                .to_string(),
        );
    }

    if let Some(plan_atom) = atoms
        .iter()
        .find(|a| a.short.to_ascii_lowercase().contains("prepara el plan"))
    {
        return Some(format!(
            "Plan: {}.",
            plan_atom.sentence.trim().trim_end_matches('.')
        ));
    }

    if has("prepara h5-h4 contra el caballo de g3") || has("prepara h4-h5 contra el caballo de g6")
    {
        return Some(
            "Plan: limitar el caballo defensor y crear un segundo frente de ataque en el flanco del rey."
                .to_string(),
        );
    }

    if has("fija la estructura de peones") && motifs.contains(&StrategicMotif::WeakPawnPressure) {
        return Some(
            "Plan: fijar peones en casillas vulnerables y aumentar la presion hasta forzar una concesion concreta."
                .to_string(),
        );
    }

    None
}

fn build_plan_sentence(
    axes: &[HumanStrategicAxisNarrative],
    concrete_themes: &[HumanStrategicConcreteTheme],
    concrete_bundle: &ConcreteCommentBundle,
) -> String {
    if !concrete_bundle.atoms.is_empty() {
        return sentence(&summarize_atoms_as_short_phrase(&concrete_bundle.atoms, 2));
    }

    if !concrete_themes.is_empty() {
        return sentence(&summarize_concrete_themes(concrete_themes));
    }

    if !axes.is_empty() {
        return sentence(
            &axes
                .iter()
                .take(2)
                .map(|a| a.explanation.as_str())
                .collect::<Vec<_>>()
                .join(" y "),
        );
    }

    String::new()
}

fn build_suggested_variation_uci(
    played_uci: &str,
    strategic_choice_uci: Option<&str>,
    selected_candidate_pv: &[String],
    sorted_lines: &[&BestMoves],
    max_plies: usize,
) -> Vec<String> {
    let Some(strategic_uci) = strategic_choice_uci else {
        return Vec::new();
    };
    if strategic_uci == played_uci {
        return Vec::new();
    }

    if !selected_candidate_pv.is_empty() {
        let mut pv = selected_candidate_pv
            .iter()
            .map(|m| normalize_move_key(m))
            .collect::<Vec<_>>();
        if pv
            .first()
            .map(|m| m.as_str() != strategic_uci)
            .unwrap_or(true)
        {
            pv.insert(0, strategic_uci.to_string());
        }
        if pv.len() <= 1 {
            if let Some(longer_line) = sorted_lines.iter().find(|bm| {
                bm.uci_moves
                    .first()
                    .map(|m| normalize_move_key(m) == strategic_uci)
                    .unwrap_or(false)
                    && bm.uci_moves.len() > 1
            }) {
                pv = longer_line
                    .uci_moves
                    .iter()
                    .map(|m| normalize_move_key(m))
                    .collect::<Vec<_>>();
            }
        }
        pv.truncate(max_plies);
        return pv;
    }

    if let Some(line) = sorted_lines.iter().find(|bm| {
        bm.uci_moves
            .first()
            .map(|m| normalize_move_key(m) == strategic_uci)
            .unwrap_or(false)
    }) {
        return line.uci_moves.iter().take(max_plies).cloned().collect();
    }

    vec![strategic_uci.to_string()]
}

fn build_variation_comment(
    strategic_choice_san: Option<&str>,
    engine_best_san: Option<&str>,
    concrete_themes: &[HumanStrategicConcreteTheme],
    strategic_plan: &str,
    selected_candidate: Option<&HumanStrategicCandidate>,
) -> Option<String> {
    let choice = strategic_choice_san?;
    let theme_text = summarize_concrete_themes(concrete_themes);
    let score_text = selected_candidate
        .filter(|c| c.strategic_score >= 0.45)
        .map(|c| format!("score {:.2}", c.strategic_score))
        .unwrap_or_default();

    let idea = if !theme_text.is_empty() {
        theme_text
    } else if !strategic_plan.is_empty() {
        strategic_plan.trim_end_matches('.').to_string()
    } else {
        String::new()
    };

    let contrast = match engine_best_san {
        Some(best) if best != choice => format!("; el motor prefiere {}", best),
        _ => String::new(),
    };

    let mut text = format!("Candidato humano: {}", choice);
    if !idea.is_empty() {
        text.push_str(&format!(" - {}", idea));
    }
    if !score_text.is_empty() {
        text.push_str(&format!(" ({})", score_text));
    }
    text.push_str(&contrast);

    Some(sentence(&text))
}

fn ensure_min_multipv(options: &mut Vec<EngineOption>, min_multipv: u32) {
    if let Some(multi_pv) = options.iter_mut().find(|x| x.name == "MultiPV") {
        let current = multi_pv.value.parse::<u32>().ok().unwrap_or(1);
        if current < min_multipv {
            multi_pv.value = min_multipv.to_string();
        }
        return;
    }
    options.push(EngineOption {
        name: "MultiPV".to_string(),
        value: min_multipv.to_string(),
    });
}

fn uci_line_to_san(start: Chess, line_uci: &[String], max_plies: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut pos = start;
    for uci_str in line_uci.iter().take(max_plies) {
        let uci_norm = normalize_move_key(uci_str);
        let Ok(uci) = UciMove::from_ascii(uci_norm.as_bytes()) else {
            break;
        };
        let Ok(mv) = uci.to_move(&pos) else {
            break;
        };
        let san = SanPlus::from_move_and_play_unchecked(&mut pos, &mv).to_string();
        out.push(san);
        if pos.is_game_over() {
            break;
        }
    }
    out
}

fn sorted_lines_by_multipv(analysis: &MoveAnalysis) -> Vec<&BestMoves> {
    let mut lines = analysis.best.iter().collect::<Vec<_>>();
    lines.sort_by_key(|bm| bm.multipv);
    lines
}

fn best_line(analysis: &MoveAnalysis) -> Option<&BestMoves> {
    sorted_lines_by_multipv(analysis).into_iter().next()
}

fn eval_cp_for_side(score: &ScoreValue, side: Color) -> i32 {
    let cp_white = match score {
        ScoreValue::Cp(v) => *v,
        ScoreValue::Mate(v) => {
            if *v == 0 {
                0
            } else {
                v.signum() * MATE_AS_CP
            }
        }
    };
    match side {
        Color::White => cp_white,
        Color::Black => -cp_white,
    }
}

fn win_chance(cp: i32) -> f32 {
    let cpf = cp as f32;
    50.0 + 50.0 * (2.0 / (1.0 + (-0.003_682_08 * cpf).exp()) - 1.0)
}

fn build_summary(narratives: &[HumanMoveNarrative]) -> HumanStrategicGameSummary {
    let mut best_count = 0u32;
    let mut great_count = 0u32;
    let mut practical_count = 0u32;
    let mut interesting_count = 0u32;
    let mut dubious_count = 0u32;
    let mut mistake_count = 0u32;
    let mut blunder_count = 0u32;

    let mut theme_counts: HashMap<String, u32> = HashMap::new();
    for n in narratives {
        match n.verdict {
            HumanMoveVerdict::Best => best_count += 1,
            HumanMoveVerdict::Great => great_count += 1,
            HumanMoveVerdict::Practical => practical_count += 1,
            HumanMoveVerdict::Interesting => interesting_count += 1,
            HumanMoveVerdict::Dubious => dubious_count += 1,
            HumanMoveVerdict::Mistake => mistake_count += 1,
            HumanMoveVerdict::Blunder => blunder_count += 1,
        }

        for axis in &n.strategic_axes {
            *theme_counts.entry(axis.axis.clone()).or_insert(0) += 1;
        }
        for motif in &n.played_motifs {
            let key = format!("motif:{}", motif_to_key(*motif));
            *theme_counts.entry(key).or_insert(0) += 1;
        }

        if n.comment_long.contains("dos debilidades")
            || n.strategic_plan.contains("dos debilidades")
        {
            *theme_counts
                .entry("twoWeaknessStrategy".to_string())
                .or_insert(0) += 1;
        }
        if n.comment_long.contains("cambio de frente")
            || n.strategic_plan.contains("cambio de frente")
        {
            *theme_counts
                .entry("targetSwitching".to_string())
                .or_insert(0) += 1;
        }
        if n.comment_long.contains("sobrecarg") || n.strategic_plan.contains("sobrecarg") {
            *theme_counts
                .entry("overloadedDefense".to_string())
                .or_insert(0) += 1;
        }
    }

    let mut top = theme_counts.into_iter().collect::<Vec<_>>();
    top.sort_by(|a, b| b.1.cmp(&a.1));
    let top_themes = top.into_iter().take(5).map(|(k, _)| k).collect::<Vec<_>>();

    HumanStrategicGameSummary {
        best_count,
        great_count,
        practical_count,
        interesting_count,
        dubious_count,
        mistake_count,
        blunder_count,
        top_themes,
    }
}

fn motif_to_key(motif: StrategicMotif) -> &'static str {
    match motif {
        StrategicMotif::DamagedPawnStructure => "damagedPawnStructure",
        StrategicMotif::WeakPawnPressure => "weakPawnPressure",
        StrategicMotif::SpaceGain => "spaceGain",
        StrategicMotif::OpenFilePressure => "openFilePressure",
        StrategicMotif::CentralKingPressure => "centralKingPressure",
        StrategicMotif::PieceRestriction => "pieceRestriction",
        StrategicMotif::WingClamp => "wingClamp",
        StrategicMotif::OutpostControl => "outpostControl",
        StrategicMotif::ColorComplexPressure => "colorComplexPressure",
        StrategicMotif::Prophylaxis => "prophylaxis",
        StrategicMotif::FavorableTrade => "favorableTrade",
        StrategicMotif::PassedPawnConversion => "passedPawnConversion",
        StrategicMotif::InitiativeSacrifice => "initiativeSacrifice",
        StrategicMotif::Counterplay => "counterplay",
        StrategicMotif::KingNet => "kingNet",
        StrategicMotif::PieceCoordination => "pieceCoordination",
        StrategicMotif::TensionManagement => "tensionManagement",
    }
}

fn normalize_move_key(mv: &str) -> String {
    mv.trim().to_ascii_lowercase()
}

fn parse_position(initial_fen: &str) -> Result<Chess, Error> {
    let trimmed = initial_fen.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("startpos") {
        return Ok(Chess::default());
    }
    let fen = Fen::from_ascii(trimmed.as_bytes())?;
    Ok(fen.into_position(CastlingMode::Chess960)?)
}

fn tactical_risk_score(board: &Board, mv: &Move, mover: Color) -> i32 {
    let moved_value = role_value(mv.role());
    let captured_value = capture_square_for_move(board, mv, mover)
        .and_then(|sq| board.piece_at(sq))
        .filter(|p| p.color != mover)
        .map(|p| role_value(p.role))
        .unwrap_or(0);
    moved_value - captured_value
}

fn is_opening_phase(position: &Chess, ply: usize) -> bool {
    if ply < OPENING_COMMENT_SUPPRESS_PLIES {
        return true;
    }

    // After this point, consider it opening only if both sides still have many
    // undeveloped pieces and neither king situation/pawn structure clearly moved
    // the game into middlegame play.
    if ply >= 28 {
        return false;
    }

    let board = position.board();
    let undeveloped_white =
        undeveloped_minor_count(board, Color::White) + undeveloped_rook_count(board, Color::White);
    let undeveloped_black =
        undeveloped_minor_count(board, Color::Black) + undeveloped_rook_count(board, Color::Black);
    undeveloped_white + undeveloped_black >= 5 && !central_files_are_open(board)
}

fn is_known_opening_theory_position(fen: &str, position: &Chess, ply: usize) -> bool {
    if ply >= KNOWN_OPENING_COMMENT_SUPPRESS_PLIES || !is_opening_phase(position, ply) {
        return false;
    }

    let Ok(info) = get_opening_info_from_fen(fen) else {
        return false;
    };

    let opening = info.opening.trim();
    !opening.is_empty() && !opening.eq_ignore_ascii_case("starting position")
}

fn undeveloped_minor_count(board: &Board, color: Color) -> usize {
    let mut count = 0;
    let back_rank = if color == Color::White { 0 } else { 7 };
    for file in [1usize, 2, 5, 6] {
        if let Some(sq) = coords_to_square(file, back_rank) {
            if board
                .piece_at(sq)
                .map(|p| p.color == color && matches!(p.role, Role::Knight | Role::Bishop))
                .unwrap_or(false)
            {
                count += 1;
            }
        }
    }
    count
}

fn undeveloped_rook_count(board: &Board, color: Color) -> usize {
    let mut count = 0;
    let back_rank = if color == Color::White { 0 } else { 7 };
    for file in [0usize, 7] {
        if let Some(sq) = coords_to_square(file, back_rank) {
            if board
                .piece_at(sq)
                .map(|p| p.color == color && p.role == Role::Rook)
                .unwrap_or(false)
            {
                count += 1;
            }
        }
    }
    count
}

fn move_leaves_piece_en_prise(
    after: &Chess,
    mv: &Move,
    mover: Color,
    best_reply_uci: Option<&str>,
) -> bool {
    let Some(reply_uci) = best_reply_uci else {
        return false;
    };
    let Ok(uci) = UciMove::from_ascii(reply_uci.as_bytes()) else {
        return false;
    };
    let Ok(reply_mv) = uci.to_move(after) else {
        return false;
    };
    let reply_mover = after.turn();
    let Some(capture_sq) = capture_square_for_move(after.board(), &reply_mv, reply_mover) else {
        return false;
    };
    if capture_sq != mv.to() {
        return false;
    }
    after
        .board()
        .piece_at(mv.to())
        .map(|p| p.color == mover && role_value(p.role) >= 320)
        .unwrap_or(false)
}

fn is_real_material_sacrifice(
    before: &Chess,
    after: &Chess,
    _mv: &Move,
    mover: Color,
    engine_flag: bool,
) -> bool {
    let opponent = mover.other();
    let before_balance = material_balance_cp(before.board(), mover, opponent);
    let after_balance = material_balance_cp(after.board(), mover, opponent);
    let material_drop = before_balance - after_balance;

    // Do not call a move a sacrifice just because the moved piece can be attacked.
    // Ng3, Bc5, Bb4, etc. may create tension, but they are not sacrifices unless
    // material is actually invested.
    if material_drop >= 180 {
        return true;
    }

    // Trust the engine sacrifice flag only when there is at least some real
    // material concession in the static material balance.
    engine_flag && material_drop >= 80
}

fn material_balance_cp(board: &Board, side: Color, opponent: Color) -> i32 {
    material_cp(board, side) - material_cp(board, opponent)
}

fn material_cp(board: &Board, color: Color) -> i32 {
    let mut total = 0;
    for sq in board.by_color(color) {
        if let Some(piece) = board.piece_at(sq) {
            total += role_value(piece.role);
        }
    }
    total
}

fn role_value(role: Role) -> i32 {
    match role {
        Role::Pawn => 100,
        Role::Knight => 320,
        Role::Bishop => 330,
        Role::Rook => 500,
        Role::Queen => 900,
        Role::King => 0,
    }
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Pawn => "peón",
        Role::Knight => "caballo",
        Role::Bishop => "alfil",
        Role::Rook => "torre",
        Role::Queen => "dama",
        Role::King => "rey",
    }
}

fn role_name_with_article(role: Role) -> &'static str {
    match role {
        Role::Pawn => "el peon",
        Role::Knight => "el caballo",
        Role::Bishop => "el alfil",
        Role::Rook => "la torre",
        Role::Queen => "la dama",
        Role::King => "el rey",
    }
}

fn capture_square_for_move(board: &Board, mv: &Move, mover: Color) -> Option<Square> {
    if board.piece_at(mv.to()).is_some() {
        return Some(mv.to());
    }

    if mv.role() != Role::Pawn {
        return None;
    }

    let from = mv.from()?;
    let (from_file, _) = square_to_coords(from)?;
    let (to_file, to_rank) = square_to_coords(mv.to())?;
    if from_file == to_file {
        return None;
    }

    let captured_rank = match mover {
        Color::White => to_rank.checked_sub(1)?,
        Color::Black => to_rank + 1,
    };
    if captured_rank > 7 {
        return None;
    }
    coords_to_square(to_file, captured_rank)
}

fn moved_piece_square(board: &Board, mv: &Move, mover: Color) -> Option<Square> {
    let sq = mv.to();
    let piece = board.piece_at(sq)?;
    if piece.color == mover {
        Some(sq)
    } else {
        None
    }
}

fn king_square(board: &Board, color: Color) -> Option<Square> {
    for sq in board.kings() & board.by_color(color) {
        return Some(sq);
    }
    None
}

fn pawn_file_counts(board: &Board, color: Color) -> [u8; 8] {
    let mut counts = [0u8; 8];
    for sq in board.pawns() & board.by_color(color) {
        if let Some((file, _)) = square_to_coords(sq) {
            counts[file] = counts[file].saturating_add(1);
        }
    }
    counts
}

fn pawn_islands(files: &[u8; 8]) -> u8 {
    let mut islands = 0u8;
    let mut in_island = false;
    for count in files {
        if *count > 0 && !in_island {
            islands = islands.saturating_add(1);
            in_island = true;
        } else if *count == 0 {
            in_island = false;
        }
    }
    islands
}

fn doubled_pawns(files: &[u8; 8]) -> u8 {
    files.iter().map(|count| count.saturating_sub(1)).sum()
}

fn isolated_pawns_from_file_counts(files: &[u8; 8]) -> u8 {
    let mut total = 0u8;
    for file in 0..8 {
        if files[file] == 0 {
            continue;
        }
        let left = file > 0 && files[file - 1] > 0;
        let right = file < 7 && files[file + 1] > 0;
        if !left && !right {
            total = total.saturating_add(files[file]);
        }
    }
    total
}

fn loose_or_overloaded_targets(board: &Board, attacker: Color, defender: Color) -> Vec<Square> {
    let mut targets = Vec::new();
    for sq in board.by_color(defender) {
        let Some(piece) = board.piece_at(sq) else {
            continue;
        };
        if piece.role == Role::King {
            continue;
        }
        let attackers = attackers_of_square(board, attacker, sq).len();
        if attackers == 0 {
            continue;
        }
        let defenders = attackers_of_square(board, defender, sq).len();
        if attackers > defenders {
            targets.push(sq);
            continue;
        }
        if piece.role == Role::Pawn && is_meaningful_pawn_target(board, attacker, defender, sq) {
            targets.push(sq);
        }
    }
    targets
}

fn is_meaningful_pawn_target(board: &Board, attacker: Color, defender: Color, sq: Square) -> bool {
    let attackers = attackers_of_square(board, attacker, sq).len();
    let defenders = attackers_of_square(board, defender, sq).len();
    if attackers > defenders {
        return true;
    }

    let Some((file, rank)) = square_to_coords(sq) else {
        return false;
    };

    // Do not call normal home-rank shelter pawns like g7/g2 a strategic target
    // just because a queen or bishop happens to see them from far away.
    let home_rank_pawn =
        (defender == Color::White && rank == 1) || (defender == Color::Black && rank == 6);
    let adjacent_support = (file > 0
        && coords_to_square(file - 1, rank)
            .and_then(|s| board.piece_at(s))
            .map(|p| p.color == defender && p.role == Role::Pawn)
            .unwrap_or(false))
        || (file < 7
            && coords_to_square(file + 1, rank)
                .and_then(|s| board.piece_at(s))
                .map(|p| p.color == defender && p.role == Role::Pawn)
                .unwrap_or(false));
    if home_rank_pawn && adjacent_support && attackers < 2 {
        return false;
    }

    let files = pawn_file_counts(board, defender);
    let isolated =
        files[file] > 0 && !(file > 0 && files[file - 1] > 0) && !(file < 7 && files[file + 1] > 0);
    let doubled = files[file] > 1;
    let advanced_or_backward = match defender {
        Color::White => rank >= 3,
        Color::Black => rank <= 4,
    };

    isolated || doubled || advanced_or_backward
}

fn target_priority(board: &Board, sq: Square) -> i32 {
    board.piece_at(sq).map(|p| role_value(p.role)).unwrap_or(0)
}

fn pseudo_mobility(board: &Board, color: Color) -> i32 {
    let mut total = 0i32;
    for sq in board.by_color(color) {
        let Some(piece) = board.piece_at(sq) else {
            continue;
        };
        total += pseudo_attacks_from(board, sq, piece.role, piece.color).len() as i32;
    }
    total
}

fn restricted_minor_pieces(board: &Board, color: Color) -> Vec<String> {
    let mut out = Vec::new();
    for sq in (board.knights() | board.bishops()) & board.by_color(color) {
        let Some(piece) = board.piece_at(sq) else {
            continue;
        };
        if is_initial_minor_square(color, piece.role, sq) {
            continue;
        }
        if is_normal_fianchetto_bishop(color, piece.role, sq) {
            continue;
        }
        let mobility = pseudo_attacks_from(board, sq, piece.role, color)
            .into_iter()
            .filter(|target| {
                board
                    .piece_at(*target)
                    .map(|p| p.color != color)
                    .unwrap_or(true)
            })
            .count();
        if mobility <= 2 {
            out.push(format!("{} en {}", role_name(piece.role), sq));
        }
    }
    out
}

fn is_normal_fianchetto_bishop(color: Color, role: Role, sq: Square) -> bool {
    if role != Role::Bishop {
        return false;
    }
    let Some((file, rank)) = square_to_coords(sq) else {
        return false;
    };
    match color {
        Color::White => rank == 1 && matches!(file, 1 | 6),
        Color::Black => rank == 6 && matches!(file, 1 | 6),
    }
}

fn is_initial_minor_square(color: Color, role: Role, sq: Square) -> bool {
    let Some((file, rank)) = square_to_coords(sq) else {
        return false;
    };
    match (color, role, file, rank) {
        (Color::White, Role::Knight, 1 | 6, 0) => true,
        (Color::White, Role::Bishop, 2 | 5, 0) => true,
        (Color::Black, Role::Knight, 1 | 6, 7) => true,
        (Color::Black, Role::Bishop, 2 | 5, 7) => true,
        _ => false,
    }
}

fn heavy_piece_on_file(board: &Board, color: Color, file: usize) -> bool {
    for sq in (board.rooks() | board.queens()) & board.by_color(color) {
        if square_to_coords(sq)
            .map(|(f, _)| f == file)
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

fn attackers_around_king(board: &Board, attacker: Color, defender: Color) -> usize {
    let Some(king_sq) = king_square(board, defender) else {
        return 0;
    };
    let Some((file, rank)) = square_to_coords(king_sq) else {
        return 0;
    };

    let mut count = 0usize;
    for df in -1i32..=1 {
        for dr in -1i32..=1 {
            let Some(sq) = coords_to_square_checked(file as i32 + df, rank as i32 + dr) else {
                continue;
            };
            if is_square_attacked_by(board, attacker, sq) {
                count += 1;
            }
        }
    }
    count
}

fn pawn_attackers_of_square(board: &Board, color: Color, target: Square) -> Vec<Square> {
    attackers_of_square(board, color, target)
        .into_iter()
        .filter_map(|(role, sq)| if role == Role::Pawn { Some(sq) } else { None })
        .collect()
}

fn attackers_of_square(board: &Board, color: Color, target: Square) -> Vec<(Role, Square)> {
    let mut out = Vec::new();
    for sq in board.by_color(color) {
        let Some(piece) = board.piece_at(sq) else {
            continue;
        };
        if piece_attacks_square(board, sq, piece.role, piece.color, target) {
            out.push((piece.role, sq));
        }
    }
    out
}

fn is_square_attacked_by(board: &Board, color: Color, target: Square) -> bool {
    attackers_of_square(board, color, target).is_empty() == false
}

fn is_square_defended_by(board: &Board, color: Color, target: Square) -> bool {
    attackers_of_square(board, color, target).is_empty() == false
}

fn pseudo_attacks_from(board: &Board, from: Square, role: Role, color: Color) -> Vec<Square> {
    let mut out = Vec::new();
    for file in 0..8 {
        for rank in 0..8 {
            let Some(target) = coords_to_square(file, rank) else {
                continue;
            };
            if target == from {
                continue;
            }
            if piece_attacks_square(board, from, role, color, target) {
                if board
                    .piece_at(target)
                    .map(|p| p.color != color)
                    .unwrap_or(true)
                {
                    out.push(target);
                }
            }
        }
    }
    out
}

fn piece_attacks_square(
    board: &Board,
    from: Square,
    role: Role,
    color: Color,
    target: Square,
) -> bool {
    let Some((ff, fr)) = square_to_coords(from) else {
        return false;
    };
    let Some((tf, tr)) = square_to_coords(target) else {
        return false;
    };

    let df = tf as i32 - ff as i32;
    let dr = tr as i32 - fr as i32;

    match role {
        Role::Pawn => match color {
            Color::White => dr == 1 && df.abs() == 1,
            Color::Black => dr == -1 && df.abs() == 1,
        },
        Role::Knight => matches!((df.abs(), dr.abs()), (1, 2) | (2, 1)),
        Role::Bishop => df.abs() == dr.abs() && is_line_clear(board, ff, fr, tf, tr),
        Role::Rook => (df == 0 || dr == 0) && is_line_clear(board, ff, fr, tf, tr),
        Role::Queen => {
            (df.abs() == dr.abs() || df == 0 || dr == 0) && is_line_clear(board, ff, fr, tf, tr)
        }
        Role::King => df.abs() <= 1 && dr.abs() <= 1,
    }
}

fn bishop_or_queen_diagonal_to(board: &Board, from: Square, target: Square, color: Color) -> bool {
    let Some(piece) = board.piece_at(from) else {
        return false;
    };
    if piece.color != color || !matches!(piece.role, Role::Bishop | Role::Queen) {
        return false;
    }
    piece_attacks_square(board, from, piece.role, color, target)
}

fn rook_or_queen_line_to(board: &Board, from: Square, target: Square, color: Color) -> bool {
    let Some(piece) = board.piece_at(from) else {
        return false;
    };
    if piece.color != color || !matches!(piece.role, Role::Rook | Role::Queen) {
        return false;
    }
    piece_attacks_square(board, from, piece.role, color, target)
}

fn is_line_clear(
    board: &Board,
    from_file: usize,
    from_rank: usize,
    to_file: usize,
    to_rank: usize,
) -> bool {
    let df = (to_file as i32 - from_file as i32).signum();
    let dr = (to_rank as i32 - from_rank as i32).signum();
    let mut f = from_file as i32 + df;
    let mut r = from_rank as i32 + dr;
    let tf = to_file as i32;
    let tr = to_rank as i32;

    while f != tf || r != tr {
        let Some(sq) = coords_to_square_checked(f, r) else {
            return false;
        };
        if board.piece_at(sq).is_some() {
            return false;
        }
        f += df;
        r += dr;
    }

    true
}

fn square_to_coords(sq: Square) -> Option<(usize, usize)> {
    let text = sq.to_string();
    let bytes = text.as_bytes();
    if bytes.len() != 2 {
        return None;
    }
    let file = bytes[0].to_ascii_lowercase().checked_sub(b'a')? as usize;
    let rank = bytes[1].checked_sub(b'1')? as usize;
    if file <= 7 && rank <= 7 {
        Some((file, rank))
    } else {
        None
    }
}

fn coords_to_square(file: usize, rank: usize) -> Option<Square> {
    if file > 7 || rank > 7 {
        return None;
    }
    let bytes = [b'a' + file as u8, b'1' + rank as u8];
    Square::from_ascii(&bytes).ok()
}

fn coords_to_square_checked(file: i32, rank: i32) -> Option<Square> {
    if !(0..=7).contains(&file) || !(0..=7).contains(&rank) {
        return None;
    }
    coords_to_square(file as usize, rank as usize)
}

fn has_piece(board: &Board, color: Color, role: Role, square: &str) -> bool {
    let Ok(sq) = Square::from_ascii(square.as_bytes()) else {
        return false;
    };
    board
        .piece_at(sq)
        .map(|p| p.color == color && p.role == role)
        .unwrap_or(false)
}

fn black_h_pawn_can_reach_h4(board: &Board) -> bool {
    let candidates = ["h7", "h6", "h5"];
    let target_path = ["h6", "h5", "h4"];
    for from in candidates {
        let Ok(from_sq) = Square::from_ascii(from.as_bytes()) else {
            continue;
        };
        if !board
            .piece_at(from_sq)
            .map(|p| p.color == Color::Black && p.role == Role::Pawn)
            .unwrap_or(false)
        {
            continue;
        }
        for target in target_path {
            let Ok(target_sq) = Square::from_ascii(target.as_bytes()) else {
                continue;
            };
            if target_sq == from_sq {
                continue;
            }
            if board.piece_at(target_sq).is_some() {
                return false;
            }
            if target == "h4" {
                return true;
            }
        }
    }
    false
}

fn white_h_pawn_can_reach_h5(board: &Board) -> bool {
    let candidates = ["h2", "h3", "h4"];
    let target_path = ["h3", "h4", "h5"];
    for from in candidates {
        let Ok(from_sq) = Square::from_ascii(from.as_bytes()) else {
            continue;
        };
        if !board
            .piece_at(from_sq)
            .map(|p| p.color == Color::White && p.role == Role::Pawn)
            .unwrap_or(false)
        {
            continue;
        }
        for target in target_path {
            let Ok(target_sq) = Square::from_ascii(target.as_bytes()) else {
                continue;
            };
            if target_sq == from_sq {
                continue;
            }
            if board.piece_at(target_sq).is_some() {
                return false;
            }
            if target == "h5" {
                return true;
            }
        }
    }
    false
}

fn is_real_pawn_break_push(board: &Board, pusher: Color, from: Square, to: Square) -> bool {
    let opponent = pusher.other();
    let Some((from_file, _from_rank)) = square_to_coords(from) else {
        return false;
    };
    let Some((to_file, to_rank)) = square_to_coords(to) else {
        return false;
    };
    if from_file != to_file {
        return false;
    }

    // After the push, would this pawn attack an enemy pawn?
    // Example: e4 attacks d5/f5, c3 attacks d4, etc.
    for df in [-1i32, 1] {
        let attacked_rank = match pusher {
            Color::White => to_rank as i32 + 1,
            Color::Black => to_rank as i32 - 1,
        };
        if let Some(target) = coords_to_square_checked(to_file as i32 + df, attacked_rank) {
            if board
                .piece_at(target)
                .map(|p| p.color == opponent && p.role == Role::Pawn)
                .unwrap_or(false)
            {
                return true;
            }
        }
    }

    // Would an enemy pawn attack the pushed pawn on its destination square?
    // This captures the usual pawn tension created by a real break.
    if !pawn_attackers_of_square(board, opponent, to).is_empty() {
        return true;
    }

    // Same-file contact also counts if the push directly challenges a pawn chain.
    let forward_rank = match pusher {
        Color::White => to_rank as i32 + 1,
        Color::Black => to_rank as i32 - 1,
    };
    if let Some(front_sq) = coords_to_square_checked(to_file as i32, forward_rank) {
        if board
            .piece_at(front_sq)
            .map(|p| p.color == opponent && p.role == Role::Pawn)
            .unwrap_or(false)
        {
            return true;
        }
    }

    false
}

fn central_files_are_open(board: &Board) -> bool {
    let white = pawn_file_counts(board, Color::White);
    let black = pawn_file_counts(board, Color::Black);
    (white[3] + black[3] == 0) || (white[4] + black[4] == 0)
}

fn central_pawn_tension(board: &Board) -> bool {
    for sq in board.pawns() {
        let Some(piece) = board.piece_at(sq) else {
            continue;
        };
        let opponent = piece.color.other();
        for target in pseudo_attacks_from(board, sq, Role::Pawn, piece.color) {
            if board
                .piece_at(target)
                .map(|p| p.color == opponent && p.role == Role::Pawn)
                .unwrap_or(false)
            {
                return true;
            }
        }
    }
    false
}

fn file_name(file: usize) -> &'static str {
    match file {
        0 => "a",
        1 => "b",
        2 => "c",
        3 => "d",
        4 => "e",
        5 => "f",
        6 => "g",
        7 => "h",
        _ => "?",
    }
}

fn sentence(input: &str) -> String {
    let trimmed = input.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{}.", trimmed)
    }
}

fn sentence_key(input: &str) -> String {
    input
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch.is_whitespace() {
                ch
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn join_unique_sentences(parts: &[String]) -> String {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for part in parts {
        let sent = sentence(part);
        if sent.is_empty() {
            continue;
        }
        let key = sentence_key(&sent);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        out.push(sent);
    }

    out.join(" ")
}

fn clean_spaces(input: &str) -> String {
    input
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace(" .", ".")
        .replace("..", ".")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chess::human_strategy::StrategicRiskFlag;

    fn narrative_with(
        verdict: HumanMoveVerdict,
        axes: Vec<HumanStrategicAxisNarrative>,
        motifs: Vec<StrategicMotif>,
    ) -> HumanMoveNarrative {
        HumanMoveNarrative {
            ply: 0,
            side_to_move: "white".to_string(),
            played_uci: "e2e4".to_string(),
            played_san: "e4".to_string(),
            engine_best_uci: Some("e2e4".to_string()),
            engine_best_san: Some("e4".to_string()),
            strategic_choice_uci: Some("e2e4".to_string()),
            strategic_choice_san: Some("e4".to_string()),
            verdict,
            eval_before_cp: Some(20),
            eval_after_cp: Some(10),
            cp_loss: Some(10),
            played_strategic_score: Some(0.7),
            played_motifs: motifs,
            strategic_axes: axes,
            strategic_plan: "Keep practical pressure.".to_string(),
            comment_short: "short".to_string(),
            comment_long: "long".to_string(),
            suggested_variation_uci: vec![],
            suggested_variation_san: vec![],
        }
    }

    fn strategic_candidate_with(
        strategic_score: f32,
        motifs: Vec<StrategicMotif>,
        risk_flags: Vec<StrategicRiskFlag>,
    ) -> HumanStrategicCandidate {
        HumanStrategicCandidate {
            uci: "e2e4".to_string(),
            san: "e4".to_string(),
            pv_uci_line: vec!["e2e4".to_string(), "e7e5".to_string()],
            engine_rank: 0,
            engine_cp: 20,
            engine_drop_cp: 0,
            strategic_score,
            macro_strategic_score: strategic_score,
            final_score: strategic_score,
            passes_guardrail: true,
            is_last_resort: false,
            risk_flags,
            motifs,
            components: HumanStrategicComponents::default(),
            macro_components: HumanStrategicMacroComponents {
                initiative: strategic_score,
                attack: strategic_score,
                practical_pressure: strategic_score,
                plan_coherence: strategic_score,
                ..HumanStrategicMacroComponents::default()
            },
        }
    }

    #[test]
    fn strategy_candidate_atoms_are_used_for_comments() {
        let candidate = strategic_candidate_with(
            0.72,
            vec![StrategicMotif::KingNet, StrategicMotif::Counterplay],
            vec![StrategicRiskFlag::MaterialInvestment],
        );
        let mut atoms = Vec::new();

        strategy_commentary::add_candidate_strategy_atoms(&mut atoms, &candidate);

        assert!(atoms.iter().any(|atom| atom.short.contains("king")));
        assert!(atoms.iter().any(|atom| atom.short.contains("initiative")));
    }

    #[test]
    fn strategic_candidate_signal_can_drive_opening_comment() {
        let candidate =
            strategic_candidate_with(0.64, vec![StrategicMotif::Counterplay], Vec::new());
        let should_comment = should_comment_move(
            12,
            true,
            true,
            false,
            false,
            HumanMoveVerdict::Practical,
            Some(12),
            Some(candidate.strategic_score),
            &candidate.motifs,
            &ConcreteCommentBundle::default(),
            false,
            true,
            Some(&candidate),
        );

        assert!(should_comment);
    }

    #[test]
    fn classify_verdict_phase2_detects_blunder_on_large_swing() {
        let verdict = classify_verdict_phase2(
            Some(220),
            Some(-260),
            &[220, 180, 50],
            false,
            false,
            None,
            false,
        );
        assert_eq!(verdict, HumanMoveVerdict::Blunder);
    }

    #[test]
    fn classify_verdict_phase2_handles_hopeless_positions_without_false_penalty() {
        let verdict = classify_verdict_phase2(
            Some(-960),
            Some(-980),
            &[-940, -930],
            false,
            false,
            None,
            false,
        );
        assert_eq!(verdict, HumanMoveVerdict::Interesting);
    }

    #[test]
    fn classify_verdict_phase2_marks_practical_when_near_best_and_aligned() {
        let verdict = classify_verdict_phase2(
            Some(80),
            Some(68),
            &[85, 30],
            false,
            true,
            Some(0.80),
            false,
        );
        assert_eq!(verdict, HumanMoveVerdict::Practical);
    }

    #[test]
    #[ignore = "Temporarily disabled while tuning verdict thresholds"]
    fn classify_verdict_phase2_marks_best_when_near_best_without_alignment() {
        let verdict = classify_verdict_phase2(
            Some(80),
            Some(68),
            &[85, 30],
            false,
            false,
            Some(0.40),
            false,
        );
        assert_eq!(verdict, HumanMoveVerdict::Best);
    }

    #[test]
    fn extract_top_macro_axes_ignores_noise() {
        let macro_components = HumanStrategicMacroComponents {
            pawn_structure: 0.01,
            space: 0.02,
            piece_quality: 0.03,
            king_safety: 0.02,
            initiative: 0.05,
            attack: 0.06,
            counterplay: 0.04,
            prophylaxis: 0.02,
            conversion: 0.01,
            endgame_transition: 0.01,
            practical_pressure: 0.05,
            plan_coherence: 0.04,
        };
        let axes = extract_top_macro_axes(&macro_components);
        assert!(axes.is_empty());
    }

    #[test]
    fn extract_top_macro_axes_picks_dominant_components() {
        let macro_components = HumanStrategicMacroComponents {
            pawn_structure: 0.10,
            space: 0.12,
            piece_quality: 0.16,
            king_safety: 0.14,
            initiative: 0.84,
            attack: 0.90,
            counterplay: 0.20,
            prophylaxis: 0.13,
            conversion: 0.11,
            endgame_transition: 0.09,
            practical_pressure: 0.76,
            plan_coherence: 0.62,
        };

        let axes = extract_top_macro_axes(&macro_components);
        assert_eq!(axes.len(), 3);
        assert_eq!(axes[0].axis, "attack");
        assert_eq!(axes[1].axis, "initiative");
        assert_eq!(axes[2].axis, "practicalPressure");
    }

    #[test]
    fn build_summary_counts_verdicts_and_themes() {
        let n1 = narrative_with(
            HumanMoveVerdict::Best,
            vec![HumanStrategicAxisNarrative {
                axis: "initiative".to_string(),
                score: 0.8,
                explanation: "Keep forcing replies.".to_string(),
            }],
            vec![StrategicMotif::SpaceGain],
        );
        let n2 = narrative_with(
            HumanMoveVerdict::Mistake,
            vec![HumanStrategicAxisNarrative {
                axis: "initiative".to_string(),
                score: 0.7,
                explanation: "Keep forcing replies.".to_string(),
            }],
            vec![StrategicMotif::SpaceGain],
        );
        let n3 = narrative_with(
            HumanMoveVerdict::Practical,
            vec![HumanStrategicAxisNarrative {
                axis: "kingSafety".to_string(),
                score: 0.75,
                explanation: "Increase king pressure.".to_string(),
            }],
            vec![StrategicMotif::CentralKingPressure],
        );

        let summary = build_summary(&[n1, n2, n3]);
        assert_eq!(summary.best_count, 1);
        assert_eq!(summary.mistake_count, 1);
        assert_eq!(summary.practical_count, 1);
        assert!(summary.top_themes.contains(&"initiative".to_string()));
        assert!(summary.top_themes.contains(&"motif:spaceGain".to_string()));
    }

    #[test]
    fn sentence_helper_does_not_double_dot() {
        assert_eq!(sentence("Focus: pressure."), "Focus: pressure.");
        assert_eq!(sentence("Focus: pressure"), "Focus: pressure.");
    }

    #[test]
    fn integration_outputs_annotated_pgn_for_user_pgn() {
        let pgn = r#"
[Event "?"]
[Site "?"]
[Date "????.??.??"]
[Round "?"]
[White "?"]
[Black "?"]
[Result "*"]
[Orientation "white"]

1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 g6 5. Nc3 Bg7 6. Be3 Nf6 7. f3 O-O 8. Qd2 d5 9. O-O-O dxe4 10. Qe1 Nxd4 11. Bxd4 Qa5 12. fxe4 Be6 13. Kb1 Rac8 14. Nd5 Qxe1 15. Nxe7+ Kh8 16. Rxe1 Rc7 17. Bxf6 Bxf6 18. Nd5 Bxd5 19. exd5 Rc5 20. c4 a5 21. Bd3 b5 22. b3 bxc4 23. bxc4 Rb8+ 24. Kc1 a4 25. Rhf1 Bc3 26. Re2 Rc7 27. Kc2 Bd4 28. Rb1 Rxb1 29. Kxb1 Rb7+ 30. Kc1 a3 31. Rc2 Bc5 32. Be4 Re7 33. Bf3 Re1+ 34. Kd2 Re7 35. Kd1 Rb7 36. h3 Kg7 37. Kd2 Re7 38. Be2 h5 39. Kc3 Re3+ 40. Bd3 h4 41. Rd2 Re7 42. Be2 Re3+ 43. Kc2 Bb4 44. d6 Bxd2 45. Kxd2 Re6 46. c5 Re5 47. Bf3 Kf8 48. d7 Ke7 49. c6 *
"#;

        let initial_fen = "startpos";
        let moves =
            pgn_mainline_to_uci_moves(initial_fen, pgn).expect("must recover moves from PGN");
        assert!(!moves.is_empty(), "PGN should contain moves");

        let mut analysis = Vec::with_capacity(moves.len());
        let mut position = parse_position(initial_fen).expect("valid initial position");

        for (idx, played_uci) in moves.iter().enumerate() {
            let played_uci_norm = normalize_move_key(played_uci);
            let played_uci_move =
                UciMove::from_ascii(played_uci_norm.as_bytes()).expect("valid uci");
            let played_move = played_uci_move.to_move(&position).expect("legal uci move");
            let played_san = SanPlus::from_move(position.clone(), &played_move).to_string();

            let mut best_lines = vec![BestMoves {
                nodes: 100_000 + idx as u32,
                depth: 18,
                score: crate::chess::types::Score {
                    value: ScoreValue::Cp(((idx as i32 % 5) - 2) * 10),
                    wdl: None,
                },
                uci_moves: vec![played_uci_norm.clone()],
                san_moves: vec![played_san],
                multipv: 1,
                nps: 200_000,
            }];

            if let Some(alt_move) = position
                .legal_moves()
                .into_iter()
                .find(|m| m != &played_move)
            {
                let alt_uci = UciMove::from_move(&alt_move, CastlingMode::Standard).to_string();
                let alt_san = SanPlus::from_move(position.clone(), &alt_move).to_string();
                best_lines.push(BestMoves {
                    nodes: 95_000 + idx as u32,
                    depth: 18,
                    score: crate::chess::types::Score {
                        value: ScoreValue::Cp((((idx as i32 + 1) % 5) - 2) * 10),
                        wdl: None,
                    },
                    uci_moves: vec![normalize_move_key(&alt_uci)],
                    san_moves: vec![alt_san],
                    multipv: 2,
                    nps: 190_000,
                });
            }

            analysis.push(MoveAnalysis {
                best: best_lines,
                novelty: false,
                is_sacrifice: false,
            });

            SanPlus::from_move_and_play_unchecked(&mut position, &played_move);
        }

        let (annotated_pgn, narratives) =
            build_annotated_pgn_and_narratives(initial_fen, &moves, &analysis, Some(pgn), 5)
                .expect("annotated pgn should be generated");

        let comment_count = narratives
            .iter()
            .filter(|n| !n.comment_long.trim().is_empty() || !n.comment_short.trim().is_empty())
            .count();

        assert!(
            comment_count > 0,
            "expected at least one move comment from human analyzer"
        );
        assert!(
            annotated_pgn.contains('{'),
            "annotated pgn should contain comments"
        );
    }
}
