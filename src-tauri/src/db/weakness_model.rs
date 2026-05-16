use crate::error::{Error, Result};
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{Double, Integer, Nullable, Text};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shakmaty::{fen::Fen, uci::UciMove, Board, CastlingMode, Chess, Color, Position, Role, Square};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

const PROFILE_WEAKNESS_TABLES_SQL: &str =
    include_str!("../../../database/schema/profile_weakness_tables.sql");

pub const WEAKNESS_MODEL_VERSION_V1: i32 = 2;
const HALF_LIFE_DAYS: f64 = 120.0;
const MIN_SIGNAL_SUPPORT: usize = 12;
const MAX_SIGNALS_DEFAULT: usize = 12;
const MAX_EVIDENCE_PER_SIGNAL_DEFAULT: usize = 4;
const PORTFOLIO_OVERLAP_THRESHOLD: f64 = 0.72;

/// Phase 1 catalog (design contract): structure families prioritized for weakness signals.
///
/// This catalog is intentionally declarative:
/// - it defines exact windows and anti-false-positive gates,
/// - it is used as a stable implementation contract across backend and UI,
/// - later phases wire detectors/scoring to these entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg(test)]
struct StructureCatalogRuleV1 {
    key: &'static str,
    perspective: &'static str, // "white" | "black" | "both"
    ply_from: i32,
    ply_to: i32,
    required: &'static [&'static str],
    contextual: &'static [&'static str],
    exclusions: &'static [&'static str],
}

