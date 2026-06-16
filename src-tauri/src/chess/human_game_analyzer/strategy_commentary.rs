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
                "permite peligro de mate",
                "El selector estrategico detecta peligro de mate en esta linea candidata.",
            ),
            StrategicRiskFlag::ForcedTacticalLine => (
                112,
                "requiere una linea tactica forzada",
                "La jugada depende de tacticas concretas, no de una ventaja estrategica tranquila.",
            ),
            StrategicRiskFlag::UndefendedLandingSquare => (
                104,
                "deja la pieza movida sin defensa",
                "La casilla de destino esta bajo control rival y la pieza movida no tiene apoyo inmediato.",
            ),
            StrategicRiskFlag::WdlDrop => (
                102,
                "cede chances practicas",
                "La senal WDL muestra una concesion practica relevante frente a la mejor linea del motor.",
            ),
            StrategicRiskFlag::UnstableScore => (
                96,
                "tiene evaluacion inestable",
                "Las senales del motor y del modulo estrategico hacen que esta candidata sea tacticamente inestable.",
            ),
            StrategicRiskFlag::LowDepthCandidate => (
                72,
                "necesita verificacion mas profunda",
                "La candidata viene de una linea con menor profundidad, asi que la idea estrategica necesita confirmacion del motor.",
            ),
            StrategicRiskFlag::MaterialInvestment => {
                if candidate.strategic_score >= 0.45 {
                    (
                        94,
                        "invierte material por iniciativa",
                        "La jugada acepta una inversion material, pero el modulo estrategico encuentra compensacion en actividad.",
                    )
                } else {
                    (
                        92,
                        "invierte material sin compensacion suficiente",
                        "La jugada entrega material y la compensacion estrategica aun no convence.",
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
            "conecta con un plan coherente",
            "El modulo estrategico ve esta jugada como parte de un plan coherente de varias jugadas.",
        );
    }
    if macro_components.practical_pressure >= 0.40 {
        add_atom_once(
            atoms,
            86,
            "maximiza la presion practica",
            "La jugada aumenta la carga defensiva aunque el margen del motor no sea grande.",
        );
    }
    if macro_components.endgame_transition >= 0.34 {
        add_atom_once(
            atoms,
            80,
            "busca una transicion favorable",
            "La linea apunta hacia un final o estructura simplificada que favorece al bando que mueve.",
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
            "mejora el control de puestos avanzados",
            "El modulo estrategico valora la jugada porque mejora el control de casillas avanzadas estables.",
        )),
        StrategicMotif::ColorComplexPressure => Some((
            base_priority,
            "presiona un complejo de color",
            "La jugada aumenta la presion sobre un complejo de color debilitado en la posicion rival.",
        )),
        StrategicMotif::Prophylaxis => Some((
            base_priority,
            "frena el plan rival",
            "La jugada es profilactica: restringe la principal fuente de contrajuego del rival.",
        )),
        StrategicMotif::FavorableTrade => Some((
            base_priority,
            "orienta hacia un cambio favorable",
            "El modulo estrategico prefiere el cambio o la transicion resultante.",
        )),
        StrategicMotif::PassedPawnConversion => Some((
            base_priority + 4,
            "apoya la conversion del peon pasado",
            "La jugada ayuda a convertir una ventaja de peon en un plan concreto.",
        )),
        StrategicMotif::InitiativeSacrifice => Some((
            base_priority + 8,
            "sacrifica por iniciativa",
            "La inversion material esta ligada a iniciativa y juego forzado.",
        )),
        StrategicMotif::Counterplay => Some((
            base_priority + 4,
            "crea contrajuego activo",
            "La jugada elige contrajuego activo en vez de defensa pasiva.",
        )),
        StrategicMotif::KingNet => Some((
            base_priority + 6,
            "construye una red contra el rey",
            "La jugada coordina amenazas alrededor del rey rival.",
        )),
        StrategicMotif::PieceCoordination => Some((
            base_priority,
            "mejora la coordinacion de piezas",
            "La jugada mejora la coordinacion de las piezas en la linea candidata.",
        )),
        StrategicMotif::TensionManagement => Some((
            base_priority + 2,
            "gestiona la tension central",
            "La jugada mantiene o libera la tension bajo circunstancias favorables.",
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
