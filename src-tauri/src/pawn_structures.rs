use crate::db::{get_games, GameQueryJs, GameSort, NormalizedGame, QueryOptions, Sides, SortDirection};
use crate::error::{Error, Result};
use chrono::Datelike;
use shakmaty::{fen::Fen, CastlingMode, Chess, Color, EnPassantMode, FromSetup, Position};
use shakmaty::san::SanPlus;
use shakmaty::uci::UciMove;
use specta::Type;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::State;

#[derive(Debug, Clone, Type, serde::Serialize, serde::Deserialize)]
pub struct PawnStructureStat {
    pub structure: String,
    pub frequency: i32,
    pub win_rate: f64,
    pub sample_fen: Option<String>,
    pub games: Vec<PawnStructureGame>,
}

#[derive(Debug, Clone, Type, serde::Serialize, serde::Deserialize)]
pub struct PawnStructureGame {
    pub game_id: i32,
    pub white: String,
    pub black: String,
    pub white_elo: Option<i32>,
    pub black_elo: Option<i32>,
    pub result: String,
    pub fen: String,
}

#[derive(Debug, Clone, Type, serde::Serialize, serde::Deserialize)]
pub struct PawnStructureOptions {
    #[serde(rename = "playerIds")]
    pub player_ids: Vec<i32>,

    #[serde(rename = "colorFilter")]
    pub color_filter: String, // "white" | "black" | "any" (o vacío)

    #[serde(rename = "platformFilter")]
    pub platform_filter: String, // "all" | "any" | "Chess.com" | "Lichess"

    #[serde(rename = "timeControlFilter")]
    pub time_control_filter: String, // "any" | "all" | "bullet" | "blitz" | ...

    #[serde(rename = "opponentEloBucket")]
    pub opponent_elo_bucket: String, // "all" | "any" | "1200" | etc.

    /// Date range filter: "SevenDays" | "ThirtyDays" | "NinetyDays" | "OneYear" | "All" | null
    /// If null or "All", no date filtering is applied.
    #[serde(rename = "dateRange", default)]
    pub date_range: Option<String>,

    #[serde(rename = "moveNumber")]
    pub move_number: i32, // 1-based fullmove. Si llega <=0, se toma la posición inicial.

    #[serde(rename = "playerColor")]
    pub player_color: String, // "white" | "black" | "any" (o vacío)

    #[serde(rename = "pawnStructureMode")]
    pub pawn_structure_mode: String, // "player" | "both"

    /// Optional pawn-structure motif filters, applied server-side.
    /// When empty, no motif filtering is applied.
    #[serde(rename = "structureFilters", default)]
    pub structure_filters: Vec<String>,

    /// Optional named pawn-structure filters (e.g. "carlsbad", "najdorf").
    /// OR semantics within the list: if any selected structure matches, the stat is kept.
    #[serde(rename = "structureNameFilters", default)]
    pub structure_name_filters: Vec<String>,
}

fn parse_structure_filters(filters: &[String]) -> Vec<String> {
    filters
        .iter()
        .map(|s| normalize_filter_value(s))
        .filter(|s| !s.is_empty())
        .collect()
}

#[derive(Debug, Clone, Copy)]
struct PawnSets {
    // pawn counts per file (0..7)
    file_counts: [u8; 8],
    // pawn presence per file+rank (rank 0..7 from White's perspective; 0 = rank1)
    squares: [[bool; 8]; 8],
}

fn pawn_sets_from_fen(fen: &str, color: Color) -> PawnSets {
    let placement = fen.split_whitespace().next().unwrap_or("");
    let mut squares: Vec<char> = Vec::with_capacity(64);
    for ch in placement.chars() {
        if ch == '/' {
            continue;
        }
        if ch.is_ascii_digit() {
            let n = ch.to_digit(10).unwrap_or(0) as usize;
            squares.extend(std::iter::repeat('.').take(n));
        } else {
            squares.push(ch);
        }
    }
    if squares.len() != 64 {
        return PawnSets {
            file_counts: [0; 8],
            squares: [[false; 8]; 8],
        };
    }

    let pawn_char = match color {
        Color::White => 'P',
        Color::Black => 'p',
    };

    let mut out = PawnSets {
        file_counts: [0; 8],
        squares: [[false; 8]; 8],
    };

    // FEN ranks are 8..1; convert to rank index from White's perspective (0..7, 0=rank1)
    for fen_rank in 0..8 {
        for file in 0..8 {
            let idx = fen_rank * 8 + file;
            if squares[idx] == pawn_char {
                let white_rank = 7usize.saturating_sub(fen_rank); // fen_rank 0 (rank8) -> 7 (rank1)?? Actually we want 0=rank1, so invert.
                // Wait: fen_rank 7 (rank1) -> 0, fen_rank 0 (rank8) -> 7
                let r = white_rank;
                out.squares[file][r] = true;
                out.file_counts[file] = out.file_counts[file].saturating_add(1);
            }
        }
    }

    out
}

fn count_pawn_islands(ps: &PawnSets) -> u8 {
    let mut islands = 0u8;
    let mut in_island = false;
    for f in 0..8 {
        let has = ps.file_counts[f] > 0;
        if has && !in_island {
            islands += 1;
            in_island = true;
        } else if !has {
            in_island = false;
        }
    }
    islands
}

fn has_isolated_pawn(ps: &PawnSets) -> bool {
    for f in 0..8 {
        if ps.file_counts[f] == 0 {
            continue;
        }
        let left = if f > 0 { ps.file_counts[f - 1] } else { 0 };
        let right = if f < 7 { ps.file_counts[f + 1] } else { 0 };
        if left == 0 && right == 0 {
            return true;
        }
    }
    false
}

fn has_doubled_pawns(ps: &PawnSets) -> bool {
    ps.file_counts.iter().any(|&c| c >= 2)
}

