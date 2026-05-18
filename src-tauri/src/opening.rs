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
            }
        }
    }
    let _ = opening_name;
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

#[allow(dead_code)]
fn opening_name_family_seed(full_name: &str) -> String {
    let trimmed = full_name.trim();
    let split_at = [trimmed.find(':'), trimmed.find(',')]
        .into_iter()
        .flatten()
        .min();

    match split_at {
        Some(index) => trimmed[..index].trim().to_string(),
        None => trimmed.to_string(),
    }
}

#[allow(dead_code)]
fn normalize_opening_match_text(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut last_was_space = false;

    for ch in value.trim().chars() {
        let mapped = match ch {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => {
                'a'
            }
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' => 'o',
            'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ù' | 'Û' | 'Ü' => 'u',
            'ñ' | 'Ñ' => 'n',
            'ç' | 'Ç' => 'c',
            'ý' | 'ÿ' | 'Ý' => 'y',
            '’' | '‘' | '`' | '´' => '\'',
            '–' | '—' | '‑' => '-',
            _ => ch,
        };

        if mapped.is_whitespace() {
            if !last_was_space {
                normalized.push(' ');
            }
            last_was_space = true;
        } else {
            normalized.extend(mapped.to_lowercase());
            last_was_space = false;
        }
    }

    normalized.trim().replace("gruenfeld", "grunfeld")
}

#[allow(dead_code)]
fn canonical_opening_family_from_key(key: &str) -> Option<&'static str> {
    let bare = key.replace('\'', "");

    if matches!(bare.as_str(), "qgd" | "queens gambit declined") {
        return Some("Queen's Gambit Declined");
    }
    if matches!(bare.as_str(), "qga" | "queens gambit accepted") {
        return Some("Queen's Gambit Accepted");
    }
    if matches!(bare.as_str(), "kga" | "kings gambit accepted") {
        return Some("King's Gambit Accepted");
    }
    if matches!(bare.as_str(), "kgd" | "kings gambit declined") {
        return Some("King's Gambit Declined");
    }

    if bare.starts_with("sicilian") || bare.ends_with(" sicilian") {
        return Some("Sicilian");
    }
    if bare.starts_with("ruy lopez") || matches!(bare.as_str(), "spanish" | "spanish game") {
        return Some("Ruy Lopez");
    }
    if bare.starts_with("italian") || bare.starts_with("giuoco") {
        return Some("Italian");
    }
    if bare.starts_with("scotch") {
        return Some("Scotch");
    }
    if bare.starts_with("vienna") {
        return Some("Vienna");
    }
    if bare.starts_with("reti") {
        return Some("Reti");
    }
    if bare.starts_with("colle") {
        return Some("Colle");
    }
    if bare.starts_with("grunfeld") {
        return Some("Grunfeld");
    }
    if bare.starts_with("neo-grunfeld") {
        return Some("Neo-Grunfeld");
    }
    if bare.starts_with("caro-kann") || bare.starts_with("caro kann") {
        return Some("Caro-Kann");
    }
    if bare.starts_with("french") {
        return Some("French");
    }
    if bare.starts_with("english") || bare.starts_with("symmetrical english") {
        return Some("English");
    }
    if bare.starts_with("kings indian attack") {
        return Some("King's Indian Attack");
    }
    if bare.starts_with("kings indian") {
        return Some("King's Indian");
    }
    if bare.starts_with("queens indian") || bare.starts_with("pseudo queens indian") {
        return Some("Queen's Indian");
    }
    if bare.starts_with("nimzo-indian") {
        return Some("Nimzo-Indian");
    }
    if bare.starts_with("bogo-indian") {
        return Some("Bogo-Indian");
    }
    if bare.starts_with("old indian") {
        return Some("Old Indian");
    }
    if bare.starts_with("queens pawn") || bare.starts_with("queen pawn") {
        return Some("Queen's Pawn");
    }
    if bare.starts_with("queens gambit") {
        return Some("Queen's Gambit");
    }
    if bare.starts_with("kings gambit") {
        return Some("King's Gambit");
    }
    if bare.starts_with("slav") {
        return Some("Slav");
    }
    if bare.starts_with("semi-slav") {
        return Some("Semi-Slav");
    }
    if bare.starts_with("catalan") {
        return Some("Catalan");
    }
    if bare.starts_with("benoni") {
        return Some("Benoni");
    }
    if bare.starts_with("benko") {
        return Some("Benko Gambit");
    }
    if bare.starts_with("dutch") {
        return Some("Dutch");
    }
    if bare.starts_with("alekhine") {
        return Some("Alekhine");
    }
    if bare.starts_with("scandinavian") {
        return Some("Scandinavian");
    }
    if bare.starts_with("pirc") {
        return Some("Pirc");
    }
    if bare.starts_with("modern") {
        return Some("Modern");
    }
    if bare.starts_with("philidor") {
        return Some("Philidor");
    }
    if bare.starts_with("petrov") || bare.starts_with("russian") {
        return Some("Petrov");
    }
    if bare.starts_with("four knights") {
        return Some("Four Knights");
    }
    if bare.starts_with("two knights") {
        return Some("Two Knights");
    }
    if bare.starts_with("bishops") {
        return Some("Bishop's");
    }
    if bare.starts_with("bird") {
        return Some("Bird");
    }
    if bare.starts_with("polish") {
        return Some("Polish");
    }
    if bare.starts_with("nimzowitsch") {
        return Some("Nimzowitsch");
    }
    if bare.starts_with("trompowsky") {
        return Some("Trompowsky");
    }
    if bare.starts_with("torre") {
        return Some("Torre");
    }
    if bare.starts_with("london") {
        return Some("London");
    }

    None
}

