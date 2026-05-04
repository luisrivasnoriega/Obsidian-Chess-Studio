use log::info;
use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, san::San, CastlingMode, Chess, EnPassantMode, Position, Setup};
use std::collections::{BTreeMap, HashSet};

use lazy_static::lazy_static;
use specta::Type;
use strsim::{jaro_winkler, sorensen_dice};

use crate::error::Error;

#[derive(Debug, Clone)]
struct Opening {
    #[allow(dead_code)]
    eco: String,
    name: String,
    setup: Setup,
    pgn: Option<String>,
}

#[derive(Debug, Clone, Type, Serialize, PartialEq, Eq)]
pub struct OutOpening {
    pub name: String,
    pub fen: String,
}

#[derive(Debug, Clone, Type, Serialize, PartialEq, Eq)]
pub struct OpeningInfo {
    pub eco: String,
    pub opening: String,
    pub variation: String,
}

#[derive(Deserialize)]
struct EcoOpeningRecord {
    eco: String,
    name: String,
    moves: Option<String>,
}

pub const ECO_JSON_DATA: [&[u8]; 6] = [
    include_bytes!("../data/ecoA.json"),
    include_bytes!("../data/ecoB.json"),
    include_bytes!("../data/ecoC.json"),
    include_bytes!("../data/ecoD.json"),
    include_bytes!("../data/ecoE.json"),
    include_bytes!("../data/eco_interpolated.json"),
];

const FISCHER_RANDOM_DATA: &[u8] = include_bytes!("../data/frc.tsv");

#[derive(Deserialize)]
struct FischerRandomRecord {
    name: String,
    fen: String,
}

// ============================================================================
// Public Tauri commands
// ============================================================================

#[tauri::command]
#[specta::specta]
pub fn get_opening_from_fen(fen: &str) -> Result<String, Error> {
    get_opening_from_fen_in(fen, &OPENINGS)
}

#[tauri::command]
#[specta::specta]
pub fn get_opening_from_name(name: &str) -> Result<String, Error> {
    get_opening_from_name_in(name, &OPENINGS)
}

#[tauri::command]
#[specta::specta]
pub fn get_opening_info_from_fen(fen: &str) -> Result<OpeningInfo, Error> {
    get_opening_info_from_fen_in(fen, &OPENINGS)
}

#[tauri::command]
#[specta::specta]
pub async fn search_opening_name(query: String) -> Result<Vec<OutOpening>, Error> {
    // Async to match your command surface; implementation is pure.
    Ok(search_opening_name_in(&query, &OPENINGS))
}

// ============================================================================
// Internal, testable helpers (do NOT require global OPENINGS)
// ============================================================================

fn normalize_fen_to_setup(fen: &str) -> Result<Setup, Error> {
    let fen: Fen = fen.parse()?;

    // Normalize by going through a Chess position and back to Setup (EnPassantMode::Legal),
    // so the matching is based on resulting position, not move order.
    let chess: Chess = fen.into_position(CastlingMode::Standard)?;
    Ok(chess.into_setup(EnPassantMode::Legal))
}

fn setup_from_move_text(move_text: &str, opening_name: &str) -> Setup {
    let mut pos = Chess::default();
    for token in move_text.split_whitespace() {
        if let Ok(san) = token.parse::<San>() {
            if let Ok(mv) = san.to_move(&pos) {
                pos.play_unchecked(&mv);
            } else {
                info!(
                    "Skipping invalid SAN token in opening {}: {}",
                    opening_name, token
                );
            }
        }
    }
    pos.into_setup(EnPassantMode::Legal)
}

fn get_opening_from_fen_in(fen: &str, openings: &[Opening]) -> Result<String, Error> {
    let setup = normalize_fen_to_setup(fen)?;
    get_opening_from_setup_in(setup, openings)
}

fn get_opening_from_name_in(name: &str, openings: &[Opening]) -> Result<String, Error> {
    openings
        .iter()
        .find(|o| o.name == name)
        .and_then(|o| o.pgn.clone())
        .ok_or_else(|| Error::NoOpeningFound)
}

pub fn get_opening_from_setup(setup: Setup) -> Result<String, Error> {
    get_opening_from_setup_in(setup, &OPENINGS)
}