fn is_passed_pawn(color: Color, _ps: &PawnSets, opp: &PawnSets, file: usize, rank: usize) -> bool {
    // For White: pawns advance to higher ranks; for Black: to lower ranks (from White perspective).
    let files = [file.saturating_sub(1), file, (file + 1).min(7)];
    match color {
        Color::White => {
            for f in files {
                for r in (rank + 1)..8 {
                    if opp.squares[f][r] {
                        return false;
                    }
                }
            }
            true
        }
        Color::Black => {
            for f in files {
                for r in 0..rank {
                    if opp.squares[f][r] {
                        return false;
                    }
                }
            }
            true
        }
    }
}

fn has_passed_pawn(color: Color, ps: &PawnSets, opp: &PawnSets) -> bool {
    for f in 0..8 {
        for r in 0..8 {
            if ps.squares[f][r] && is_passed_pawn(color, ps, opp, f, r) {
                return true;
            }
        }
    }
    false
}

fn has_connected_passed_pawns(color: Color, ps: &PawnSets, opp: &PawnSets) -> bool {
    let mut passed_by_file: [bool; 8] = [false; 8];
    for f in 0..8 {
        'r: for r in 0..8 {
            if ps.squares[f][r] && is_passed_pawn(color, ps, opp, f, r) {
                passed_by_file[f] = true;
                break 'r;
            }
        }
    }
    for f in 0..7 {
        if passed_by_file[f] && passed_by_file[f + 1] {
            return true;
        }
    }
    false
}

fn has_hanging_pawns(ps: &PawnSets) -> bool {
    // Classic heuristic: pawns on c/d without pawns on b/e.
    let c = ps.file_counts[2] > 0;
    let d = ps.file_counts[3] > 0;
    let b = ps.file_counts[1] > 0;
    let e = ps.file_counts[4] > 0;
    c && d && !b && !e
}

fn has_iqp(ps: &PawnSets) -> bool {
    // Classic IQP heuristic: pawn on d-file, no pawns on c/e.
    let d = ps.file_counts[3] > 0;
    let c = ps.file_counts[2] > 0;
    let e = ps.file_counts[4] > 0;
    d && !c && !e
}

fn has_fianchetto(color: Color, ps: &PawnSets) -> bool {
    match color {
        Color::White => {
            // g3 + f2 + h2
            let g3 = ps.squares[6][2];
            let f2 = ps.squares[5][1];
            let h2 = ps.squares[7][1];
            g3 && f2 && h2
        }
        Color::Black => {
            // g6 + f7 + h7
            let g6 = ps.squares[6][5];
            let f7 = ps.squares[5][6];
            let h7 = ps.squares[7][6];
            g6 && f7 && h7
        }
    }
}

fn has_minority_attack_pattern(color: Color, ps: &PawnSets, opp: &PawnSets) -> bool {
    // Classic heuristic: a+b vs opponent a+b+c (queenside minority).
    // This is a very rough approximation of the pawn-structure prerequisite for a minority attack.
    let has_a = ps.file_counts[0] > 0;
    let has_b = ps.file_counts[1] > 0;
    let opp_has_a = opp.file_counts[0] > 0;
    let opp_has_b = opp.file_counts[1] > 0;
    let opp_has_c = opp.file_counts[2] > 0;
    // Require both a and b pawns for the attacker, and a+b+c for the defender.
    // Color is unused here but kept for symmetry/future improvements.
    let _ = color;
    has_a && has_b && opp_has_a && opp_has_b && opp_has_c
}

fn has_backward_pawn(color: Color, ps: &PawnSets, opp: &PawnSets) -> bool {
    // Heuristic: pawn behind adjacent-file pawns, with its advance square attacked by an enemy pawn.
    // This is a simplified detector meant for filtering, not a full strategic evaluator.
    for f in 0..8 {
        for r in 0..8 {
            if !ps.squares[f][r] {
                continue;
            }

            // Adjacent friendly pawns are more advanced?
            let left_advanced = if f > 0 {
                (0..8).any(|rr| ps.squares[f - 1][rr] && match color { Color::White => rr > r, Color::Black => rr < r })
            } else {
                false
            };
            let right_advanced = if f < 7 {
                (0..8).any(|rr| ps.squares[f + 1][rr] && match color { Color::White => rr > r, Color::Black => rr < r })
            } else {
                false
            };
            if !(left_advanced || right_advanced) {
                continue;
            }

            // Advance square exists?
            let advance_rank = match color {
                Color::White => {
                    if r >= 7 { continue; }
                    r + 1
                }
                Color::Black => {
                    if r == 0 { continue; }
                    r - 1
                }
            };

            // Is the advance square attacked by an enemy pawn?
            // Enemy pawn attacks depend on enemy color (opponent of `color`).
            let attacked = match color {
                Color::White => {
                    // black pawns attack downwards: from (f-1, advance_rank+1) or (f+1, advance_rank+1)
                    let src_rank = advance_rank + 1;
                    if src_rank >= 8 { false } else {
                        (f > 0 && opp.squares[f - 1][src_rank]) || (f < 7 && opp.squares[f + 1][src_rank])
                    }
                }
                Color::Black => {
                    // white pawns attack upwards: from (f-1, advance_rank-1) or (f+1, advance_rank-1)
                    if advance_rank == 0 { false } else {
                        let src_rank = advance_rank - 1;
                        (f > 0 && opp.squares[f - 1][src_rank]) || (f < 7 && opp.squares[f + 1][src_rank])
                    }
                }
            };
            if attacked {
                return true;
            }
        }
    }
    false
}

