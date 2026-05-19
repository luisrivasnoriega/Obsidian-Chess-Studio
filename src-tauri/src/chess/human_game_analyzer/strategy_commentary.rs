use super::{ConcreteCommentAtom, HumanMoveVerdict};
use crate::chess::human_strategy::{HumanStrategicCandidate, StrategicMotif, StrategicRiskFlag};

pub(super) fn add_candidate_strategy_atoms(
    atoms: &mut Vec<ConcreteCommentAtom>,
    candidate: &HumanStrategicCandidate,
) {
    add_risk_atoms(atoms, candidate);
    add_motif_atoms(atoms, candidate);
    add_macro_axis_atoms(atoms, candidate);
}

pub(super) fn should_comment_from_candidate(
    candidate: Option<&HumanStrategicCandidate>,
    verdict: HumanMoveVerdict,
    played_matches_strategic: bool,
    is_sacrifice: bool,
) -> bool {
    let Some(candidate) = candidate else {
        return false;
    };

    if has_high_risk_flag(candidate) {
        return true;
    }

    if is_sacrifice
        && candidate.strategic_score >= 0.38
        && (candidate.motifs.iter().any(|m| {
            matches!(
                m,
                StrategicMotif::InitiativeSacrifice | StrategicMotif::KingNet
            )
        }) || candidate.macro_components.attack >= 0.24
            || candidate.macro_components.initiative >= 0.24)
    {
        return true;
    }

    let positive_verdict = matches!(
        verdict,
        HumanMoveVerdict::Best
            | HumanMoveVerdict::Great
            | HumanMoveVerdict::Practical
            | HumanMoveVerdict::Interesting
    );
    if !positive_verdict {
        return true;
    }

    if played_matches_strategic && candidate.strategic_score >= 0.42 {
        return true;
    }

    candidate.strategic_score >= 0.62
        && candidate.passes_guardrail
        && candidate
            .motifs
            .iter()
            .any(|motif| is_comment_worthy_motif(*motif))
}

pub(super) fn has_opening_plan_signal_from_candidate(
    candidate: Option<&HumanStrategicCandidate>,
    played_matches_strategic: bool,
) -> bool {
    let Some(candidate) = candidate else {
        return false;
    };

    if has_high_risk_flag(candidate) {
        return true;
    }

    if !candidate.passes_guardrail {
        return false;
    }

    (played_matches_strategic && candidate.strategic_score >= 0.40)
        || (candidate.strategic_score >= 0.56
            && candidate.motifs.iter().any(|motif| {
                matches!(
                    motif,
                    StrategicMotif::DamagedPawnStructure
                        | StrategicMotif::OpenFilePressure
                        | StrategicMotif::CentralKingPressure
                        | StrategicMotif::InitiativeSacrifice
                        | StrategicMotif::Counterplay
                        | StrategicMotif::KingNet
                        | StrategicMotif::TensionManagement
                )
            }))
}

fn add_risk_atoms(atoms: &mut Vec<ConcreteCommentAtom>, candidate: &HumanStrategicCandidate) {
    for flag in &candidate.risk_flags {
        let (priority, short, sentence) = match flag {
            StrategicRiskFlag::MateRisk => (
                120,
                "allows a mate-risk line",
                "The strategic selector flags a mating danger in this candidate line.",
            ),
            StrategicRiskFlag::ForcedTacticalLine => (
                112,
                "requires a forced tactical line",
                "The move depends on concrete tactics rather than a quiet strategic edge.",
            ),
            StrategicRiskFlag::UndefendedLandingSquare => (
                104,
                "leaves the moved piece undefended",
                "The destination square is under enemy control and the moved piece lacks immediate support.",
            ),
            StrategicRiskFlag::WdlDrop => (
                102,
                "drops practical winning chances",
                "The WDL signal shows a meaningful practical concession compared with the best engine line.",
            ),
            StrategicRiskFlag::UnstableScore => (
                96,
                "has an unstable evaluation",
                "The engine and strategic signals make this candidate tactically unstable.",
            ),
            StrategicRiskFlag::LowDepthCandidate => (
                72,
                "needs deeper verification",
                "The candidate comes from a lower-depth line, so the strategic idea needs engine confirmation.",
            ),
            StrategicRiskFlag::MaterialInvestment => {
                if candidate.strategic_score >= 0.45 {
                    (
                        94,
                        "invests material for initiative",
                        "The move accepts a material investment, but the strategic module finds compensation in activity.",
                    )
                } else {
                    (
                        92,
                        "invests material without enough compensation",
                        "The move gives material and the strategic compensation is not yet convincing.",
                    )
                }
            }
        };
        add_atom_once(atoms, priority, short, sentence);
    }
}