fn get_opening_from_setup_in(setup: Setup, openings: &[Opening]) -> Result<String, Error> {
    openings
        .iter()
        .find(|o| o.setup == setup)
        .map(|o| o.name.clone())
        .ok_or_else(|| Error::NoOpeningFound)
}

fn split_opening_name(full_name: &str) -> (String, String) {
    // Expected formats in TSV:
    // - "Catalan Opening"
    // - "Catalan Opening: Hungarian Gambit"
    // - "Catalan Opening: Open Defense, Alekhine Variation"
    // - Sometimes (rare): "Queen's Gambit, Accepted"
    let trimmed = full_name.trim();

    if let Some((opening, rest)) = trimmed.split_once(':') {
        (opening.trim().to_string(), rest.trim().to_string())
    } else if let Some((opening, rest)) = trimmed.split_once(',') {
        (opening.trim().to_string(), rest.trim().to_string())
    } else {
        (trimmed.to_string(), String::new())
    }
}

fn get_opening_info_from_fen_in(fen: &str, openings: &[Opening]) -> Result<OpeningInfo, Error> {
    let fen_str = fen.to_string();
    let setup = normalize_fen_to_setup(fen)?;

    // Try exact match first
    let mut opening = openings.iter().find(|o| o.setup == setup);

    // If no exact match, compare board + turn + counters (lenient)
    if opening.is_none() {
        opening = openings.iter().find(|o| {
            o.setup.board == setup.board
                && o.setup.turn == setup.turn
                && o.setup.fullmoves == setup.fullmoves
                && o.setup.halfmoves == setup.halfmoves
        });
    }

    // If still no match, compare only board + turn (most lenient)
    if opening.is_none() {
        opening = openings
            .iter()
            .find(|o| o.setup.board == setup.board && o.setup.turn == setup.turn);
    }

    let opening = opening.ok_or_else(|| {
        info!("No opening found for FEN: {}", fen_str);
        Error::NoOpeningFound
    })?;

    let eco = opening.eco.clone();
    let (opening_name, variation) = split_opening_name(&opening.name);

    Ok(OpeningInfo {
        eco,
        opening: opening_name,
        variation,
    })
}

fn search_opening_name_in(query: &str, openings: &[Opening]) -> Vec<OutOpening> {
    let lower_query = query.to_lowercase();

    let mut scored = openings
        .iter()
        .map(|opening| {
            let lower_name = opening.name.to_lowercase();
            let sorenson_score = sorensen_dice(&lower_query, &lower_name);
            let jaro_score = jaro_winkler(&lower_query, &lower_name);
            let score = sorenson_score.max(jaro_score);
            (opening, score)
        })
        .filter(|(_, score)| *score > 0.8)
        .collect::<Vec<_>>();

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    scored
        .into_iter()
        .take(15)
        .map(|(o, _)| OutOpening {
            name: o.name.clone(),
            fen: Fen::from_setup(o.setup.clone()).to_string(),
        })
        .collect()
}

pub fn opening_fens_for_precache() -> Vec<(String, String)> {
    let mut seen_fens = HashSet::new();
    let mut out = Vec::new();

    for opening in OPENINGS.iter() {
        // Keep compatibility with previous behavior: precache only standard openings,
        // excluding synthetic entries and Fischer Random.
        if opening.eco == "Extra" || opening.eco == "FRC" {
            continue;
        }

        let fen = Fen::from_setup(opening.setup.clone()).to_string();
        if seen_fens.insert(fen.clone()) {
            out.push((opening.name.clone(), fen));
        }
    }

    out
}

// ============================================================================
// Global opening database (loaded once)
// ============================================================================

