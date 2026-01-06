use crate::db::{get_games, GameQueryJs, GameSort, NormalizedGame, QueryOptions, Sides, SortDirection};
use crate::error::{Error, Result};
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

    #[serde(rename = "earliestDate")]
    pub earliest_date: Option<String>,

    #[serde(rename = "moveNumber")]
    pub move_number: i32, // 1-based fullmove. Si llega <=0, se toma la posición inicial.

    #[serde(rename = "playerColor")]
    pub player_color: String, // "white" | "black" | "any" (o vacío)

    #[serde(rename = "pawnStructureMode")]
    pub pawn_structure_mode: String, // "player" | "both"
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

fn clean_optional_date(opt: &Option<String>) -> Option<String> {
    opt.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
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

    let start_date = clean_optional_date(&options.earliest_date);

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

    let mut stats: HashMap<String, (i32, f64, Option<String>, Vec<PawnStructureGame>)> = HashMap::new();
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
            .or_insert_with(|| (0, 0.0, Some(fen_str.clone()), Vec::new()));
        entry.0 += 1;
        entry.1 += won;

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
        .map(|(structure, (count, wins, sample_fen, games))| PawnStructureStat {
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
    fn clean_optional_date_works() {
        let none: Option<String> = None;
        assert_eq!(clean_optional_date(&none), None);

        let empty = Some("   ".to_string());
        assert_eq!(clean_optional_date(&empty), None);

        let d = Some("2024-01-01".to_string());
        assert_eq!(clean_optional_date(&d), Some("2024-01-01".to_string()));
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
