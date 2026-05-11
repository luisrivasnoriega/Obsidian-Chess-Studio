use crate::error::{Error, Result};
use crate::variant_coverage_graph::{VariantCoverageGraphNodeDto, VariantCoverageTierDto};
use specta::Type;
use std::collections::HashSet;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[specta(rename = "PuzzleTreeNodeDto")]
#[serde(rename_all = "camelCase")]
pub struct TreeNodeDto {
    pub fen: String,
    #[serde(default)]
    pub san: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub opening_name: Option<String>,
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

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CoveragePuzzleTierFilterDto {
    All,
    Mainline,
    Secondary,
    Alternative,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneratePuzzleVariantsFromCoverageNodeRequest {
    pub graph_root: VariantCoverageGraphNodeDto,
    pub action_node_id: String,
    pub orientation: String,
    pub selected_depth: u32,
    pub tier_filter: CoveragePuzzleTierFilterDto,
    pub include_low_sample: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CoveragePuzzleVariantGenerationDto {
    pub tier: VariantCoverageTierDto,
    pub pgn: String,
    pub count: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneratePuzzleVariantsFromCoverageNodeResponse {
    pub results: Vec<CoveragePuzzleVariantGenerationDto>,
    pub empty_tiers: Vec<VariantCoverageTierDto>,
    pub eco_variant: Option<String>,
}

fn fen_turn(fen: &str) -> Result<Side> {
    let parts: Vec<&str> = fen.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return Err(Error::FenError(format!(
            "Invalid FEN (missing turn): {fen}"
        )));
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

fn coverage_tier_filter_targets(
    filter: CoveragePuzzleTierFilterDto,
) -> Vec<VariantCoverageTierDto> {
    match filter {
        CoveragePuzzleTierFilterDto::All => vec![
            VariantCoverageTierDto::Mainline,
            VariantCoverageTierDto::Secondary,
            VariantCoverageTierDto::Alternative,
        ],
        CoveragePuzzleTierFilterDto::Mainline => vec![VariantCoverageTierDto::Mainline],
        CoveragePuzzleTierFilterDto::Secondary => vec![VariantCoverageTierDto::Secondary],
        CoveragePuzzleTierFilterDto::Alternative => vec![VariantCoverageTierDto::Alternative],
    }
}

fn format_coverage_eco_variant(opening_name: Option<&str>) -> Option<String> {
    let trimmed = opening_name?.trim();
    if trimmed.is_empty() {
        return None;
    }

    let re = regex::Regex::new(r"(?i)^([A-E]\d{2})(?:\s*[-:]\s*|\s+)(.+)$").unwrap();
    if let Some(captures) = re.captures(trimmed) {
        let eco_code = captures.get(1).map(|m| m.as_str().to_uppercase());
        let opening = captures.get(2).map(|m| m.as_str().trim().to_string());
        if let (Some(eco_code), Some(opening)) = (eco_code, opening) {
            if !opening.is_empty() {
                return Some(format!("{eco_code}: {opening}"));
            }
        }
    }

    Some(trimmed.to_string())
}

#[derive(Debug, Clone)]
struct PgnOpeningHeaders {
    eco: Option<String>,
    opening: Option<String>,
}

fn parse_pgn_opening_headers(opening_name: Option<&str>) -> Option<PgnOpeningHeaders> {
    let trimmed = opening_name?.trim();
    if trimmed.is_empty() {
        return None;
    }

    let re = regex::Regex::new(r"(?i)^([A-E]\d{2})(?:\s*[-:]\s*|\s+)(.+)$").unwrap();
    if let Some(captures) = re.captures(trimmed) {
        let eco = captures.get(1).map(|m| m.as_str().to_uppercase());
        let opening = captures
            .get(2)
            .map(|m| m.as_str().trim().to_string())
            .filter(|value| !value.is_empty());
        return Some(PgnOpeningHeaders { eco, opening });
    }

    Some(PgnOpeningHeaders {
        eco: None,
        opening: Some(trimmed.to_string()),
    })
}

fn escape_pgn_tag_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn extract_san_from_coverage_label(label: &str) -> Option<String> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return None;
    }
    let left_part = trimmed.split('|').next().unwrap_or(trimmed).trim();
    let first_token = left_part.split_whitespace().next().unwrap_or("").trim();
    if first_token.is_empty() {
        None
    } else {
        Some(first_token.to_string())
    }
}

fn extract_san_from_override_key(override_key: Option<&str>) -> Option<String> {
    let override_key = override_key?.trim();
    let separator = override_key.rfind('|')?;
    if separator == 0 || separator + 1 >= override_key.len() {
        return None;
    }
    let san = override_key[separator + 1..].trim();
    if san.is_empty() {
        None
    } else {
        Some(san.to_string())
    }
}

fn extract_san_from_coverage_node(node: &VariantCoverageGraphNodeDto) -> Option<String> {
    extract_san_from_override_key(node.override_key.as_deref())
        .or_else(|| extract_san_from_coverage_label(&node.label))
}

fn find_coverage_node_path_by_id<'a>(
    node: &'a VariantCoverageGraphNodeDto,
    id: &str,
    path: &mut Vec<&'a VariantCoverageGraphNodeDto>,
) -> bool {
    path.push(node);
    if node.id == id {
        return true;
    }

    for child in &node.children {
        if find_coverage_node_path_by_id(child, id, path) {
            return true;
        }
    }

    path.pop();
    false
}

fn direct_branch_matches(
    child: &VariantCoverageGraphNodeDto,
    direct_branch_override_key: Option<&str>,
    direct_branch_san: Option<&str>,
) -> bool {
    if direct_branch_override_key.is_none() && direct_branch_san.is_none() {
        return true;
    }

    if let Some(direct_key) = direct_branch_override_key {
        if child.override_key.as_deref() == Some(direct_key) {
            return true;
        }
    }

    direct_branch_san
        .and_then(|san| extract_san_from_coverage_node(child).map(|child_san| child_san == san))
        .unwrap_or(false)
}

fn node_is_eligible_for_coverage_puzzles(
    node: &VariantCoverageGraphNodeDto,
    include_low_sample: bool,
) -> bool {
    include_low_sample || node.low_sample != Some(true)
}

fn has_tier_in_subtree(
    node: &VariantCoverageGraphNodeDto,
    selected_tier: VariantCoverageTierDto,
    include_low_sample: bool,
) -> bool {
    if node.tier == selected_tier && node_is_eligible_for_coverage_puzzles(node, include_low_sample)
    {
        return true;
    }
    node.children
        .iter()
        .any(|child| has_tier_in_subtree(child, selected_tier, include_low_sample))
}

fn to_filtered_puzzle_children(
    parent: &VariantCoverageGraphNodeDto,
    selected_tier: VariantCoverageTierDto,
    include_low_sample: bool,
    direct_branch_override_key: Option<&str>,
    direct_branch_san: Option<&str>,
    inherited_opening_name: Option<&str>,
) -> Vec<TreeNodeDto> {
    let mut out = Vec::new();

    for child in &parent.children {
        if !direct_branch_matches(child, direct_branch_override_key, direct_branch_san) {
            continue;
        }

        if child.tier != VariantCoverageTierDto::Root {
            let is_selected_tier = child.tier == selected_tier
                && node_is_eligible_for_coverage_puzzles(child, include_low_sample);
            let connects_to_selected_tier =
                has_tier_in_subtree(child, selected_tier, include_low_sample);
            if !is_selected_tier && !connects_to_selected_tier {
                continue;
            }
        }

        let Some(san) = extract_san_from_coverage_node(child) else {
            continue;
        };
        let Some(fen) = child
            .fen
            .as_deref()
            .map(str::trim)
            .filter(|fen| !fen.is_empty())
        else {
            continue;
        };

        let opening_name = child
            .opening_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or(inherited_opening_name)
            .map(str::to_string);

        out.push(TreeNodeDto {
            fen: fen.to_string(),
            san: Some(san),
            opening_name: opening_name.clone(),
            children: to_filtered_puzzle_children(
                child,
                selected_tier,
                include_low_sample,
                None,
                None,
                opening_name.as_deref(),
            ),
        });
    }

    out
}

fn collect_allowed_start_keys(
    parent: &VariantCoverageGraphNodeDto,
    selected_tier: VariantCoverageTierDto,
    include_low_sample: bool,
    direct_branch_override_key: Option<&str>,
    direct_branch_san: Option<&str>,
    allowed_start_keys: &mut HashSet<String>,
) {
    for child in &parent.children {
        if !direct_branch_matches(child, direct_branch_override_key, direct_branch_san) {
            continue;
        }

        if child.tier == selected_tier
            && node_is_eligible_for_coverage_puzzles(child, include_low_sample)
        {
            if let Some(override_key) = child
                .override_key
                .as_deref()
                .map(str::trim)
                .filter(|key| !key.is_empty())
            {
                let has_playable_reply = child.children.iter().any(|reply| {
                    extract_san_from_coverage_node(reply).is_some()
                        && reply
                            .fen
                            .as_deref()
                            .map(str::trim)
                            .is_some_and(|fen| !fen.is_empty())
                });
                if has_playable_reply {
                    allowed_start_keys.insert(override_key.to_string());
                }
            }
        }

        collect_allowed_start_keys(
            child,
            selected_tier,
            include_low_sample,
            None,
            None,
            allowed_start_keys,
        );
    }
}

fn collect_transposition_source_nodes<'a>(
    node: &'a VariantCoverageGraphNodeDto,
    start_fen_key: &str,
    seen_source_ids: &mut HashSet<String>,
    out: &mut Vec<&'a VariantCoverageGraphNodeDto>,
) {
    if let Some(fen) = node
        .fen
        .as_deref()
        .map(str::trim)
        .filter(|fen| !fen.is_empty())
    {
        if fen_identity_key(fen) == start_fen_key && seen_source_ids.insert(node.id.clone()) {
            out.push(node);
        }
    }

    for child in &node.children {
        collect_transposition_source_nodes(child, start_fen_key, seen_source_ids, out);
    }
}

fn generate_puzzle_variants_from_coverage_node_impl(
    request: GeneratePuzzleVariantsFromCoverageNodeRequest,
) -> Result<GeneratePuzzleVariantsFromCoverageNodeResponse> {
    let puzzle_side = Side::from_orientation(&request.orientation)?;
    let mut path = Vec::new();
    if !find_coverage_node_path_by_id(&request.graph_root, &request.action_node_id, &mut path) {
        return Err(Error::InvalidInput(
            "Could not locate the selected coverage node in the current graph".to_string(),
        ));
    }

    let selected_node = path
        .last()
        .copied()
        .ok_or_else(|| Error::InvalidInput("Coverage node path is empty".to_string()))?;
    let selected_parent_node = if path.len() > 1 {
        path.get(path.len() - 2).copied()
    } else {
        None
    };
    let use_parent_as_source =
        selected_node.tier != VariantCoverageTierDto::Root && selected_parent_node.is_some();
    let source_node = if use_parent_as_source {
        selected_parent_node.unwrap()
    } else {
        selected_node
    };

    let direct_branch_override_key = use_parent_as_source
        .then_some(selected_node.override_key.as_deref())
        .flatten();
    let direct_branch_san = if use_parent_as_source {
        extract_san_from_coverage_node(selected_node)
    } else {
        None
    };

    let start_fen = source_node
        .fen
        .as_deref()
        .map(str::trim)
        .filter(|fen| !fen.is_empty())
        .ok_or_else(|| {
            Error::InvalidInput("Selected coverage node has no FEN context".to_string())
        })?;
    let start_fen_key = fen_identity_key(start_fen);

    let mut transposition_source_nodes = Vec::new();
    let mut seen_source_ids = HashSet::new();
    collect_transposition_source_nodes(
        &request.graph_root,
        &start_fen_key,
        &mut seen_source_ids,
        &mut transposition_source_nodes,
    );
    if transposition_source_nodes.is_empty() {
        transposition_source_nodes.push(source_node);
    }

    let eco_variant = format_coverage_eco_variant(
        selected_node
            .opening_name
            .as_deref()
            .or(source_node.opening_name.as_deref()),
    );

    let mut results = Vec::new();
    let mut empty_tiers = Vec::new();

    for selected_tier in coverage_tier_filter_targets(request.tier_filter) {
        let mut allowed_start_keys = HashSet::new();
        for transposition_source_node in &transposition_source_nodes {
            collect_allowed_start_keys(
                transposition_source_node,
                selected_tier,
                request.include_low_sample,
                direct_branch_override_key,
                direct_branch_san.as_deref(),
                &mut allowed_start_keys,
            );
        }

        let mut merged_puzzle_children = Vec::new();
        for transposition_source_node in &transposition_source_nodes {
            merged_puzzle_children.extend(to_filtered_puzzle_children(
                transposition_source_node,
                selected_tier,
                request.include_low_sample,
                direct_branch_override_key,
                direct_branch_san.as_deref(),
                transposition_source_node
                    .opening_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty()),
            ));
        }

        if merged_puzzle_children.is_empty() || allowed_start_keys.is_empty() {
            empty_tiers.push(selected_tier);
            continue;
        }

        let puzzle_root = TreeNodeDto {
            fen: start_fen.to_string(),
            san: None,
            opening_name: source_node
                .opening_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            children: merged_puzzle_children,
        };
        let generated = generate_puzzle_variants_from_tree_impl(
            &puzzle_root,
            puzzle_side,
            request.selected_depth,
            Some(&allowed_start_keys),
        )?;

        if generated.count == 0 || generated.pgn.trim().is_empty() {
            empty_tiers.push(selected_tier);
            continue;
        }

        results.push(CoveragePuzzleVariantGenerationDto {
            tier: selected_tier,
            pgn: generated.pgn,
            count: generated.count,
        });
    }

