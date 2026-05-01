use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use chrono::Local;
use pgn_reader::BufferedReader;
use serde::{Deserialize, Serialize};
use shakmaty::{
    fen::Fen,
    san::SanPlus,
    uci::UciMove,
    CastlingMode, Chess, EnPassantMode, Position,
};
use specta::Type;

use crate::{
    db::pgn::{GameTree, GameTreeNode, Importer},
    error::Result,
};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PostGameReviewVariantsInput {
    pub document_dir: String,
    pub initial_fen: String,
    pub moves: Vec<String>,
    pub human_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PostGameReviewVariantsResult {
    pub detected: bool,
    pub variant_deviation_ply: Option<usize>,
    pub new_line_added: bool,
    pub variants_book_path: Option<String>,
    pub variants_book_name: Option<String>,
    pub added_variant_line: Option<String>,
    pub open_variants_after_review: bool,
    pub kind: String,
    pub book_match_plies: Vec<usize>,
    pub book_errors: Vec<BookErrorEntry>,
    pub book_unknowns: Vec<BookUnknownEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookErrorEntry {
    pub ply: usize,
    pub played_move: String,
    pub expected_move: Option<String>,
    pub expected_moves: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookUnknownEntry {
    pub ply: usize,
    pub played_move: String,
    pub expected_move: Option<String>,
    pub expected_moves: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    White,
    Black,
}

impl Side {
    fn parse(input: &str) -> Option<Self> {
        match input.trim().to_ascii_lowercase().as_str() {
            "white" => Some(Self::White),
            "black" => Some(Self::Black),
            _ => None,
        }
    }

    fn other(self) -> Self {
        match self {
            Self::White => Self::Black,
            Self::Black => Self::White,
        }
    }
}

#[derive(Debug, Clone)]
struct BookNode {
    allowed_moves: HashSet<String>,
}

#[derive(Debug, Clone)]
struct VariantBook {
    path: String,
    side: Option<Side>,
    entry_fen_key: Option<String>,
    entry_ply: usize,
    nodes_by_fen: HashMap<String, BookNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EvalStatus {
    NoMatch,
    Matching,
    FullyMatched,
    BookEndedOrOutsideScope,
    DivergedBeforeEntry,
    SelfDeviation,
    OppNovelty,
}

#[derive(Debug, Clone)]
struct BookEvaluation {
    book: VariantBook,
    entry_reached: bool,
    matched_depth: usize,
    self_deviation_ply: Option<usize>,
    opp_deviation_ply: Option<usize>,
    deciding_ply_or_infinity: usize,
    status: EvalStatus,
}

#[derive(Debug, Clone)]
struct Decision {
    detected: bool,
    ply: Option<usize>,
    target_book_path: Option<String>,
    book_path: Option<String>,
    should_open_variants: bool,
    kind: &'static str,
}

#[derive(Debug, Deserialize, Default)]
struct FileInfoMetadata {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    tags: Vec<String>,
}

fn normalize_fen_key(fen: &str) -> String {
    fen.split_whitespace().take(4).collect::<Vec<_>>().join(" ")
}

fn normalize_move_key(mv: &str) -> String {
    mv.trim().to_ascii_lowercase()
}

fn parse_position(initial_fen: &str) -> Option<Chess> {
    let trimmed = initial_fen.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("startpos") {
        return Some(Chess::default());
    }

    let fen = Fen::from_ascii(trimmed.as_bytes()).ok()?;
    fen.into_position(CastlingMode::Standard).ok()
}

fn pos_fen_key(pos: &Chess) -> String {
    let fen = Fen::from_setup(pos.clone().into_setup(EnPassantMode::Legal)).to_string();
    normalize_fen_key(&fen)
}

fn parse_side_from_tags(tags: &[String]) -> Option<Side> {
    for raw in tags {
        let tag = raw.to_ascii_lowercase();
        for prefix in ["orientation:", "side:", "color:"] {
            if !tag.starts_with(prefix) {
                continue;
            }
            let value = tag[prefix.len()..].trim();
            if let Some(side) = Side::parse(value) {
                return Some(side);
            }
        }
    }
    None
}

fn parse_side_from_pgn_headers(raw_pgn: &str) -> Option<Side> {
    for line in raw_pgn.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("[orientation \"") {
            let value = rest.split('"').next().unwrap_or_default().trim();
            if let Some(side) = Side::parse(value) {
                return Some(side);
            }
        }
    }
    None
}

fn parse_entry_fen_from_tags(tags: &[String]) -> Option<String> {
    for raw in tags {
        let trimmed = raw.trim();
        if !trimmed.to_ascii_lowercase().starts_with("fen:") {
            continue;
        }
        let fen_value = trimmed[4..].trim();
        if fen_value.is_empty() {
            continue;
        }
        return Some(normalize_fen_key(fen_value));
    }
    None
}

fn collect_variant_pgn_files(root: &Path, out: &mut Vec<(PathBuf, FileInfoMetadata)>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_variant_pgn_files(&path, out);
            continue;
        }

        if path.extension().and_then(|e| e.to_str()) != Some("pgn") {
            continue;
        }

        let info_path = path.with_extension("info");
        let Ok(info_raw) = fs::read_to_string(&info_path) else {
            continue;
        };
        let Ok(info) = serde_json::from_str::<FileInfoMetadata>(&info_raw) else {
            continue;
        };
        if info.r#type != "variants" {
            continue;
        }

        out.push((path, info));
    }
}