fn detect_motif_mask(fen: &str, player_color: Color, mode: &str) -> u32 {
    let mode_norm = normalize_filter_value(mode);
    let analyze_both = mode_norm == "both";

    let mut mask: u32 = 0;

    // Bit assignments
    const ISLANDS: u32 = 1 << 0;
    const ISOLATED: u32 = 1 << 1;
    const DOUBLED: u32 = 1 << 2;
    const PASSED: u32 = 1 << 3;
    const HANGING: u32 = 1 << 4;
    const BACKWARD: u32 = 1 << 5;
    const MINORITY_ATTACK: u32 = 1 << 6;
    const IQP: u32 = 1 << 7;
    const CONNECTED_PASSED: u32 = 1 << 8;
    const FIANCHETTO: u32 = 1 << 9;

    let colors: Vec<Color> = if analyze_both { vec![Color::White, Color::Black] } else { vec![player_color] };
    for c in colors {
        let ps = pawn_sets_from_fen(fen, c);
        let opp = pawn_sets_from_fen(fen, if c == Color::White { Color::Black } else { Color::White });

        if count_pawn_islands(&ps) >= 3 {
            mask |= ISLANDS;
        }
        if has_isolated_pawn(&ps) {
            mask |= ISOLATED;
        }
        if has_doubled_pawns(&ps) {
            mask |= DOUBLED;
        }
        if has_passed_pawn(c, &ps, &opp) {
            mask |= PASSED;
        }
        if has_connected_passed_pawns(c, &ps, &opp) {
            mask |= CONNECTED_PASSED;
        }
        if has_hanging_pawns(&ps) {
            mask |= HANGING;
        }
        if has_backward_pawn(c, &ps, &opp) {
            mask |= BACKWARD;
        }
        if has_minority_attack_pattern(c, &ps, &opp) {
            mask |= MINORITY_ATTACK;
        }
        if has_iqp(&ps) {
            mask |= IQP;
        }
        if has_fianchetto(c, &ps) {
            mask |= FIANCHETTO;
        }
    }

    mask
}

fn motif_filter_mask(filters: &[String]) -> u32 {
    let mut mask: u32 = 0;
    for f in parse_structure_filters(filters) {
        match f.as_str() {
            "islands" => mask |= 1 << 0,
            "isolated" => mask |= 1 << 1,
            "doubled" => mask |= 1 << 2,
            "passed" => mask |= 1 << 3,
            "hanging" => mask |= 1 << 4,
            "backward" => mask |= 1 << 5,
            "minority_attack" => mask |= 1 << 6,
            "iqp" => mask |= 1 << 7,
            "connected_passed" => mask |= 1 << 8,
            "fianchetto" => mask |= 1 << 9,
            _ => {}
        }
    }
    mask
}

fn named_structure_filter_mask(filters: &[String]) -> u32 {
    let mut mask: u32 = 0;
    for f in parse_structure_filters(filters) {
        match f.as_str() {
            "carlsbad" => mask |= 1 << 0,
            "maroczy_bind" => mask |= 1 << 1,
            "hedgehog" => mask |= 1 << 2,
            "stonewall" => mask |= 1 << 3,
            "scheveningen" => mask |= 1 << 4,
            "najdorf" => mask |= 1 << 5,
            "dragon" => mask |= 1 << 6,
            "benoni" => mask |= 1 << 7,
            "benko" => mask |= 1 << 8,
            "french" => mask |= 1 << 9,
            "slav" => mask |= 1 << 10,
            "semi_slav_triangle" => mask |= 1 << 11,
            "kings_indian" => mask |= 1 << 12,
            _ => {}
        }
    }
    mask
}

fn has_pawn(ps: &PawnSets, file: usize, rank: usize) -> bool {
    ps.squares[file][rank]
}