fn add_motif_atoms(atoms: &mut Vec<ConcreteCommentAtom>, candidate: &HumanStrategicCandidate) {
    for motif in &candidate.motifs {
        let Some((priority, short, sentence)) = motif_atom(*motif, candidate.strategic_score)
        else {
            continue;
        };
        add_atom_once(atoms, priority, short, sentence);
    }
}

fn add_macro_axis_atoms(atoms: &mut Vec<ConcreteCommentAtom>, candidate: &HumanStrategicCandidate) {
    let macro_components = &candidate.macro_components;
    if macro_components.plan_coherence >= 0.34 {
        add_atom_once(
            atoms,
            82,
            "connects to a coherent plan",
            "The strategic module sees this move as part of a coherent multi-move plan.",
        );
    }
    if macro_components.practical_pressure >= 0.40 {
        add_atom_once(
            atoms,
            86,
            "maximizes practical pressure",
            "The move increases the defensive burden even if the engine margin is not large.",
        );
    }
    if macro_components.endgame_transition >= 0.34 {
        add_atom_once(
            atoms,
            80,
            "heads for a favorable transition",
            "The line points toward an endgame or simplified structure that favors the mover.",
        );
    }
}

fn motif_atom(
    motif: StrategicMotif,
    strategic_score: f32,
) -> Option<(i32, &'static str, &'static str)> {
    let base_priority = if strategic_score >= 0.62 { 88 } else { 78 };
    match motif {
        StrategicMotif::OutpostControl => Some((
            base_priority,
            "improves outpost control",
            "The strategic module values the move because it improves control of stable forward squares.",
        )),
        StrategicMotif::ColorComplexPressure => Some((
            base_priority,
            "pressures a color complex",
            "The move increases pressure on a weakened color complex around the enemy position.",
        )),
        StrategicMotif::Prophylaxis => Some((
            base_priority,
            "stops the opponent's plan",
            "The move is prophylactic: it restricts the opponent's main source of counterplay.",
        )),
        StrategicMotif::FavorableTrade => Some((
            base_priority,
            "steers toward a favorable trade",
            "The strategic module prefers the resulting trade or transition.",
        )),
        StrategicMotif::PassedPawnConversion => Some((
            base_priority + 4,
            "supports passed-pawn conversion",
            "The move helps turn a pawn advantage into a concrete conversion plan.",
        )),
        StrategicMotif::InitiativeSacrifice => Some((
            base_priority + 8,
            "sacrifices for initiative",
            "The material investment is tied to initiative and forcing play.",
        )),
        StrategicMotif::Counterplay => Some((
            base_priority + 4,
            "creates active counterplay",
            "The move chooses active counterplay instead of passive defense.",
        )),
        StrategicMotif::KingNet => Some((
            base_priority + 6,
            "builds a net around the king",
            "The move coordinates threats around the enemy king.",
        )),
        StrategicMotif::PieceCoordination => Some((
            base_priority,
            "improves piece coordination",
            "The move improves how the pieces work together in the candidate line.",
        )),
        StrategicMotif::TensionManagement => Some((
            base_priority + 2,
            "manages the central tension",
            "The move keeps or releases tension under favorable circumstances.",
        )),
        _ => None,
    }
}

fn has_high_risk_flag(candidate: &HumanStrategicCandidate) -> bool {
    candidate.risk_flags.iter().any(|flag| {
        matches!(
            flag,
            StrategicRiskFlag::MateRisk
                | StrategicRiskFlag::ForcedTacticalLine
                | StrategicRiskFlag::UndefendedLandingSquare
                | StrategicRiskFlag::WdlDrop
                | StrategicRiskFlag::UnstableScore
        )
    })
}

fn is_comment_worthy_motif(motif: StrategicMotif) -> bool {
    matches!(
        motif,
        StrategicMotif::DamagedPawnStructure
            | StrategicMotif::OpenFilePressure
            | StrategicMotif::CentralKingPressure
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
}

fn add_atom_once(atoms: &mut Vec<ConcreteCommentAtom>, priority: i32, short: &str, sentence: &str) {
    if atoms
        .iter()
        .any(|atom| atom.short == short || atom.sentence == sentence)
    {
        return;
    }

    atoms.push(ConcreteCommentAtom {
        priority,
        short: short.to_string(),
        sentence: sentence.to_string(),
    });
}