fn add_allowed_move(nodes: &mut HashMap<String, BookNode>, fen_key: String, move_key: String) {
    let entry = nodes.entry(fen_key).or_insert_with(|| BookNode {
        allowed_moves: HashSet::new(),
    });
    entry.allowed_moves.insert(move_key);
}

fn walk_game_tree(
    tree: &GameTree,
    start_pos: &Chess,
    start_ply: usize,
    entry_fen_key: Option<&str>,
    entry_ply: &mut Option<usize>,
    nodes: &mut HashMap<String, BookNode>,
) {
    let mut cur_pos = start_pos.clone();
    let mut prev_pos = cur_pos.clone();
    let mut cur_ply = start_ply;
    let mut prev_ply = cur_ply;

    for item in tree.nodes() {
        match item {
            GameTreeNode::Move(san_plus) => {
                let fen_before = pos_fen_key(&cur_pos);
                if let Some(entry_fen) = entry_fen_key {
                    if fen_before == entry_fen {
                        *entry_ply = Some((*entry_ply).map_or(cur_ply, |v| v.min(cur_ply)));
                    }
                }

                let Ok(mv) = san_plus.san.to_move(&cur_pos) else {
                    continue;
                };

                let move_key = normalize_move_key(&mv.to_uci(CastlingMode::Standard).to_string());
                add_allowed_move(nodes, fen_before, move_key);

                prev_pos = cur_pos.clone();
                prev_ply = cur_ply;
                cur_pos.play_unchecked(&mv);
                cur_ply += 1;

                if let Some(entry_fen) = entry_fen_key {
                    let fen_after = pos_fen_key(&cur_pos);
                    if fen_after == entry_fen {
                        *entry_ply = Some((*entry_ply).map_or(cur_ply, |v| v.min(cur_ply)));
                    }
                }
            }
            GameTreeNode::Variation(branch) => {
                walk_game_tree(branch, &prev_pos, prev_ply, entry_fen_key, entry_ply, nodes);
            }
            GameTreeNode::Comment(_) | GameTreeNode::Nag(_) => {}
        }
    }
}