fn detect_named_structure_mask(fen: &str, player_color: Color, mode: &str) -> u32 {
    let mode_norm = normalize_filter_value(mode);
    let analyze_both = mode_norm == "both";

    let mut mask: u32 = 0;

    // Bit assignments match named_structure_filter_mask above.
    const CARLSBAD: u32 = 1 << 0;
    const MAROCZY: u32 = 1 << 1;
    const HEDGEHOG: u32 = 1 << 2;
    const STONEWALL: u32 = 1 << 3;
    const SCHEVENINGEN: u32 = 1 << 4;
    const NAJDORF: u32 = 1 << 5;
    const DRAGON: u32 = 1 << 6;
    const BENONI: u32 = 1 << 7;
    const BENKO: u32 = 1 << 8;
    const FRENCH: u32 = 1 << 9;
    const SLAV: u32 = 1 << 10;
    const SEMI_SLAV_TRI: u32 = 1 << 11;
    const KINGS_INDIAN: u32 = 1 << 12;

    let colors: Vec<Color> = if analyze_both { vec![Color::White, Color::Black] } else { vec![player_color] };
    for c in colors {
        let ps = pawn_sets_from_fen(fen, c);
        let opp = pawn_sets_from_fen(fen, if c == Color::White { Color::Black } else { Color::White });

        // Helpers: file indices a=0..h=7, rank indices 0=rank1..7=rank8 (White perspective)
        // Note: These are heuristics for filtering.

        // Carlsbad (strict): White pawns on a2, b2, d4, e3, f2, g2, h2
        // Black pawns on a7, b7, c6, d5, f7, g7, h7
        let carlsbad = match c {
            Color::White => {
                // White pawns: a2(0,1), b2(1,1), d4(3,3), e3(4,2), f2(5,1), g2(6,1), h2(7,1)
                // Black pawns: a7(0,6), b7(1,6), c6(2,5), d5(3,4), f7(5,6), g7(6,6), h7(7,6)
                has_pawn(&ps, 0, 1) && has_pawn(&ps, 1, 1) && has_pawn(&ps, 3, 3) && has_pawn(&ps, 4, 2)
                    && has_pawn(&ps, 5, 1) && has_pawn(&ps, 6, 1) && has_pawn(&ps, 7, 1)
                    && has_pawn(&opp, 0, 6) && has_pawn(&opp, 1, 6) && has_pawn(&opp, 2, 5) && has_pawn(&opp, 3, 4)
                    && has_pawn(&opp, 5, 6) && has_pawn(&opp, 6, 6) && has_pawn(&opp, 7, 6)
            }
            Color::Black => {
                // Black pawns: a7(0,6), b7(1,6), c6(2,5), d5(3,4), f7(5,6), g7(6,6), h7(7,6)
                // White pawns: a2(0,1), b2(1,1), d4(3,3), e3(4,2), f2(5,1), g2(6,1), h2(7,1)
                has_pawn(&ps, 0, 6) && has_pawn(&ps, 1, 6) && has_pawn(&ps, 2, 5) && has_pawn(&ps, 3, 4)
                    && has_pawn(&ps, 5, 6) && has_pawn(&ps, 6, 6) && has_pawn(&ps, 7, 6)
                    && has_pawn(&opp, 0, 1) && has_pawn(&opp, 1, 1) && has_pawn(&opp, 3, 3) && has_pawn(&opp, 4, 2)
                    && has_pawn(&opp, 5, 1) && has_pawn(&opp, 6, 1) && has_pawn(&opp, 7, 1)
            }
        };
        if carlsbad {
            mask |= CARLSBAD;
        }

        // Maróczy Bind: White pawns c4 + e4 (vs Sicilian structures). We'll just require c4+e4 for one side.
        let maroczy = match c {
            Color::White => has_pawn(&ps, 2, 3) && has_pawn(&ps, 4, 3),
            Color::Black => has_pawn(&opp, 2, 3) && has_pawn(&opp, 4, 3),
        };
        if maroczy {
            mask |= MAROCZY;
        }

        // Hedgehog: classic black setup pawns a6 b6 d6 e6 (white often has c4,e4).
        // We'll detect presence of a6+b6+d6+e6 for one side.
        let hedgehog = match c {
            Color::White => has_pawn(&opp, 0, 5) && has_pawn(&opp, 1, 5) && has_pawn(&opp, 3, 5) && has_pawn(&opp, 4, 5),
            Color::Black => has_pawn(&ps, 0, 5) && has_pawn(&ps, 1, 5) && has_pawn(&ps, 3, 5) && has_pawn(&ps, 4, 5),
        };
        if hedgehog {
            mask |= HEDGEHOG;
        }

        // Stonewall: pawns c3 d4 e3 f4 (white) or c6 d5 e6 f5 (black).
        let stonewall_white = has_pawn(&ps, 2, 2) && has_pawn(&ps, 3, 3) && has_pawn(&ps, 4, 2) && has_pawn(&ps, 5, 3);
        let stonewall_black = has_pawn(&ps, 2, 5) && has_pawn(&ps, 3, 4) && has_pawn(&ps, 4, 5) && has_pawn(&ps, 5, 4);
        if stonewall_white || stonewall_black {
            mask |= STONEWALL;
        }

        // Scheveningen: black pawns c5 d6 e6
        let schev = has_pawn(&ps, 2, 4) && has_pawn(&ps, 3, 5) && has_pawn(&ps, 4, 5);
        if schev {
            mask |= SCHEVENINGEN;
        }

        // Najdorf: black pawns a6 + c5 + d6
        let najdorf = has_pawn(&ps, 0, 5) && has_pawn(&ps, 2, 4) && has_pawn(&ps, 3, 5);
        if najdorf {
            mask |= NAJDORF;
        }

        // Dragon: black pawns g6 + c5 + d6
        let dragon = has_pawn(&ps, 6, 5) && has_pawn(&ps, 2, 4) && has_pawn(&ps, 3, 5);
        if dragon {
            mask |= DRAGON;
        }

        // Benoni: black pawns c5 + d6 and white pawn d5
        let benoni = has_pawn(&ps, 2, 4) && has_pawn(&ps, 3, 5) && has_pawn(&opp, 3, 4);
        if benoni {
            mask |= BENONI;
        }

        // Benko: black pawns a6 + b5 + c5
        let benko = has_pawn(&ps, 0, 5) && has_pawn(&ps, 1, 4) && has_pawn(&ps, 2, 4);
        if benko {
            mask |= BENKO;
        }

        // French: black d5+e6 AND white d4+e5
        let french = has_pawn(&ps, 3, 4) && has_pawn(&ps, 4, 5) && has_pawn(&opp, 3, 3) && has_pawn(&opp, 4, 4);
        if french {
            mask |= FRENCH;
        }

        // Slav: black c6+d5
        let slav = has_pawn(&ps, 2, 5) && has_pawn(&ps, 3, 4);
        if slav {
            mask |= SLAV;
        }

        // Semi-Slav triangle: black c6+d5+e6
        let semi_slav = has_pawn(&ps, 2, 5) && has_pawn(&ps, 3, 4) && has_pawn(&ps, 4, 5);
        if semi_slav {
            mask |= SEMI_SLAV_TRI;
        }

        // King's Indian: black d6+e5+g6
        let kings_indian = has_pawn(&ps, 3, 5) && has_pawn(&ps, 4, 4) && has_pawn(&ps, 6, 5);
        if kings_indian {
            mask |= KINGS_INDIAN;
        }
    }

    mask
}

fn normalize_platform(site: &str) -> Option<String> {
    let lower = site.trim().to_lowercase();
    let condensed: String = lower.chars().filter(|c| c.is_alphanumeric()).collect();
    if condensed.contains("chesscom") || lower.contains("chess.com") {
        Some("Chess.com".to_string())
    } else if condensed.contains("lichess") || lower.contains("lichess") {
        Some("Lichess".to_string())
    } else {
        None
    }
}

fn normalize_filter_value(raw: &str) -> String {
    raw.trim().to_lowercase()
}

fn is_all_any(value: &str) -> bool {
    let v = normalize_filter_value(value);
    v.is_empty() || v == "any" || v == "all"
}

/// Calculate earliest date from date range.
/// Returns date in PGN format (YYYY.MM.DD) or None if range is "All" or invalid.
/// Accepts backend format ("SevenDays", "ThirtyDays", "NinetyDays", "OneYear", "All").
fn calculate_earliest_date_from_range(date_range: &Option<String>) -> Option<String> {
    let range = date_range.as_ref()?;
    let range_norm = normalize_filter_value(range);
    
    if range_norm == "all" || range_norm.is_empty() {
        return None;
    }
    
    // Calculate days to subtract based on range
    // Backend format: "SevenDays", "ThirtyDays", "NinetyDays", "OneYear" (normalized to lowercase)
    let days = match range_norm.as_str() {
        "sevendays" => 7,
        "thirtydays" => 30,
        "ninetydays" => 90,
        "oneyear" => 365,
        _ => return None,
    };
    
    // Get current date in UTC
    let now = chrono::Utc::now();
    let earliest = now - chrono::Duration::days(days as i64);
    
    // Format as PGN date (YYYY.MM.DD)
    Some(format!("{:04}.{:02}.{:02}", earliest.year(), earliest.month(), earliest.day()))
}