lazy_static! {
    static ref OPENINGS: Vec<Opening> = {
        let mut positions = vec![
            Opening {
                eco: "Extra".to_string(),
                name: "Starting Position".to_string(),
                setup: Setup::default(),
                pgn: None,
            },
            Opening {
                eco: "Extra".to_string(),
                name: "Empty Board".to_string(),
                setup: Setup::empty(),
                pgn: None,
            },
        ];

        // Load standard openings from eco.json chunks (A-E + interpolated)
        let mut total_loaded = 0usize;
        for (json_idx, json_data) in ECO_JSON_DATA.iter().enumerate() {
            let parsed: Result<BTreeMap<String, EcoOpeningRecord>, serde_json::Error> =
                serde_json::from_slice(json_data);
            let eco_map = match parsed {
                Ok(map) => map,
                Err(e) => {
                    info!("Failed to parse eco json chunk {}: {}", json_idx, e);
                    continue;
                }
            };
            let mut file_count = 0usize;

            for (fen_key, record) in eco_map {
                let setup = match normalize_fen_to_setup(&fen_key) {
                    Ok(setup) => setup,
                    Err(_) => {
                        let Some(moves) = record.moves.as_deref() else {
                            info!("Skipping opening with invalid FEN and no moves: {}", record.name);
                            continue;
                        };
                        setup_from_move_text(moves, &record.name)
                    }
                };

                positions.push(Opening {
                    eco: record.eco.clone(),
                    name: record.name.clone(),
                    setup,
                    pgn: record.moves.clone(),
                });

                file_count += 1;
                total_loaded += 1;
            }

            let file_name = match json_idx {
                0 => "ecoA.json",
                1 => "ecoB.json",
                2 => "ecoC.json",
                3 => "ecoD.json",
                4 => "ecoE.json",
                5 => "eco_interpolated.json",
                _ => "unknown",
            };
            info!("Loaded {} openings from file {}", file_count, file_name);
        }

        info!("Total openings loaded: {}", total_loaded);

        // Load Fischer Random (FRC) positions
        let mut rdr = csv::ReaderBuilder::new()
            .delimiter(b'\t')
            .from_reader(FISCHER_RANDOM_DATA);

        for result in rdr.deserialize() {
            match result {
                Ok(record) => {
                    let record: FischerRandomRecord = record;
                    match record.fen.parse::<Fen>() {
                        Ok(fen) => {
                            positions.push(Opening {
                                eco: "FRC".to_string(),
                                name: record.name,
                                setup: fen.into_setup(),
                                pgn: None,
                            });
                        }
                        Err(e) => {
                            info!("Failed to parse FEN for opening {}: {}", record.name, e);
                        }
                    }
                }
                Err(e) => {
                    info!("Failed to deserialize Fischer Random opening: {}", e);
                }
            }
        }

        positions
    };
}