fn parse_games_into_book(path: &Path, metadata: &FileInfoMetadata) -> Option<VariantBook> {
    let raw = fs::read_to_string(path).ok()?;
    let mut reader = BufferedReader::new_cursor(&raw[..]);
    let mut importer = Importer::new(None);

    let side = parse_side_from_tags(&metadata.tags).or_else(|| parse_side_from_pgn_headers(&raw));
    let entry_fen_key = parse_entry_fen_from_tags(&metadata.tags);
    let mut entry_ply: Option<usize> = None;
    let mut nodes_by_fen: HashMap<String, BookNode> = HashMap::new();

    loop {
        let game = match reader.read_game(&mut importer) {
            Ok(Some(Some(game))) => game,
            Ok(Some(None)) => continue,
            Ok(None) => break,
            Err(_) => break,
        };
        walk_game_tree(
            &game.tree,
            &game.position,
            0,
            entry_fen_key.as_deref(),
            &mut entry_ply,
            &mut nodes_by_fen,
        );
    }

    Some(VariantBook {
        path: path.to_string_lossy().to_string(),
        side,
        entry_fen_key,
        entry_ply: entry_ply.unwrap_or(0),
        nodes_by_fen,
    })
}

fn load_variant_books(document_dir: &str) -> Vec<VariantBook> {
    let mut files = Vec::new();
    collect_variant_pgn_files(Path::new(document_dir), &mut files);

    let mut books = Vec::new();
    for (path, meta) in files {
        if let Some(book) = parse_games_into_book(&path, &meta) {
            books.push(book);
        }
    }
    books
}

fn detect_book_errors(
    initial_fen: &str,
    moves: &[String],
    human_color: Side,
    books: &[VariantBook],
) -> (Vec<usize>, Vec<BookErrorEntry>, Vec<BookUnknownEntry>) {
    let scoped: Vec<&VariantBook> = books
        .iter()
        .filter(|book| book.side.map_or(false, |side| side == human_color))
        .collect();
    if scoped.is_empty() {
        return (Vec::new(), Vec::new(), Vec::new());
    }

    let Some(mut position) = parse_position(initial_fen) else {
        return (Vec::new(), Vec::new(), Vec::new());
    };

    let mut matches = Vec::new();
    let mut out_errors = Vec::new();
    let mut out_unknowns = Vec::new();
    for (ply, played_move_raw) in moves.iter().enumerate() {
        let played_move = normalize_move_key(played_move_raw);
        let turn = if position.turn().is_white() {
            Side::White
        } else {
            Side::Black
        };

        let fen_before_move = pos_fen_key(&position);
        let mut allowed_moves: HashSet<String> = HashSet::new();

        for book in &scoped {
            if let Some(node) = book.nodes_by_fen.get(&fen_before_move) {
                allowed_moves.extend(node.allowed_moves.iter().cloned());
            }
        }

        if !allowed_moves.is_empty() {
            if allowed_moves.contains(&played_move) {
                // Variants take priority for both sides whenever the played move is mapped.
                matches.push(ply);
            } else if turn == human_color {
                let mut expected_moves: Vec<String> = allowed_moves.iter().cloned().collect();
                expected_moves.sort();
                out_errors.push(BookErrorEntry {
                    ply,
                    played_move: played_move_raw.clone(),
                    expected_move: expected_moves.first().cloned(),
                    expected_moves,
                });
            } else if turn == human_color.other() {
                let mut expected_moves: Vec<String> = allowed_moves.into_iter().collect();
                expected_moves.sort();
                out_unknowns.push(BookUnknownEntry {
                    ply,
                    played_move: played_move_raw.clone(),
                    expected_move: expected_moves.first().cloned(),
                    expected_moves,
                });
            }
        }

        let Ok(uci) = UciMove::from_ascii(played_move.as_bytes()) else {
            break;
        };
        let Ok(mv) = uci.to_move(&position) else {
            break;
        };
        position.play_unchecked(&mv);
    }

    (matches, out_errors, out_unknowns)
}