fn get_time_control(_site: &str, time_control: &str) -> Option<String> {
    let tc_lower = time_control.to_lowercase();

    if tc_lower.contains("ultrabullet") || tc_lower.contains("0+1") || tc_lower.contains("0+2") {
        return Some("ultra_bullet".to_string());
    }
    if tc_lower.contains("bullet")
        || tc_lower.contains("1+0")
        || tc_lower.contains("1+1")
        || tc_lower.contains("2+1")
        || tc_lower.contains("2+0")
    {
        return Some("bullet".to_string());
    }
    if tc_lower.contains("blitz")
        || tc_lower.contains("3+0")
        || tc_lower.contains("3+2")
        || tc_lower.contains("5+0")
        || tc_lower.contains("5+3")
    {
        return Some("blitz".to_string());
    }
    if tc_lower.contains("rapid")
        || tc_lower.contains("10+0")
        || tc_lower.contains("10+5")
        || tc_lower.contains("15+0")
        || tc_lower.contains("15+10")
    {
        return Some("rapid".to_string());
    }
    if tc_lower.contains("classical") || tc_lower.contains("30+0") || tc_lower.contains("30+20") {
        return Some("classical".to_string());
    }
    if tc_lower.contains("correspondence") {
        return Some("correspondence".to_string());
    }
    if tc_lower.contains("daily") {
        return Some("daily".to_string());
    }

    None
}

/// Firma “real” de estructura de peones: tablero completo manteniendo SOLO peones.
fn pawn_structure_signature_from_fen(fen: &str, mode: &str, player_color: Color) -> String {
    let placement = fen.split_whitespace().next().unwrap_or("");
    if placement.is_empty() {
        return String::new();
    }

    let mut squares: Vec<char> = Vec::with_capacity(64);
    for ch in placement.chars() {
        if ch == '/' {
            continue;
        }
        if ch.is_ascii_digit() {
            let n = ch.to_digit(10).unwrap_or(0) as usize;
            squares.extend(std::iter::repeat('.').take(n));
        } else {
            squares.push(ch);
        }
    }
    if squares.len() != 64 {
        return String::new();
    }

    let keep_both = normalize_filter_value(mode) == "both";

    let mut out = String::new();
    for rank in 0..8 {
        if rank > 0 {
            out.push('/');
        }
        let mut empty_run = 0usize;

        for file in 0..8 {
            let idx = rank * 8 + file;
            let ch = squares[idx];

            let keep = if keep_both {
                ch == 'P' || ch == 'p'
            } else {
                match player_color {
                    Color::White => ch == 'P',
                    Color::Black => ch == 'p',
                }
            };

            if keep {
                if empty_run > 0 {
                    out.push_str(&empty_run.to_string());
                    empty_run = 0;
                }
                out.push(if keep_both { ch } else { 'P' });
            } else {
                empty_run += 1;
            }
        }

        if empty_run > 0 {
            out.push_str(&empty_run.to_string());
        }
    }

    out
}

fn determine_win(result: &str, player_color: Color) -> f64 {
    match (result, player_color) {
        ("1-0", Color::White) | ("0-1", Color::Black) => 1.0,
        ("1/2-1/2", _) => 0.5,
        ("0-1", Color::White) | ("1-0", Color::Black) => 0.0,
        _ => 0.0,
    }
}

fn strip_pgn_noise(movetext: &str) -> String {
    let mut out = String::with_capacity(movetext.len());
    let mut in_brace = false;
    let mut in_line = false;
    let mut paren_depth: usize = 0;

    for ch in movetext.chars() {
        if in_line {
            if ch == '\n' || ch == '\r' {
                in_line = false;
                out.push(' ');
            }
            continue;
        }

        if in_brace {
            if ch == '}' {
                in_brace = false;
                out.push(' ');
            }
            continue;
        }

        if paren_depth > 0 {
            if ch == '(' {
                paren_depth += 1;
            } else if ch == ')' {
                paren_depth = paren_depth.saturating_sub(1);
                if paren_depth == 0 {
                    out.push(' ');
                }
            }
            continue;
        }

        match ch {
            '{' => in_brace = true,
            ';' => in_line = true,
            '(' => paren_depth = 1,
            _ => out.push(ch),
        }
    }

    out
}

fn strip_move_number_prefix(token: &str) -> &str {
    let mut t = token.trim();

    if t.starts_with("...") {
        t = &t[3..];
    }

    let bytes = t.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }

    if i > 0 && i < bytes.len() && bytes[i] == b'.' {
        let mut j = i;
        while j < bytes.len() && bytes[j] == b'.' {
            j += 1;
        }
        t = &t[j..];
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
    if t.is_empty() {
        return true;
    }
    t.chars().all(|c| c.is_ascii_digit() || c == '.')
}

fn tokenize_moves(movetext: &str) -> Vec<String> {
    let cleaned = strip_pgn_noise(movetext);
    let mut out: Vec<String> = Vec::new();

    for raw in cleaned.split_whitespace() {
        if raw.is_empty() {
            continue;
        }

        if raw.starts_with('$') && raw[1..].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }

        let mut t = strip_move_number_prefix(raw).to_string();
        if t.is_empty() {
            continue;
        }

        while t.ends_with('.') && t.chars().all(|c| c.is_ascii_digit() || c == '.') {
            t.pop();
        }

        let ttrim = t.trim();
        if ttrim.is_empty() {
            continue;
        }

        if is_result_token(ttrim) || is_move_number_token(ttrim) {
            continue;
        }

        out.push(ttrim.to_string());
    }

    out
}