// ============================================================================
// Unit tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_opening(eco: &str, name: &str, setup: Setup, pgn: Option<&str>) -> Opening {
        Opening {
            eco: eco.to_string(),
            name: name.to_string(),
            setup,
            pgn: pgn.map(|s| s.to_string()),
        }
    }

    fn setup_after_sans(sans: &[&str]) -> Setup {
        let mut pos = Chess::default();
        for t in sans {
            let san: San = t.parse().unwrap();
            let mv = san.to_move(&pos).unwrap();
            pos.play_unchecked(&mv);
        }
        pos.into_setup(EnPassantMode::Legal)
    }

    fn fen_of_setup(setup: Setup) -> String {
        Fen::from_setup(setup).to_string()
    }

    fn mutate_fen_counters(fen: &str, half: u32, full: u32) -> String {
        // FEN format: "board turn castling ep halfmove fullmove"
        let mut parts = fen.split_whitespace().collect::<Vec<_>>();
        assert!(parts.len() >= 6);
        parts[4] = Box::leak(half.to_string().into_boxed_str());
        parts[5] = Box::leak(full.to_string().into_boxed_str());
        parts.join(" ")
    }

    #[test]
    fn split_opening_name_handles_colon() {
        let (o, v) = split_opening_name("Catalan Opening: Open Defense, Alekhine Variation");
        assert_eq!(o, "Catalan Opening");
        assert_eq!(v, "Open Defense, Alekhine Variation");
    }

    #[test]
    fn split_opening_name_handles_comma() {
        let (o, v) = split_opening_name("Queen's Gambit, Accepted");
        assert_eq!(o, "Queen's Gambit");
        assert_eq!(v, "Accepted");
    }

    #[test]
    fn split_opening_name_handles_no_separator() {
        let (o, v) = split_opening_name("Catalan Opening");
        assert_eq!(o, "Catalan Opening");
        assert_eq!(v, "");
    }

    #[test]
    fn get_opening_from_setup_in_exact_match() {
        let setup = setup_after_sans(&["e4", "e5", "Nf3", "Nc6"]);
        let openings = vec![mk_opening("C50", "Italian Game", setup.clone(), Some("1. e4 e5 2. Nf3 Nc6"))];

        let got = get_opening_from_setup_in(setup, &openings).unwrap();
        assert_eq!(got, "Italian Game");
    }

    #[test]
    fn get_opening_from_setup_in_not_found() {
        let setup = setup_after_sans(&["d4"]);
        let openings: Vec<Opening> = vec![];
        let err = get_opening_from_setup_in(setup, &openings).unwrap_err();
        match err {
            Error::NoOpeningFound => {}
            other => panic!("expected NoOpeningFound, got {:?}", other),
        }
    }

    #[test]
    fn get_opening_from_name_in_returns_pgn() {
        let setup = Setup::default();
        let openings = vec![mk_opening("C00", "Test Opening", setup, Some("1. e4"))];

        let pgn = get_opening_from_name_in("Test Opening", &openings).unwrap();
        assert_eq!(pgn, "1. e4");
    }

    #[test]
    fn get_opening_from_name_in_errors_when_missing_or_no_pgn() {
        let setup = Setup::default();
        let openings = vec![mk_opening("C00", "No PGN Opening", setup, None)];

        let err = get_opening_from_name_in("No PGN Opening", &openings).unwrap_err();
        match err {
            Error::NoOpeningFound => {}
            other => panic!("expected NoOpeningFound, got {:?}", other),
        }

        let err = get_opening_from_name_in("Missing", &openings).unwrap_err();
        match err {
            Error::NoOpeningFound => {}
            other => panic!("expected NoOpeningFound, got {:?}", other),
        }
    }

    #[test]
    fn get_opening_from_fen_in_normalizes_and_matches() {
        let setup = setup_after_sans(&["e4", "e5", "Qh5"]);
        let fen = fen_of_setup(setup.clone());
        let openings = vec![mk_opening(
            "C20",
            "King's Pawn Game: Wayward Queen Attack",
            setup,
            Some("1. e4 e5 2. Qh5"),
        )];

        let got = get_opening_from_fen_in(&fen, &openings).unwrap();
        assert_eq!(got, "King's Pawn Game: Wayward Queen Attack");
    }

    #[test]
    fn get_opening_info_from_fen_in_parses_opening_and_variation() {
        let setup = setup_after_sans(&["e4", "e5", "Nf3", "Nc6", "Bb5"]);
        let fen = fen_of_setup(setup.clone());
        let openings = vec![mk_opening(
            "C60",
            "Ruy Lopez: Morphy Defense",
            setup,
            Some("1. e4 e5 2. Nf3 Nc6 3. Bb5"),
        )];

        let info = get_opening_info_from_fen_in(&fen, &openings).unwrap();
        assert_eq!(
            info,
            OpeningInfo {
                eco: "C60".to_string(),
                opening: "Ruy Lopez".to_string(),
                variation: "Morphy Defense".to_string(),
            }
        );
    }

    #[test]
    fn get_opening_info_from_fen_in_lenient_match_board_turn_only() {
        let setup = setup_after_sans(&["e4", "e5", "Nf3"]);
        let fen = fen_of_setup(setup.clone());

        // Create a "different" FEN with same board/turn but different counters
        let fen_mut = mutate_fen_counters(&fen, 99, 99);

        let openings = vec![mk_opening(
            "C40",
            "King's Knight Opening",
            setup,
            Some("1. e4 e5 2. Nf3"),
        )];

        let info = get_opening_info_from_fen_in(&fen_mut, &openings).unwrap();
        assert_eq!(info.eco, "C40");
        assert_eq!(info.opening, "King's Knight Opening");
    }

    #[test]
    fn search_opening_name_in_returns_ranked_matches_limited() {
        // Create 20 similar openings; expect at most 15 results.
        let mut openings = vec![];
        for i in 0..20 {
            let setup = Setup::default();
            openings.push(mk_opening(
                "X00",
                &format!("Sicilian Defense: Test Line {}", i),
                setup.clone(),
                Some("1. e4 c5"),
            ));
        }

        let results = search_opening_name_in("sicilian defense", &openings);
        assert!(results.len() <= 15);
        // all must include a fen and name
        assert!(results.iter().all(|r| !r.name.is_empty() && !r.fen.is_empty()));
    }

    #[test]
    fn invalid_fen_errors() {
        let openings: Vec<Opening> = vec![];
        let err = get_opening_from_fen_in("not-a-fen", &openings).unwrap_err();
        // Parsing error types vary; just ensure it's an Error and not Ok.
        let _ = format!("{:?}", err);
    }
}