fn evaluate_book_against_game(
    book: &VariantBook,
    initial_fen: &str,
    moves: &[String],
    human_color: Side,
) -> BookEvaluation {
    let mut state = BookEvaluation {
        book: book.clone(),
        entry_reached: false,
        matched_depth: 0,
        self_deviation_ply: None,
        opp_deviation_ply: None,
        deciding_ply_or_infinity: usize::MAX,
        status: EvalStatus::NoMatch,
    };

    let Some(mut position) = parse_position(initial_fen) else {
        return state;
    };

    if book.entry_fen_key.is_none() {
        state.entry_reached = true;
    } else if let Some(entry_fen) = &book.entry_fen_key {
        if pos_fen_key(&position) == *entry_fen {
            state.entry_reached = true;
        }
    }

    for (ply, played_move_raw) in moves.iter().enumerate() {
        let current_fen = pos_fen_key(&position);
        let Some(node) = book.nodes_by_fen.get(&current_fen) else {
            state.status = if state.entry_reached {
                EvalStatus::BookEndedOrOutsideScope
            } else {
                EvalStatus::NoMatch
            };
            break;
        };

        let played_move = normalize_move_key(played_move_raw);
        let turn = if position.turn().is_white() {
            Side::White
        } else {
            Side::Black
        };

        if node.allowed_moves.contains(&played_move) {
            state.status = EvalStatus::Matching;
            state.matched_depth = ply;

            let Ok(uci) = UciMove::from_ascii(played_move.as_bytes()) else {
                break;
            };
            let Ok(mv) = uci.to_move(&position) else {
                break;
            };
            position.play_unchecked(&mv);

            if !state.entry_reached {
                if let Some(entry_fen) = &book.entry_fen_key {
                    if pos_fen_key(&position) == *entry_fen {
                        state.entry_reached = true;
                    }
                }
            }
            continue;
        }

        if !state.entry_reached {
            state.status = EvalStatus::DivergedBeforeEntry;
            state.deciding_ply_or_infinity = ply;
            if turn == human_color {
                state.self_deviation_ply = Some(ply);
            } else if turn == human_color.other() {
                state.opp_deviation_ply = Some(ply);
            }
            break;
        }

        if turn == human_color {
            state.status = EvalStatus::SelfDeviation;
            state.self_deviation_ply = Some(ply);
            state.deciding_ply_or_infinity = ply;
            break;
        }

        state.status = EvalStatus::OppNovelty;
        state.opp_deviation_ply = Some(ply);
        state.deciding_ply_or_infinity = ply;
        break;
    }

    if state.status == EvalStatus::Matching {
        state.status = if state.entry_reached {
            EvalStatus::FullyMatched
        } else {
            EvalStatus::NoMatch
        };
    }

    state
}