#[cfg(test)]
const STRUCTURE_CATALOG_V1: &[StructureCatalogRuleV1] = &[
    StructureCatalogRuleV1 {
        key: "MAROCZY_BIND_STRICT",
        perspective: "both",
        ply_from: 10,
        ply_to: 15,
        required: &[
            "side c/e pawn duo advanced (c4+e4 or c5+e5)",
            "opponent c-pawn absent from c-file",
            "opponent central d-break absent (d5/d4 not achieved)",
            "opponent d-pawn remains restrictive (d6|d7 or d3|d2)",
            "side d-pawn absent from d-file",
        ],
        contextual: &["open-sicilian skeleton", "space restriction on d5/d4"],
        exclusions: &["pure c4+e4 visual similarity without restrictive d-pawn pattern"],
    },
    StructureCatalogRuleV1 {
        key: "SICILIAN_DRAGON_CLASSICAL",
        perspective: "both",
        ply_from: 10,
        ply_to: 18,
        required: &["opponent pawns on c5+d6+g6"],
        contextual: &["opponent kingside fianchetto shell (f7/g6/h7 or f2/g3/h2)"],
        exclusions: &["missing c5 pawn", "no g-pawn fianchetto structure"],
    },
    StructureCatalogRuleV1 {
        key: "SICILIAN_DRAGON_ACCELERATED",
        perspective: "both",
        ply_from: 8,
        ply_to: 16,
        required: &[
            "opponent pawns on c5+g6",
            "opponent d-pawn not fixed on d6 by window end",
        ],
        contextual: &["sicilian opening family", "early ...d5 pressure motifs"],
        exclusions: &["classical dragon with fixed d6 and no acceleration evidence"],
    },
    StructureCatalogRuleV1 {
        key: "IQP_PROFILE",
        perspective: "both",
        ply_from: 12,
        ply_to: 30,
        required: &[
            "profile isolated d-pawn",
            "profile no c/e pawn support on adjacent files",
        ],
        contextual: &[
            "open files around isolated pawn",
            "minor-piece activity compensation",
        ],
        exclusions: &[
            "hanging pawns c+d",
            "fully blocked center where isolation is irrelevant",
        ],
    },
    StructureCatalogRuleV1 {
        key: "IQP_OPPONENT",
        perspective: "both",
        ply_from: 12,
        ply_to: 30,
        required: &[
            "opponent isolated d-pawn",
            "opponent no c/e pawn support on adjacent files",
        ],
        contextual: &["pressure squares in front of IQP (d5/d4)"],
        exclusions: &[
            "hanging pawns c+d",
            "transient isolation resolved within window",
        ],
    },
    StructureCatalogRuleV1 {
        key: "HANGING_PAWNS_PROFILE",
        perspective: "both",
        ply_from: 12,
        ply_to: 30,
        required: &[
            "profile connected c+d pawns",
            "no b/e pawn support on adjacent files",
        ],
        contextual: &[
            "central expansion potential",
            "file-opening risk when overextended",
        ],
        exclusions: &["iqp on only one file", "fixed chain with full side support"],
    },
    StructureCatalogRuleV1 {
        key: "HANGING_PAWNS_OPPONENT",
        perspective: "both",
        ply_from: 12,
        ply_to: 30,
        required: &[
            "opponent connected c+d pawns",
            "no b/e pawn support on adjacent files",
        ],
        contextual: &["blockade targets on c/d files"],
        exclusions: &[
            "iqp on only one file",
            "temporary hanging pair that resolves immediately",
        ],
    },
    StructureCatalogRuleV1 {
        key: "CARLSBAD_PROFILE",
        perspective: "both",
        ply_from: 12,
        ply_to: 32,
        required: &["carlsbad strict pawn skeleton present for profile side"],
        contextual: &[
            "minority-attack plans (b4-b5) if profile is white side",
            "central break timing",
        ],
        exclusions: &[
            "slav-like structure missing c6/d5 anchors",
            "symmetrical structure without c-pawn imbalance",
        ],
    },
    StructureCatalogRuleV1 {
        key: "CARLSBAD_OPPONENT",
        perspective: "both",
        ply_from: 12,
        ply_to: 32,
        required: &["carlsbad strict pawn skeleton present for opponent side"],
        contextual: &[
            "minority-attack defense resources",
            "c-file pressure handling",
        ],
        exclusions: &["pseudo-carlsbad with missing c6/d5 pair"],
    },
    StructureCatalogRuleV1 {
        key: "STONEWALL_PROFILE",
        perspective: "both",
        ply_from: 10,
        ply_to: 25,
        required: &["profile stonewall pawn chain (c/d/e/f)"],
        contextual: &[
            "dark-square control",
            "light-square weaknesses around e5/e4",
        ],
        exclusions: &["three-pawn partial chain without full stonewall lock"],
    },
    StructureCatalogRuleV1 {
        key: "BENONI_OPPONENT",
        perspective: "both",
        ply_from: 10,
        ply_to: 25,
        required: &["opponent benoni pawns c5+d6 with side pawn on d5 for profile"],
        contextual: &["queenside counterplay vs central space"],
        exclusions: &["closed benoni-like shape without c5-d6 tension"],
    },
    StructureCatalogRuleV1 {
        key: "FRENCH_CHAIN_TENSION",
        perspective: "both",
        ply_from: 8,
        ply_to: 22,
        required: &["french chain core (d4/e5 vs d5/e6)"],
        contextual: &[
            "base-of-chain attack plans",
            "light-squared bishop restrictions",
        ],
        exclusions: &["caro-kann structures without e5/e6 lock"],
    },
    StructureCatalogRuleV1 {
        key: "KID_LOCKED_CENTER",
        perspective: "both",
        ply_from: 10,
        ply_to: 25,
        required: &["kings-indian center lock with d/e pawn tension fixed"],
        contextual: &["wing race plans (kingside vs queenside)"],
        exclusions: &["open center where locked-center plans do not apply"],
    },
    StructureCatalogRuleV1 {
        key: "GRUNFELD_BROAD_CENTER",
        perspective: "both",
        ply_from: 8,
        ply_to: 18,
        required: &["white broad center footprint with black hypermodern pressure shell"],
        contextual: &["central pawn targetability", "piece pressure on d4/e4/c4"],
        exclusions: &["transposed QGD/Slav centers without grunfeld pressure pattern"],
    },
];

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileWeaknessSignalEvidence {
    pub evidence_rank: i32,
    pub game_id: Option<i32>,
    pub ply_from: Option<i32>,
    pub ply_to: Option<i32>,
    pub evidence_text: String,
    pub evidence_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileWeaknessSignal {
    pub signal_key: String,
    pub title: String,
    pub trigger_text: String,
    pub attack_plan: String,
    pub score: f64,
    pub severity: f64,
    pub confidence: f64,
    pub controllability: f64,
    pub recency: f64,
    pub support: i32,
    pub n_eff: Option<f64>,
    pub impact_json: String,
    pub trigger_json: String,
    pub evidence: Vec<ProfileWeaknessSignalEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileWeaknessSignalsByColor {
    pub white: Vec<ProfileWeaknessSignal>,
    pub black: Vec<ProfileWeaknessSignal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileWeaknessModel {
    pub snapshot_key: String,
    pub model_version: i32,
    pub generated_at: String,
    pub total_games: i32,
    pub scored_games: i32,
    pub backfilled_games: i32,
    pub signals: Vec<ProfileWeaknessSignal>,
    pub signals_by_color: ProfileWeaknessSignalsByColor,
}

#[derive(Debug, Clone)]
pub struct ComputedWeaknessFeaturesV1 {
    pub opening_family: Option<String>,
    pub time_control_bucket: Option<String>,
    pub color_played: String,
    pub ply_bucket_features_json: Value,
    pub features_json: Value,
}

#[derive(Debug, Clone)]
pub struct WeaknessGameFeaturesUpsert {
    pub game_id: i32,
    pub model_version: i32,
    pub computed_at: String,
    pub opening_family: Option<String>,
    pub time_control_bucket: Option<String>,
    pub color_played: Option<String>,
    pub ply_bucket_features_json: Value,
    pub features_json: Value,
}

#[derive(Debug, Clone)]
pub struct WeaknessSignalSnapshotUpsert {
    pub signal_key: String,
    pub title: String,
    pub trigger_text: String,
    pub attack_plan: String,
    pub score: f64,
    pub severity: f64,
    pub confidence: f64,
    pub controllability: f64,
    pub recency: f64,
    pub support: i32,
    pub n_eff: Option<f64>,
    pub impact_json: Value,
    pub trigger_json: Value,
}

#[derive(Debug, Clone)]
pub struct WeaknessEvidenceUpsert {
    pub signal_key: String,
    pub evidence_rank: i32,
    pub game_id: Option<i32>,
    pub ply_from: Option<i32>,
    pub ply_to: Option<i32>,
    pub evidence_text: String,
    pub evidence_json: Value,
}

#[derive(Debug, Clone, QueryableByName, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WeaknessSignalSnapshotRow {
    #[diesel(sql_type = Text, column_name = "SnapshotKey")]
    pub snapshot_key: String,
    #[diesel(sql_type = Text, column_name = "SignalKey")]
    pub signal_key: String,
    #[diesel(sql_type = Integer, column_name = "ModelVersion")]
    pub model_version: i32,
    #[diesel(sql_type = Text, column_name = "GeneratedAt")]
    pub generated_at: String,
    #[diesel(sql_type = Text, column_name = "FiltersJson")]
    pub filters_json: String,
    #[diesel(sql_type = Text, column_name = "Title")]
    pub title: String,
    #[diesel(sql_type = Text, column_name = "TriggerText")]
    pub trigger_text: String,
    #[diesel(sql_type = Text, column_name = "AttackPlan")]
    pub attack_plan: String,
    #[diesel(sql_type = Double, column_name = "Score")]
    pub score: f64,
    #[diesel(sql_type = Double, column_name = "Severity")]
    pub severity: f64,
    #[diesel(sql_type = Double, column_name = "Confidence")]
    pub confidence: f64,
    #[diesel(sql_type = Double, column_name = "Controllability")]
    pub controllability: f64,
    #[diesel(sql_type = Double, column_name = "Recency")]
    pub recency: f64,
    #[diesel(sql_type = Integer, column_name = "Support")]
    pub support: i32,
    #[diesel(sql_type = Nullable<Double>, column_name = "NEff")]
    pub n_eff: Option<f64>,
    #[diesel(sql_type = Text, column_name = "ImpactJson")]
    pub impact_json: String,
    #[diesel(sql_type = Text, column_name = "TriggerJson")]
    pub trigger_json: String,
}

#[derive(Debug, Clone, QueryableByName, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WeaknessEvidenceRow {
    #[diesel(sql_type = Text, column_name = "SnapshotKey")]
    pub snapshot_key: String,
    #[diesel(sql_type = Text, column_name = "SignalKey")]
    pub signal_key: String,
    #[diesel(sql_type = Integer, column_name = "EvidenceRank")]
    pub evidence_rank: i32,
    #[diesel(sql_type = Nullable<Integer>, column_name = "GameID")]
    pub game_id: Option<i32>,
    #[diesel(sql_type = Nullable<Integer>, column_name = "PlyFrom")]
    pub ply_from: Option<i32>,
    #[diesel(sql_type = Nullable<Integer>, column_name = "PlyTo")]
    pub ply_to: Option<i32>,
    #[diesel(sql_type = Text, column_name = "EvidenceText")]
    pub evidence_text: String,
    #[diesel(sql_type = Text, column_name = "EvidenceJson")]
    pub evidence_json: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CastleSide {
    Short,
    Long,
}

impl CastleSide {
    fn as_str(self) -> &'static str {
        match self {
            Self::Short => "short",
            Self::Long => "long",
        }
    }
}

pub fn ensure_profile_weakness_tables(db: &mut SqliteConnection) -> Result<()> {
    db.batch_execute(PROFILE_WEAKNESS_TABLES_SQL)?;
    Ok(())
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

fn square_from_coords(file: usize, rank: usize) -> Option<Square> {
    if file > 7 || rank > 7 {
        return None;
    }
    let file_c = (b'a' + file as u8) as char;
    let rank_c = (b'1' + rank as u8) as char;
    let name = format!("{file_c}{rank_c}");
    name.parse::<Square>().ok()
}

fn opponent(color: Color) -> Color {
    match color {
        Color::White => Color::Black,
        Color::Black => Color::White,
    }
}

fn detect_castle_move(
    mover: Color,
    role: Role,
    from: Option<Square>,
    to: Square,
) -> Option<CastleSide> {
    if role != Role::King {
        return None;
    }
    let Some(from_sq) = from else {
        return None;
    };
    let Some((ff, fr)) = square_to_coords(from_sq) else {
        return None;
    };
    let Some((tf, tr)) = square_to_coords(to) else {
        return None;
    };

    // Standard-chess castling detection (most common in profile games).
    match mover {
        Color::White => {
            if ff == 4 && fr == 0 && tr == 0 && tf == 6 {
                return Some(CastleSide::Short);
            }
            if ff == 4 && fr == 0 && tr == 0 && tf == 2 {
                return Some(CastleSide::Long);
            }
        }
        Color::Black => {
            if ff == 4 && fr == 7 && tr == 7 && tf == 6 {
                return Some(CastleSide::Short);
            }
            if ff == 4 && fr == 7 && tr == 7 && tf == 2 {
                return Some(CastleSide::Long);
            }
        }
    }
    None
}

fn pawns_per_file(board: &Board, color: Color) -> [u8; 8] {
    let mut out = [0u8; 8];
    let pawns = board.pawns() & board.by_color(color);
    for sq in pawns {
        if let Some((file, _)) = square_to_coords(sq) {
            out[file] = out[file].saturating_add(1);
        }
    }
    out
}

fn rooks_on_file(board: &Board, color: Color, file: usize) -> u8 {
    let mut count = 0u8;
    let rooks = board.rooks() & board.by_color(color);
    for sq in rooks {
        if let Some((f, _)) = square_to_coords(sq) {
            if f == file {
                count = count.saturating_add(1);
            }
        }
    }
    count
}

fn open_file_control_delta(board: &Board, profile_color: Color) -> i32 {
    let opp = opponent(profile_color);
    let white_pawns = pawns_per_file(board, Color::White);
    let black_pawns = pawns_per_file(board, Color::Black);
    let mut profile_count = 0i32;
    let mut opp_count = 0i32;

    for file in 0..8 {
        if white_pawns[file] == 0 && black_pawns[file] == 0 {
            if rooks_on_file(board, profile_color, file) > 0 {
                profile_count += 1;
            }
            if rooks_on_file(board, opp, file) > 0 {
                opp_count += 1;
            }
        }
    }

    profile_count - opp_count
}

fn semi_open_file_control_delta(board: &Board, profile_color: Color) -> i32 {
    let opp = opponent(profile_color);
    let own_pawns = pawns_per_file(board, profile_color);
    let opp_pawns = pawns_per_file(board, opp);
    let mut profile_count = 0i32;
    let mut opp_count = 0i32;

    for file in 0..8 {
        // Semi-open for profile side.
        if own_pawns[file] == 0
            && opp_pawns[file] > 0
            && rooks_on_file(board, profile_color, file) > 0
        {
            profile_count += 1;
        }
        // Semi-open for opponent side.
        if opp_pawns[file] == 0 && own_pawns[file] > 0 && rooks_on_file(board, opp, file) > 0 {
            opp_count += 1;
        }
    }

    profile_count - opp_count
}

fn clear_between_on_line(board: &Board, a: Square, b: Square) -> bool {
    let Some((af, ar)) = square_to_coords(a) else {
        return false;
    };
    let Some((bf, br)) = square_to_coords(b) else {
        return false;
    };

    if af == bf {
        let min_r = ar.min(br) + 1;
        let max_r = ar.max(br);
        for r in min_r..max_r {
            let Some(sq) = square_from_coords(af, r) else {
                return false;
            };
            if board.piece_at(sq).is_some() {
                return false;
            }
        }
        return true;
    }

    if ar == br {
        let min_f = af.min(bf) + 1;
        let max_f = af.max(bf);
        for f in min_f..max_f {
            let Some(sq) = square_from_coords(f, ar) else {
                return false;
            };
            if board.piece_at(sq).is_some() {
                return false;
            }
        }
        return true;
    }

    false
}

fn rooks_connected(board: &Board, color: Color) -> bool {
    let rooks = board.rooks() & board.by_color(color);
    let squares: Vec<Square> = rooks.into_iter().collect();
    if squares.len() < 2 {
        return false;
    }

    for i in 0..squares.len() {
        for j in (i + 1)..squares.len() {
            if clear_between_on_line(board, squares[i], squares[j]) {
                return true;
            }
        }
    }
    false
}

fn is_square_attacked_by_color(board: &Board, attacker: Color, target: Square) -> bool {
    for from in board.by_color(attacker) {
        if board.attacks_from(from).contains(target) {
            return true;
        }
    }
    false
}

fn classify_time_control_bucket(time_control: Option<&str>) -> Option<String> {
    let tc = time_control?.trim();
    if tc.is_empty() {
        return None;
    }
    let lower = tc.to_lowercase();
    if lower.contains("bullet") {
        return Some("bullet".to_string());
    }
    if lower.contains("blitz") {
        return Some("blitz".to_string());
    }
    if lower.contains("rapid") {
        return Some("rapid".to_string());
    }
    if lower.contains("classical") || lower.contains("correspondence") || lower.contains("daily") {
        return Some("classical".to_string());
    }

    let base_seconds = if let Some((base, _inc)) = tc.split_once('+') {
        base.trim().parse::<f64>().ok()
    } else {
        tc.parse::<f64>().ok()
    }?;

    if base_seconds < 180.0 {
        Some("bullet".to_string())
    } else if base_seconds < 480.0 {
        Some("blitz".to_string())
    } else if base_seconds < 1500.0 {
        Some("rapid".to_string())
    } else {
        Some("classical".to_string())
    }
}

fn opening_family_from_eco(eco: Option<&str>) -> Option<String> {
    let eco = eco?.trim().to_uppercase();
    if eco.len() < 3 {
        return None;
    }
    let bytes = eco.as_bytes();
    let letter = bytes[0] as char;
    let number: i32 = eco[1..3].parse().ok()?;

    let family = match (letter, number) {
        ('B', 20..=99) => "sicilian",
        ('B', 10..=19) => "caro-kann",
        ('C', 0..=19) => "french",
        ('D', 20..=69) => "queens-gambit",
        ('D', 70..=99) => "grunfeld",
        ('E', 60..=99) => "kings-indian",
        ('A', _) => "flank-a",
        ('B', _) => "semi-open-b",
        ('C', _) => "open-c",
        ('D', _) => "closed-d",
        ('E', _) => "indian-e",
        _ => "other",
    };
    Some(family.to_string())
}

fn board_has_pawn(board: &Board, color: Color, file: usize, rank: usize) -> bool {
    let Some(sq) = square_from_coords(file, rank) else {
        return false;
    };
    board
        .piece_at(sq)
        .map(|p| p.color == color && p.role == Role::Pawn)
        .unwrap_or(false)
}

fn board_has_pawn_on_file(board: &Board, color: Color, file: usize) -> bool {
    let pawns = board.pawns() & board.by_color(color);
    for sq in pawns {
        if let Some((f, _)) = square_to_coords(sq) {
            if f == file {
                return true;
            }
        }
    }
    false
}

fn pawn_ranks_on_file(board: &Board, color: Color, file: usize) -> Vec<usize> {
    let pawns = board.pawns() & board.by_color(color);
    let mut out = Vec::new();
    for sq in pawns {
        if let Some((f, rank)) = square_to_coords(sq) {
            if f == file {
                out.push(rank);
            }
        }
    }
    out
}

/// Strict Maroczy bind detector to avoid false positives from just `c4+e4`.
///
/// Requirements for `side`:
/// - Side has c/e pawn duo advanced (`c4+e4` for White, `c5+e5` for Black)
/// - Opponent c-pawn is gone from c-file (typical c-pawn exchange)
/// - Opponent has not achieved central break (`...d5` / `d4`)
/// - Opponent d-pawn remains in restrictive squares (`d6|d7` / `d3|d2`)
/// - Side d-pawn is absent from d-file (classic Open Sicilian Maroczy bind skeleton)
fn detect_real_maroczy_bind(board: &Board, side: Color) -> bool {
    let opp = opponent(side);

    let (side_c_rank, side_e_rank, opp_d_break_rank, opp_d_restrictive_ranks) = match side {
        Color::White => (3usize, 3usize, 4usize, [5usize, 6usize]), // c4/e4, opp ...d5 absent, opp d6/d7
        Color::Black => (4usize, 4usize, 3usize, [2usize, 1usize]), // c5/e5, opp d4 absent, opp d3/d2
    };

    let side_duo =
        board_has_pawn(board, side, 2, side_c_rank) && board_has_pawn(board, side, 4, side_e_rank);
    if !side_duo {
        return false;
    }

    let opp_c_file_absent = !board_has_pawn_on_file(board, opp, 2);
    if !opp_c_file_absent {
        return false;
    }

    let opp_break_absent = !board_has_pawn(board, opp, 3, opp_d_break_rank);
    if !opp_break_absent {
        return false;
    }

    let opp_d_restrictive = board_has_pawn(board, opp, 3, opp_d_restrictive_ranks[0])
        || board_has_pawn(board, opp, 3, opp_d_restrictive_ranks[1]);
    if !opp_d_restrictive {
        return false;
    }

    let side_d_file_absent = !board_has_pawn_on_file(board, side, 3);
    if !side_d_file_absent {
        return false;
    }

    true
}

/// IQP detector (side perspective): side has d-pawn and no c/e-pawn support.
fn detect_iqp(board: &Board, side: Color) -> bool {
    let has_d = board_has_pawn_on_file(board, side, 3);
    let has_c = board_has_pawn_on_file(board, side, 2);
    let has_e = board_has_pawn_on_file(board, side, 4);
    has_d && !has_c && !has_e
}

/// Carlsbad detector (side perspective), strict-enough practical gate:
/// - side has no c-pawn and has d-pawn advanced,
/// - opponent has c-pawn + d-pawn anchor pair.
fn detect_carlsbad_for_side(board: &Board, side: Color) -> bool {
    match side {
        Color::White => {
            !board_has_pawn_on_file(board, Color::White, 2)
                && board_has_pawn(board, Color::White, 3, 3) // d4
                && board_has_pawn(board, Color::Black, 2, 5) // c6
                && board_has_pawn(board, Color::Black, 3, 4) // d5
        }
        Color::Black => {
            !board_has_pawn_on_file(board, Color::Black, 2)
                && board_has_pawn(board, Color::Black, 3, 4) // d5
                && board_has_pawn(board, Color::White, 2, 2) // c3
                && board_has_pawn(board, Color::White, 3, 3) // d4
        }
    }
}

fn detect_classical_dragon_for_side(board: &Board, side: Color) -> bool {
    match side {
        Color::Black => {
            board_has_pawn(board, side, 6, 5) // g6
                && board_has_pawn(board, side, 2, 4) // c5
                && board_has_pawn(board, side, 3, 5) // d6
        }
        Color::White => {
            board_has_pawn(board, side, 6, 2) // g3
                && board_has_pawn(board, side, 2, 3) // c4
                && board_has_pawn(board, side, 3, 2) // d3
        }
    }
}

fn detect_accelerated_dragon_for_side(board: &Board, side: Color) -> bool {
    match side {
        Color::Black => {
            board_has_pawn(board, side, 2, 4) // c5
                && board_has_pawn(board, side, 6, 5) // g6
                && !board_has_pawn(board, side, 3, 5) // no fixed d6 yet
                && board_has_pawn(board, Color::White, 4, 3) // white e4 anchor
                && !board_has_pawn(board, side, 4, 4) // avoid KID-like e5 locks
        }
        Color::White => {
            board_has_pawn(board, side, 2, 3) // c4
                && board_has_pawn(board, side, 6, 2) // g3
                && !board_has_pawn(board, side, 3, 2) // no fixed d3 yet
                && board_has_pawn(board, Color::Black, 4, 4) // black e5 anchor (reverse-Sicilian shell)
                && !board_has_pawn(board, side, 4, 3) // avoid locked-center transpositions
        }
    }
}

fn detect_french_chain_for_side(board: &Board, side: Color) -> bool {
    match side {
        Color::White => {
            board_has_pawn(board, Color::White, 3, 3) // d4
                && board_has_pawn(board, Color::White, 4, 4) // e5
                && board_has_pawn(board, Color::Black, 3, 4) // d5
                && board_has_pawn(board, Color::Black, 4, 5) // e6
        }
        Color::Black => {
            board_has_pawn(board, Color::Black, 3, 4) // d5
                && board_has_pawn(board, Color::Black, 4, 5) // e6
                && board_has_pawn(board, Color::White, 3, 3) // d4
                && board_has_pawn(board, Color::White, 4, 4) // e5
        }
    }
}

fn detect_kid_locked_center_for_side(board: &Board, side: Color) -> bool {
    match side {
        Color::Black => {
            board_has_pawn(board, Color::Black, 3, 5) // d6
                && board_has_pawn(board, Color::Black, 4, 4) // e5
                && board_has_pawn(board, Color::Black, 6, 5) // g6
                && board_has_pawn(board, Color::White, 3, 4) // d5
                && board_has_pawn(board, Color::White, 4, 3) // e4
                && board_has_pawn(board, Color::White, 2, 3) // c4
        }
        Color::White => {
            board_has_pawn(board, Color::White, 3, 2) // d3
                && board_has_pawn(board, Color::White, 4, 3) // e4
                && board_has_pawn(board, Color::White, 6, 2) // g3
                && board_has_pawn(board, Color::Black, 3, 3) // d4
                && board_has_pawn(board, Color::Black, 4, 4) // e5
                && board_has_pawn(board, Color::Black, 2, 4) // c5
        }
    }
}

fn detect_hanging_pawns_for_side(board: &Board, side: Color) -> bool {
    if !board_has_pawn_on_file(board, side, 2) || !board_has_pawn_on_file(board, side, 3) {
        return false;
    }
    // Classic hanging pawns gate: c/d duo with no direct b/e pawn support.
    if board_has_pawn_on_file(board, side, 1) || board_has_pawn_on_file(board, side, 4) {
        return false;
    }

    let c_ranks = pawn_ranks_on_file(board, side, 2);
    let d_ranks = pawn_ranks_on_file(board, side, 3);
    let connected = c_ranks
        .iter()
        .any(|cr| d_ranks.iter().any(|dr| cr.abs_diff(*dr) <= 1));
    if !connected {
        return false;
    }

    match side {
        Color::White => c_ranks.iter().any(|r| *r >= 3) && d_ranks.iter().any(|r| *r >= 3),
        Color::Black => c_ranks.iter().any(|r| *r <= 4) && d_ranks.iter().any(|r| *r <= 4),
    }
}

fn detect_stonewall_for_side(board: &Board, side: Color) -> bool {
    match side {
        Color::White => {
            board_has_pawn(board, Color::White, 3, 3) // d4
                && board_has_pawn(board, Color::White, 4, 2) // e3
                && board_has_pawn(board, Color::White, 5, 3) // f4
                && (board_has_pawn(board, Color::White, 2, 2) // c3
                    || board_has_pawn(board, Color::White, 2, 3)) // c4
        }
        Color::Black => {
            board_has_pawn(board, Color::Black, 3, 4) // d5
                && board_has_pawn(board, Color::Black, 4, 5) // e6
                && board_has_pawn(board, Color::Black, 5, 4) // f5
                && (board_has_pawn(board, Color::Black, 2, 5) // c6
                    || board_has_pawn(board, Color::Black, 2, 4)) // c5
        }
    }
}

fn detect_grunfeld_broad_center_for_side(board: &Board, side: Color) -> bool {
    let white_broad_center = board_has_pawn(board, Color::White, 2, 3) // c4
        && board_has_pawn(board, Color::White, 3, 3) // d4
        && board_has_pawn(board, Color::White, 4, 3); // e4
    let black_hypermodern_shell = board_has_pawn(board, Color::Black, 6, 5); // g6
    let black_d5 = board_has_pawn(board, Color::Black, 3, 4); // d5
    let black_not_kid_lock = !board_has_pawn(board, Color::Black, 4, 4); // avoid e5 KID lock

    match side {
        Color::White => {
            white_broad_center && black_hypermodern_shell && black_not_kid_lock && !black_d5
        }
        Color::Black => {
            white_broad_center && black_hypermodern_shell && black_not_kid_lock && black_d5
        }
    }
}

fn opening_family_in(row: &WeaknessAggregationInputRow, accepted: &[&str]) -> bool {
    let Some(family_raw) = row.opening_family.as_deref() else {
        return true;
    };
    let family = family_raw.trim().to_ascii_lowercase();
    if family.is_empty() {
        return true;
    }
    accepted.iter().any(|value| family == *value)
}

fn structure_flags_for_bucket(board: &Board, profile_color: Color) -> Value {
    let profile = profile_color;
    let opp = opponent(profile);

    let white_maroczy = detect_real_maroczy_bind(board, Color::White);
    let black_maroczy = detect_real_maroczy_bind(board, Color::Black);

    let vs_hedgehog = match opp {
        Color::Black => {
            board_has_pawn(board, opp, 0, 5)
                && board_has_pawn(board, opp, 1, 5)
                && board_has_pawn(board, opp, 3, 5)
                && board_has_pawn(board, opp, 4, 5)
        }
        Color::White => {
            board_has_pawn(board, opp, 0, 2)
                && board_has_pawn(board, opp, 1, 2)
                && board_has_pawn(board, opp, 3, 2)
                && board_has_pawn(board, opp, 4, 2)
        }
    };

    let profile_dragon = detect_classical_dragon_for_side(board, profile);
    let vs_dragon = detect_classical_dragon_for_side(board, opp);
    let profile_dragon_accelerated = detect_accelerated_dragon_for_side(board, profile);
    let vs_dragon_accelerated = detect_accelerated_dragon_for_side(board, opp);
    let profile_iqp = detect_iqp(board, profile);
    let vs_iqp = detect_iqp(board, opp);
    let profile_carlsbad = detect_carlsbad_for_side(board, profile);
    let vs_carlsbad = detect_carlsbad_for_side(board, opp);
    let profile_french_chain = detect_french_chain_for_side(board, profile);
    let vs_french_chain = detect_french_chain_for_side(board, opp);
    let profile_hanging_pawns = detect_hanging_pawns_for_side(board, profile);
    let vs_hanging_pawns = detect_hanging_pawns_for_side(board, opp);
    let profile_stonewall = detect_stonewall_for_side(board, profile);
    let vs_stonewall = detect_stonewall_for_side(board, opp);
    let profile_kid_locked_center = detect_kid_locked_center_for_side(board, profile);
    let vs_kid_locked_center = detect_kid_locked_center_for_side(board, opp);
    let profile_grunfeld_broad_center = detect_grunfeld_broad_center_for_side(board, profile);
    let vs_grunfeld_broad_center = detect_grunfeld_broad_center_for_side(board, opp);

    let vs_benoni = match (profile, opp) {
        (Color::White, Color::Black) => {
            board_has_pawn(board, opp, 2, 4)
                && board_has_pawn(board, opp, 3, 5)
                && board_has_pawn(board, profile, 3, 4)
        }
        (Color::Black, Color::White) => {
            board_has_pawn(board, opp, 2, 3)
                && board_has_pawn(board, opp, 3, 2)
                && board_has_pawn(board, profile, 3, 3)
        }
        _ => false,
    };

    // Profile-side fianchetto setup (rough strategic proxy).
    let profile_fianchetto = match profile {
        Color::White => {
            board_has_pawn(board, Color::White, 6, 2)
                && board_has_pawn(board, Color::White, 5, 1)
                && board_has_pawn(board, Color::White, 7, 1)
        }
        Color::Black => {
            board_has_pawn(board, Color::Black, 6, 5)
                && board_has_pawn(board, Color::Black, 5, 6)
                && board_has_pawn(board, Color::Black, 7, 6)
        }
    };

    // Opponent dragon setup (common practical tactical motif).
    let opponent_dragon = match opp {
        Color::White => {
            board_has_pawn(board, Color::White, 6, 2)
                && board_has_pawn(board, Color::White, 2, 3)
                && board_has_pawn(board, Color::White, 3, 2)
        }
        Color::Black => {
            board_has_pawn(board, Color::Black, 6, 5)
                && board_has_pawn(board, Color::Black, 2, 4)
                && board_has_pawn(board, Color::Black, 3, 5)
        }
    };

    let profile_maroczy = match profile {
        Color::White => white_maroczy,
        Color::Black => black_maroczy,
    };
    let vs_maroczy = match profile {
        Color::White => black_maroczy,
        Color::Black => white_maroczy,
    };

    json!({
        "profileMaroczy": profile_maroczy,
        "vsMaroczy": vs_maroczy,
        "vsHedgehog": vs_hedgehog,
        "profileDragon": profile_dragon,
        "vsDragon": vs_dragon,
        "profileDragonAccelerated": profile_dragon_accelerated,
        "vsDragonAccelerated": vs_dragon_accelerated,
        "profileIqp": profile_iqp,
        "vsIqp": vs_iqp,
        "profileCarlsbad": profile_carlsbad,
        "vsCarlsbad": vs_carlsbad,
        "profileFrenchChain": profile_french_chain,
        "vsFrenchChain": vs_french_chain,
        "profileHangingPawns": profile_hanging_pawns,
        "vsHangingPawns": vs_hanging_pawns,
        "profileStonewall": profile_stonewall,
        "vsStonewall": vs_stonewall,
        "profileKidLockedCenter": profile_kid_locked_center,
        "vsKidLockedCenter": vs_kid_locked_center,
        "profileGrunfeldBroadCenter": profile_grunfeld_broad_center,
        "vsGrunfeldBroadCenter": vs_grunfeld_broad_center,
        "vsBenoni": vs_benoni,
        "profileFianchetto": profile_fianchetto,
        "opponentDragon": opponent_dragon
    })
}

pub fn compute_weakness_features_v1(
    initial_fen: &str,
    moves: &[String],
    profile_color: Color,
    time_control: Option<&str>,
    eco: Option<&str>,
    game_ply_count: Option<i32>,
) -> Result<ComputedWeaknessFeaturesV1> {
    let fen = Fen::from_ascii(initial_fen.as_bytes())?;
    let mut pos: Chess = fen.into_position(CastlingMode::Chess960)?;

    let profile_target_h = match profile_color {
        Color::White => "h2".parse::<Square>().ok(),
        Color::Black => "h7".parse::<Square>().ok(),
    };
    let profile_target_f = match profile_color {
        Color::White => "f3".parse::<Square>().ok(),
        Color::Black => "f6".parse::<Square>().ok(),
    };

    let mut white_castle: Option<(CastleSide, i32)> = None;
    let mut black_castle: Option<(CastleSide, i32)> = None;
    let mut white_first_rook_move_ply: Option<i32> = None;
    let mut black_first_rook_move_ply: Option<i32> = None;
    let mut rooks_connected_by_ply18: Option<bool> = None;
    let mut rooks_connected_by_ply20: Option<bool> = None;
    let mut open_file_delta_ply20: Option<i32> = None;
    let mut semi_open_file_delta_ply20: Option<i32> = None;
    let mut pressure_h_ply: Option<i32> = None;
    let mut pressure_f_ply: Option<i32> = None;
    let mut capture_h_ply: Option<i32> = None;
    let mut capture_f_ply: Option<i32> = None;

    let mut bucket_features = serde_json::Map::new();
    let bucket_set = [5i32, 8, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 25, 30, 32];

    for (idx, m) in moves.iter().enumerate() {
        let ply = (idx as i32) + 1;
        let mover = pos.turn();
        let before = pos.board().clone();

        let uci = UciMove::from_ascii(m.as_bytes()).map_err(|_| {
            Error::PackageManager(format!("Invalid UCI move in weakness features: {m}"))
        })?;
        let mv = uci.to_move(&pos).map_err(|_| {
            Error::PackageManager(format!("Illegal move in weakness features: {m}"))
        })?;

        if let Some(side) = detect_castle_move(mover, mv.role(), mv.from(), mv.to()) {
            match mover {
                Color::White => {
                    if white_castle.is_none() {
                        white_castle = Some((side, ply));
                    }
                }
                Color::Black => {
                    if black_castle.is_none() {
                        black_castle = Some((side, ply));
                    }
                }
            }
        }

        if mv.role() == Role::Rook {
            match mover {
                Color::White => {
                    if white_first_rook_move_ply.is_none() {
                        white_first_rook_move_ply = Some(ply);
                    }
                }
                Color::Black => {
                    if black_first_rook_move_ply.is_none() {
                        black_first_rook_move_ply = Some(ply);
                    }
                }
            }
        }

        if mover == opponent(profile_color) {
            if let Some(target_h) = profile_target_h {
                if capture_h_ply.is_none()
                    && mv.to() == target_h
                    && before
                        .piece_at(target_h)
                        .map(|p| p.color == profile_color)
                        .unwrap_or(false)
                {
                    capture_h_ply = Some(ply);
                }
            }

            if let Some(target_f) = profile_target_f {
                if capture_f_ply.is_none()
                    && mv.to() == target_f
                    && before
                        .piece_at(target_f)
                        .map(|p| p.color == profile_color)
                        .unwrap_or(false)
                {
                    capture_f_ply = Some(ply);
                }
            }
        }

        pos.play_unchecked(&mv);

        let after = pos.board();
        if mover == opponent(profile_color) {
            if pressure_h_ply.is_none() {
                if let Some(target_h) = profile_target_h {
                    if is_square_attacked_by_color(after, mover, target_h)
                        && after
                            .piece_at(target_h)
                            .map(|p| p.color == profile_color)
                            .unwrap_or(false)
                    {
                        pressure_h_ply = Some(ply);
                    }
                }
            }

            if pressure_f_ply.is_none() {
                if let Some(target_f) = profile_target_f {
                    if is_square_attacked_by_color(after, mover, target_f)
                        && after
                            .piece_at(target_f)
                            .map(|p| p.color == profile_color)
                            .unwrap_or(false)
                    {
                        pressure_f_ply = Some(ply);
                    }
                }
            }
        }

        if ply == 18 {
            rooks_connected_by_ply18 = Some(rooks_connected(after, profile_color));
        }
        if ply == 20 {
            rooks_connected_by_ply20 = Some(rooks_connected(after, profile_color));
            open_file_delta_ply20 = Some(open_file_control_delta(after, profile_color));
            semi_open_file_delta_ply20 = Some(semi_open_file_control_delta(after, profile_color));
        }

        if bucket_set.contains(&ply) {
            let profile_castled_ply = match profile_color {
                Color::White => white_castle.map(|(_, p)| p),
                Color::Black => black_castle.map(|(_, p)| p),
            };
            let opp_castled_ply = match profile_color {
                Color::White => black_castle.map(|(_, p)| p),
                Color::Black => white_castle.map(|(_, p)| p),
            };

            let profile_side = match profile_color {
                Color::White => white_castle.map(|(s, _)| s),
                Color::Black => black_castle.map(|(s, _)| s),
            };
            let opp_side = match profile_color {
                Color::White => black_castle.map(|(s, _)| s),
                Color::Black => white_castle.map(|(s, _)| s),
            };

            let opposite_castled = profile_castled_ply.map(|p| p <= ply).unwrap_or(false)
                && opp_castled_ply.map(|p| p <= ply).unwrap_or(false)
                && profile_side.is_some()
                && opp_side.is_some()
                && profile_side != opp_side;

            bucket_features.insert(
                ply.to_string(),
                json!({
                    "uncastledProfile": profile_castled_ply.map(|p| p > ply).unwrap_or(true),
                    "rooksConnected": rooks_connected(after, profile_color),
                    "openFileControlDelta": open_file_control_delta(after, profile_color),
                    "semiOpenFileControlDelta": semi_open_file_control_delta(after, profile_color),
                    "oppositeSideCastling": opposite_castled,
                    "hTargetPressureSeen": pressure_h_ply.map(|p| p <= ply).unwrap_or(false),
                    "fTargetPressureSeen": pressure_f_ply.map(|p| p <= ply).unwrap_or(false),
                    "structures": structure_flags_for_bucket(after, profile_color),
                }),
            );
        }

        if pos.is_game_over() {
            break;
        }
    }

    let total_ply = game_ply_count
        .unwrap_or(moves.len() as i32)
        .max(moves.len() as i32);
    let profile_castle = match profile_color {
        Color::White => white_castle,
        Color::Black => black_castle,
    };
    let opp_castle = match profile_color {
        Color::White => black_castle,
        Color::Black => white_castle,
    };
    let profile_first_rook_ply = match profile_color {
        Color::White => white_first_rook_move_ply,
        Color::Black => black_first_rook_move_ply,
    };

    let profile_castle_side = profile_castle.map(|(s, _)| s.as_str().to_string());
    let profile_castle_ply = profile_castle.map(|(_, p)| p);
    let opp_castle_side = opp_castle.map(|(s, _)| s.as_str().to_string());
    let opp_castle_ply = opp_castle.map(|(_, p)| p);
    let opposite_side_castling = profile_castle
        .and_then(|(ps, pp)| opp_castle.map(|(os, op)| (ps, pp, os, op)))
        .map(|(ps, _pp, os, _op)| ps != os)
        .unwrap_or(false);

    let rooks_connected_final = rooks_connected(pos.board(), profile_color);
    let open_file_delta_final = open_file_control_delta(pos.board(), profile_color);
    let semi_open_file_delta_final = semi_open_file_control_delta(pos.board(), profile_color);

    Ok(ComputedWeaknessFeaturesV1 {
        opening_family: opening_family_from_eco(eco),
        time_control_bucket: classify_time_control_bucket(time_control),
        color_played: match profile_color {
            Color::White => "white".to_string(),
            Color::Black => "black".to_string(),
        },
        ply_bucket_features_json: Value::Object(bucket_features),
        features_json: json!({
            "version": WEAKNESS_MODEL_VERSION_V1,
            "gameLengthPly": total_ply,
            "longEndgame": total_ply >= 40,
            "castling": {
                "profileSide": profile_castle_side,
                "profilePly": profile_castle_ply,
                "opponentSide": opp_castle_side,
                "opponentPly": opp_castle_ply,
                "uncastledByPly12": profile_castle_ply.map(|p| p > 12).unwrap_or(true),
                "uncastledByPly15": profile_castle_ply.map(|p| p > 15).unwrap_or(true),
                "oppositeSideCastling": opposite_side_castling,
            },
            "rookActivity": {
                "firstRookActivationPly": profile_first_rook_ply,
                "rooksConnectedByPly18": rooks_connected_by_ply18.unwrap_or(rooks_connected_final),
                "rooksConnectedByPly20": rooks_connected_by_ply20
                    .or(rooks_connected_by_ply18)
                    .unwrap_or(rooks_connected_final),
                "rooksConnectedFinal": rooks_connected_final,
            },
            "fileControl": {
                "openFileControlDeltaPly20": open_file_delta_ply20.unwrap_or(open_file_delta_final),
                "semiOpenFileControlDeltaPly20": semi_open_file_delta_ply20.unwrap_or(semi_open_file_delta_final),
                "openFileControlDeltaFinal": open_file_delta_final,
                "semiOpenFileControlDeltaFinal": semi_open_file_delta_final,
            },
            "pressureTargets": {
                "hTarget": match profile_color { Color::White => "h2", Color::Black => "h7" },
                "fTarget": match profile_color { Color::White => "f3", Color::Black => "f6" },
                "hTargetPressurePly": pressure_h_ply,
                "fTargetPressurePly": pressure_f_ply,
                "hTargetCapturePly": capture_h_ply,
                "fTargetCapturePly": capture_f_ply,
            }
        }),
    })
}

pub fn upsert_weakness_game_features(
    db: &mut SqliteConnection,
    row: &WeaknessGameFeaturesUpsert,
) -> Result<()> {
    ensure_profile_weakness_tables(db)?;

    let ply_bucket_features_json =
        serde_json::to_string(&row.ply_bucket_features_json).unwrap_or_else(|_| "{}".to_string());
    let features_json =
        serde_json::to_string(&row.features_json).unwrap_or_else(|_| "{}".to_string());

    sql_query(
        r#"
        INSERT INTO WeaknessGameFeatures (
            GameID, ModelVersion, ComputedAt, OpeningFamily, TimeControlBucket, ColorPlayed,
            PlyBucketFeaturesJson, FeaturesJson, UpdatedAt
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP)
        ON CONFLICT(GameID) DO UPDATE SET
            ModelVersion=excluded.ModelVersion,
            ComputedAt=excluded.ComputedAt,
            OpeningFamily=excluded.OpeningFamily,
            TimeControlBucket=excluded.TimeControlBucket,
            ColorPlayed=excluded.ColorPlayed,
            PlyBucketFeaturesJson=excluded.PlyBucketFeaturesJson,
            FeaturesJson=excluded.FeaturesJson,
            UpdatedAt=CURRENT_TIMESTAMP
        "#,
    )
    .bind::<Integer, _>(row.game_id)
    .bind::<Integer, _>(row.model_version)
    .bind::<Text, _>(&row.computed_at)
    .bind::<Nullable<Text>, _>(row.opening_family.as_deref())
    .bind::<Nullable<Text>, _>(row.time_control_bucket.as_deref())
    .bind::<Nullable<Text>, _>(row.color_played.as_deref())
    .bind::<Text, _>(&ply_bucket_features_json)
    .bind::<Text, _>(&features_json)
    .execute(db)?;

    Ok(())
}

pub fn replace_weakness_snapshot(
    db: &mut SqliteConnection,
    snapshot_key: &str,
    model_version: i32,
    generated_at: &str,
    filters_json: &Value,
    signals: &[WeaknessSignalSnapshotUpsert],
    evidence: &[WeaknessEvidenceUpsert],
) -> Result<()> {
    ensure_profile_weakness_tables(db)?;

    let filters_json_s = serde_json::to_string(filters_json).unwrap_or_else(|_| "{}".to_string());

    db.transaction::<_, Error, _>(|tx| {
        sql_query("DELETE FROM WeaknessEvidence WHERE SnapshotKey = ?1")
            .bind::<Text, _>(snapshot_key)
            .execute(tx)?;

        sql_query("DELETE FROM WeaknessSignalSnapshot WHERE SnapshotKey = ?1")
            .bind::<Text, _>(snapshot_key)
            .execute(tx)?;

        for signal in signals {
            let impact_json_s =
                serde_json::to_string(&signal.impact_json).unwrap_or_else(|_| "{}".to_string());
            let trigger_json_s =
                serde_json::to_string(&signal.trigger_json).unwrap_or_else(|_| "{}".to_string());

            sql_query(
                r#"
                INSERT INTO WeaknessSignalSnapshot (
                    SnapshotKey, SignalKey, ModelVersion, GeneratedAt, FiltersJson,
                    Title, TriggerText, AttackPlan, Score, Severity, Confidence,
                    Controllability, Recency, Support, NEff, ImpactJson, TriggerJson, UpdatedAt
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, CURRENT_TIMESTAMP)
                "#,
            )
            .bind::<Text, _>(snapshot_key)
            .bind::<Text, _>(&signal.signal_key)
            .bind::<Integer, _>(model_version)
            .bind::<Text, _>(generated_at)
            .bind::<Text, _>(&filters_json_s)
            .bind::<Text, _>(&signal.title)
            .bind::<Text, _>(&signal.trigger_text)
            .bind::<Text, _>(&signal.attack_plan)
            .bind::<Double, _>(signal.score)
            .bind::<Double, _>(signal.severity)
            .bind::<Double, _>(signal.confidence)
            .bind::<Double, _>(signal.controllability)
            .bind::<Double, _>(signal.recency)
            .bind::<Integer, _>(signal.support)
            .bind::<Nullable<Double>, _>(signal.n_eff)
            .bind::<Text, _>(&impact_json_s)
            .bind::<Text, _>(&trigger_json_s)
            .execute(tx)?;
        }

        for ev in evidence {
            let evidence_json_s =
                serde_json::to_string(&ev.evidence_json).unwrap_or_else(|_| "{}".to_string());

            sql_query(
                r#"
                INSERT INTO WeaknessEvidence (
                    SnapshotKey, SignalKey, EvidenceRank, GameID, PlyFrom, PlyTo, EvidenceText, EvidenceJson
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                "#,
            )
            .bind::<Text, _>(snapshot_key)
            .bind::<Text, _>(&ev.signal_key)
            .bind::<Integer, _>(ev.evidence_rank)
            .bind::<Nullable<Integer>, _>(ev.game_id)
            .bind::<Nullable<Integer>, _>(ev.ply_from)
            .bind::<Nullable<Integer>, _>(ev.ply_to)
            .bind::<Text, _>(&ev.evidence_text)
            .bind::<Text, _>(&evidence_json_s)
            .execute(tx)?;
        }

        Ok(())
    })?;

    Ok(())
}

pub fn get_weakness_signals(
    db: &mut SqliteConnection,
    snapshot_key: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<WeaknessSignalSnapshotRow>> {
    ensure_profile_weakness_tables(db)?;

    let rows = sql_query(
        r#"
        SELECT
            SnapshotKey, SignalKey, ModelVersion, GeneratedAt, FiltersJson,
            Title, TriggerText, AttackPlan, Score, Severity, Confidence,
            Controllability, Recency, Support, NEff, ImpactJson, TriggerJson
        FROM WeaknessSignalSnapshot
        WHERE SnapshotKey = ?1
        ORDER BY Score DESC, SignalKey ASC
        LIMIT ?2 OFFSET ?3
        "#,
    )
    .bind::<Text, _>(snapshot_key)
    .bind::<Integer, _>(limit as i32)
    .bind::<Integer, _>(offset as i32)
    .load::<WeaknessSignalSnapshotRow>(db)?;

    Ok(rows)
}

pub fn get_weakness_evidence(
    db: &mut SqliteConnection,
    snapshot_key: &str,
    signal_key: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<WeaknessEvidenceRow>> {
    ensure_profile_weakness_tables(db)?;

    let rows = sql_query(
        r#"
        SELECT
            SnapshotKey, SignalKey, EvidenceRank, GameID, PlyFrom, PlyTo, EvidenceText, EvidenceJson
        FROM WeaknessEvidence
        WHERE SnapshotKey = ?1 AND SignalKey = ?2
        ORDER BY EvidenceRank ASC
        LIMIT ?3 OFFSET ?4
        "#,
    )
    .bind::<Text, _>(snapshot_key)
    .bind::<Text, _>(signal_key)
    .bind::<Integer, _>(limit as i32)
    .bind::<Integer, _>(offset as i32)
    .load::<WeaknessEvidenceRow>(db)?;

    Ok(rows)
}

#[derive(Debug, Clone)]
pub struct WeaknessAggregationInputRow {
    pub game_id: i32,
    pub timestamp_ms: Option<i64>,
    pub profile_outcome: Option<String>, // "win" | "draw" | "loss" | "unknown"
    pub opponent_name: Option<String>,
    pub accuracy: Option<f64>,
    pub acpl: Option<f64>,
    pub blunder_rate: Option<f64>,
    pub mistake_rate: Option<f64>,
    pub inaccuracy_rate: Option<f64>,
    pub estimated_elo: Option<i64>,
    pub opening_family: Option<String>,
    pub time_control_bucket: Option<String>,
    pub color_played: Option<String>,
    pub game_length_ply: Option<i32>,
    pub ply_bucket_features_json: Value,
    pub features_json: Value,
}

#[derive(Debug, Clone)]
pub struct WeaknessSnapshotBuildResult {
    pub total_games: i32,
    pub scored_games: i32,
    pub signals: Vec<WeaknessSignalSnapshotUpsert>,
    pub evidence: Vec<WeaknessEvidenceUpsert>,
}

#[derive(Debug, Clone)]
struct SignalHit {
    row_index: usize,
    ply_from: Option<i32>,
    ply_to: Option<i32>,
    trigger_payload: Value,
}

#[derive(Debug, Clone)]
struct StagedSignalCandidate {
    signal: WeaknessSignalSnapshotUpsert,
    evidence: Vec<WeaknessEvidenceUpsert>,
    hit_game_ids: HashSet<i32>,
    portfolio_cluster: &'static str,
}

#[derive(Debug, Clone, Default)]
struct MetricAggregate {
    loss_sum: f64,
    loss_count: usize,
    acpl_sum: f64,
    acpl_count: usize,
    acc_sum: f64,
    acc_count: usize,
    blunder_sum: f64,
    blunder_count: usize,
    mistake_sum: f64,
    mistake_count: usize,
    inaccuracy_sum: f64,
    inaccuracy_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SignalColorPerspective {
    White,
    Black,
    Mixed,
}

impl SignalColorPerspective {
    fn as_str(self) -> &'static str {
        match self {
            Self::White => "white",
            Self::Black => "black",
            Self::Mixed => "mixed",
        }
    }
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = value;
    for key in path {
        cur = cur.get(*key)?;
    }
    Some(cur)
}

fn value_bool(value: &Value, path: &[&str]) -> Option<bool> {
    value_at_path(value, path)?.as_bool()
}

fn value_i64(value: &Value, path: &[&str]) -> Option<i64> {
    value_at_path(value, path)?.as_i64()
}

fn value_str(value: &Value, path: &[&str]) -> Option<String> {
    value_at_path(value, path)?.as_str().map(|v| v.to_string())
}

fn bucket_bool(value: &Value, ply: i32, path: &[&str]) -> Option<bool> {
    let key = ply.to_string();
    let bucket = value.get(&key)?;
    value_bool(bucket, path)
}

fn clamp01(v: f64) -> f64 {
    v.max(0.0).min(1.0)
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn option_round2(v: Option<f64>) -> Option<f64> {
    v.map(round2)
}

fn sort_signals_by_score_desc(signals: &mut [ProfileWeaknessSignal]) {
    signals.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.signal_key.cmp(&b.signal_key))
    });
}

fn normalize_signal_key(signal_key: &str) -> &str {
    if signal_key == "WM_MAROCCZY_10_15" {
        "WM_MAROCZY_10_15"
    } else {
        signal_key
    }
}

fn mean(sum: f64, count: usize) -> Option<f64> {
    if count == 0 {
        None
    } else {
        Some(sum / count as f64)
    }
}

fn accumulate_metrics(agg: &mut MetricAggregate, row: &WeaknessAggregationInputRow) {
    if let Some(outcome) = row.profile_outcome.as_deref() {
        if !outcome.eq_ignore_ascii_case("unknown") {
            agg.loss_sum += if outcome.eq_ignore_ascii_case("loss") {
                1.0
            } else {
                0.0
            };
            agg.loss_count += 1;
        }
    }

    if let Some(v) = row.acpl {
        if v.is_finite() {
            agg.acpl_sum += v;
            agg.acpl_count += 1;
        }
    }

    if let Some(v) = row.accuracy {
        if v.is_finite() {
            agg.acc_sum += v;
            agg.acc_count += 1;
        }
    }

    if let Some(v) = row.blunder_rate {
        if v.is_finite() && v >= 0.0 {
            agg.blunder_sum += v;
            agg.blunder_count += 1;
        }
    }

    if let Some(v) = row.mistake_rate {
        if v.is_finite() && v >= 0.0 {
            agg.mistake_sum += v;
            agg.mistake_count += 1;
        }
    }

    if let Some(v) = row.inaccuracy_rate {
        if v.is_finite() && v >= 0.0 {
            agg.inaccuracy_sum += v;
            agg.inaccuracy_count += 1;
        }
    }
}

fn normalized_context_token(value: &Option<String>) -> String {
    let raw = value
        .as_deref()
        .unwrap_or("any")
        .trim()
        .to_ascii_lowercase();
    if raw.is_empty() {
        "any".to_string()
    } else {
        raw
    }
}

fn row_context_key(row: &WeaknessAggregationInputRow) -> String {
    let color = normalized_context_token(&row.color_played);
    let tc = normalized_context_token(&row.time_control_bucket);
    let opening = normalized_context_token(&row.opening_family);
    format!("color:{color}|tc:{tc}|opening:{opening}")
}

fn color_perspective_from_hits(
    rows: &[WeaknessAggregationInputRow],
    hits: &[SignalHit],
) -> (SignalColorPerspective, usize, usize) {
    let mut white_hits = 0usize;
    let mut black_hits = 0usize;
    for hit in hits {
        match rows[hit.row_index]
            .color_played
            .as_deref()
            .map(|v| v.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("white") => white_hits += 1,
            Some("black") => black_hits += 1,
            _ => {}
        }
    }

    let perspective = if white_hits == 0 && black_hits == 0 {
        SignalColorPerspective::Mixed
    } else if white_hits >= black_hits + 2 {
        SignalColorPerspective::White
    } else if black_hits >= white_hits + 2 {
        SignalColorPerspective::Black
    } else {
        SignalColorPerspective::Mixed
    };

    (perspective, white_hits, black_hits)
}

fn confidence_band(confidence: f64, support: usize) -> &'static str {
    if support >= 60 && confidence >= 0.75 {
        "high"
    } else if support >= 20 && confidence >= 0.45 {
        "medium"
    } else {
        "low"
    }
}

fn support_weight_from_support(support: usize) -> f64 {
    if support <= MIN_SIGNAL_SUPPORT {
        return 0.55;
    }
    let extra = (support - MIN_SIGNAL_SUPPORT) as f64;
    let ramp = clamp01(extra / 60.0).sqrt();
    0.55 + 0.45 * ramp
}

fn context_weight_from_rows(context_baseline_rows: usize, support: usize) -> f64 {
    if support == 0 {
        return 0.0;
    }
    let ratio = (context_baseline_rows as f64) / ((support as f64) * 2.0);
    clamp01(ratio.sqrt())
}

fn wilson_interval(successes: usize, n: usize) -> Option<(f64, f64)> {
    if n == 0 {
        return None;
    }
    let z = 1.959_963_984_540_054_f64; // 95% CI
    let z2 = z * z;
    let n_f = n as f64;
    let s = successes.min(n) as f64;
    let phat = s / n_f;
    let denom = 1.0 + z2 / n_f;
    let center = (phat + z2 / (2.0 * n_f)) / denom;
    let margin = (z * ((phat * (1.0 - phat) + z2 / (4.0 * n_f)) / n_f).sqrt()) / denom;
    Some((clamp01(center - margin), clamp01(center + margin)))
}

fn signal_controllability(signal_key: &str) -> f64 {
    let signal_key = normalize_signal_key(signal_key);
    match signal_key {
        "WM_UNCASTLED_EARLY" => 0.85,
        "WM_LATE_ROOK_CONNECTION" => 0.85,
        "WM_NO_ROOK_ACTIVATION_20" => 0.85,
        "WM_OPEN_FILE_CONTROL_LOSS" => 0.85,
        "WM_SEMIOPEN_FILE_CONTROL_LOSS" => 0.80,
        "WM_H7_H2_PRESSURE_DAMAGE" => 0.70,
        "WM_F3_F6_PRESSURE_DAMAGE" => 0.70,
        "WM_OPPOSITE_CASTLING_COLLAPSE" => 0.65,
        "WM_LONG_ENDGAME_CONVERSION" => 0.55,
        "WM_MAROCZY_10_15" => 0.70,
        "WM_VS_DRAGON_10_18" => 0.72,
        "WM_IQP_12_30" => 0.74,
        "WM_CARLSBAD_12_32" => 0.76,
        "WM_HANGING_PAWNS_12_30" => 0.73,
        "WM_STONEWALL_10_25" => 0.69,
        "WM_VS_BENONI_10_25" => 0.71,
        "WM_VS_ACCELERATED_DRAGON_8_16" => 0.71,
        "WM_FRENCH_CHAIN_8_22" => 0.68,
        "WM_KID_LOCKED_CENTER_10_25" => 0.66,
        "WM_GRUNFELD_BROAD_CENTER_8_18" => 0.69,
        _ => 0.55,
    }
}

fn signal_priority_weight(signal_key: &str) -> f64 {
    let signal_key = normalize_signal_key(signal_key);
    match signal_key {
        "WM_NO_ROOK_ACTIVATION_20" => 1.12,
        "WM_OPEN_FILE_CONTROL_LOSS" => 1.10,
        "WM_SEMIOPEN_FILE_CONTROL_LOSS" => 1.08,
        "WM_OPPOSITE_CASTLING_COLLAPSE" => 1.08,
        "WM_H7_H2_PRESSURE_DAMAGE" => 1.10,
        "WM_F3_F6_PRESSURE_DAMAGE" => 1.10,
        "WM_VS_DRAGON_10_18" => 1.05,
        "WM_IQP_12_30" => 1.07,
        "WM_CARLSBAD_12_32" => 1.06,
        "WM_HANGING_PAWNS_12_30" => 1.05,
        "WM_STONEWALL_10_25" => 1.03,
        "WM_VS_BENONI_10_25" => 1.04,
        "WM_VS_ACCELERATED_DRAGON_8_16" => 1.05,
        "WM_FRENCH_CHAIN_8_22" => 1.04,
        "WM_KID_LOCKED_CENTER_10_25" => 1.03,
        "WM_GRUNFELD_BROAD_CENTER_8_18" => 1.04,
        _ => 1.0,
    }
}

fn signal_portfolio_cluster(signal_key: &str) -> &'static str {
    let signal_key = normalize_signal_key(signal_key);
    match signal_key {
        "WM_UNCASTLED_EARLY" | "WM_LATE_ROOK_CONNECTION" | "WM_NO_ROOK_ACTIVATION_20" => {
            "rookDevelopment"
        }
        "WM_OPEN_FILE_CONTROL_LOSS" | "WM_SEMIOPEN_FILE_CONTROL_LOSS" => "fileControl",
        "WM_H7_H2_PRESSURE_DAMAGE"
        | "WM_F3_F6_PRESSURE_DAMAGE"
        | "WM_OPPOSITE_CASTLING_COLLAPSE" => "kingAttackDefense",
        "WM_LONG_ENDGAME_CONVERSION" => "endgameConversion",
        "WM_MAROCZY_10_15" | "WM_VS_DRAGON_10_18" | "WM_VS_ACCELERATED_DRAGON_8_16" => {
            "sicilianStructures"
        }
        "WM_IQP_12_30"
        | "WM_CARLSBAD_12_32"
        | "WM_HANGING_PAWNS_12_30"
        | "WM_STONEWALL_10_25"
        | "WM_VS_BENONI_10_25"
        | "WM_FRENCH_CHAIN_8_22"
        | "WM_KID_LOCKED_CENTER_10_25"
        | "WM_GRUNFELD_BROAD_CENTER_8_18" => "strategicStructures",
        "WM_FALLBACK_LOSS_CLUSTER" => "fallback",
        _ => "misc",
    }
}

fn signal_hit_game_ids(rows: &[WeaknessAggregationInputRow], hits: &[SignalHit]) -> HashSet<i32> {
    hits.iter().map(|hit| rows[hit.row_index].game_id).collect()
}

fn signal_evidence_game_ids(evidence_rows: &[WeaknessEvidenceUpsert]) -> HashSet<i32> {
    evidence_rows.iter().filter_map(|row| row.game_id).collect()
}

fn signal_overlap_ratio(a: &HashSet<i32>, b: &HashSet<i32>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let min_len = a.len().min(b.len()) as f64;
    let overlap = a.intersection(b).count() as f64;
    if min_len <= 0.0 {
        0.0
    } else {
        overlap / min_len
    }
}

fn is_redundant_portfolio_candidate(
    candidate: &StagedSignalCandidate,
    selected: &[StagedSignalCandidate],
) -> bool {
    selected.iter().any(|picked| {
        if candidate.portfolio_cluster != picked.portfolio_cluster {
            return false;
        }
        signal_overlap_ratio(&candidate.hit_game_ids, &picked.hit_game_ids)
            >= PORTFOLIO_OVERLAP_THRESHOLD
    })
}

fn select_signal_portfolio(
    mut candidates: Vec<StagedSignalCandidate>,
    keep: usize,
) -> Vec<StagedSignalCandidate> {
    if candidates.len() <= 1 {
        return candidates;
    }

    candidates.sort_by(|a, b| {
        b.signal
            .score
            .partial_cmp(&a.signal.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.signal.signal_key.cmp(&b.signal.signal_key))
    });

    let mut selected: Vec<StagedSignalCandidate> = Vec::new();
    let mut deferred: Vec<StagedSignalCandidate> = Vec::new();

    for candidate in candidates {
        if selected.len() >= keep {
            break;
        }
        if is_redundant_portfolio_candidate(&candidate, &selected) {
            deferred.push(candidate);
        } else {
            selected.push(candidate);
        }
    }

    if selected.len() < keep {
        for candidate in deferred {
            if selected.len() >= keep {
                break;
            }
            selected.push(candidate);
        }
    }

    selected
}

fn signal_title(signal_key: &str, perspective: SignalColorPerspective) -> &'static str {
    let signal_key = normalize_signal_key(signal_key);
    match signal_key {
        "WM_UNCASTLED_EARLY" => "King Safety: Uncastled Early",
        "WM_LATE_ROOK_CONNECTION" => "Rook Activity: Late Activation by ply 20",
        "WM_NO_ROOK_ACTIVATION_20" => "Rook Activity: No Activation by ply 40",
        "WM_OPEN_FILE_CONTROL_LOSS" => "Open Files: Control Deficit",
        "WM_SEMIOPEN_FILE_CONTROL_LOSS" => "Semi-open Files: Control Deficit",
        "WM_H7_H2_PRESSURE_DAMAGE" => "Kingside Target: h-file Pressure Damage",
        "WM_F3_F6_PRESSURE_DAMAGE" => "Center-Kingside Target: f-file Pressure Damage",
        "WM_OPPOSITE_CASTLING_COLLAPSE" => "Opposite Castling: Race Collapse",
        "WM_LONG_ENDGAME_CONVERSION" => "Endgame: Long Conversion Drop",
        "WM_MAROCZY_10_15" => match perspective {
            SignalColorPerspective::White => {
                "Structure: Maroczy Window Stress as White (ply 10-15)"
            }
            SignalColorPerspective::Black => {
                "Structure: Maroczy Window Stress as Black (ply 10-15)"
            }
            SignalColorPerspective::Mixed => "Structure: Maroczy Window Stress (ply 10-15)",
        },
        "WM_VS_DRAGON_10_18" => match perspective {
            SignalColorPerspective::White => "Structure: Dragon Stress as White (ply 10-18)",
            SignalColorPerspective::Black => "Structure: Dragon Stress as Black (ply 10-18)",
            SignalColorPerspective::Mixed => "Structure: Dragon Stress (ply 10-18)",
        },
        "WM_IQP_12_30" => match perspective {
            SignalColorPerspective::White => "Structure: IQP Stress as White (ply 12-30)",
            SignalColorPerspective::Black => "Structure: IQP Stress as Black (ply 12-30)",
            SignalColorPerspective::Mixed => "Structure: IQP Stress (ply 12-30)",
        },
        "WM_CARLSBAD_12_32" => match perspective {
            SignalColorPerspective::White => "Structure: Carlsbad Stress as White (ply 12-32)",
            SignalColorPerspective::Black => "Structure: Carlsbad Stress as Black (ply 12-32)",
            SignalColorPerspective::Mixed => "Structure: Carlsbad Stress (ply 12-32)",
        },
        "WM_HANGING_PAWNS_12_30" => match perspective {
            SignalColorPerspective::White => "Structure: Hanging-Pawns Stress as White (ply 12-30)",
            SignalColorPerspective::Black => "Structure: Hanging-Pawns Stress as Black (ply 12-30)",
            SignalColorPerspective::Mixed => "Structure: Hanging-Pawns Stress (ply 12-30)",
        },
        "WM_STONEWALL_10_25" => match perspective {
            SignalColorPerspective::White => "Structure: Stonewall Stress as White (ply 10-25)",
            SignalColorPerspective::Black => "Structure: Stonewall Stress as Black (ply 10-25)",
            SignalColorPerspective::Mixed => "Structure: Stonewall Stress (ply 10-25)",
        },
        "WM_VS_BENONI_10_25" => match perspective {
            SignalColorPerspective::White => "Structure: Benoni Stress as White (ply 10-25)",
            SignalColorPerspective::Black => "Structure: Benoni Stress as Black (ply 10-25)",
            SignalColorPerspective::Mixed => "Structure: Benoni Stress (ply 10-25)",
        },
        "WM_VS_ACCELERATED_DRAGON_8_16" => match perspective {
            SignalColorPerspective::White => {
                "Structure: Accelerated Dragon Stress as White (ply 8-16)"
            }
            SignalColorPerspective::Black => {
                "Structure: Accelerated Dragon Stress as Black (ply 8-16)"
            }
            SignalColorPerspective::Mixed => "Structure: Accelerated Dragon Stress (ply 8-16)",
        },
        "WM_FRENCH_CHAIN_8_22" => match perspective {
            SignalColorPerspective::White => "Structure: French Chain Stress as White (ply 8-22)",
            SignalColorPerspective::Black => "Structure: French Chain Stress as Black (ply 8-22)",
            SignalColorPerspective::Mixed => "Structure: French Chain Stress (ply 8-22)",
        },
        "WM_KID_LOCKED_CENTER_10_25" => match perspective {
            SignalColorPerspective::White => {
                "Structure: KID Locked-Center Stress as White (ply 10-25)"
            }
            SignalColorPerspective::Black => {
                "Structure: KID Locked-Center Stress as Black (ply 10-25)"
            }
            SignalColorPerspective::Mixed => "Structure: KID Locked-Center Stress (ply 10-25)",
        },
        "WM_GRUNFELD_BROAD_CENTER_8_18" => match perspective {
            SignalColorPerspective::White => {
                "Structure: Grunfeld Broad-Center Stress as White (ply 8-18)"
            }
            SignalColorPerspective::Black => {
                "Structure: Grunfeld Broad-Center Stress as Black (ply 8-18)"
            }
            SignalColorPerspective::Mixed => "Structure: Grunfeld Broad-Center Stress (ply 8-18)",
        },
        _ => "Strategic Weakness",
    }
}