#[allow(dead_code)]
fn trim_opening_family_suffixes(value: &str) -> String {
    let mut family = value.trim().to_string();

    for suffix in [" Opening", " Defense", " Defence", " Game", " System"] {
        if family.ends_with(suffix) && family.len() > suffix.len() {
            family.truncate(family.len() - suffix.len());
            break;
        }
    }

    family
}

#[allow(dead_code)]
pub fn normalize_opening_family_name(full_name: &str) -> Option<String> {
    let trimmed = full_name.trim();
    if trimmed.is_empty() {
        return None;
    }

    let full_key = normalize_opening_match_text(trimmed);
    for (needle, family) in [
        ("colle system", "Colle"),
        ("london system", "London"),
        ("torre attack", "Torre"),
        ("stonewall attack", "Stonewall"),
        ("rapport-jobava", "Rapport-Jobava"),
        ("nimzo-larsen", "Nimzo-Larsen Attack"),
        ("king's indian attack", "King's Indian Attack"),
        ("smith-morra", "Smith-Morra Gambit"),
        ("blackmar-diemer", "Blackmar-Diemer Gambit"),
        ("fried liver", "Fried Liver Attack"),
        ("evans gambit", "Evans Gambit"),
        ("danish gambit", "Danish Gambit"),
        ("latvian gambit", "Latvian Gambit"),
    ] {
        if full_key.contains(needle) {
            return Some(family.to_string());
        }
    }

    let seed = opening_name_family_seed(trimmed);
    let seed_key = normalize_opening_match_text(&seed);
    if let Some(family) = canonical_opening_family_from_key(&seed_key) {
        return Some(family.to_string());
    }

    let family = trim_opening_family_suffixes(&seed);
    if family.is_empty() {
        None
    } else {
        Some(family)
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
        let _ = fen_str;
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
        for json_data in ECO_JSON_DATA.iter() {
            let parsed: Result<BTreeMap<String, EcoOpeningRecord>, serde_json::Error> =
                serde_json::from_slice(json_data);
            let eco_map = match parsed {
                Ok(map) => map,
                Err(_) => continue,
            };

            for (fen_key, record) in eco_map {
                let setup = match normalize_fen_to_setup(&fen_key) {
                    Ok(setup) => setup,
                    Err(_) => {
                        let Some(moves) = record.moves.as_deref() else {
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
            }
        }

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
                        Err(_) => {}
                    }
                }
                Err(_) => {}
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
    fn normalize_opening_family_name_handles_catalog_aliases() {
        let cases = [
            ("Sicilian Defense: Najdorf Variation", "Sicilian"),
            ("Sicilian: Dragon Variation", "Sicilian"),
            ("Spanish: Morphy Defense", "Ruy Lopez"),
            ("Ruy Lopez: Closed", "Ruy Lopez"),
            ("Italian Game: Giuoco Piano", "Italian"),
            ("Scotch Game: Classical Variation", "Scotch"),
            ("Vienna Game: Max Lange Defense", "Vienna"),
            ("Queen's Pawn Game: Colle System", "Colle"),
            (
                "Indian Defense: Colle System, King's Indian Variation",
                "Colle",
            ),
            ("Reti Opening", "Reti"),
            ("Réti Opening", "Reti"),
            ("Gruenfeld Defense: Exchange Variation", "Grunfeld"),
            ("Grünfeld Defense", "Grunfeld"),
            ("Caro–Kann Defense: Advance Variation", "Caro-Kann"),
            ("Queen's Gambit, Accepted", "Queen's Gambit"),
        ];

        for (input, expected) in cases {
            assert_eq!(
                normalize_opening_family_name(input),
                Some(expected.to_string()),
                "input: {input}"
            );
        }
    }

    #[test]
    fn normalize_opening_family_name_handles_empty_input() {
        assert_eq!(normalize_opening_family_name("  "), None);
    }

    #[test]
    fn normalize_opening_family_name_covers_embedded_catalog() {
        let mut checked = 0usize;
        let mut families = BTreeMap::<String, usize>::new();
        let mut missing = Vec::<String>::new();

        for json_data in ECO_JSON_DATA.iter() {
            let eco_map: BTreeMap<String, EcoOpeningRecord> =
                serde_json::from_slice(json_data).unwrap();

            for record in eco_map.values() {
                let name = record.name.trim();
                if name.is_empty() {
                    continue;
                }

                checked += 1;
                match normalize_opening_family_name(name) {
                    Some(family) if !family.trim().is_empty() => {
                        *families.entry(family).or_insert(0) += 1;
                    }
                    _ => missing.push(name.to_string()),
                }
            }
        }

        assert!(checked > 15_000);
        assert_eq!(missing, Vec::<String>::new());

        for family in [
            "Sicilian",
            "Ruy Lopez",
            "Italian",
            "Scotch",
            "Vienna",
            "Colle",
            "Reti",
            "Grunfeld",
        ] {
            assert!(families.contains_key(family), "missing family: {family}");
        }
    }

    #[test]
    fn get_opening_from_setup_in_exact_match() {
        let setup = setup_after_sans(&["e4", "e5", "Nf3", "Nc6"]);
        let openings = vec![mk_opening(
            "C50",
            "Italian Game",
            setup.clone(),
            Some("1. e4 e5 2. Nf3 Nc6"),
        )];

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
        assert!(results
            .iter()
            .all(|r| !r.name.is_empty() && !r.fen.is_empty()));
    }

    #[test]
    fn invalid_fen_errors() {
        let openings: Vec<Opening> = vec![];
        let err = get_opening_from_fen_in("not-a-fen", &openings).unwrap_err();
        // Parsing error types vary; just ensure it's an Error and not Ok.
        let _ = format!("{:?}", err);
    }
}