fn decide_variant_action(
    initial_fen: &str,
    moves: &[String],
    human_color: Side,
    books: &[VariantBook],
) -> Decision {
    let scoped: Vec<VariantBook> = books
        .iter()
        .filter(|book| book.side.map_or(false, |s| s == human_color))
        .cloned()
        .collect();

    if scoped.is_empty() {
        return Decision {
            detected: true,
            ply: None,
            target_book_path: None,
            book_path: None,
            should_open_variants: true,
            kind: "no-book",
        };
    }

    let evaluations: Vec<BookEvaluation> = scoped
        .iter()
        .map(|book| evaluate_book_against_game(book, initial_fen, moves, human_color))
        .collect();

    let reached: Vec<BookEvaluation> = evaluations
        .iter()
        .filter(|state| state.entry_reached)
        .cloned()
        .collect();

    if reached.is_empty() {
        let mut near_entry: Vec<BookEvaluation> = evaluations
            .iter()
            .filter(|state| {
                state.book.entry_ply > 0
                    && state.opp_deviation_ply.is_some()
                    && state.matched_depth >= state.book.entry_ply.saturating_sub(2)
            })
            .cloned()
            .collect();

        near_entry.sort_by(|a, b| {
            b.matched_depth
                .cmp(&a.matched_depth)
                .then_with(|| b.book.entry_ply.cmp(&a.book.entry_ply))
                .then_with(|| a.deciding_ply_or_infinity.cmp(&b.deciding_ply_or_infinity))
        });

        if let Some(best) = near_entry.first() {
            let top_tuple = (
                best.matched_depth,
                best.book.entry_ply,
                best.deciding_ply_or_infinity,
            );
            let tied_count = near_entry
                .iter()
                .filter(|state| {
                    (
                        state.matched_depth,
                        state.book.entry_ply,
                        state.deciding_ply_or_infinity,
                    ) == top_tuple
                })
                .count();

            if tied_count > 1 {
                return Decision {
                    detected: true,
                    ply: None,
                    target_book_path: None,
                    book_path: None,
                    should_open_variants: true,
                    kind: "ambiguous",
                };
            }

            return Decision {
                detected: true,
                ply: best.opp_deviation_ply,
                target_book_path: Some(best.book.path.clone()),
                book_path: Some(best.book.path.clone()),
                should_open_variants: true,
                kind: "no-entry",
            };
        }

        return Decision {
            detected: true,
            ply: None,
            target_book_path: None,
            book_path: None,
            should_open_variants: true,
            kind: "no-entry",
        };
    }

    let mut sorted = reached;
    sorted.sort_by(|a, b| {
        b.book
            .entry_ply
            .cmp(&a.book.entry_ply)
            .then_with(|| b.matched_depth.cmp(&a.matched_depth))
            .then_with(|| a.deciding_ply_or_infinity.cmp(&b.deciding_ply_or_infinity))
    });

    let best = &sorted[0];
    let best_tuple = (
        best.book.entry_ply,
        best.matched_depth,
        best.deciding_ply_or_infinity,
    );
    let tied_count = sorted
        .iter()
        .filter(|state| {
            (
                state.book.entry_ply,
                state.matched_depth,
                state.deciding_ply_or_infinity,
            ) == best_tuple
        })
        .count();

    if tied_count > 1 {
        return Decision {
            detected: true,
            ply: None,
            target_book_path: None,
            book_path: None,
            should_open_variants: true,
            kind: "ambiguous",
        };
    }

    if let Some(self_ply) = best.self_deviation_ply {
        if best.opp_deviation_ply.map_or(true, |opp_ply| self_ply <= opp_ply) {
            return Decision {
                detected: true,
                ply: Some(self_ply),
                target_book_path: None,
                book_path: Some(best.book.path.clone()),
                should_open_variants: false,
                kind: "self",
            };
        }
    }

    if let Some(opp_ply) = best.opp_deviation_ply {
        return Decision {
            detected: true,
            ply: Some(opp_ply),
            target_book_path: Some(best.book.path.clone()),
            book_path: Some(best.book.path.clone()),
            should_open_variants: true,
            kind: "opp",
        };
    }

    Decision {
        detected: false,
        ply: None,
        target_book_path: None,
        book_path: Some(best.book.path.clone()),
        should_open_variants: false,
        kind: "none",
    }
}