/// Intenta parsear token como SAN(+suffix) y si falla como UCI.
fn token_to_move(token: &str, pos: &Chess) -> Option<shakmaty::Move> {
    // ✅ FIX: en tu versión SanPlus no tiene to_move(); el SAN vive en sp.san
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

/// Extrae estructura (y FEN) después de la jugada del jugador en el fullmove `move_number`.
fn extract_structure_at_move(
    game: &NormalizedGame,
    move_number: i32,
    player_color: Color,
    pawn_structure_mode: &str,
) -> Result<Option<(String, String)>> {
    let mut pos: Chess = if game.fen.trim().is_empty() {
        Chess::default()
    } else {
        let fen: Fen = game
            .fen
            .as_str()
            .parse()
            .map_err(|_| Error::FenError("Invalid FEN".to_string()))?;
        Chess::from_setup(fen.into(), CastlingMode::Standard)
            .map_err(|_| Error::FenError("Invalid FEN".to_string()))?
    };

    if move_number <= 0 {
        let fen_now = Fen::from_setup(pos.clone().into_setup(EnPassantMode::Legal)).to_string();
        let sig = pawn_structure_signature_from_fen(&fen_now, pawn_structure_mode, player_color);
        return Ok(Some((sig, fen_now)));
    }

    let tokens = tokenize_moves(&game.moves);
    if tokens.is_empty() {
        return Ok(None);
    }

    for tok in tokens {
        let mover = pos.turn();
        let current_fullmove = pos.fullmoves().get() as i32;

        let mv = match token_to_move(&tok, &pos) {
            Some(mv) => mv,
            None => {
                // token raro → abortamos esta partida para no des-sincronizar
                return Ok(None);
            }
        };

        if mover == player_color && current_fullmove == move_number {
            pos.play_unchecked(&mv);

            let fen_after = Fen::from_setup(pos.clone().into_setup(EnPassantMode::Legal)).to_string();
            let signature = if normalize_filter_value(pawn_structure_mode) == "both" {
                pawn_structure_signature_from_fen(&fen_after, "both", player_color)
            } else {
                pawn_structure_signature_from_fen(&fen_after, "player", player_color)
            };

            return Ok(Some((signature, fen_after)));
        }

        pos.play_unchecked(&mv);
    }

    Ok(None)
}

#[tauri::command]
#[specta::specta]
pub async fn compute_pawn_structures(
    file: PathBuf,
    options: PawnStructureOptions,
    state: State<'_, crate::AppState>,
) -> Result<Vec<PawnStructureStat>> {
    let cf = normalize_filter_value(&options.color_filter);
    let pc = normalize_filter_value(&options.player_color);
    let color_choice = if !cf.is_empty() { cf } else { pc };

    let platform_choice_raw = normalize_filter_value(&options.platform_filter);
    let platform_all = is_all_any(&platform_choice_raw);

    let tc_choice_raw = normalize_filter_value(&options.time_control_filter);
    let tc_all = is_all_any(&tc_choice_raw);

    let elo_choice_raw = normalize_filter_value(&options.opponent_elo_bucket);
    let elo_all = is_all_any(&elo_choice_raw);

    let pawn_mode = {
        let m = normalize_filter_value(&options.pawn_structure_mode);
        if m == "player" || m == "both" {
            m
        } else {
            "both".to_string()
        }
    };

    let wanted_motif_mask = motif_filter_mask(&options.structure_filters);
    let wanted_named_structure_mask = named_structure_filter_mask(&options.structure_name_filters);

    // Calculate start_date from date_range (all filtering happens in backend)
    let start_date = calculate_earliest_date_from_range(&options.date_range);

    let mut game_data: Vec<(i32, NormalizedGame)> = Vec::new();

    // Usamos tipos separados:
    let page_size_i32: i32 = 200;
    let game_details_limit_u64: u64 = page_size_i32 as u64;

    for player_id in &options.player_ids {
        let mut page = 1;
        loop {
            let response = get_games(
                file.clone(),
                GameQueryJs {
                    player1: Some(*player_id),
                    player2: None,
                    range1: None,
                    range2: None,
                    tournament_id: None,
                    sides: Some(Sides::Any),
                    outcome: None,
                    start_date: start_date.clone(),
                    end_date: None,
                    position: None,
                    // ✅ FIX: game_details_limit espera u64
                    game_details_limit: Some(game_details_limit_u64),
                    wanted_result: None,
                    time_control_category: None,
                    options: Some(QueryOptions {
                        skip_count: page != 1,
                        page: Some(page),
                        page_size: Some(page_size_i32),
                        sort: GameSort::Date,
                        direction: SortDirection::Desc,
                    }),
                },
                state.clone(),
            )
            .await?;

            let games = response.data;
            if games.is_empty() {
                break;
            }

            for game in &games {
                if options.move_number > 0 && game.moves.trim().is_empty() {
                    continue;
                }

                let is_white = game.white_id == *player_id;
                let is_black = game.black_id == *player_id;

                let matches_color = match color_choice.as_str() {
                    "white" => is_white,
                    "black" => is_black,
                    _ => is_white || is_black, // any/empty/unknown = no filtrar
                };
                if !matches_color {
                    continue;
                }

                if !platform_all {
                    let wanted = match normalize_platform(&options.platform_filter) {
                        Some(p) => p,
                        None => options.platform_filter.clone(),
                    };
                    let normalized_site = normalize_platform(&game.site);
                    let matches_platform = normalized_site.as_ref().map(|s| s == &wanted).unwrap_or(false);
                    if !matches_platform {
                        continue;
                    }
                }

                if !tc_all {
                    if let Some(ref tc) = game.time_control {
                        if let Some(parsed_tc) = get_time_control(&game.site, tc) {
                            if parsed_tc != tc_choice_raw {
                                continue;
                            }
                        } else {
                            continue;
                        }
                    } else {
                        continue;
                    }
                }

                if !elo_all {
                    if let Ok(start) = options.opponent_elo_bucket.trim().parse::<i32>() {
                        let opponent_elo = if is_white { game.black_elo } else { game.white_elo };
                        if let Some(elo) = opponent_elo {
                            let end = start + 199;
                            if elo < start || elo > end {
                                continue;
                            }
                        } else {
                            continue;
                        }
                    }
                }

                game_data.push((*player_id, game.clone()));
            }

            if games.len() < page_size_i32 as usize {
                break;
            }
            page += 1;
        }
    }

    let mut stats: HashMap<String, (i32, f64, Option<String>, Vec<PawnStructureGame>, u32, u32)> = HashMap::new();
    let max_games_per_structure = 50;

    for (player_id, game) in game_data.iter() {
        let player_color = if game.white_id == *player_id { Color::White } else { Color::Black };

        let requested_player_color = normalize_filter_value(&options.player_color);
        if !is_all_any(&requested_player_color) {
            let want = if requested_player_color == "white" { Color::White } else { Color::Black };
            if player_color != want {
                continue;
            }
        }

        let maybe = extract_structure_at_move(game, options.move_number, player_color, &pawn_mode)?;
        let Some((structure_str, fen_str)) = maybe else {
            continue;
        };

        let result_json = serde_json::to_string(&game.result).unwrap_or_else(|_| "*".to_string());
        let result_str = result_json.trim_matches('"');
        let won = determine_win(result_str, player_color);

        let entry = stats
            .entry(structure_str.clone())
            .or_insert_with(|| (0, 0.0, Some(fen_str.clone()), Vec::new(), 0u32, 0u32));
        entry.0 += 1;
        entry.1 += won;
        entry.4 |= detect_motif_mask(&fen_str, player_color, &pawn_mode);
        entry.5 |= detect_named_structure_mask(&fen_str, player_color, &pawn_mode);

        if entry.3.len() < max_games_per_structure {
            entry.3.push(PawnStructureGame {
                game_id: game.id,
                white: game.white.clone(),
                black: game.black.clone(),
                white_elo: game.white_elo,
                black_elo: game.black_elo,
                result: result_str.to_string(),
                fen: fen_str,
            });
        }
    }

    let mut results: Vec<PawnStructureStat> = stats
        .into_iter()
        .filter(|(_structure, (_count, _wins, _sample_fen, _games, motif_mask, named_mask))| {
            let motifs_ok = if wanted_motif_mask == 0 {
                true
            } else {
                // AND semantics: when multiple motifs are selected, require all of them.
                (motif_mask & wanted_motif_mask) == wanted_motif_mask
            };

            let named_ok = if wanted_named_structure_mask == 0 {
                true
            } else {
                // OR semantics: any selected named structure matches.
                (named_mask & wanted_named_structure_mask) != 0
            };

            motifs_ok && named_ok
        })
        .map(|(structure, (count, wins, sample_fen, games, _motif_mask, _named_mask))| PawnStructureStat {
            structure,
            frequency: count,
            win_rate: if count > 0 { wins / count as f64 } else { 0.0 },
            sample_fen,
            games,
        })
        .collect();

    results.sort_by(|a, b| b.frequency.cmp(&a.frequency));
    results.truncate(20);

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Outcome;
    use shakmaty::fen::Fen;

    // Ojo: este helper asume que NormalizedGame implementa Default + que estos campos son pub.
    // Si tu NormalizedGame no tiene Default, reemplaza esto por un constructor con TODOS los campos requeridos.
    fn mk_game(moves: &str, fen: &str) -> NormalizedGame {
        let mut g = NormalizedGame::default();
        g.id = 1;
        g.white_id = 10;
        g.black_id = 20;
        g.white = "WhitePlayer".to_string();
        g.black = "BlackPlayer".to_string();
        g.white_elo = Some(1500);
        g.black_elo = Some(1500);
        g.result = Outcome::WhiteWin;
        g.site = "Lichess".to_string();
        g.time_control = Some("3+0".to_string());
        g.moves = moves.to_string();
        g.fen = fen.to_string();
        g
    }

    #[test]
    fn normalize_platform_works() {
        assert_eq!(normalize_platform("Chess.com"), Some("Chess.com".to_string()));
        assert_eq!(normalize_platform(" chess.com "), Some("Chess.com".to_string()));
        assert_eq!(normalize_platform("CHESSCOM"), Some("Chess.com".to_string()));
        assert_eq!(normalize_platform("https://lichess.org/@/foo"), Some("Lichess".to_string()));
        assert_eq!(normalize_platform("LiCHESS"), Some("Lichess".to_string()));
        assert_eq!(normalize_platform("unknown site"), None);
    }

    #[test]
    fn normalize_filter_and_is_all_any() {
        assert_eq!(normalize_filter_value("  BLITZ "), "blitz");
        assert!(is_all_any(""));
        assert!(is_all_any("any"));
        assert!(is_all_any(" ALL "));
        assert!(!is_all_any("blitz"));
        assert!(!is_all_any("white"));
    }

    #[test]
    fn get_time_control_parses_common() {
        assert_eq!(get_time_control("Lichess", "0+1"), Some("ultra_bullet".to_string()));
        assert_eq!(get_time_control("Lichess", "ultrabullet"), Some("ultra_bullet".to_string()));

        assert_eq!(get_time_control("Lichess", "1+0"), Some("bullet".to_string()));
        assert_eq!(get_time_control("Lichess", "Bullet"), Some("bullet".to_string()));

        assert_eq!(get_time_control("Lichess", "3+0"), Some("blitz".to_string()));
        assert_eq!(get_time_control("Lichess", "5+3"), Some("blitz".to_string()));

        assert_eq!(get_time_control("Lichess", "10+0"), Some("rapid".to_string()));
        assert_eq!(get_time_control("Lichess", "15+10"), Some("rapid".to_string()));

        assert_eq!(get_time_control("Lichess", "30+0"), Some("classical".to_string()));
        assert_eq!(get_time_control("Lichess", "correspondence"), Some("correspondence".to_string()));
        assert_eq!(get_time_control("Lichess", "daily"), Some("daily".to_string()));

        assert_eq!(get_time_control("Lichess", "???"), None);
    }

    #[test]
    fn pawn_structure_signature_from_startpos() {
        // FEN inicial estándar
        let pos = Chess::default();
        let fen = Fen::from_setup(pos.into_setup(EnPassantMode::Legal)).to_string();

        // both mantiene P/p
        let both = pawn_structure_signature_from_fen(&fen, "both", Color::White);
        assert_eq!(
            both,
            "8/pppppppp/8/8/8/8/PPPPPPPP/8".to_string()
        );

        // player (white) mantiene sólo peones blancos, normalizados como 'P'
        let white_only = pawn_structure_signature_from_fen(&fen, "player", Color::White);
        assert_eq!(
            white_only,
            "8/8/8/8/8/8/PPPPPPPP/8".to_string()
        );

        // player (black) mantiene sólo peones negros, normalizados como 'P'
        let black_only = pawn_structure_signature_from_fen(&fen, "player", Color::Black);
        assert_eq!(
            black_only,
            "8/PPPPPPPP/8/8/8/8/8/8".to_string()
        );
    }

    #[test]
    fn determine_win_works() {
        assert_eq!(determine_win("1-0", Color::White), 1.0);
        assert_eq!(determine_win("1-0", Color::Black), 0.0);
        assert_eq!(determine_win("0-1", Color::Black), 1.0);
        assert_eq!(determine_win("0-1", Color::White), 0.0);
        assert_eq!(determine_win("1/2-1/2", Color::White), 0.5);
        assert_eq!(determine_win("1/2-1/2", Color::Black), 0.5);
        assert_eq!(determine_win("*", Color::White), 0.0);
    }

    #[test]
    fn strip_pgn_noise_removes_comments_and_variations() {
        let s = "1. e4 {hello} e5 ;line comment\n2. Nf3 Nc6 (2... d6 (2... g6)) 3. Bb5 a6 1-0";
        let cleaned = strip_pgn_noise(s);
        // Debe seguir conteniendo los tokens principales
        assert!(cleaned.contains("e4"));
        assert!(cleaned.contains("e5"));
        assert!(cleaned.contains("Nf3"));
        assert!(cleaned.contains("Nc6"));
        assert!(cleaned.contains("Bb5"));
        assert!(cleaned.contains("a6"));
        // Pero NO debe contener contenido de comentario/variación
        assert!(!cleaned.contains("hello"));
        assert!(!cleaned.contains("line comment"));
        assert!(!cleaned.contains("d6"));
        assert!(!cleaned.contains("g6"));
    }

    #[test]
    fn tokenize_moves_basic_pgn() {
        let s = "1. e4 {hi} e5 2. Nf3 Nc6 (2... d6) 3. Bb5 a6 1-0";
        let toks = tokenize_moves(s);
        assert_eq!(
            toks,
            vec![
                "e4".to_string(),
                "e5".to_string(),
                "Nf3".to_string(),
                "Nc6".to_string(),
                "Bb5".to_string(),
                "a6".to_string()
            ]
        );
    }

    #[test]
    fn tokenize_moves_handles_black_ellipsis_and_nags() {
        let s = "1... d5 $1 2. c4 $2 2... e6 *";
        let toks = tokenize_moves(s);
        assert_eq!(toks, vec!["d5".to_string(), "c4".to_string(), "e6".to_string()]);
    }

    #[test]
    fn token_to_move_accepts_san_and_uci() {
        // SAN
        let mut pos = Chess::default();
        let mv = token_to_move("e4", &pos).expect("SAN e4 should parse");
        pos.play_unchecked(&mv);
        let fen = Fen::from_setup(pos.clone().into_setup(EnPassantMode::Legal)).to_string();
        let placement = fen.split_whitespace().next().unwrap_or("");
        assert_eq!(
            placement,
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR"
        );

        // UCI
        let mut pos2 = Chess::default();
        let mv2 = token_to_move("e2e4", &pos2).expect("UCI e2e4 should parse");
        pos2.play_unchecked(&mv2);
        let fen2 = Fen::from_setup(pos2.clone().into_setup(EnPassantMode::Legal)).to_string();
        let placement2 = fen2.split_whitespace().next().unwrap_or("");
        assert_eq!(
            placement2,
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR"
        );
    }

    #[test]
    fn extract_structure_at_move_white_fullmove_1_both() -> Result<()> {
        let game = mk_game("1. e4 e5 2. Nf3 Nc6", "");
        let got = extract_structure_at_move(&game, 1, Color::White, "both")?;
        let (sig, fen_after) = got.expect("should extract");

        assert_eq!(sig, "8/pppppppp/8/8/4P3/8/PPPP1PPP/8".to_string());

        // sanity: fen_after placement debe tener el peón en e4
        let placement = fen_after.split_whitespace().next().unwrap_or("");
        assert!(placement.contains("4P3"));
        Ok(())
    }

    #[test]
    fn extract_structure_at_move_black_fullmove_1_both() -> Result<()> {
        let game = mk_game("1. e4 e5 2. Nf3 Nc6", "");
        let got = extract_structure_at_move(&game, 1, Color::Black, "both")?;
        let (sig, _fen_after) = got.expect("should extract");

        assert_eq!(sig, "8/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/8".to_string());
        Ok(())
    }

    #[test]
    fn extract_structure_at_move_move0_returns_initial() -> Result<()> {
        let game = mk_game("", "");
        let got = extract_structure_at_move(&game, 0, Color::White, "both")?;
        let (sig, _fen_now) = got.expect("should extract initial");
        assert_eq!(sig, "8/pppppppp/8/8/8/8/PPPPPPPP/8".to_string());
        Ok(())
    }

    #[test]
    fn extract_structure_player_mode_keeps_only_player_pawns() -> Result<()> {
        let game = mk_game("1. e4 e5", "");
        let got = extract_structure_at_move(&game, 1, Color::White, "player")?;
        let (sig, _fen_after) = got.expect("should extract");
        assert_eq!(sig, "8/8/8/8/4P3/8/PPPP1PPP/8".to_string());
        Ok(())
    }
}