fn signal_attack_plan(signal_key: &str, perspective: SignalColorPerspective) -> &'static str {
    let signal_key = normalize_signal_key(signal_key);
    match signal_key {
        "WM_UNCASTLED_EARLY" => {
            "Accelerate development and force central pawn breaks before move 12 to punish king delay."
        }
        "WM_LATE_ROOK_CONNECTION" => {
            "Keep central tension, open one file by move 15-20, and contest rook entry squares before exchanges."
        }
        "WM_NO_ROOK_ACTIVATION_20" => {
            "If rook activation is delayed beyond ply 40, keep files closed for them and force passive rook defense."
        }
        "WM_OPEN_FILE_CONTROL_LOSS" => {
            "Trade central pawns to create open files, double rooks first, then invade the 7th rank."
        }
        "WM_SEMIOPEN_FILE_CONTROL_LOSS" => {
            "Fix a pawn target to create semi-open files and occupy them with heavy pieces before transitions."
        }
        "WM_H7_H2_PRESSURE_DAMAGE" => {
            "Build bishop-queen battery toward the h-target and keep attacking pieces to sustain tactical threats."
        }
        "WM_F3_F6_PRESSURE_DAMAGE" => {
            "Coordinate knight and bishop pressure on f-target squares and force defensive pawn concessions."
        }
        "WM_OPPOSITE_CASTLING_COLLAPSE" => {
            "Launch pawn storms on the castled wing while preserving central tension to keep both kings exposed."
        }
        "WM_LONG_ENDGAME_CONVERSION" => {
            "Steer into long technical endings, keep more pieces, and stretch play beyond 40 plies."
        }
        "WM_MAROCZY_10_15" => {
            match perspective {
                SignalColorPerspective::Black => {
                    "As Black vs Maroczy: prepare ...b5 and ...d5 breaks with full piece support (...a6, ...Rc8, ...Re8, ...Nxd4 ideas), avoid premature pawn breaks, and trade into positions that reduce white's space grip."
                }
                SignalColorPerspective::White => {
                    "As White vs Maroczy structures: keep pressure on d5/c5, limit counterplay with prophylaxis, and only commit central/queenside breaks when development and king safety are complete."
                }
                SignalColorPerspective::Mixed => {
                    "Against Maroczy structures: prioritize anti-bind plans by side (for Black: ...b5/...d5 preparation; for White: d5/c5 squeeze and prophylaxis)."
                }
            }
        }
        "WM_VS_DRAGON_10_18" => match perspective {
            SignalColorPerspective::Black => {
                "As Black vs Dragon structures: reduce kingside hooks, trade one attacker, and contest c-file before committing pawn races."
            }
            SignalColorPerspective::White => {
                "As White vs Dragon structures: pressure dark squares and d5, keep king safety first, and open c/d files only when heavy pieces are coordinated."
            }
            SignalColorPerspective::Mixed => {
                "Against Dragon setups: prioritize dark-square control, file pressure on c/d, and avoid premature opposite-wing pawn races."
            }
        },
        "WM_IQP_12_30" => match perspective {
            SignalColorPerspective::Black => {
                "As Black in IQP structures: blockade the isolated pawn square, exchange one minor piece pair, and avoid passive heavy-piece placement."
            }
            SignalColorPerspective::White => {
                "As White in IQP structures: keep dynamic piece activity, avoid mass simplification too early, and time central breaks before the IQP becomes static."
            }
            SignalColorPerspective::Mixed => {
                "In IQP structures: choose between dynamic activity and static blockade intentionally; avoid drifting into the wrong plan for your side."
            }
        },
        "WM_CARLSBAD_12_32" => match perspective {
            SignalColorPerspective::Black => {
                "As Black in Carlsbad structures: neutralize minority attack plans, keep c-file control, and counter with timely central breaks."
            }
            SignalColorPerspective::White => {
                "As White in Carlsbad structures: execute minority attack with piece support, control c-file entry squares, and avoid slow maneuvering without pressure."
            }
            SignalColorPerspective::Mixed => {
                "In Carlsbad structures: align plan with side duties (minority attack vs defense), and prioritize c-file + central-break timing."
            }
        },
        "WM_HANGING_PAWNS_12_30" => match perspective {
            SignalColorPerspective::Black => {
                "As Black in hanging-pawns structures: blockade c/d pawn advances, pressure base squares, and simplify only when blockading pieces are stable."
            }
            SignalColorPerspective::White => {
                "As White with hanging pawns: keep dynamic piece activity, prepare c/d breaks with full support, and avoid drifting into static weaknesses."
            }
            SignalColorPerspective::Mixed => {
                "In hanging-pawns structures: choose dynamic breaks or static blockade early, and avoid transitioning into the side's worst-case plan."
            }
        },
        "WM_STONEWALL_10_25" => match perspective {
            SignalColorPerspective::Black => {
                "As Black in Stonewall structures: secure dark squares, coordinate heavy pieces behind the pawn chain, and time central/queenside breaks before passivity sets in."
            }
            SignalColorPerspective::White => {
                "As White vs Stonewall setups: challenge dark-square control, trade the strongest kingside attacker, and attack base pawns before they consolidate."
            }
            SignalColorPerspective::Mixed => {
                "In Stonewall structures: anchor plans around dark-square control and avoid passive piece placements behind locked pawns."
            }
        },
        "WM_VS_BENONI_10_25" => match perspective {
            SignalColorPerspective::Black => {
                "As Black vs Benoni structures: contest central space immediately, reduce queenside pressure with timely piece exchanges, and deny outpost squares."
            }
            SignalColorPerspective::White => {
                "As White vs Benoni structures: maintain space edge, pressure d6 and queenside dark squares, and restrain ...b5 breaks before tactical operations."
            }
            SignalColorPerspective::Mixed => {
                "Against Benoni structures: prioritize center-vs-queenside balance and force decisions around pawn breaks instead of slow maneuvering."
            }
        },
        "WM_VS_ACCELERATED_DRAGON_8_16" => match perspective {
            SignalColorPerspective::Black => {
                "As Black vs Accelerated Dragon structures: time ...d5 breaks precisely, avoid passive setups, and neutralize dark-square pressure before simplification."
            }
            SignalColorPerspective::White => {
                "As White vs Accelerated Dragon structures: keep central grip, restrain ...d5 counterplay, and increase queenside/file pressure before tactical races."
            }
            SignalColorPerspective::Mixed => {
                "Against Accelerated Dragon setups: prioritize anti-...d5 control, dark-square pressure, and coordinated file play."
            }
        },
        "WM_FRENCH_CHAIN_8_22" => match perspective {
            SignalColorPerspective::Black => {
                "As Black in French-chain structures: pressure the chain base, solve light-squared bishop activity, and avoid releasing central tension prematurely."
            }
            SignalColorPerspective::White => {
                "As White in French-chain structures: protect chain base, coordinate kingside space gains, and convert space without overextension."
            }
            SignalColorPerspective::Mixed => {
                "In French-chain structures: define chain-base pressure plan early and preserve piece activity around the locked center."
            }
        },
        "WM_KID_LOCKED_CENTER_10_25" => match perspective {
            SignalColorPerspective::Black => {
                "As Black in KID locked centers: launch kingside initiative with piece support, keep central lock stable, and avoid slow queenside drift."
            }
            SignalColorPerspective::White => {
                "As White vs KID locked centers: expand queenside with timing, limit kingside breaks, and keep king safety while central lock holds."
            }
            SignalColorPerspective::Mixed => {
                "In KID locked centers: commit to correct wing plan by side and avoid tempo-loss maneuvers before pawn breaks."
            }
        },
        "WM_GRUNFELD_BROAD_CENTER_8_18" => match perspective {
            SignalColorPerspective::Black => {
                "As Black vs broad-center Grunfeld structures: intensify central target pressure and coordinate piece play before structural simplification."
            }
            SignalColorPerspective::White => {
                "As White with broad-center structures: maintain central cohesion, avoid overextension, and convert space edge before tactical liquidation."
            }
            SignalColorPerspective::Mixed => {
                "In broad-center Grunfeld structures: align plan around central targetability and timely piece pressure."
            }
        },
        _ => "Keep play in the detected weakness context and increase practical pressure.",
    }
}

