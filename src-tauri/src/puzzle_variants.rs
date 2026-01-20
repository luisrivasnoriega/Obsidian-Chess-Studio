use crate::error::{Error, Result};
use specta::Type;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[specta(rename = "PuzzleTreeNodeDto")]
#[serde(rename_all = "camelCase")]
pub struct TreeNodeDto {
    pub fen: String,
    #[serde(default)]
    pub san: Option<String>,
    #[serde(default)]
    pub children: Vec<TreeNodeDto>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    White,
    Black,
}

impl Side {
    fn from_orientation(orientation: &str) -> Result<Self> {
        match orientation.trim().to_lowercase().as_str() {
            "white" => Ok(Side::White),
            "black" => Ok(Side::Black),
            other => Err(Error::FenError(format!(
                "Invalid orientation: {other} (expected 'white' or 'black')"
            ))),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneratePuzzleVariantsResponse {
    pub pgn: String,
    pub count: usize,
}

fn fen_turn(fen: &str) -> Result<Side> {
    let parts: Vec<&str> = fen.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return Err(Error::FenError(format!("Invalid FEN (missing turn): {fen}")));
    }
    match parts[1] {
        "w" => Ok(Side::White),
        "b" => Ok(Side::Black),
        other => Err(Error::FenError(format!("Invalid FEN turn: {other}"))),
    }
}

fn fen_fullmove_number(fen: &str) -> u32 {
    let parts: Vec<&str> = fen.trim().split_whitespace().collect();
    if parts.len() >= 6 {
        parts[5].parse::<u32>().unwrap_or(1)
    } else {
        1
    }
}

fn fen_identity_key(fen: &str) -> String {
    // Best-effort key: first 4 fields (piece placement, turn, castling, ep).
    // This matches the frontend's intention (dedupe transpositions with same identity).
    let parts: Vec<&str> = fen.trim().split_whitespace().collect();
    if parts.len() >= 4 {
        parts[..4].join(" ")
    } else {
        fen.trim().to_string()
    }
}

fn canonicalize_solution(solution: &str) -> String {
    // Remove move numbers like "12." or "12..." and normalize spaces.
    let re = regex::Regex::new(r"\b\d+\.(?:\.\.)?\s*").unwrap();
    let without_numbers = re.replace_all(solution, "");
    without_numbers
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn normalize_san_token(san: &str) -> String {
    // Best-effort normalization for legacy SAN strings that may include prefixes like "...e5".
    // The frontend typically stores SAN without move-number/ellipsis prefixes.
    san.trim_start_matches('.').trim().to_string()
}

fn build_solution_text(start_fen: &str, sans: &[String]) -> Result<String> {
    let start_turn = fen_turn(start_fen)?;
    let mut move_number = fen_fullmove_number(start_fen);

    let mut parts: Vec<String> = Vec::with_capacity(sans.len() * 2);
    let mut turn = start_turn;

    for (i, san) in sans.iter().enumerate() {
        let san = san.trim();
        if san.is_empty() {
            return Ok(String::new());
        }

        match turn {
            Side::White => {
                parts.push(format!("{move_number}. {san}"));
                move_number = move_number.saturating_add(1);
            }
            Side::Black => {
                if i == 0 && start_turn == Side::Black {
                    parts.push(format!("{move_number}... {san}"));
                    move_number = move_number.saturating_add(1);
                } else {
                    parts.push(san.to_string());
                }
            }
        }

        // Toggle turn each ply (we don't validate legality here).
        turn = if turn == Side::White { Side::Black } else { Side::White };
    }

    Ok(parts.join(" ").trim().to_string())
}

fn max_moves_from_node(node: &TreeNodeDto, puzzle_side: Side, memo: &mut std::collections::HashMap<*const TreeNodeDto, u32>) -> Result<u32> {
    let key = node as *const TreeNodeDto;
    if let Some(v) = memo.get(&key) {
        return Ok(*v);
    }

    let turn = fen_turn(&node.fen)?;
    if node.children.is_empty() {
        memo.insert(key, 0);
        return Ok(0);
    }

    let add = if turn == puzzle_side { 1 } else { 0 };
    let mut best = 0u32;
    for child in &node.children {
        if child.san.as_deref().unwrap_or("").trim().is_empty() {
            continue;
        }
        let child_best = max_moves_from_node(child, puzzle_side, memo)?;
        best = best.max(add + child_best);
    }

    memo.insert(key, best);
    Ok(best)
}

fn collect_lines_from_position(
    start: &TreeNodeDto,
    puzzle_side: Side,
    selected_depth: u32,
) -> Result<Vec<Vec<String>>> {
    if selected_depth == 0 {
        return Ok(vec![]);
    }

    let mut memo: std::collections::HashMap<*const TreeNodeDto, u32> = std::collections::HashMap::new();
    if max_moves_from_node(start, puzzle_side, &mut memo)? < selected_depth {
        return Ok(vec![]);
    }

    let mut out: Vec<Vec<String>> = Vec::new();

    fn step(
        node: &TreeNodeDto,
        puzzle_side: Side,
        selected_depth: u32,
        memo: &mut std::collections::HashMap<*const TreeNodeDto, u32>,
        moves: &mut Vec<String>,
        puzzle_moves: u32,
        depth: u32,
        out: &mut Vec<Vec<String>>,
    ) -> Result<()> {
        const MAX_DEPTH: u32 = 80;
        if depth > MAX_DEPTH {
            return Ok(());
        }

        if puzzle_moves == selected_depth {
            if !moves.is_empty() {
                out.push(moves.clone());
            }
            return Ok(());
        }

        let remaining = selected_depth.saturating_sub(puzzle_moves);
        if max_moves_from_node(node, puzzle_side, memo)? < remaining {
            return Ok(());
        }

        let turn = fen_turn(&node.fen)?;
        let add = if turn == puzzle_side { 1 } else { 0 };

        for child in &node.children {
            let san = child.san.as_deref().unwrap_or("").trim();
            if san.is_empty() {
                continue;
            }

            let next_puzzle_moves = puzzle_moves + add;
            if next_puzzle_moves > selected_depth {
                continue;
            }

            moves.push(san.to_string());
            step(
                child,
                puzzle_side,
                selected_depth,
                memo,
                moves,
                next_puzzle_moves,
                depth + 1,
                out,
            )?;
            moves.pop();
        }

        Ok(())
    }

    let mut moves = Vec::new();
    step(
        start,
        puzzle_side,
        selected_depth,
        &mut memo,
        &mut moves,
        0,
        0,
        &mut out,
    )?;

    Ok(out)
}

fn generate_puzzle_variants_from_tree_impl(
    root: &TreeNodeDto,
    puzzle_side: Side,
    selected_depth: u32,
) -> Result<GeneratePuzzleVariantsResponse> {
    if selected_depth < 1 {
        return Ok(GeneratePuzzleVariantsResponse {
            pgn: String::new(),
            count: 0,
        });
    }

    // Puzzles must always include a prior "system" move (the opponent's move) before the solver acts.
    // That means the puzzle starts one ply earlier than the branching node:
    // - Start FEN: opponent to move
    // - First move in the solution: forced opponent move
    // - Then: solver chooses among variations (depth counts solver moves only)
    fn traverse_and_collect(
        node: &TreeNodeDto,
        parent: Option<&TreeNodeDto>,
        puzzle_side: Side,
        selected_depth: u32,
        counter: &mut usize,
        dedupe: &mut std::collections::HashSet<String>,
        out: &mut String,
    ) -> Result<()> {
        const MAX_DEPTH: u32 = 80;

        fn inner(
            node: &TreeNodeDto,
            parent: Option<&TreeNodeDto>,
            puzzle_side: Side,
            selected_depth: u32,
            depth: u32,
            counter: &mut usize,
            dedupe: &mut std::collections::HashSet<String>,
            out: &mut String,
        ) -> Result<()> {
            if depth > MAX_DEPTH {
                return Ok(());
            }

            let turn = fen_turn(&node.fen)?;
            let children_with_san: Vec<&TreeNodeDto> = node
                .children
                .iter()
                .filter(|c| c.san.as_deref().unwrap_or("").trim().len() > 0)
                .collect();
            let has_continuations = !children_with_san.is_empty();

            // Branching node: solver to move with multiple variations.
            // We only generate a puzzle if there's a parent node (so we can include the forced system move).
            if turn == puzzle_side && has_continuations {
                if let Some(parent) = parent {
                    let parent_turn = fen_turn(&parent.fen)?;
                    let forced_system_move = node
                        .san
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty());

                    // Parent must be the opponent to move; the move leading here is the forced system move.
                    if parent_turn != puzzle_side {
                        if let Some(forced_system_move) = forced_system_move {
                            let lines = collect_lines_from_position(node, puzzle_side, selected_depth)?;
                            for line in lines {
                                let mut sans: Vec<String> = Vec::with_capacity(line.len() + 1);
                                sans.push(normalize_san_token(forced_system_move));
                                sans.extend(line);

                                let solution = build_solution_text(&parent.fen, &sans)?;
                                if solution.is_empty() {
                                    continue;
                                }
                                let canonical = canonicalize_solution(&solution);
                                let start_key = fen_identity_key(&parent.fen);
                                let dedupe_key = format!("{start_key}|{canonical}");
                                if dedupe.contains(&dedupe_key) {
                                    continue;
                                }
                                dedupe.insert(dedupe_key);

                                *counter += 1;
                                let current_date = chrono::Local::now().format("%Y.%m.%d").to_string();
                                let (white_name, black_name) = match puzzle_side {
                                    Side::White => ("Puzzle", "?"),
                                    Side::Black => ("?", "Puzzle"),
                                };

                                out.push_str(&format!(r#"[Event "Mini puzzle {n}"]"#, n = *counter));
                                out.push('\n');
                                out.push_str(r#"[Site "Local"]"#);
                                out.push('\n');
                                out.push_str(&format!(r#"[Date "{current_date}"]"#));
                                out.push('\n');
                                out.push_str(r#"[Round "-"]"#);
                                out.push('\n');
                                out.push_str(&format!(r#"[White "{white_name}"]"#));
                                out.push('\n');
                                out.push_str(&format!(r#"[Black "{black_name}"]"#));
                                out.push('\n');
                                out.push_str(r#"[Result "*"]"#);
                                out.push('\n');
                                out.push_str(r#"[SetUp "1"]"#);
                                out.push('\n');
                                out.push_str(&format!(r#"[FEN "{fen}"]"#, fen = parent.fen));
                                out.push('\n');
                                out.push_str(&format!(r#"[Solution "{solution}"]"#));
                                out.push('\n');
                                out.push('\n');
                                out.push_str(&solution);
                                out.push('\n');
                                out.push('\n');
                            }
                        }
                    }
                }
            }

            for child in children_with_san {
                inner(
                    child,
                    Some(node),
                    puzzle_side,
                    selected_depth,
                    depth + 1,
                    counter,
                    dedupe,
                    out,
                )?;
            }

            Ok(())
        }

        inner(
            node,
            parent,
            puzzle_side,
            selected_depth,
            0,
            counter,
            dedupe,
            out,
        )
    }

    let mut out = String::new();
    let mut counter: usize = 0;
    let mut dedupe: std::collections::HashSet<String> = std::collections::HashSet::new();

    traverse_and_collect(root, None, puzzle_side, selected_depth, &mut counter, &mut dedupe, &mut out)?;

    Ok(GeneratePuzzleVariantsResponse { pgn: out, count: counter })
}

#[tauri::command]
#[specta::specta]
pub fn generate_puzzle_variants_from_tree(
    root: TreeNodeDto,
    orientation: String,
    selected_depth: u32,
) -> Result<GeneratePuzzleVariantsResponse> {
    let puzzle_side = Side::from_orientation(&orientation)?;
    generate_puzzle_variants_from_tree_impl(&root, puzzle_side, selected_depth)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(fen: &str, san: Option<&str>, children: Vec<TreeNodeDto>) -> TreeNodeDto {
        TreeNodeDto {
            fen: fen.to_string(),
            san: san.map(|s| s.to_string()),
            children,
        }
    }

    #[test]
    fn puzzles_start_with_forced_system_move_white() {
        // Root: black to move (system), plays a forced move to a position where white has variations.
        let tree = n(
            "8/8/8/8/8/8/8/8 b - - 0 1",
            None,
            vec![
                n(
                    "8/8/8/8/8/8/8/8 w - - 0 2",
                    Some("e5"),
                    vec![
                        n("8/8/8/8/8/8/8/8 b - - 0 2", Some("Nf3"), vec![]),
                        n("8/8/8/8/8/8/8/8 b - - 0 2", Some("Bc4"), vec![]),
                    ],
                ),
            ],
        );

        let res = generate_puzzle_variants_from_tree_impl(&tree, Side::White, 1).unwrap();
        assert_eq!(res.count, 2, "Two alternative white replies should produce two puzzles at depth=1");
        assert!(
            res.pgn.contains(r#"[FEN "8/8/8/8/8/8/8/8 b - - 0 1"]"#),
            "Puzzle FEN must be the position before the system move"
        );
        assert!(
            res.pgn.contains(r#"[Solution "1... e5 2. Nf3"]"#)
                || res.pgn.contains(r#"[Solution "1... e5 2. Bc4"]"#),
            "Solution must include the forced system move first"
        );
    }

    #[test]
    fn puzzles_work_with_single_solver_move() {
        // Root: black to move (system), plays a forced move; white has exactly one reply.
        let tree = n(
            "8/8/8/8/8/8/8/8 b - - 0 1",
            None,
            vec![n(
                "8/8/8/8/8/8/8/8 w - - 0 2",
                Some("e5"),
                vec![n("8/8/8/8/8/8/8/8 b - - 0 2", Some("Nf3"), vec![])],
            )],
        );

        let res = generate_puzzle_variants_from_tree_impl(&tree, Side::White, 1).unwrap();
        assert_eq!(res.count, 1, "A single forced reply should still generate a puzzle");
        assert!(
            res.pgn.contains(r#"[Solution "1... e5 2. Nf3"]"#),
            "Solution must include the forced system move first"
        );
    }

    #[test]
    fn puzzles_do_not_start_at_root_without_system_move() {
        // Root: white to move with variations (no prior system move), should produce 0 puzzles.
        let tree = n(
            "8/8/8/8/8/8/8/8 w - - 0 1",
            None,
            vec![
                n("8/8/8/8/8/8/8/8 b - - 0 1", Some("e4"), vec![]),
                n("8/8/8/8/8/8/8/8 b - - 0 1", Some("d4"), vec![]),
            ],
        );

        let res = generate_puzzle_variants_from_tree_impl(&tree, Side::White, 1).unwrap();
        assert_eq!(res.count, 0);
    }
}