fn build_line_pgn(initial_fen: &str, moves: &[String], until_ply: usize) -> Option<(String, String)> {
    if moves.is_empty() {
        return None;
    }

    let mut position = parse_position(initial_fen)?;
    let bounded = until_ply.min(moves.len().saturating_sub(1));
    let mut tree = GameTree::new();

    for mv in moves.iter().take(bounded + 1) {
        let normalized = normalize_move_key(mv);
        let uci = UciMove::from_ascii(normalized.as_bytes()).ok()?;
        let parsed = uci.to_move(&position).ok()?;
        let san_plus = SanPlus::from_move_and_play_unchecked(&mut position, &parsed);
        tree.push(GameTreeNode::Move(san_plus));
    }

    let line_text = tree.to_string().trim().to_string();
    if line_text.is_empty() {
        return None;
    }

    let date = Local::now().format("%Y.%m.%d").to_string();
    let mut tags = vec![
        r#"[Event "Variant extension"]"#.to_string(),
        r#"[Site "Obsidian Chess Studio"]"#.to_string(),
        format!(r#"[Date "{date}"]"#),
        r#"[Result "*"]"#.to_string(),
    ];

    let start_key = pos_fen_key(&Chess::default());
    let initial_trimmed = initial_fen.trim();
    if !initial_trimmed.is_empty()
        && !initial_trimmed.eq_ignore_ascii_case("startpos")
        && normalize_fen_key(initial_trimmed) != start_key
    {
        tags.push(r#"[SetUp "1"]"#.to_string());
        tags.push(format!(r#"[FEN "{}"]"#, initial_trimmed.replace('"', "\\\"")));
    }

    let pgn = format!("{}\n\n{} *\n", tags.join("\n"), line_text);
    Some((pgn, line_text))
}

fn append_line_to_book(book_path: &str, initial_fen: &str, moves: &[String], until_ply: usize) -> Option<(String, String)> {
    let (line_pgn, line_text) = build_line_pgn(initial_fen, moves, until_ply)?;
    let current = fs::read_to_string(book_path).ok()?;
    let next = format!("{}\n\n{}\n", line_pgn.trim(), current.trim_start());
    fs::write(book_path, next).ok()?;
    Some((book_path.to_string(), line_text))
}

fn extract_book_name(path: Option<&str>) -> Option<String> {
    let p = path?;
    let as_path = Path::new(p);
    as_path.file_name().map(|n| n.to_string_lossy().to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn post_game_review_variants(
    input: PostGameReviewVariantsInput,
) -> Result<PostGameReviewVariantsResult> {
    log::info!(
        "post_game_review_variants:start dir={} human_color={:?} moves={} initial_fen={}",
        input.document_dir,
        input.human_color,
        input.moves.len(),
        input.initial_fen
    );
    let human = input.human_color.as_deref().and_then(Side::parse);
    let Some(human_color) = human else {
        log::info!("post_game_review_variants:skip no-human-color");
        return Ok(PostGameReviewVariantsResult {
            detected: false,
            variant_deviation_ply: None,
            new_line_added: false,
            variants_book_path: None,
            variants_book_name: None,
            added_variant_line: None,
            open_variants_after_review: false,
            kind: "none".to_string(),
            book_match_plies: Vec::new(),
            book_errors: Vec::new(),
            book_unknowns: Vec::new(),
        });
    };

    let books = load_variant_books(&input.document_dir);
    let scoped_books = books
        .iter()
        .filter(|book| book.side.map_or(false, |s| s == human_color))
        .count();
    let decision = decide_variant_action(&input.initial_fen, &input.moves, human_color, &books);
    let (book_match_plies, book_errors, book_unknowns) =
        detect_book_errors(&input.initial_fen, &input.moves, human_color, &books);
    log::info!(
        "post_game_review_variants:loaded books_total={} books_scoped={} matches={} errors={} unknowns={} decision_kind={} decision_ply={:?}",
        books.len(),
        scoped_books,
        book_match_plies.len(),
        book_errors.len(),
        book_unknowns.len(),
        decision.kind,
        decision.ply
    );

    let mut new_line_added = false;
    let mut variants_book_path = decision.book_path.clone();
    let mut added_variant_line: Option<String> = None;

    if let (Some(target), Some(ply)) = (decision.target_book_path.as_deref(), decision.ply) {
        if let Some((path, line)) = append_line_to_book(target, &input.initial_fen, &input.moves, ply) {
            new_line_added = true;
            variants_book_path = Some(path);
            added_variant_line = Some(line);
        }
    }

    Ok(PostGameReviewVariantsResult {
        detected: decision.detected,
        variant_deviation_ply: decision.ply,
        new_line_added,
        variants_book_name: extract_book_name(variants_book_path.as_deref()),
        variants_book_path,
        added_variant_line,
        open_variants_after_review: decision.should_open_variants,
        kind: decision.kind.to_string(),
        book_match_plies,
        book_errors,
        book_unknowns,
    })
}