fn signal_trigger_text(
    signal_key: &str,
    perspective: SignalColorPerspective,
    delta_acpl: f64,
    delta_loss_rate: f64,
    delta_accuracy: f64,
    delta_blunder_rate: f64,
    delta_mistake_rate: f64,
    delta_inaccuracy_rate: f64,
) -> String {
    let signal_key = normalize_signal_key(signal_key);
    let loss_pp = delta_loss_rate * 100.0;
    let blunder_pp = delta_blunder_rate * 100.0;
    let mistake_pp = delta_mistake_rate * 100.0;
    let inaccuracy_pp = delta_inaccuracy_rate * 100.0;
    match signal_key {
        "WM_UNCASTLED_EARLY" => format!(
            "Uncastled by ply 12: {:+.1} ACPL, {:+.1} pp loss rate, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy, {:+.1}% accuracy shift.",
            delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp, delta_accuracy
        ),
        "WM_LATE_ROOK_CONNECTION" => format!(
            "Rooks not coordinated/activated by ply 20: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
            delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
        ),
        "WM_NO_ROOK_ACTIVATION_20" => format!(
            "No useful rook activation by ply 40 (or blunder missed rook activation line): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
            delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
        ),
        "WM_OPEN_FILE_CONTROL_LOSS" => format!(
            "Negative open-file control after ply 15: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
            delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
        ),
        "WM_SEMIOPEN_FILE_CONTROL_LOSS" => format!(
            "Semi-open file control deficit after ply 15: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
            delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
        ),
        "WM_H7_H2_PRESSURE_DAMAGE" => format!(
            "Early h-target pressure (<= ply 25): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
            delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
        ),
        "WM_F3_F6_PRESSURE_DAMAGE" => format!(
            "Early f-target pressure (<= ply 25): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
            delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
        ),
        "WM_OPPOSITE_CASTLING_COLLAPSE" => format!(
            "Opposite-side castling races: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
            delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
        ),
        "WM_LONG_ENDGAME_CONVERSION" => format!(
            "Long games (>= 40 plies): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy vs baseline.",
            delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
        ),
        "WM_MAROCZY_10_15" => match perspective {
            SignalColorPerspective::Black => format!(
                "As Black vs Maroczy in ply 10-15: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::White => format!(
                "As White vs Maroczy in ply 10-15: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::Mixed => format!(
                "Vs Maroczy in ply 10-15: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
        },
        "WM_VS_DRAGON_10_18" => match perspective {
            SignalColorPerspective::Black => format!(
                "As Black vs Dragon in ply 10-18: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::White => format!(
                "As White vs Dragon in ply 10-18: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::Mixed => format!(
                "Vs Dragon in ply 10-18: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
        },
        "WM_IQP_12_30" => match perspective {
            SignalColorPerspective::Black => format!(
                "As Black in IQP windows (ply 12-30): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::White => format!(
                "As White in IQP windows (ply 12-30): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::Mixed => format!(
                "In IQP windows (ply 12-30): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
        },
        "WM_CARLSBAD_12_32" => match perspective {
            SignalColorPerspective::Black => format!(
                "As Black in Carlsbad windows (ply 12-32): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::White => format!(
                "As White in Carlsbad windows (ply 12-32): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::Mixed => format!(
                "In Carlsbad windows (ply 12-32): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
        },
        "WM_HANGING_PAWNS_12_30" => match perspective {
            SignalColorPerspective::Black => format!(
                "As Black in hanging-pawns windows (ply 12-30): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::White => format!(
                "As White in hanging-pawns windows (ply 12-30): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::Mixed => format!(
                "In hanging-pawns windows (ply 12-30): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
        },
        "WM_STONEWALL_10_25" => match perspective {
            SignalColorPerspective::Black => format!(
                "As Black in Stonewall windows (ply 10-25): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::White => format!(
                "As White in Stonewall windows (ply 10-25): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::Mixed => format!(
                "In Stonewall windows (ply 10-25): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
        },
        "WM_VS_BENONI_10_25" => match perspective {
            SignalColorPerspective::Black => format!(
                "As Black vs Benoni in ply 10-25: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::White => format!(
                "As White vs Benoni in ply 10-25: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::Mixed => format!(
                "Vs Benoni in ply 10-25: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
        },
        "WM_VS_ACCELERATED_DRAGON_8_16" => match perspective {
            SignalColorPerspective::Black => format!(
                "As Black vs Accelerated Dragon in ply 8-16: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::White => format!(
                "As White vs Accelerated Dragon in ply 8-16: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::Mixed => format!(
                "Vs Accelerated Dragon in ply 8-16: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
        },
        "WM_FRENCH_CHAIN_8_22" => match perspective {
            SignalColorPerspective::Black => format!(
                "As Black in French-chain windows (ply 8-22): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::White => format!(
                "As White in French-chain windows (ply 8-22): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::Mixed => format!(
                "In French-chain windows (ply 8-22): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
        },
        "WM_KID_LOCKED_CENTER_10_25" => match perspective {
            SignalColorPerspective::Black => format!(
                "As Black in KID locked-center windows (ply 10-25): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::White => format!(
                "As White in KID locked-center windows (ply 10-25): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::Mixed => format!(
                "In KID locked-center windows (ply 10-25): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
        },
        "WM_GRUNFELD_BROAD_CENTER_8_18" => match perspective {
            SignalColorPerspective::Black => format!(
                "As Black in Grunfeld broad-center windows (ply 8-18): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::White => format!(
                "As White in Grunfeld broad-center windows (ply 8-18): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
            SignalColorPerspective::Mixed => format!(
                "In Grunfeld broad-center windows (ply 8-18): {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy.",
                delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp
            ),
        },
        _ => format!(
            "Detected weakness context: {:+.1} ACPL, {:+.1} pp loss, {:+.1} pp blunder, {:+.1} pp mistake, {:+.1} pp inaccuracy, {:+.1}% accuracy.",
            delta_acpl, loss_pp, blunder_pp, mistake_pp, inaccuracy_pp, delta_accuracy
        ),
    }
}

fn matched_structure_plies(
    row: &WeaknessAggregationInputRow,
    from_ply: i32,
    to_ply: i32,
    key: &str,
) -> Vec<i32> {
    let mut matched = Vec::new();
    for ply in from_ply..=to_ply {
        if bucket_bool(&row.ply_bucket_features_json, ply, &["structures", key]).unwrap_or(false) {
            matched.push(ply);
        }
    }
    matched
}

fn detect_signal_hit(
    signal_key: &str,
    row: &WeaknessAggregationInputRow,
) -> Option<(Option<i32>, Option<i32>, Value)> {
    let signal_key = normalize_signal_key(signal_key);
    match signal_key {
        "WM_UNCASTLED_EARLY" => {
            if value_bool(&row.features_json, &["castling", "uncastledByPly12"]).unwrap_or(false) {
                let profile_ply =
                    value_i64(&row.features_json, &["castling", "profilePly"]).map(|v| v as i32);
                Some((
                    Some(1),
                    Some(12),
                    json!({
                        "uncastledByPly12": true,
                        "profileCastlingPly": profile_ply,
                    }),
                ))
            } else {
                None
            }
        }
        "WM_LATE_ROOK_CONNECTION" => {
            let connected = value_bool(
                &row.features_json,
                &["rookActivity", "rooksConnectedByPly20"],
            )
            .or_else(|| {
                value_bool(
                    &row.features_json,
                    &["rookActivity", "rooksConnectedByPly18"],
                )
            })
            .unwrap_or(false);
            let first_rook = value_i64(
                &row.features_json,
                &["rookActivity", "firstRookActivationPly"],
            )
            .map(|v| v as i32);
            let late_activation = first_rook.map(|p| p > 20).unwrap_or(true);
            if late_activation {
                Some((
                    Some(12),
                    Some(24),
                    json!({
                        "rooksConnectedByPly20": connected,
                        "firstRookActivationPly": first_rook
                    }),
                ))
            } else {
                None
            }
        }
        "WM_NO_ROOK_ACTIVATION_20" => {
            let first_rook = value_i64(
                &row.features_json,
                &["rookActivity", "firstRookActivationPly"],
            )
            .map(|v| v as i32);
            let missed_activation_blunder = value_bool(
                &row.features_json,
                &["rookActivity", "missedActivationBlunder"],
            )
            .unwrap_or(false);
            let missed_activation_blunder_ply = value_i64(
                &row.features_json,
                &["rookActivity", "missedActivationBlunderPly"],
            )
            .map(|v| v as i32);
            let missing_or_late = first_rook.map(|p| p > 40).unwrap_or(true);
            if missing_or_late || missed_activation_blunder {
                let ply_from = missed_activation_blunder_ply.or(Some(30));
                let ply_to = first_rook.or(Some(40));
                Some((
                    ply_from,
                    ply_to,
                    json!({
                        "firstRookActivationPly": first_rook,
                        "rooksConnectedByPly20": value_bool(&row.features_json, &["rookActivity", "rooksConnectedByPly20"])
                            .or_else(|| value_bool(&row.features_json, &["rookActivity", "rooksConnectedByPly18"])),
                        "missedActivationBlunder": missed_activation_blunder,
                        "missedActivationBlunderPly": missed_activation_blunder_ply,
                    }),
                ))
            } else {
                None
            }
        }
        "WM_OPEN_FILE_CONTROL_LOSS" => {
            let delta_20 = value_i64(
                &row.features_json,
                &["fileControl", "openFileControlDeltaPly20"],
            )
            .unwrap_or(0);
            let delta_final = value_i64(
                &row.features_json,
                &["fileControl", "openFileControlDeltaFinal"],
            )
            .unwrap_or(0);
            if delta_20 < 0 || delta_final < 0 {
                Some((
                    Some(15),
                    Some(30),
                    json!({
                        "openFileControlDeltaPly20": delta_20,
                        "openFileControlDeltaFinal": delta_final,
                    }),
                ))
            } else {
                None
            }
        }
        "WM_SEMIOPEN_FILE_CONTROL_LOSS" => {
            let delta_20 = value_i64(
                &row.features_json,
                &["fileControl", "semiOpenFileControlDeltaPly20"],
            )
            .unwrap_or(0);
            let delta_final = value_i64(
                &row.features_json,
                &["fileControl", "semiOpenFileControlDeltaFinal"],
            )
            .unwrap_or(0);
            if delta_20 < 0 || delta_final < 0 {
                Some((
                    Some(15),
                    Some(35),
                    json!({
                        "semiOpenFileControlDeltaPly20": delta_20,
                        "semiOpenFileControlDeltaFinal": delta_final,
                    }),
                ))
            } else {
                None
            }
        }
        "WM_H7_H2_PRESSURE_DAMAGE" => {
            let pressure = value_i64(
                &row.features_json,
                &["pressureTargets", "hTargetPressurePly"],
            )
            .map(|v| v as i32);
            if let Some(ply) = pressure {
                if ply <= 25 {
                    return Some((
                        Some(ply),
                        Some((ply + 6).min(40)),
                        json!({
                            "target": value_str(&row.features_json, &["pressureTargets", "hTarget"]),
                            "pressurePly": ply,
                            "capturePly": value_i64(&row.features_json, &["pressureTargets", "hTargetCapturePly"]),
                        }),
                    ));
                }
            }
            None
        }
        "WM_F3_F6_PRESSURE_DAMAGE" => {
            let pressure = value_i64(
                &row.features_json,
                &["pressureTargets", "fTargetPressurePly"],
            )
            .map(|v| v as i32);
            if let Some(ply) = pressure {
                if ply <= 25 {
                    return Some((
                        Some(ply),
                        Some((ply + 6).min(40)),
                        json!({
                            "target": value_str(&row.features_json, &["pressureTargets", "fTarget"]),
                            "pressurePly": ply,
                            "capturePly": value_i64(&row.features_json, &["pressureTargets", "fTargetCapturePly"]),
                        }),
                    ));
                }
            }
            None
        }
        "WM_OPPOSITE_CASTLING_COLLAPSE" => {
            let opposite = value_bool(&row.features_json, &["castling", "oppositeSideCastling"])
                .unwrap_or(false);
            if opposite {
                Some((
                    Some(8),
                    Some(35),
                    json!({
                        "oppositeSideCastling": true,
                        "profileCastlingPly": value_i64(&row.features_json, &["castling", "profilePly"]),
                        "opponentCastlingPly": value_i64(&row.features_json, &["castling", "opponentPly"]),
                    }),
                ))
            } else {
                None
            }
        }
        "WM_LONG_ENDGAME_CONVERSION" => {
            let length = value_i64(&row.features_json, &["gameLengthPly"])
                .map(|v| v as i32)
                .or(row.game_length_ply);
            let is_long = value_bool(&row.features_json, &["longEndgame"]).unwrap_or(false)
                || length.map(|v| v >= 40).unwrap_or(false);
            if is_long {
                Some((
                    Some(40),
                    length,
                    json!({
                        "longEndgame": true,
                        "gameLengthPly": length
                    }),
                ))
            } else {
                None
            }
        }
        "WM_MAROCZY_10_15" => {
            if !opening_family_in(row, &["sicilian"]) {
                return None;
            }
            let matched_plies = matched_structure_plies(row, 10, 15, "vsMaroczy");
            if !matched_plies.is_empty() {
                Some((
                    Some(10),
                    Some(15),
                    json!({
                        "matchedPlies": matched_plies,
                        "openingFamily": row.opening_family.clone(),
                    }),
                ))
            } else {
                None
            }
        }
        "WM_VS_DRAGON_10_18" => {
            if !opening_family_in(row, &["sicilian"]) {
                return None;
            }
            let matched_plies = matched_structure_plies(row, 10, 18, "vsDragon");
            if !matched_plies.is_empty() {
                Some((
                    Some(10),
                    Some(18),
                    json!({
                        "matchedPlies": matched_plies,
                        "openingFamily": row.opening_family.clone(),
                    }),
                ))
            } else {
                None
            }
        }
        "WM_IQP_12_30" => {
            let profile_hits = matched_structure_plies(row, 12, 30, "profileIqp");
            let vs_hits = matched_structure_plies(row, 12, 30, "vsIqp");
            if profile_hits.is_empty() && vs_hits.is_empty() {
                None
            } else {
                let mut matched_plies = profile_hits.clone();
                matched_plies.extend(vs_hits.iter().copied());
                matched_plies.sort_unstable();
                matched_plies.dedup();
                let mode = if !profile_hits.is_empty() && !vs_hits.is_empty() {
                    "mixed"
                } else if !profile_hits.is_empty() {
                    "profileIqp"
                } else {
                    "vsIqp"
                };
                Some((
                    Some(12),
                    Some(30),
                    json!({
                        "mode": mode,
                        "matchedPlies": matched_plies,
                        "profileHits": profile_hits,
                        "vsHits": vs_hits,
                        "openingFamily": row.opening_family.clone(),
                    }),
                ))
            }
        }
        "WM_CARLSBAD_12_32" => {
            let profile_hits = matched_structure_plies(row, 12, 32, "profileCarlsbad");
            let vs_hits = matched_structure_plies(row, 12, 32, "vsCarlsbad");
            if profile_hits.is_empty() && vs_hits.is_empty() {
                None
            } else {
                let mut matched_plies = profile_hits.clone();
                matched_plies.extend(vs_hits.iter().copied());
                matched_plies.sort_unstable();
                matched_plies.dedup();
                let mode = if !profile_hits.is_empty() && !vs_hits.is_empty() {
                    "mixed"
                } else if !profile_hits.is_empty() {
                    "profileCarlsbad"
                } else {
                    "vsCarlsbad"
                };
                Some((
                    Some(12),
                    Some(32),
                    json!({
                        "mode": mode,
                        "matchedPlies": matched_plies,
                        "profileHits": profile_hits,
                        "vsHits": vs_hits,
                        "openingFamily": row.opening_family.clone(),
                    }),
                ))
            }
        }
        "WM_HANGING_PAWNS_12_30" => {
            if !opening_family_in(row, &["queens-gambit", "closed-d", "indian-e"]) {
                return None;
            }
            let profile_hits = matched_structure_plies(row, 12, 30, "profileHangingPawns");
            let vs_hits = matched_structure_plies(row, 12, 30, "vsHangingPawns");
            if profile_hits.is_empty() && vs_hits.is_empty() {
                None
            } else {
                let mut matched_plies = profile_hits.clone();
                matched_plies.extend(vs_hits.iter().copied());
                matched_plies.sort_unstable();
                matched_plies.dedup();
                let mode = if !profile_hits.is_empty() && !vs_hits.is_empty() {
                    "mixed"
                } else if !profile_hits.is_empty() {
                    "profileHangingPawns"
                } else {
                    "vsHangingPawns"
                };
                Some((
                    Some(12),
                    Some(30),
                    json!({
                        "mode": mode,
                        "matchedPlies": matched_plies,
                        "profileHits": profile_hits,
                        "vsHits": vs_hits,
                        "openingFamily": row.opening_family.clone(),
                    }),
                ))
            }
        }
        "WM_STONEWALL_10_25" => {
            if !opening_family_in(row, &["flank-a", "indian-e", "closed-d", "french"]) {
                return None;
            }
            let profile_hits = matched_structure_plies(row, 10, 25, "profileStonewall");
            let vs_hits = matched_structure_plies(row, 10, 25, "vsStonewall");
            if profile_hits.is_empty() && vs_hits.is_empty() {
                None
            } else {
                let mut matched_plies = profile_hits.clone();
                matched_plies.extend(vs_hits.iter().copied());
                matched_plies.sort_unstable();
                matched_plies.dedup();
                let mode = if !profile_hits.is_empty() && !vs_hits.is_empty() {
                    "mixed"
                } else if !profile_hits.is_empty() {
                    "profileStonewall"
                } else {
                    "vsStonewall"
                };
                Some((
                    Some(10),
                    Some(25),
                    json!({
                        "mode": mode,
                        "matchedPlies": matched_plies,
                        "profileHits": profile_hits,
                        "vsHits": vs_hits,
                        "openingFamily": row.opening_family.clone(),
                    }),
                ))
            }
        }
        "WM_VS_BENONI_10_25" => {
            if !opening_family_in(row, &["flank-a", "indian-e", "closed-d"]) {
                return None;
            }
            let matched_plies = matched_structure_plies(row, 10, 25, "vsBenoni");
            if !matched_plies.is_empty() {
                Some((
                    Some(10),
                    Some(25),
                    json!({
                        "matchedPlies": matched_plies,
                        "openingFamily": row.opening_family.clone(),
                    }),
                ))
            } else {
                None
            }
        }
        "WM_VS_ACCELERATED_DRAGON_8_16" => {
            if !opening_family_in(row, &["sicilian"]) {
                return None;
            }
            let matched_plies = matched_structure_plies(row, 8, 16, "vsDragonAccelerated");
            if !matched_plies.is_empty() {
                Some((
                    Some(8),
                    Some(16),
                    json!({
                        "matchedPlies": matched_plies,
                        "openingFamily": row.opening_family.clone(),
                    }),
                ))
            } else {
                None
            }
        }
        "WM_FRENCH_CHAIN_8_22" => {
            if !opening_family_in(row, &["french"]) {
                return None;
            }
            let profile_hits = matched_structure_plies(row, 8, 22, "profileFrenchChain");
            let vs_hits = matched_structure_plies(row, 8, 22, "vsFrenchChain");
            if profile_hits.is_empty() && vs_hits.is_empty() {
                None
            } else {
                let mut matched_plies = profile_hits.clone();
                matched_plies.extend(vs_hits.iter().copied());
                matched_plies.sort_unstable();
                matched_plies.dedup();
                let mode = if !profile_hits.is_empty() && !vs_hits.is_empty() {
                    "mixed"
                } else if !profile_hits.is_empty() {
                    "profileFrenchChain"
                } else {
                    "vsFrenchChain"
                };
                Some((
                    Some(8),
                    Some(22),
                    json!({
                        "mode": mode,
                        "matchedPlies": matched_plies,
                        "profileHits": profile_hits,
                        "vsHits": vs_hits,
                        "openingFamily": row.opening_family.clone(),
                    }),
                ))
            }
        }
        "WM_KID_LOCKED_CENTER_10_25" => {
            if !opening_family_in(row, &["kings-indian"]) {
                return None;
            }
            let profile_hits = matched_structure_plies(row, 10, 25, "profileKidLockedCenter");
            let vs_hits = matched_structure_plies(row, 10, 25, "vsKidLockedCenter");
            if profile_hits.is_empty() && vs_hits.is_empty() {
                None
            } else {
                let mut matched_plies = profile_hits.clone();
                matched_plies.extend(vs_hits.iter().copied());
                matched_plies.sort_unstable();
                matched_plies.dedup();
                let mode = if !profile_hits.is_empty() && !vs_hits.is_empty() {
                    "mixed"
                } else if !profile_hits.is_empty() {
                    "profileKidLockedCenter"
                } else {
                    "vsKidLockedCenter"
                };
                Some((
                    Some(10),
                    Some(25),
                    json!({
                        "mode": mode,
                        "matchedPlies": matched_plies,
                        "profileHits": profile_hits,
                        "vsHits": vs_hits,
                        "openingFamily": row.opening_family.clone(),
                    }),
                ))
            }
        }
        "WM_GRUNFELD_BROAD_CENTER_8_18" => {
            if !opening_family_in(row, &["grunfeld", "closed-d"]) {
                return None;
            }
            let profile_hits = matched_structure_plies(row, 8, 18, "profileGrunfeldBroadCenter");
            let vs_hits = matched_structure_plies(row, 8, 18, "vsGrunfeldBroadCenter");
            if profile_hits.is_empty() && vs_hits.is_empty() {
                None
            } else {
                let mut matched_plies = profile_hits.clone();
                matched_plies.extend(vs_hits.iter().copied());
                matched_plies.sort_unstable();
                matched_plies.dedup();
                let mode = if !profile_hits.is_empty() && !vs_hits.is_empty() {
                    "mixed"
                } else if !profile_hits.is_empty() {
                    "profileGrunfeldBroadCenter"
                } else {
                    "vsGrunfeldBroadCenter"
                };
                Some((
                    Some(8),
                    Some(18),
                    json!({
                        "mode": mode,
                        "matchedPlies": matched_plies,
                        "profileHits": profile_hits,
                        "vsHits": vs_hits,
                        "openingFamily": row.opening_family.clone(),
                    }),
                ))
            }
        }
        _ => None,
    }
}

fn compute_recency_score(
    rows: &[WeaknessAggregationInputRow],
    hits: &[SignalHit],
    now_ms: i64,
) -> f64 {
    let mut weighted_sum = 0.0f64;
    let mut n = 0usize;
    let lambda = std::f64::consts::LN_2 / HALF_LIFE_DAYS;
    for hit in hits {
        if let Some(ts) = rows[hit.row_index].timestamp_ms {
            let age_ms = (now_ms - ts).max(0) as f64;
            let age_days = age_ms / 86_400_000.0;
            weighted_sum += (-lambda * age_days).exp();
            n += 1;
        }
    }
    if n == 0 {
        0.6
    } else {
        clamp01(weighted_sum / (n as f64))
    }
}

fn signal_damage_score(
    row: &WeaknessAggregationInputRow,
    baseline_acpl: Option<f64>,
    baseline_acc: Option<f64>,
) -> f64 {
    let mut score = 0.0f64;
    if row
        .profile_outcome
        .as_deref()
        .map(|o| o.eq_ignore_ascii_case("loss"))
        .unwrap_or(false)
    {
        score += 1.3;
    }
    if let (Some(acpl), Some(base)) = (row.acpl, baseline_acpl) {
        score += ((acpl - base).max(0.0) / 25.0).min(2.0);
    }
    if let (Some(acc), Some(base)) = (row.accuracy, baseline_acc) {
        score += ((base - acc).max(0.0) / 8.0).min(2.0);
    }
    score
}

fn build_evidence_text(
    signal_key: &str,
    row: &WeaknessAggregationInputRow,
    hit: &SignalHit,
) -> String {
    let signal_key = normalize_signal_key(signal_key);
    let outcome = row
        .profile_outcome
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let acpl = row
        .acpl
        .map(|v| format!("{:.1}", v))
        .unwrap_or_else(|| "-".to_string());
    let acc = row
        .accuracy
        .map(|v| format!("{:.1}", v))
        .unwrap_or_else(|| "-".to_string());
    let opponent = row
        .opponent_name
        .clone()
        .unwrap_or_else(|| "unknown opponent".to_string());

    match signal_key {
        "WM_UNCASTLED_EARLY" => format!(
            "Game {} (vs {}): still uncastled in the first 12 plies (outcome: {}, ACPL: {}, accuracy: {}%).",
            row.game_id, opponent, outcome, acpl, acc
        ),
        "WM_LATE_ROOK_CONNECTION" => format!(
            "Game {} (vs {}): rook coordination/activation lagged until after ply 20 (outcome: {}, ACPL: {}, accuracy: {}%).",
            row.game_id, opponent, outcome, acpl, acc
        ),
        "WM_NO_ROOK_ACTIVATION_20" => {
            let missed_blunder = hit
                .trigger_payload
                .get("missedActivationBlunder")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let blunder_ply = hit
                .trigger_payload
                .get("missedActivationBlunderPly")
                .and_then(|v| v.as_i64())
                .unwrap_or_default();

            if missed_blunder {
                format!(
                    "Game {} (vs {}): blunder around ply {} where best line required rook activation (outcome: {}, ACPL: {}, accuracy: {}%).",
                    row.game_id, opponent, blunder_ply, outcome, acpl, acc
                )
            } else {
                format!(
                    "Game {} (vs {}): no active rook play by move 40 or later (outcome: {}, ACPL: {}, accuracy: {}%).",
                    row.game_id, opponent, outcome, acpl, acc
                )
            }
        }
        "WM_OPEN_FILE_CONTROL_LOSS" => format!(
            "Game {} (vs {}): open-file control stayed negative in the early middlegame (outcome: {}, ACPL: {}, accuracy: {}%).",
            row.game_id, opponent, outcome, acpl, acc
        ),
        "WM_SEMIOPEN_FILE_CONTROL_LOSS" => format!(
            "Game {} (vs {}): semi-open files were controlled by the opponent (outcome: {}, ACPL: {}, accuracy: {}%).",
            row.game_id, opponent, outcome, acpl, acc
        ),
        "WM_H7_H2_PRESSURE_DAMAGE" => format!(
            "Game {} (vs {}): h-target pressure appeared around ply {} (outcome: {}, ACPL: {}, accuracy: {}%).",
            row.game_id,
            opponent,
            hit.ply_from.unwrap_or_default(),
            outcome,
            acpl,
            acc
        ),
        "WM_F3_F6_PRESSURE_DAMAGE" => format!(
            "Game {} (vs {}): f-target pressure appeared around ply {} (outcome: {}, ACPL: {}, accuracy: {}%).",
            row.game_id,
            opponent,
            hit.ply_from.unwrap_or_default(),
            outcome,
            acpl,
            acc
        ),
        "WM_OPPOSITE_CASTLING_COLLAPSE" => format!(
            "Game {} (vs {}): opposite-side castling race turned unfavorable (outcome: {}, ACPL: {}, accuracy: {}%).",
            row.game_id, opponent, outcome, acpl, acc
        ),
        "WM_LONG_ENDGAME_CONVERSION" => format!(
            "Game {} (vs {}): long ending ({} plies) with reduced conversion quality (outcome: {}, ACPL: {}, accuracy: {}%).",
            row.game_id,
            opponent,
            row.game_length_ply.unwrap_or_default(),
            outcome,
            acpl,
            acc
        ),
        "WM_MAROCZY_10_15" => format!(
            "Game {} (vs {}): Maroczy pressure zone in ply 10-15 (outcome: {}, ACPL: {}, accuracy: {}%).",
            row.game_id, opponent, outcome, acpl, acc
        ),
        "WM_VS_DRAGON_10_18" => format!(
            "Game {} (vs {}): Dragon structure pressure in ply 10-18 (outcome: {}, ACPL: {}, accuracy: {}%).",
            row.game_id, opponent, outcome, acpl, acc
        ),
        "WM_IQP_12_30" => {
            let mode = hit
                .trigger_payload
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            format!(
                "Game {} (vs {}): IQP structure mode '{}' in ply 12-30 (outcome: {}, ACPL: {}, accuracy: {}%).",
                row.game_id, opponent, mode, outcome, acpl, acc
            )
        }
        "WM_CARLSBAD_12_32" => {
            let mode = hit
                .trigger_payload
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            format!(
                "Game {} (vs {}): Carlsbad structure mode '{}' in ply 12-32 (outcome: {}, ACPL: {}, accuracy: {}%).",
                row.game_id, opponent, mode, outcome, acpl, acc
            )
        }
        "WM_HANGING_PAWNS_12_30" => {
            let mode = hit
                .trigger_payload
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            format!(
                "Game {} (vs {}): hanging-pawns mode '{}' in ply 12-30 (outcome: {}, ACPL: {}, accuracy: {}%).",
                row.game_id, opponent, mode, outcome, acpl, acc
            )
        }
        "WM_STONEWALL_10_25" => {
            let mode = hit
                .trigger_payload
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            format!(
                "Game {} (vs {}): Stonewall mode '{}' in ply 10-25 (outcome: {}, ACPL: {}, accuracy: {}%).",
                row.game_id, opponent, mode, outcome, acpl, acc
            )
        }
        "WM_VS_BENONI_10_25" => format!(
            "Game {} (vs {}): Benoni pressure zone in ply 10-25 (outcome: {}, ACPL: {}, accuracy: {}%).",
            row.game_id, opponent, outcome, acpl, acc
        ),
        "WM_VS_ACCELERATED_DRAGON_8_16" => format!(
            "Game {} (vs {}): Accelerated Dragon pressure zone in ply 8-16 (outcome: {}, ACPL: {}, accuracy: {}%).",
            row.game_id, opponent, outcome, acpl, acc
        ),
        "WM_FRENCH_CHAIN_8_22" => {
            let mode = hit
                .trigger_payload
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            format!(
                "Game {} (vs {}): French-chain mode '{}' in ply 8-22 (outcome: {}, ACPL: {}, accuracy: {}%).",
                row.game_id, opponent, mode, outcome, acpl, acc
            )
        }
        "WM_KID_LOCKED_CENTER_10_25" => {
            let mode = hit
                .trigger_payload
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            format!(
                "Game {} (vs {}): KID locked-center mode '{}' in ply 10-25 (outcome: {}, ACPL: {}, accuracy: {}%).",
                row.game_id, opponent, mode, outcome, acpl, acc
            )
        }
        "WM_GRUNFELD_BROAD_CENTER_8_18" => {
            let mode = hit
                .trigger_payload
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            format!(
                "Game {} (vs {}): Grunfeld broad-center mode '{}' in ply 8-18 (outcome: {}, ACPL: {}, accuracy: {}%).",
                row.game_id, opponent, mode, outcome, acpl, acc
            )
        }
        _ => format!(
            "Game {} (vs {}): weakness context detected (outcome: {}, ACPL: {}, accuracy: {}%).",
            row.game_id, opponent, outcome, acpl, acc
        ),
    }
}

fn build_fallback_loss_cluster_signal(
    rows: &[WeaknessAggregationInputRow],
    max_evidence_per_signal: usize,
) -> Option<(WeaknessSignalSnapshotUpsert, Vec<WeaknessEvidenceUpsert>)> {
    #[derive(Default, Clone)]
    struct GroupAgg {
        row_indices: Vec<usize>,
        losses: usize,
        decided: usize,
    }

    let mut total_losses = 0usize;
    let mut total_decided = 0usize;
    let mut groups: HashMap<String, GroupAgg> = HashMap::new();

    for (idx, row) in rows.iter().enumerate() {
        let outcome = row.profile_outcome.as_deref().unwrap_or("unknown");
        let mut decided_delta = 0usize;
        let mut loss_delta = 0usize;
        if outcome == "win" || outcome == "loss" {
            decided_delta = 1;
            if outcome == "loss" {
                loss_delta = 1;
            }
        }
        total_decided += decided_delta;
        total_losses += loss_delta;

        let opening = row
            .opening_family
            .as_deref()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or("Unknown");
        let tc = row
            .time_control_bucket
            .as_deref()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or("any");
        let group_key = format!("opening:{opening}|tc:{tc}");
        let entry = groups.entry(group_key).or_default();
        entry.row_indices.push(idx);
        entry.decided += decided_delta;
        entry.losses += loss_delta;
    }

    let overall_loss_rate = if total_decided > 0 {
        (total_losses as f64) / (total_decided as f64)
    } else {
        0.5
    };

    let mut best: Option<(String, GroupAgg, f64, f64)> = None;
    let use_loss_delta_scoring = total_decided > 0;
    for (key, agg_ref) in &groups {
        if agg_ref.row_indices.is_empty() {
            continue;
        }
        let agg = agg_ref.clone();
        let group_loss_rate = if agg.decided > 0 {
            (agg.losses as f64) / (agg.decided as f64)
        } else {
            overall_loss_rate
        };
        let score = if use_loss_delta_scoring {
            if agg.decided < 4 {
                continue;
            }
            let delta = group_loss_rate - overall_loss_rate;
            if delta <= 0.05 {
                continue;
            }
            delta * (agg.row_indices.len() as f64)
        } else {
            agg.row_indices.len() as f64
        };
        let is_better = best
            .as_ref()
            .map(|(_, _, _, current_score)| score > *current_score)
            .unwrap_or(true);
        if is_better {
            best = Some((key.clone(), agg, group_loss_rate, score));
        }
    }

    let selected = best.or_else(|| {
        // Last-resort fallback when no statistically significant cluster is found:
        // keep one broad signal so the model still provides guidance instead of an empty state.
        let mut fallback_best: Option<(String, GroupAgg, f64, f64)> = None;
        for (key, agg_ref) in &groups {
            if agg_ref.row_indices.is_empty() {
                continue;
            }
            let agg = agg_ref.clone();
            let score = agg.row_indices.len() as f64;
            let is_better = fallback_best
                .as_ref()
                .map(|(_, _, _, current_score)| score > *current_score)
                .unwrap_or(true);
            if is_better {
                fallback_best = Some((key.clone(), agg, overall_loss_rate, score));
            }
        }
        fallback_best
    });
    let (group_key, agg, group_loss_rate, _score) = selected?;
    let delta_pp = (group_loss_rate - overall_loss_rate) * 100.0;
    let severity = clamp01((delta_pp / 20.0).max(0.0));
    let confidence = clamp01(((agg.row_indices.len() as f64) / 50.0).sqrt());
    let controllability = 0.58;
    let recency = 0.75;
    let total_score = round2(severity * confidence * controllability * recency * 100.0);

    let title = format!("Loss cluster: {}", group_key.replace('|', " "));
    let trigger_text = format!(
        "In {} your loss rate is +{:.1}pp vs baseline.",
        group_key,
        round2(delta_pp)
    );
    let attack_plan = "Prioritize safer plans and targeted prep in this cluster; reduce tactical concessions before move 20."
        .to_string();

    let impact_json = json!({
        "fallback": true,
        "groupKey": group_key,
        "groupLossRate": round2(group_loss_rate * 100.0),
        "overallLossRate": round2(overall_loss_rate * 100.0),
        "deltaLossRate": round2(delta_pp),
    });
    let trigger_json = json!({
        "fallback": true,
        "support": agg.row_indices.len(),
        "decidedGames": agg.decided,
    });

    let mut evidence_order = agg.row_indices.clone();
    evidence_order.sort_by(|a, b| {
        let ra = &rows[*a];
        let rb = &rows[*b];
        let la = ra.profile_outcome.as_deref().unwrap_or("unknown") == "loss";
        let lb = rb.profile_outcome.as_deref().unwrap_or("unknown") == "loss";
        lb.cmp(&la).then_with(|| ra.game_id.cmp(&rb.game_id))
    });

    let mut evidence_rows = Vec::new();
    for (idx, row_idx) in evidence_order
        .into_iter()
        .take(max_evidence_per_signal.max(1))
        .enumerate()
    {
        let row = &rows[row_idx];
        let outcome = row
            .profile_outcome
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        let evidence_text = format!(
            "Game {} ({}): fallback cluster hit ({}).",
            row.game_id, group_key, outcome
        );
        evidence_rows.push(WeaknessEvidenceUpsert {
            signal_key: "WM_FALLBACK_LOSS_CLUSTER".to_string(),
            evidence_rank: (idx as i32) + 1,
            game_id: Some(row.game_id),
            ply_from: None,
            ply_to: None,
            evidence_text,
            evidence_json: json!({
                "fallback": true,
                "groupKey": group_key,
                "outcome": row.profile_outcome.clone(),
                "gameId": row.game_id,
                "openingFamily": row.opening_family.clone(),
                "timeControlBucket": row.time_control_bucket.clone(),
            }),
        });
    }

    let signal = WeaknessSignalSnapshotUpsert {
        signal_key: "WM_FALLBACK_LOSS_CLUSTER".to_string(),
        title,
        trigger_text,
        attack_plan,
        score: total_score,
        severity: round2(severity),
        confidence: round2(confidence),
        controllability: round2(controllability),
        recency: round2(recency),
        support: agg.row_indices.len() as i32,
        n_eff: Some(round2((agg.row_indices.len() as f64) * recency)),
        impact_json,
        trigger_json,
    };

    Some((signal, evidence_rows))
}

pub fn build_weakness_snapshot_v1(
    rows: &[WeaknessAggregationInputRow],
    max_signals: Option<usize>,
    max_evidence_per_signal: Option<usize>,
) -> WeaknessSnapshotBuildResult {
    let signal_keys = [
        "WM_UNCASTLED_EARLY",
        "WM_LATE_ROOK_CONNECTION",
        "WM_NO_ROOK_ACTIVATION_20",
        "WM_OPEN_FILE_CONTROL_LOSS",
        "WM_SEMIOPEN_FILE_CONTROL_LOSS",
        "WM_H7_H2_PRESSURE_DAMAGE",
        "WM_F3_F6_PRESSURE_DAMAGE",
        "WM_OPPOSITE_CASTLING_COLLAPSE",
        "WM_LONG_ENDGAME_CONVERSION",
        "WM_MAROCZY_10_15",
        "WM_VS_DRAGON_10_18",
        "WM_IQP_12_30",
        "WM_CARLSBAD_12_32",
        "WM_HANGING_PAWNS_12_30",
        "WM_STONEWALL_10_25",
        "WM_VS_BENONI_10_25",
        "WM_VS_ACCELERATED_DRAGON_8_16",
        "WM_FRENCH_CHAIN_8_22",
        "WM_KID_LOCKED_CENTER_10_25",
        "WM_GRUNFELD_BROAD_CENTER_8_18",
    ];

    let mut global_baseline = MetricAggregate::default();
    for row in rows {
        accumulate_metrics(&mut global_baseline, row);
    }

    let global_loss_rate =
        mean(global_baseline.loss_sum, global_baseline.loss_count).unwrap_or(0.0);
    let global_acpl = mean(global_baseline.acpl_sum, global_baseline.acpl_count);
    let global_acc = mean(global_baseline.acc_sum, global_baseline.acc_count);
    let global_blunder_rate =
        mean(global_baseline.blunder_sum, global_baseline.blunder_count).unwrap_or(0.0);
    let global_mistake_rate =
        mean(global_baseline.mistake_sum, global_baseline.mistake_count).unwrap_or(0.0);
    let global_inaccuracy_rate = mean(
        global_baseline.inaccuracy_sum,
        global_baseline.inaccuracy_count,
    )
    .unwrap_or(0.0);

    let mut row_context_keys: Vec<String> = Vec::with_capacity(rows.len());
    let mut rows_by_context: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, row) in rows.iter().enumerate() {
        let key = row_context_key(row);
        row_context_keys.push(key.clone());
        rows_by_context.entry(key).or_default().push(idx);
    }

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let mut staged: Vec<StagedSignalCandidate> = Vec::new();

    for signal_key in signal_keys {
        let mut hits: Vec<SignalHit> = Vec::new();
        for (idx, row) in rows.iter().enumerate() {
            if let Some((ply_from, ply_to, trigger_payload)) = detect_signal_hit(signal_key, row) {
                hits.push(SignalHit {
                    row_index: idx,
                    ply_from,
                    ply_to,
                    trigger_payload,
                });
            }
        }

        if hits.len() < MIN_SIGNAL_SUPPORT {
            continue;
        }

        let mut triggered = MetricAggregate::default();
        for hit in &hits {
            accumulate_metrics(&mut triggered, &rows[hit.row_index]);
        }

        let trigger_loss_rate = mean(triggered.loss_sum, triggered.loss_count).unwrap_or(0.0);
        let trigger_acpl = mean(triggered.acpl_sum, triggered.acpl_count);
        let trigger_acc = mean(triggered.acc_sum, triggered.acc_count);
        let trigger_blunder_rate =
            mean(triggered.blunder_sum, triggered.blunder_count).unwrap_or(0.0);
        let trigger_mistake_rate =
            mean(triggered.mistake_sum, triggered.mistake_count).unwrap_or(0.0);
        let trigger_inaccuracy_rate =
            mean(triggered.inaccuracy_sum, triggered.inaccuracy_count).unwrap_or(0.0);

        let mut hit_index_mask = vec![false; rows.len()];
        let mut hit_contexts: HashMap<String, usize> = HashMap::new();
        for hit in &hits {
            hit_index_mask[hit.row_index] = true;
            let ctx = row_context_keys
                .get(hit.row_index)
                .cloned()
                .unwrap_or_else(|| "color:any|tc:any|opening:any".to_string());
            *hit_contexts.entry(ctx).or_insert(0) += 1;
        }

        let mut context_baseline = MetricAggregate::default();
        let mut context_baseline_rows = 0usize;
        for (ctx_key, _count) in &hit_contexts {
            if let Some(ctx_rows) = rows_by_context.get(ctx_key) {
                for row_idx in ctx_rows {
                    if hit_index_mask[*row_idx] {
                        continue;
                    }
                    accumulate_metrics(&mut context_baseline, &rows[*row_idx]);
                    context_baseline_rows += 1;
                }
            }
        }

        let context_loss_rate = mean(context_baseline.loss_sum, context_baseline.loss_count);
        let context_acpl = mean(context_baseline.acpl_sum, context_baseline.acpl_count);
        let context_acc = mean(context_baseline.acc_sum, context_baseline.acc_count);
        let context_blunder_rate =
            mean(context_baseline.blunder_sum, context_baseline.blunder_count);
        let context_mistake_rate =
            mean(context_baseline.mistake_sum, context_baseline.mistake_count);
        let context_inaccuracy_rate = mean(
            context_baseline.inaccuracy_sum,
            context_baseline.inaccuracy_count,
        );

        let baseline_loss_rate = context_loss_rate.unwrap_or(global_loss_rate);
        let baseline_acpl = context_acpl.or(global_acpl);
        let baseline_acc = context_acc.or(global_acc);
        let baseline_blunder_rate = context_blunder_rate.unwrap_or(global_blunder_rate);
        let baseline_mistake_rate = context_mistake_rate.unwrap_or(global_mistake_rate);
        let baseline_inaccuracy_rate = context_inaccuracy_rate.unwrap_or(global_inaccuracy_rate);
        let trigger_loss_ci =
            wilson_interval(triggered.loss_sum.round() as usize, triggered.loss_count);
        let baseline_loss_ci = if context_baseline_rows > 0 {
            wilson_interval(
                context_baseline.loss_sum.round() as usize,
                context_baseline.loss_count,
            )
        } else {
            wilson_interval(
                global_baseline.loss_sum.round() as usize,
                global_baseline.loss_count,
            )
        };
        let baseline_mode = if context_baseline_rows > 0 {
            "contextMatched"
        } else {
            "global"
        };

        let delta_loss_rate = trigger_loss_rate - baseline_loss_rate;
        let delta_acpl = trigger_acpl
            .zip(baseline_acpl)
            .map(|(t, b)| t - b)
            .unwrap_or(0.0);
        let delta_accuracy = trigger_acc
            .zip(baseline_acc)
            .map(|(t, b)| t - b)
            .unwrap_or(0.0);
        let delta_blunder_rate = trigger_blunder_rate - baseline_blunder_rate;
        let delta_mistake_rate = trigger_mistake_rate - baseline_mistake_rate;
        let delta_inaccuracy_rate = trigger_inaccuracy_rate - baseline_inaccuracy_rate;
        let delta_loss_ci = match (trigger_loss_ci, baseline_loss_ci) {
            (Some((trigger_low, trigger_high)), Some((baseline_low, baseline_high))) => {
                Some((trigger_low - baseline_high, trigger_high - baseline_low))
            }
            _ => None,
        };

        let sev_acpl = clamp01(delta_acpl.max(0.0) / 22.0);
        let sev_loss = clamp01(delta_loss_rate.max(0.0) / 0.14);
        let sev_acc = clamp01((-delta_accuracy).max(0.0) / 8.0);
        let sev_blunder = clamp01(delta_blunder_rate.max(0.0) / 0.08);
        let sev_mistake = clamp01(delta_mistake_rate.max(0.0) / 0.10);
        let sev_inaccuracy = clamp01(delta_inaccuracy_rate.max(0.0) / 0.12);
        let severity = clamp01(
            sev_acpl * 0.30
                + sev_loss * 0.25
                + sev_acc * 0.10
                + sev_blunder * 0.20
                + sev_mistake * 0.10
                + sev_inaccuracy * 0.05,
        );

        // Skip contexts that do not show a weakness direction against baseline.
        if severity <= 0.0 {
            continue;
        }

        let support_factor = clamp01(((hits.len() as f64) / 90.0).sqrt());
        let context_factor = context_weight_from_rows(context_baseline_rows, hits.len());
        let recency = compute_recency_score(rows, &hits, now_ms);
        let trend = compute_signal_trend(rows, &hits);
        let ci_factor = trigger_loss_ci
            .map(|(low, high)| clamp01(1.0 - ((high - low) / 0.55)))
            .unwrap_or(0.5);
        let confidence = clamp01(
            support_factor * 0.50
                + context_factor * 0.15
                + recency * 0.10
                + severity * 0.10
                + ci_factor * 0.15,
        );
        let controllability = signal_controllability(signal_key);
        let priority_weight = signal_priority_weight(signal_key);
        let support_weight = support_weight_from_support(hits.len());
        let confidence_weight = confidence.powf(1.25);
        let severity_weight = severity.powf(1.05);
        let score_without_recency =
            round2(severity_weight * confidence_weight * controllability * support_weight * 100.0);
        let score = round2(score_without_recency * recency * priority_weight * trend.weight);

        let n_eff = Some(round2((hits.len() as f64) * recency.max(0.25)));
        let (dominant_color, white_hits, black_hits) = color_perspective_from_hits(rows, &hits);

        let title = signal_title(signal_key, dominant_color).to_string();
        let trigger_text = signal_trigger_text(
            signal_key,
            dominant_color,
            delta_acpl,
            delta_loss_rate,
            delta_accuracy,
            delta_blunder_rate,
            delta_mistake_rate,
            delta_inaccuracy_rate,
        );
        let attack_plan = signal_attack_plan(signal_key, dominant_color).to_string();
        let impact_json = json!({
            "deltaAcpl": round2(delta_acpl),
            "deltaAccuracy": round2(delta_accuracy),
            "deltaLossRate": round2(delta_loss_rate * 100.0),
            "deltaBlunderRate": round2(delta_blunder_rate * 100.0),
            "deltaMistakeRate": round2(delta_mistake_rate * 100.0),
            "deltaInaccuracyRate": round2(delta_inaccuracy_rate * 100.0),
            "triggerAvgAcpl": option_round2(trigger_acpl),
            "baselineAvgAcpl": option_round2(baseline_acpl),
            "triggerAvgAccuracy": option_round2(trigger_acc),
            "baselineAvgAccuracy": option_round2(baseline_acc),
            "triggerLossRate": round2(trigger_loss_rate * 100.0),
            "baselineLossRate": round2(baseline_loss_rate * 100.0),
            "triggerBlunderRate": round2(trigger_blunder_rate * 100.0),
            "baselineBlunderRate": round2(baseline_blunder_rate * 100.0),
            "triggerMistakeRate": round2(trigger_mistake_rate * 100.0),
            "baselineMistakeRate": round2(baseline_mistake_rate * 100.0),
            "triggerInaccuracyRate": round2(trigger_inaccuracy_rate * 100.0),
            "baselineInaccuracyRate": round2(baseline_inaccuracy_rate * 100.0),
            "triggerLossRateCiLow": option_round2(trigger_loss_ci.map(|(low, _)| low * 100.0)),
            "triggerLossRateCiHigh": option_round2(trigger_loss_ci.map(|(_, high)| high * 100.0)),
            "baselineLossRateCiLow": option_round2(baseline_loss_ci.map(|(low, _)| low * 100.0)),
            "baselineLossRateCiHigh": option_round2(baseline_loss_ci.map(|(_, high)| high * 100.0)),
            "deltaLossRateCiLow": option_round2(delta_loss_ci.map(|(low, _)| low * 100.0)),
            "deltaLossRateCiHigh": option_round2(delta_loss_ci.map(|(_, high)| high * 100.0)),
            "recentVsPreviousDeltaLossRate": option_round2(trend.delta_loss_rate_pp),
            "recentVsPreviousDeltaAcpl": option_round2(trend.delta_acpl),
            "baselineMode": baseline_mode,
            "contextBaselineRows": context_baseline_rows,
            "scoreWithoutRecency": score_without_recency,
            "scoreWithRecency": score,
            "priorityWeight": round2(priority_weight),
            "trendWeight": trend.weight,
            "supportWeight": round2(support_weight),
            "supportFactor": round2(support_factor),
            "contextFactor": round2(context_factor),
            "ciFactor": round2(ci_factor),
            "confidenceWeight": round2(confidence_weight),
            "severityWeight": round2(severity_weight),
            "meanEstimatedElo": option_round2({
                let mut sum = 0.0f64;
                let mut n = 0usize;
                for h in &hits {
                    if let Some(v) = rows[h.row_index].estimated_elo {
                        sum += v as f64;
                        n += 1;
                    }
                }
                mean(sum, n)
            }),
        });

        let trigger_rate = if rows.is_empty() {
            0.0
        } else {
            (hits.len() as f64) / (rows.len() as f64)
        };
        let mut context_counter: HashMap<String, usize> = HashMap::new();
        let mut opponent_counter: HashMap<String, usize> = HashMap::new();
        for h in &hits {
            let row = &rows[h.row_index];
            if let Some(tc) = &row.time_control_bucket {
                *context_counter
                    .entry(format!("timeControl:{tc}"))
                    .or_insert(0) += 1;
            }
            if let Some(of) = &row.opening_family {
                *context_counter
                    .entry(format!("openingFamily:{of}"))
                    .or_insert(0) += 1;
            }
            if let Some(color) = &row.color_played {
                *context_counter.entry(format!("color:{color}")).or_insert(0) += 1;
            }
            if let Some(opp) = &row.opponent_name {
                let normalized = opp.trim();
                if !normalized.is_empty() {
                    *opponent_counter.entry(normalized.to_string()).or_insert(0) += 1;
                }
            }
        }
        let mut context_top: Vec<(String, usize)> = context_counter.into_iter().collect();
        context_top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let mut opponents_top: Vec<(String, usize)> = opponent_counter.into_iter().collect();
        opponents_top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let portfolio_cluster = signal_portfolio_cluster(signal_key);
        let trigger_json = json!({
            "triggerRate": round2(trigger_rate * 100.0),
            "support": hits.len(),
            "dominantColor": dominant_color.as_str(),
            "portfolioCluster": portfolio_cluster,
            "supportByColor": {
                "white": white_hits,
                "black": black_hits
            },
            "supportTier": if hits.len() >= 60 { "high" } else if hits.len() >= 20 { "medium" } else { "low" },
            "confidenceBand": confidence_band(confidence, hits.len()),
            "trend": {
                "label": trend.label,
                "recentCount": trend.recent_count,
                "previousCount": trend.previous_count,
                "deltaLossRatePp": option_round2(trend.delta_loss_rate_pp),
                "deltaAcpl": option_round2(trend.delta_acpl),
                "weight": trend.weight
            },
            "lossRateCi": {
                "trigger": {
                    "low": option_round2(trigger_loss_ci.map(|(low, _)| low * 100.0)),
                    "high": option_round2(trigger_loss_ci.map(|(_, high)| high * 100.0))
                },
                "baseline": {
                    "low": option_round2(baseline_loss_ci.map(|(low, _)| low * 100.0)),
                    "high": option_round2(baseline_loss_ci.map(|(_, high)| high * 100.0))
                },
                "delta": {
                    "low": option_round2(delta_loss_ci.map(|(low, _)| low * 100.0)),
                    "high": option_round2(delta_loss_ci.map(|(_, high)| high * 100.0))
                }
            },
            "contextsTop": context_top.into_iter().take(5).map(|(k, v)| json!({"key": k, "count": v})).collect::<Vec<_>>(),
            "opponentsTop": opponents_top.into_iter().take(5).map(|(k, v)| json!({"name": k, "count": v})).collect::<Vec<_>>(),
        });

        let mut ranked_hits = hits.clone();
        ranked_hits.sort_by(|a, b| {
            let sa = signal_damage_score(&rows[a.row_index], baseline_acpl, baseline_acc);
            let sb = signal_damage_score(&rows[b.row_index], baseline_acpl, baseline_acc);
            sb.partial_cmp(&sa)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| rows[a.row_index].game_id.cmp(&rows[b.row_index].game_id))
        });

        let evidence_limit = max_evidence_per_signal
            .unwrap_or(MAX_EVIDENCE_PER_SIGNAL_DEFAULT)
            .max(1);
        let mut evidence_rows: Vec<WeaknessEvidenceUpsert> = Vec::new();
        for (idx, hit) in ranked_hits.into_iter().take(evidence_limit).enumerate() {
            let row = &rows[hit.row_index];
            let evidence_text = build_evidence_text(signal_key, row, &hit);
            let evidence_json = json!({
                "gameId": row.game_id,
                "trigger": hit.trigger_payload,
                "outcome": row.profile_outcome.clone(),
                "acpl": option_round2(row.acpl),
                "accuracy": option_round2(row.accuracy),
                "blunderRate": option_round2(row.blunder_rate.map(|v| v * 100.0)),
                "mistakeRate": option_round2(row.mistake_rate.map(|v| v * 100.0)),
                "inaccuracyRate": option_round2(row.inaccuracy_rate.map(|v| v * 100.0)),
                "opponentName": row.opponent_name.clone(),
                "estimatedElo": row.estimated_elo,
                "openingFamily": row.opening_family.clone(),
                "timeControlBucket": row.time_control_bucket.clone(),
            });
            evidence_rows.push(WeaknessEvidenceUpsert {
                signal_key: signal_key.to_string(),
                evidence_rank: (idx as i32) + 1,
                game_id: Some(row.game_id),
                ply_from: hit.ply_from,
                ply_to: hit.ply_to,
                evidence_text,
                evidence_json,
            });
        }

        staged.push(StagedSignalCandidate {
            signal: WeaknessSignalSnapshotUpsert {
                signal_key: signal_key.to_string(),
                title,
                trigger_text,
                attack_plan,
                score,
                severity: round2(severity),
                confidence: round2(confidence),
                controllability: round2(controllability),
                recency: round2(recency),
                support: hits.len() as i32,
                n_eff,
                impact_json,
                trigger_json,
            },
            evidence: evidence_rows,
            hit_game_ids: signal_hit_game_ids(rows, &hits),
            portfolio_cluster,
        });
    }

    if staged.is_empty() {
        if let Some(fallback) = build_fallback_loss_cluster_signal(
            rows,
            max_evidence_per_signal.unwrap_or(MAX_EVIDENCE_PER_SIGNAL_DEFAULT),
        ) {
            let (signal, evidence) = fallback;
            staged.push(StagedSignalCandidate {
                hit_game_ids: signal_evidence_game_ids(&evidence),
                portfolio_cluster: signal_portfolio_cluster(&signal.signal_key),
                signal,
                evidence,
            });
        }
    }

    let keep = max_signals.unwrap_or(MAX_SIGNALS_DEFAULT).max(1);
    let staged = select_signal_portfolio(staged, keep);

    let mut signals = Vec::new();
    let mut evidence = Vec::new();
    for mut candidate in staged {
        signals.push(candidate.signal);
        evidence.append(&mut candidate.evidence);
    }

    let mut scored_games = 0i32;
    for row in rows {
        if row.acpl.is_some()
            || row.accuracy.is_some()
            || row.blunder_rate.is_some()
            || row.mistake_rate.is_some()
            || row.inaccuracy_rate.is_some()
            || row.profile_outcome.is_some()
        {
            scored_games += 1;
        }
    }

    WeaknessSnapshotBuildResult {
        total_games: rows.len() as i32,
        scored_games,
        signals,
        evidence,
    }
}

pub fn compose_profile_weakness_model(
    snapshot_key: String,
    generated_at: String,
    total_games: i32,
    scored_games: i32,
    backfilled_games: i32,
    signal_rows: Vec<WeaknessSignalSnapshotRow>,
    evidence_rows_by_signal: HashMap<String, Vec<WeaknessEvidenceRow>>,
    signals_by_color: Option<ProfileWeaknessSignalsByColor>,
) -> ProfileWeaknessModel {
    let mut signals: Vec<ProfileWeaknessSignal> = Vec::new();

    for signal in signal_rows {
        let evidence_rows = evidence_rows_by_signal
            .get(&signal.signal_key)
            .cloned()
            .unwrap_or_default();
        let evidence = evidence_rows
            .into_iter()
            .map(|row| ProfileWeaknessSignalEvidence {
                evidence_rank: row.evidence_rank,
                game_id: row.game_id,
                ply_from: row.ply_from,
                ply_to: row.ply_to,
                evidence_text: row.evidence_text,
                evidence_json: row.evidence_json,
            })
            .collect::<Vec<_>>();

        signals.push(ProfileWeaknessSignal {
            signal_key: normalize_signal_key(&signal.signal_key).to_string(),
            title: signal.title,
            trigger_text: signal.trigger_text,
            attack_plan: signal.attack_plan,
            score: signal.score,
            severity: signal.severity,
            confidence: signal.confidence,
            controllability: signal.controllability,
            recency: signal.recency,
            support: signal.support,
            n_eff: signal.n_eff,
            impact_json: signal.impact_json,
            trigger_json: signal.trigger_json,
            evidence,
        });
    }

    sort_signals_by_score_desc(&mut signals);
    let mut by_color = signals_by_color.unwrap_or_default();
    sort_signals_by_score_desc(&mut by_color.white);
    sort_signals_by_score_desc(&mut by_color.black);

    ProfileWeaknessModel {
        snapshot_key,
        model_version: WEAKNESS_MODEL_VERSION_V1,
        generated_at,
        total_games,
        scored_games,
        backfilled_games,
        signals,
        signals_by_color: by_color,
    }
}

pub fn compose_profile_signals_from_upserts(
    signal_rows: &[WeaknessSignalSnapshotUpsert],
    evidence_rows: &[WeaknessEvidenceUpsert],
) -> Vec<ProfileWeaknessSignal> {
    let mut evidence_by_signal: HashMap<String, Vec<&WeaknessEvidenceUpsert>> = HashMap::new();
    for ev in evidence_rows {
        evidence_by_signal
            .entry(ev.signal_key.clone())
            .or_default()
            .push(ev);
    }

    let mut out = Vec::with_capacity(signal_rows.len());
    for signal in signal_rows {
        let mut ev_rows = evidence_by_signal
            .remove(&signal.signal_key)
            .unwrap_or_default();
        ev_rows.sort_by_key(|ev| ev.evidence_rank);
        let evidence = ev_rows
            .into_iter()
            .map(|ev| ProfileWeaknessSignalEvidence {
                evidence_rank: ev.evidence_rank,
                game_id: ev.game_id,
                ply_from: ev.ply_from,
                ply_to: ev.ply_to,
                evidence_text: ev.evidence_text.clone(),
                evidence_json: ev.evidence_json.to_string(),
            })
            .collect::<Vec<_>>();

        out.push(ProfileWeaknessSignal {
            signal_key: normalize_signal_key(&signal.signal_key).to_string(),
            title: signal.title.clone(),
            trigger_text: signal.trigger_text.clone(),
            attack_plan: signal.attack_plan.clone(),
            score: signal.score,
            severity: signal.severity,
            confidence: signal.confidence,
            controllability: signal.controllability,
            recency: signal.recency,
            support: signal.support,
            n_eff: signal.n_eff,
            impact_json: signal.impact_json.to_string(),
            trigger_json: signal.trigger_json.to_string(),
            evidence,
        });
    }

    sort_signals_by_score_desc(&mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn structure_row_with_opening(
        game_id: i32,
        structures_by_ply: Value,
        opening_family: &str,
    ) -> WeaknessAggregationInputRow {
        WeaknessAggregationInputRow {
            game_id,
            timestamp_ms: None,
            profile_outcome: Some("loss".to_string()),
            opponent_name: Some("opp".to_string()),
            accuracy: Some(75.0),
            acpl: Some(80.0),
            blunder_rate: Some(0.12),
            mistake_rate: Some(0.16),
            inaccuracy_rate: Some(0.20),
            estimated_elo: Some(2000),
            opening_family: Some(opening_family.to_string()),
            time_control_bucket: Some("rapid".to_string()),
            color_played: Some("white".to_string()),
            game_length_ply: Some(48),
            ply_bucket_features_json: structures_by_ply,
            features_json: json!({
                "castling": { "uncastledByPly12": false },
                "rookActivity": { "firstRookActivationPly": 12 },
                "fileControl": {
                    "openFileControlDeltaPly20": 0,
                    "openFileControlDeltaFinal": 0,
                    "semiOpenFileControlDeltaPly20": 0,
                    "semiOpenFileControlDeltaFinal": 0
                }
            }),
        }
    }

    fn structure_row(game_id: i32, structures_by_ply: Value) -> WeaknessAggregationInputRow {
        structure_row_with_opening(game_id, structures_by_ply, "sicilian")
    }

    fn isabeast_row(game_id: i32, is_signal_hit: bool) -> WeaknessAggregationInputRow {
        let (outcome, acpl, accuracy, blunder_rate, mistake_rate, inaccuracy_rate) =
            if is_signal_hit {
                ("loss", 88.0, 71.0, 0.18, 0.24, 0.30)
            } else {
                ("win", 24.0, 93.0, 0.03, 0.06, 0.11)
            };

        WeaknessAggregationInputRow {
            game_id,
            timestamp_ms: None,
            profile_outcome: Some(outcome.to_string()),
            opponent_name: Some(format!("opp_{game_id}")),
            accuracy: Some(accuracy),
            acpl: Some(acpl),
            blunder_rate: Some(blunder_rate),
            mistake_rate: Some(mistake_rate),
            inaccuracy_rate: Some(inaccuracy_rate),
            estimated_elo: Some(2200),
            opening_family: None,
            time_control_bucket: None,
            color_played: None,
            game_length_ply: Some(46),
            ply_bucket_features_json: json!({}),
            features_json: json!({
                "castling": {
                    "uncastledByPly12": is_signal_hit,
                    "profilePly": if is_signal_hit { serde_json::Value::Null } else { json!(8) }
                },
                "rookActivity": {
                    "rooksConnectedByPly18": !is_signal_hit,
                    "firstRookActivationPly": if is_signal_hit { 22 } else { 12 }
                },
                "fileControl": {
                    "openFileControlDeltaPly20": if is_signal_hit { -1 } else { 1 },
                    "openFileControlDeltaFinal": if is_signal_hit { -1 } else { 1 },
                    "semiOpenFileControlDeltaPly20": if is_signal_hit { -1 } else { 1 },
                    "semiOpenFileControlDeltaFinal": if is_signal_hit { -1 } else { 1 }
                },
                "pressureTargets": {
                    "hTargetPressurePly": if is_signal_hit { json!(16) } else { serde_json::Value::Null },
                    "fTargetPressurePly": if is_signal_hit { json!(15) } else { serde_json::Value::Null }
                },
                "longEndgame": true,
                "gameLengthPly": 46
            }),
        }
    }

    fn staged_candidate(signal_key: &str, score: f64, game_ids: &[i32]) -> StagedSignalCandidate {
        let hit_game_ids = game_ids
            .iter()
            .copied()
            .collect::<std::collections::HashSet<_>>();
        StagedSignalCandidate {
            signal: WeaknessSignalSnapshotUpsert {
                signal_key: signal_key.to_string(),
                title: signal_key.to_string(),
                trigger_text: "trigger".to_string(),
                attack_plan: "plan".to_string(),
                score,
                severity: 0.5,
                confidence: 0.5,
                controllability: 0.5,
                recency: 0.5,
                support: game_ids.len() as i32,
                n_eff: Some(game_ids.len() as f64),
                impact_json: json!({}),
                trigger_json: json!({}),
            },
            evidence: Vec::new(),
            hit_game_ids,
            portfolio_cluster: signal_portfolio_cluster(signal_key),
        }
    }

    #[test]
    fn isabeast_all_any_all_all_time_returns_at_least_one_signal() {
        // Regression target:
        // profile "Isabeast" under filters all / any / all / all-time should yield >= 1 weakness signal.
        // This synthetic dataset emulates that full-filter scope with enough support.
        let mut rows: Vec<WeaknessAggregationInputRow> = Vec::new();
        for idx in 0..12 {
            rows.push(isabeast_row(1000 + idx, true));
        }
        for idx in 0..8 {
            rows.push(isabeast_row(2000 + idx, false));
        }

        let build = build_weakness_snapshot_v1(&rows, Some(12), Some(4));
        assert!(
            !build.signals.is_empty(),
            "Expected at least one weakness signal for Isabeast under all/any/all/all-time filters"
        );
        assert!(
            build
                .signals
                .iter()
                .any(|s| s.signal_key == "WM_UNCASTLED_EARLY"),
            "Expected WM_UNCASTLED_EARLY to be present in the generated signals"
        );
    }

    #[test]
    fn structure_catalog_v1_includes_dragon_iqp_and_carlsbad() {
        let keys = STRUCTURE_CATALOG_V1
            .iter()
            .map(|rule| rule.key)
            .collect::<Vec<_>>();

        assert!(
            keys.contains(&"SICILIAN_DRAGON_CLASSICAL"),
            "Phase 1 catalog must include Dragon (classical) structure"
        );
        assert!(
            keys.contains(&"IQP_PROFILE") && keys.contains(&"IQP_OPPONENT"),
            "Phase 1 catalog must include IQP perspectives"
        );
        assert!(
            keys.contains(&"CARLSBAD_PROFILE") && keys.contains(&"CARLSBAD_OPPONENT"),
            "Phase 1 catalog must include Carlsbad perspectives"
        );
    }

    #[test]
    fn structure_catalog_v1_includes_hanging_stonewall_and_benoni() {
        let keys = STRUCTURE_CATALOG_V1
            .iter()
            .map(|rule| rule.key)
            .collect::<Vec<_>>();

        assert!(
            keys.contains(&"HANGING_PAWNS_PROFILE") && keys.contains(&"HANGING_PAWNS_OPPONENT"),
            "Catalog must include hanging-pawns profile and opponent perspectives"
        );
        assert!(
            keys.contains(&"STONEWALL_PROFILE"),
            "Catalog must include Stonewall profile rule"
        );
        assert!(
            keys.contains(&"BENONI_OPPONENT"),
            "Catalog must include Benoni opponent rule"
        );
    }

    #[test]
    fn structure_catalog_v1_windows_are_valid() {
        for rule in STRUCTURE_CATALOG_V1 {
            assert!(
                rule.ply_from >= 1,
                "Invalid ply_from {} for {}",
                rule.ply_from,
                rule.key
            );
            assert!(
                rule.ply_to >= rule.ply_from,
                "Invalid window {}-{} for {}",
                rule.ply_from,
                rule.ply_to,
                rule.key
            );
            assert!(
                !rule.required.is_empty(),
                "Structure {} must define required conditions",
                rule.key
            );
            assert!(
                matches!(rule.perspective, "white" | "black" | "both"),
                "Invalid perspective '{}' for {}",
                rule.perspective,
                rule.key
            );
        }
    }

    #[test]
    fn detect_vs_dragon_signal_hit() {
        let row = structure_row(
            1,
            json!({
                "10": { "structures": { "vsDragon": true } },
                "12": { "structures": { "vsDragon": true } },
                "15": { "structures": { "vsDragon": true } }
            }),
        );
        let hit = detect_signal_hit("WM_VS_DRAGON_10_18", &row);
        assert!(
            hit.is_some(),
            "Expected Dragon signal hit from bucket flags"
        );
    }

    #[test]
    fn detect_iqp_signal_hit_profile_mode() {
        let row = structure_row(
            2,
            json!({
                "12": { "structures": { "profileIqp": true } },
                "20": { "structures": { "profileIqp": true } }
            }),
        );
        let hit = detect_signal_hit("WM_IQP_12_30", &row);
        assert!(hit.is_some(), "Expected IQP signal hit in profile mode");
        let payload = hit.unwrap().2;
        assert_eq!(
            payload.get("mode").and_then(|v| v.as_str()),
            Some("profileIqp")
        );
    }

    #[test]
    fn detect_carlsbad_signal_hit_vs_mode() {
        let row = structure_row(
            3,
            json!({
                "13": { "structures": { "vsCarlsbad": true } },
                "25": { "structures": { "vsCarlsbad": true } },
                "32": { "structures": { "vsCarlsbad": true } }
            }),
        );
        let hit = detect_signal_hit("WM_CARLSBAD_12_32", &row);
        assert!(hit.is_some(), "Expected Carlsbad signal hit in vs mode");
        let payload = hit.unwrap().2;
        assert_eq!(
            payload.get("mode").and_then(|v| v.as_str()),
            Some("vsCarlsbad")
        );
    }

    #[test]
    fn detect_accelerated_dragon_signal_hit() {
        let row = structure_row(
            4,
            json!({
                "8": { "structures": { "vsDragonAccelerated": true } },
                "12": { "structures": { "vsDragonAccelerated": true } }
            }),
        );
        let hit = detect_signal_hit("WM_VS_ACCELERATED_DRAGON_8_16", &row);
        assert!(hit.is_some(), "Expected Accelerated Dragon signal hit");
    }

    #[test]
    fn detect_french_chain_signal_hit_profile_mode() {
        let row = structure_row_with_opening(
            5,
            json!({
                "9": { "structures": { "profileFrenchChain": true } },
                "18": { "structures": { "profileFrenchChain": true } }
            }),
            "french",
        );
        let hit = detect_signal_hit("WM_FRENCH_CHAIN_8_22", &row);
        assert!(hit.is_some(), "Expected French-chain signal hit");
        let payload = hit.unwrap().2;
        assert_eq!(
            payload.get("mode").and_then(|v| v.as_str()),
            Some("profileFrenchChain")
        );
    }

    #[test]
    fn detect_kid_locked_center_signal_hit_vs_mode() {
        let row = structure_row_with_opening(
            6,
            json!({
                "10": { "structures": { "vsKidLockedCenter": true } },
                "21": { "structures": { "vsKidLockedCenter": true } }
            }),
            "kings-indian",
        );
        let hit = detect_signal_hit("WM_KID_LOCKED_CENTER_10_25", &row);
        assert!(hit.is_some(), "Expected KID locked-center signal hit");
        let payload = hit.unwrap().2;
        assert_eq!(
            payload.get("mode").and_then(|v| v.as_str()),
            Some("vsKidLockedCenter")
        );
    }

    #[test]
    fn detect_grunfeld_broad_center_signal_hit_profile_mode() {
        let row = structure_row_with_opening(
            7,
            json!({
                "8": { "structures": { "profileGrunfeldBroadCenter": true } },
                "17": { "structures": { "profileGrunfeldBroadCenter": true } }
            }),
            "grunfeld",
        );
        let hit = detect_signal_hit("WM_GRUNFELD_BROAD_CENTER_8_18", &row);
        assert!(hit.is_some(), "Expected Grunfeld broad-center signal hit");
        let payload = hit.unwrap().2;
        assert_eq!(
            payload.get("mode").and_then(|v| v.as_str()),
            Some("profileGrunfeldBroadCenter")
        );
    }

    #[test]
    fn detect_hanging_pawns_signal_hit_profile_mode() {
        let row = structure_row_with_opening(
            8,
            json!({
                "12": { "structures": { "profileHangingPawns": true } },
                "22": { "structures": { "profileHangingPawns": true } }
            }),
            "queens-gambit",
        );
        let hit = detect_signal_hit("WM_HANGING_PAWNS_12_30", &row);
        assert!(hit.is_some(), "Expected hanging-pawns signal hit");
        let payload = hit.unwrap().2;
        assert_eq!(
            payload.get("mode").and_then(|v| v.as_str()),
            Some("profileHangingPawns")
        );
    }

    #[test]
    fn detect_stonewall_signal_hit_vs_mode() {
        let row = structure_row_with_opening(
            9,
            json!({
                "10": { "structures": { "vsStonewall": true } },
                "24": { "structures": { "vsStonewall": true } }
            }),
            "flank-a",
        );
        let hit = detect_signal_hit("WM_STONEWALL_10_25", &row);
        assert!(hit.is_some(), "Expected Stonewall signal hit");
        let payload = hit.unwrap().2;
        assert_eq!(
            payload.get("mode").and_then(|v| v.as_str()),
            Some("vsStonewall")
        );
    }

    #[test]
    fn detect_vs_benoni_signal_hit() {
        let row = structure_row_with_opening(
            10,
            json!({
                "11": { "structures": { "vsBenoni": true } },
                "18": { "structures": { "vsBenoni": true } }
            }),
            "flank-a",
        );
        let hit = detect_signal_hit("WM_VS_BENONI_10_25", &row);
        assert!(hit.is_some(), "Expected Benoni signal hit");
    }

    #[test]
    fn french_chain_requires_opening_family_gate() {
        let row = structure_row_with_opening(
            11,
            json!({
                "9": { "structures": { "profileFrenchChain": true } },
                "18": { "structures": { "profileFrenchChain": true } }
            }),
            "sicilian",
        );
        let hit = detect_signal_hit("WM_FRENCH_CHAIN_8_22", &row);
        assert!(
            hit.is_none(),
            "French-chain signal must be gated out when opening family is not French"
        );
    }

    #[test]
    fn support_weight_increases_with_support() {
        let near_min = support_weight_from_support(MIN_SIGNAL_SUPPORT);
        let medium = support_weight_from_support(30);
        let high = support_weight_from_support(80);
        assert!(
            medium > near_min,
            "Support weight should increase after minimum support"
        );
        assert!(
            high > medium,
            "Support weight should keep increasing with larger support"
        );
        assert!(high <= 1.0, "Support weight must stay normalized");
    }

    #[test]
    fn context_weight_reflects_baseline_coverage() {
        let low = context_weight_from_rows(4, 20);
        let high = context_weight_from_rows(60, 20);
        assert!(
            high > low,
            "Context weight should grow with richer context baseline"
        );
        assert!(high <= 1.0, "Context weight must stay normalized");
    }

    #[test]
    fn wilson_interval_gets_tighter_with_more_samples() {
        let small_n = wilson_interval(7, 12).expect("small-n interval");
        let large_n = wilson_interval(58, 100).expect("large-n interval");
        let width_small = small_n.1 - small_n.0;
        let width_large = large_n.1 - large_n.0;
        assert!(
            width_large < width_small,
            "Wilson interval should shrink with larger sample size"
        );
    }

    #[test]
    fn signal_trend_marks_worsening_when_recent_window_degrades() {
        let mut rows: Vec<WeaknessAggregationInputRow> = Vec::new();
        let base_ts = 1_700_000_000_000_i64;
        for i in 0..12usize {
            let is_recent = i >= 6;
            rows.push(WeaknessAggregationInputRow {
                game_id: (100 + i) as i32,
                timestamp_ms: Some(base_ts + (i as i64) * 86_400_000),
                profile_outcome: Some(if is_recent {
                    "loss".to_string()
                } else {
                    "win".to_string()
                }),
                opponent_name: Some("opp".to_string()),
                accuracy: Some(if is_recent { 73.0 } else { 91.0 }),
                acpl: Some(if is_recent { 84.0 } else { 28.0 }),
                blunder_rate: Some(if is_recent { 0.16 } else { 0.04 }),
                mistake_rate: Some(if is_recent { 0.20 } else { 0.07 }),
                inaccuracy_rate: Some(if is_recent { 0.24 } else { 0.12 }),
                estimated_elo: Some(2100),
                opening_family: Some("sicilian".to_string()),
                time_control_bucket: Some("rapid".to_string()),
                color_played: Some("white".to_string()),
                game_length_ply: Some(50),
                ply_bucket_features_json: json!({}),
                features_json: json!({}),
            });
        }

        let hits: Vec<SignalHit> = rows
            .iter()
            .enumerate()
            .map(|(idx, _)| SignalHit {
                row_index: idx,
                ply_from: None,
                ply_to: None,
                trigger_payload: json!({}),
            })
            .collect();
        let trend = compute_signal_trend(&rows, &hits);
        assert_eq!(trend.label, "worsening");
        assert!(
            trend.weight > 1.0,
            "Worsening trend should boost score weight"
        );
        assert!(
            trend.delta_loss_rate_pp.unwrap_or(0.0) > 0.0,
            "Recent loss rate should be above previous window"
        );
    }

    #[test]
    fn portfolio_selector_deduplicates_high_overlap_inside_same_cluster() {
        let candidates = vec![
            staged_candidate(
                "WM_OPEN_FILE_CONTROL_LOSS",
                92.0,
                &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            ),
            staged_candidate(
                "WM_SEMIOPEN_FILE_CONTROL_LOSS",
                91.0,
                &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            ),
            staged_candidate(
                "WM_H7_H2_PRESSURE_DAMAGE",
                88.0,
                &[101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112],
            ),
        ];

        let selected = select_signal_portfolio(candidates, 2);
        let keys = selected
            .iter()
            .map(|c| c.signal.signal_key.as_str())
            .collect::<Vec<_>>();

        assert!(
            keys.contains(&"WM_OPEN_FILE_CONTROL_LOSS"),
            "Expected strongest file-control signal to remain in portfolio"
        );
        assert!(
            !keys.contains(&"WM_SEMIOPEN_FILE_CONTROL_LOSS"),
            "Expected redundant file-control twin to be filtered out"
        );
        assert!(
            keys.contains(&"WM_H7_H2_PRESSURE_DAMAGE"),
            "Expected different-cluster signal to survive for diversity"
        );
    }

    #[test]
    fn portfolio_selector_backfills_when_redundancy_would_underfill_target() {
        let candidates = vec![
            staged_candidate("WM_OPEN_FILE_CONTROL_LOSS", 90.0, &[1, 2, 3, 4, 5, 6]),
            staged_candidate("WM_SEMIOPEN_FILE_CONTROL_LOSS", 89.0, &[1, 2, 3, 4, 5, 6]),
        ];

        let selected = select_signal_portfolio(candidates, 2);
        assert_eq!(
            selected.len(),
            2,
            "Selector should backfill deferred candidates to avoid underfilled portfolio"
        );
    }
}

#[derive(Debug, Clone)]
struct SignalTrendSummary {
    label: &'static str, // worsening | stable | improving | insufficientData
    recent_count: usize,
    previous_count: usize,
    delta_loss_rate_pp: Option<f64>,
    delta_acpl: Option<f64>,
    weight: f64,
}

fn compute_signal_trend(
    rows: &[WeaknessAggregationInputRow],
    hits: &[SignalHit],
) -> SignalTrendSummary {
    let mut dated_indices: Vec<usize> = hits
        .iter()
        .filter_map(|hit| rows[hit.row_index].timestamp_ms.map(|_| hit.row_index))
        .collect();

    if dated_indices.len() < 8 {
        return SignalTrendSummary {
            label: "insufficientData",
            recent_count: 0,
            previous_count: 0,
            delta_loss_rate_pp: None,
            delta_acpl: None,
            weight: 1.0,
        };
    }

    dated_indices.sort_by_key(|idx| rows[*idx].timestamp_ms.unwrap_or(i64::MIN));
    let split = dated_indices.len() / 2;
    let (previous_indices, recent_indices) = dated_indices.split_at(split);
    if previous_indices.len() < 3 || recent_indices.len() < 3 {
        return SignalTrendSummary {
            label: "insufficientData",
            recent_count: recent_indices.len(),
            previous_count: previous_indices.len(),
            delta_loss_rate_pp: None,
            delta_acpl: None,
            weight: 1.0,
        };
    }

    let mut prev_loss_num = 0.0f64;
    let mut prev_loss_den = 0usize;
    let mut prev_acpl_sum = 0.0f64;
    let mut prev_acpl_n = 0usize;
    for idx in previous_indices {
        let row = &rows[*idx];
        if let Some(outcome) = row.profile_outcome.as_deref() {
            if outcome.eq_ignore_ascii_case("win") || outcome.eq_ignore_ascii_case("loss") {
                prev_loss_den += 1;
                if outcome.eq_ignore_ascii_case("loss") {
                    prev_loss_num += 1.0;
                }
            }
        }
        if let Some(acpl) = row.acpl {
            if acpl.is_finite() {
                prev_acpl_sum += acpl;
                prev_acpl_n += 1;
            }
        }
    }

    let mut recent_loss_num = 0.0f64;
    let mut recent_loss_den = 0usize;
    let mut recent_acpl_sum = 0.0f64;
    let mut recent_acpl_n = 0usize;
    for idx in recent_indices {
        let row = &rows[*idx];
        if let Some(outcome) = row.profile_outcome.as_deref() {
            if outcome.eq_ignore_ascii_case("win") || outcome.eq_ignore_ascii_case("loss") {
                recent_loss_den += 1;
                if outcome.eq_ignore_ascii_case("loss") {
                    recent_loss_num += 1.0;
                }
            }
        }
        if let Some(acpl) = row.acpl {
            if acpl.is_finite() {
                recent_acpl_sum += acpl;
                recent_acpl_n += 1;
            }
        }
    }

    let prev_loss_rate = mean(prev_loss_num, prev_loss_den);
    let recent_loss_rate = mean(recent_loss_num, recent_loss_den);
    let prev_acpl = mean(prev_acpl_sum, prev_acpl_n);
    let recent_acpl = mean(recent_acpl_sum, recent_acpl_n);

    let delta_loss_rate_pp = match (recent_loss_rate, prev_loss_rate) {
        (Some(recent), Some(previous)) => Some((recent - previous) * 100.0),
        _ => None,
    };
    let delta_acpl = match (recent_acpl, prev_acpl) {
        (Some(recent), Some(previous)) => Some(recent - previous),
        _ => None,
    };

    let has_signal = delta_loss_rate_pp.is_some() || delta_acpl.is_some();
    if !has_signal {
        return SignalTrendSummary {
            label: "insufficientData",
            recent_count: recent_indices.len(),
            previous_count: previous_indices.len(),
            delta_loss_rate_pp: None,
            delta_acpl: None,
            weight: 1.0,
        };
    }

    let mut trend_score = 0.0f64;
    if let Some(v) = delta_loss_rate_pp {
        trend_score += (v / 12.0).clamp(-1.0, 1.0) * 0.7;
    }
    if let Some(v) = delta_acpl {
        trend_score += (v / 24.0).clamp(-1.0, 1.0) * 0.3;
    }
    trend_score = trend_score.clamp(-1.0, 1.0);

    let (label, weight) = if trend_score >= 0.2 {
        ("worsening", 1.04 + (trend_score.abs() * 0.08))
    } else if trend_score <= -0.2 {
        ("improving", 0.96 - (trend_score.abs() * 0.06))
    } else {
        ("stable", 1.0)
    };

    SignalTrendSummary {
        label,
        recent_count: recent_indices.len(),
        previous_count: previous_indices.len(),
        delta_loss_rate_pp: delta_loss_rate_pp.map(round2),
        delta_acpl: delta_acpl.map(round2),
        weight: round2(weight.clamp(0.85, 1.15)),
    }
}