    Ok(GeneratePuzzleVariantsFromCoverageNodeResponse {
        results,
        empty_tiers,
        eco_variant,
    })
}

fn build_allowed_start_key(fen: &str, forced_system_move: &str) -> String {
    format!(
        "{}|{}",
        fen_identity_key(fen),
        normalize_san_token(forced_system_move)
    )
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
        turn = if turn == Side::White {
            Side::Black
        } else {
            Side::White
        };
    }

    Ok(parts.join(" ").trim().to_string())
}

fn max_moves_from_node(
    node: &TreeNodeDto,
    puzzle_side: Side,
    memo: &mut std::collections::HashMap<*const TreeNodeDto, u32>,
) -> Result<u32> {
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

#[derive(Debug, Clone)]
struct PuzzleLine {
    sans: Vec<String>,
    opening_name: Option<String>,
}

fn normalize_opening_name(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn collect_lines_from_position(
    start: &TreeNodeDto,
    puzzle_side: Side,
    selected_depth: u32,
) -> Result<Vec<PuzzleLine>> {
    if selected_depth == 0 {
        return Ok(vec![]);
    }

    let mut memo: std::collections::HashMap<*const TreeNodeDto, u32> =
        std::collections::HashMap::new();
    if max_moves_from_node(start, puzzle_side, &mut memo)? < selected_depth {
        return Ok(vec![]);
    }

    let mut out: Vec<PuzzleLine> = Vec::new();

    fn step(
        node: &TreeNodeDto,
        puzzle_side: Side,
        selected_depth: u32,
        memo: &mut std::collections::HashMap<*const TreeNodeDto, u32>,
        moves: &mut Vec<String>,
        opening_name: Option<String>,
        puzzle_moves: u32,
        depth: u32,
        out: &mut Vec<PuzzleLine>,
    ) -> Result<()> {
        const MAX_DEPTH: u32 = 80;
        if depth > MAX_DEPTH {
            return Ok(());
        }

        let current_opening_name =
            normalize_opening_name(node.opening_name.as_deref()).or(opening_name);

        if puzzle_moves == selected_depth {
            if !moves.is_empty() {
                out.push(PuzzleLine {
                    sans: moves.clone(),
                    opening_name: current_opening_name,
                });
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
                current_opening_name.clone(),
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
        None,
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
    allowed_start_keys: Option<&std::collections::HashSet<String>>,
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
        allowed_start_keys: Option<&std::collections::HashSet<String>>,
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
            allowed_start_keys: Option<&std::collections::HashSet<String>>,
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
                    let forced_system_move =
                        node.san.as_deref().map(str::trim).filter(|s| !s.is_empty());

                    // Parent must be the opponent to move; the move leading here is the forced system move.
                    if parent_turn != puzzle_side {
                        if let Some(forced_system_move) = forced_system_move {
                            let forced_key =
                                build_allowed_start_key(&parent.fen, forced_system_move);
                            let allowed = allowed_start_keys
                                .map(|set| set.contains(&forced_key))
                                .unwrap_or(true);

                            if allowed {
                                let lines =
                                    collect_lines_from_position(node, puzzle_side, selected_depth)?;
                                for line in lines {
                                    let mut sans: Vec<String> =
                                        Vec::with_capacity(line.sans.len() + 1);
                                    sans.push(normalize_san_token(forced_system_move));
                                    sans.extend(line.sans);

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
                                    let current_date =
                                        chrono::Local::now().format("%Y.%m.%d").to_string();
                                    let (white_name, black_name) = match puzzle_side {
                                        Side::White => ("Puzzle", "?"),
                                        Side::Black => ("?", "Puzzle"),
                                    };
                                    let opening_headers = parse_pgn_opening_headers(
                                        line.opening_name
                                            .as_deref()
                                            .or(node.opening_name.as_deref()),
                                    );

                                    out.push_str(&format!(
                                        r#"[Event "Mini puzzle {n}"]"#,
                                        n = *counter
                                    ));
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
                                    if let Some(headers) = opening_headers {
                                        if let Some(eco) = headers.eco {
                                            out.push_str(&format!(
                                                r#"[ECO "{}"]"#,
                                                escape_pgn_tag_value(&eco)
                                            ));
                                            out.push('\n');
                                        }
                                        if let Some(opening) = headers.opening {
                                            out.push_str(&format!(
                                                r#"[Opening "{}"]"#,
                                                escape_pgn_tag_value(&opening)
                                            ));
                                            out.push('\n');
                                        }
                                    }
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
            }

            for child in children_with_san {
                inner(
                    child,
                    Some(node),
                    puzzle_side,
                    selected_depth,
                    allowed_start_keys,
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
            allowed_start_keys,
            0,
            counter,
            dedupe,
            out,
        )
    }

    let mut out = String::new();
    let mut counter: usize = 0;
    let mut dedupe: std::collections::HashSet<String> = std::collections::HashSet::new();

    traverse_and_collect(
        root,
        None,
        puzzle_side,
        selected_depth,
        allowed_start_keys,
        &mut counter,
        &mut dedupe,
        &mut out,
    )?;

    Ok(GeneratePuzzleVariantsResponse {
        pgn: out,
        count: counter,
    })
}

#[tauri::command]
#[specta::specta]
pub fn generate_puzzle_variants_from_tree(
    root: TreeNodeDto,
    orientation: String,
    selected_depth: u32,
    allowed_start_keys: Option<Vec<String>>,
) -> Result<GeneratePuzzleVariantsResponse> {
    let puzzle_side = Side::from_orientation(&orientation)?;
    let allowed_set = allowed_start_keys.map(|items| {
        items
            .into_iter()
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty())
            .collect::<std::collections::HashSet<String>>()
    });
    generate_puzzle_variants_from_tree_impl(
        &root,
        puzzle_side,
        selected_depth,
        allowed_set.as_ref(),
    )
}

#[tauri::command]
#[specta::specta]
pub fn generate_puzzle_variants_from_coverage_node(
    request: GeneratePuzzleVariantsFromCoverageNodeRequest,
) -> Result<GeneratePuzzleVariantsFromCoverageNodeResponse> {
    generate_puzzle_variants_from_coverage_node_impl(request)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEN_B1: &str = "8/8/8/8/8/8/8/8 b - - 0 1";
    const FEN_W2: &str = "8/8/8/8/8/8/8/8 w - - 0 2";
    const FEN_B2: &str = "8/8/8/8/8/8/8/8 b - - 0 2";

    fn n(fen: &str, san: Option<&str>, children: Vec<TreeNodeDto>) -> TreeNodeDto {
        TreeNodeDto {
            fen: fen.to_string(),
            san: san.map(|s| s.to_string()),
            opening_name: None,
            children,
        }
    }

    fn cn(
        id: &str,
        label: &str,
        tier: VariantCoverageTierDto,
        fen: Option<&str>,
        override_key: Option<&str>,
        low_sample: bool,
        children: Vec<VariantCoverageGraphNodeDto>,
    ) -> VariantCoverageGraphNodeDto {
        VariantCoverageGraphNodeDto {
            id: id.to_string(),
            label: label.to_string(),
            opening_name: None,
            transposition_labels: None,
            tier,
            percent: None,
            response_percent: None,
            response_rarity: None,
            fen: fen.map(ToOwned::to_owned),
            override_key: override_key.map(ToOwned::to_owned),
            active_moves_used: None,
            low_sample: low_sample.then_some(true),
            unmapped_response: None,
            collapsed: None,
            hidden_children_count: None,
            active_win_rate: None,
            active_loss_rate: None,
            profile_win_rate: None,
            profile_loss_rate: None,
            complete_line: None,
            engine_advantage: None,
            engine_ms: None,
            engine_name: None,
            children,
        }
    }

    fn coverage_root_with_branches(
        extra_children: Vec<VariantCoverageGraphNodeDto>,
    ) -> VariantCoverageGraphNodeDto {
        let mut children = vec![
            cn(
                "a6",
                "a6, Ba4",
                VariantCoverageTierDto::Mainline,
                Some(FEN_W2),
                Some("8/8/8/8/8/8/8/8 b - -|a6"),
                false,
                vec![cn(
                    "ba4",
                    "Ba4",
                    VariantCoverageTierDto::Mainline,
                    Some(FEN_B2),
                    Some("8/8/8/8/8/8/8/8 w - -|Ba4"),
                    false,
                    vec![],
                )],
            ),
            cn(
                "d6",
                "d6, d4",
                VariantCoverageTierDto::Secondary,
                Some(FEN_W2),
                Some("8/8/8/8/8/8/8/8 b - -|d6"),
                false,
                vec![cn(
                    "d4",
                    "d4",
                    VariantCoverageTierDto::Mainline,
                    Some(FEN_B2),
                    Some("8/8/8/8/8/8/8/8 w - -|d4"),
                    false,
                    vec![],
                )],
            ),
        ];
        children.extend(extra_children);
        cn(
            "root",
            "Root",
            VariantCoverageTierDto::Root,
            Some(FEN_B1),
            None,
            false,
            children,
        )
    }

    #[test]
    fn puzzles_start_with_forced_system_move_white() {
        // Root: black to move (system), plays a forced move to a position where white has variations.
        let tree = n(
            "8/8/8/8/8/8/8/8 b - - 0 1",
            None,
            vec![n(
                "8/8/8/8/8/8/8/8 w - - 0 2",
                Some("e5"),
                vec![
                    n("8/8/8/8/8/8/8/8 b - - 0 2", Some("Nf3"), vec![]),
                    n("8/8/8/8/8/8/8/8 b - - 0 2", Some("Bc4"), vec![]),
                ],
            )],
        );

        let res = generate_puzzle_variants_from_tree_impl(&tree, Side::White, 1, None).unwrap();
        assert_eq!(
            res.count, 2,
            "Two alternative white replies should produce two puzzles at depth=1"
        );
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

        let res = generate_puzzle_variants_from_tree_impl(&tree, Side::White, 1, None).unwrap();
        assert_eq!(
            res.count, 1,
            "A single forced reply should still generate a puzzle"
        );
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

        let res = generate_puzzle_variants_from_tree_impl(&tree, Side::White, 1, None).unwrap();
        assert_eq!(res.count, 0);
    }

    #[test]
    fn coverage_node_generation_filters_to_selected_direct_branch() {
        let request = GeneratePuzzleVariantsFromCoverageNodeRequest {
            graph_root: coverage_root_with_branches(vec![]),
            action_node_id: "a6".to_string(),
            orientation: "white".to_string(),
            selected_depth: 1,
            tier_filter: CoveragePuzzleTierFilterDto::All,
            include_low_sample: false,
        };

        let res = generate_puzzle_variants_from_coverage_node_impl(request).unwrap();

        assert_eq!(res.results.len(), 1);
        assert_eq!(res.results[0].tier, VariantCoverageTierDto::Mainline);
        assert_eq!(res.results[0].count, 1);
        assert!(res.results[0]
            .pgn
            .contains(r#"[Solution "1... a6 2. Ba4"]"#));
        assert!(res.empty_tiers.contains(&VariantCoverageTierDto::Secondary));
        assert!(res
            .empty_tiers
            .contains(&VariantCoverageTierDto::Alternative));
    }

    #[test]
    fn coverage_node_generation_respects_low_sample_filter() {
        let low_sample_alternative = cn(
            "nf6",
            "Nf6, d4",
            VariantCoverageTierDto::Alternative,
            Some(FEN_W2),
            Some("8/8/8/8/8/8/8/8 b - -|Nf6"),
            true,
            vec![cn(
                "reply-d4",
                "d4",
                VariantCoverageTierDto::Alternative,
                Some(FEN_B2),
                Some("8/8/8/8/8/8/8/8 w - -|d4"),
                false,
                vec![],
            )],
        );

        let excluded = generate_puzzle_variants_from_coverage_node_impl(
            GeneratePuzzleVariantsFromCoverageNodeRequest {
                graph_root: coverage_root_with_branches(vec![low_sample_alternative.clone()]),
                action_node_id: "root".to_string(),
                orientation: "white".to_string(),
                selected_depth: 1,
                tier_filter: CoveragePuzzleTierFilterDto::Alternative,
                include_low_sample: false,
            },
        )
        .unwrap();
        assert!(excluded.results.is_empty());
        assert!(excluded
            .empty_tiers
            .contains(&VariantCoverageTierDto::Alternative));

        let included = generate_puzzle_variants_from_coverage_node_impl(
            GeneratePuzzleVariantsFromCoverageNodeRequest {
                graph_root: coverage_root_with_branches(vec![low_sample_alternative]),
                action_node_id: "root".to_string(),
                orientation: "white".to_string(),
                selected_depth: 1,
                tier_filter: CoveragePuzzleTierFilterDto::Alternative,
                include_low_sample: true,
            },
        )
        .unwrap();
        assert_eq!(included.results.len(), 1);
        assert_eq!(included.results[0].count, 1);
        assert!(included.results[0]
            .pgn
            .contains(r#"[Solution "1... Nf6 2. d4"]"#));
    }

    #[test]
    fn coverage_node_generation_dedupes_transposition_sources() {
        let duplicate_source = cn(
            "transposed-root",
            "Transposed",
            VariantCoverageTierDto::Root,
            Some(FEN_B1),
            None,
            false,
            vec![cn(
                "transposed-a6",
                "a6, Ba4",
                VariantCoverageTierDto::Mainline,
                Some(FEN_W2),
                Some("8/8/8/8/8/8/8/8 b - -|a6"),
                false,
                vec![cn(
                    "transposed-ba4",
                    "Ba4",
                    VariantCoverageTierDto::Mainline,
                    Some(FEN_B2),
                    Some("8/8/8/8/8/8/8/8 w - -|Ba4"),
                    false,
                    vec![],
                )],
            )],
        );

        let request = GeneratePuzzleVariantsFromCoverageNodeRequest {
            graph_root: coverage_root_with_branches(vec![duplicate_source]),
            action_node_id: "root".to_string(),
            orientation: "white".to_string(),
            selected_depth: 1,
            tier_filter: CoveragePuzzleTierFilterDto::Mainline,
            include_low_sample: false,
        };

        let res = generate_puzzle_variants_from_coverage_node_impl(request).unwrap();

        assert_eq!(res.results.len(), 1);
        assert_eq!(res.results[0].count, 1);
        assert_eq!(
            res.results[0]
                .pgn
                .match_indices(r#"[Event "Mini puzzle"#)
                .count(),
            1
        );
    }
}
