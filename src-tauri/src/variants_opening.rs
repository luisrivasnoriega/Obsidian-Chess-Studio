use serde::Serialize;
use serde_json::{json, Value};
use specta::Type;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use crate::db::pgn::{GameTree, GameTreeNode, Importer, TempGame};
use crate::error::{Error, Result};
use crate::opening::{get_opening_info_from_fen, OpeningInfo};
use crate::variants_manager::{
    variants_delete_files, variants_list_fast, VariantInfoDto, VariantLinkRefDto,
};
use chrono::Local;
use pgn_reader::BufferedReader;
use shakmaty::{fen::Fen, Chess, EnPassantMode, Position};

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateOpeningVariantsResult {
    pub created: u32,
    pub removed: u32,
    pub root_path: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CompressVariantFamilyResult {
    pub merged: u32,
    pub removed: u32,
    pub root_path: String,
}

#[derive(Debug, Clone)]
struct SimpleNode {
    san: Option<String>,
    fen: String,
    children: Vec<SimpleNode>,
}

#[derive(Debug, Clone)]
struct ParsedVariantGame {
    root: SimpleNode,
    orientation: String,
}

#[derive(Debug, Clone)]
struct OpeningGroup {
    id: String,
    title: String,
    title_candidates: Vec<String>,
    fen: String,
    source_nodes: Vec<SimpleNode>,
    parent_id: Option<String>,
    parent_anchor_san: Option<String>,
    children: Vec<String>,
    file_stem: String,
    file_path: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct OpeningAnchor {
    anchor_fen: String,
    anchor_path: Vec<u32>,
    anchor_ply: u32,
    label: Option<String>,
}

fn normalize_path_key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

fn normalize_fen_key(fen: &str) -> String {
    let parts: Vec<&str> = fen.split_whitespace().collect();
    if parts.len() < 4 {
        return fen.trim().to_string();
    }
    parts[..4].join(" ")
}

fn parent_dir(path: &Path) -> PathBuf {
    path.parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

fn resolve_link_path(owner_path: &Path, link_path: &str) -> String {
    if Path::new(link_path).is_absolute() {
        normalize_path_key(link_path)
    } else {
        normalize_path_key(&parent_dir(owner_path).join(link_path).to_string_lossy())
    }
}

fn info_path(path: &Path) -> PathBuf {
    path.with_extension("info")
}

fn read_metadata(path: &Path) -> Result<Value> {
    let path = info_path(path);
    if !path.exists() {
        return Ok(json!({
            "type": "variants",
            "tags": [],
            "schemaVersion": 2,
            "links": { "children": [] }
        }));
    }
    let raw = fs::read_to_string(path)?;
    let mut value: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    if value.get("type").is_none() {
        value["type"] = json!("variants");
    }
    if value.get("tags").and_then(Value::as_array).is_none() {
        value["tags"] = json!([]);
    }
    if value.get("schemaVersion").is_none() {
        value["schemaVersion"] = json!(2);
    }
    if value.get("links").is_none() {
        value["links"] = json!({ "children": [] });
    }
    if value
        .get("links")
        .and_then(|links| links.get("children"))
        .and_then(Value::as_array)
        .is_none()
    {
        value["links"]["children"] = json!([]);
    }
    Ok(value)
}

fn write_metadata(path: &Path, value: &Value) -> Result<()> {
    let raw = serde_json::to_string_pretty(value).map_err(|error| {
        Error::InvalidInput(format!("Failed to serialize variant metadata: {error}"))
    })?;
    fs::write(info_path(path), raw)?;
    Ok(())
}

fn metadata_tags(value: &Value) -> Vec<String> {
    value
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn tag_value(tags: &[String], prefix: &str) -> Option<String> {
    tags.iter()
        .find_map(|tag| tag.strip_prefix(prefix))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn sanitize_file_stem(input: &str, fallback: &str) -> String {
    let cleaned = input
        .chars()
        .filter(|ch| !matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

fn truncate_file_stem(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.chars().count() <= 96 {
        return trimmed.to_string();
    }
    trimmed
        .chars()
        .take(96)
        .collect::<String>()
        .trim()
        .to_string()
}

fn make_unique_file_stem(input: &str, reserved: &mut HashSet<String>, fallback: &str) -> String {
    let base = truncate_file_stem(&sanitize_file_stem(input, fallback));
    let mut candidate = base.clone();
    let mut index = 2usize;
    while reserved.contains(&candidate.to_lowercase()) {
        candidate = truncate_file_stem(&format!("{base} {index}"));
        index = index.saturating_add(1);
    }
    reserved.insert(candidate.to_lowercase());
    candidate
}

fn make_unique_opening_file_stem(
    title_candidates: &[String],
    reserved: &mut HashSet<String>,
    fallback: &str,
) -> (String, String) {
    let candidates = if title_candidates.is_empty() {
        vec![fallback.to_string()]
    } else {
        title_candidates.to_vec()
    };
    for title in &candidates {
        let file_stem = truncate_file_stem(&sanitize_file_stem(title, fallback));
        if !reserved.contains(&file_stem.to_lowercase()) {
            reserved.insert(file_stem.to_lowercase());
            return (title.clone(), file_stem);
        }
    }
    let title = candidates
        .last()
        .cloned()
        .unwrap_or_else(|| fallback.to_string());
    let file_stem = make_unique_file_stem(&title, reserved, fallback);
    (title, file_stem)
}

fn normalize_opening_variant_key(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace(" ,", ",")
        .to_lowercase()
}

fn is_eco_code(value: &str) -> bool {
    let mut chars = value.trim().chars();
    let Some(letter) = chars.next() else {
        return false;
    };
    if !matches!(letter.to_ascii_uppercase(), 'A' | 'B' | 'C' | 'D' | 'E') {
        return false;
    }
    let digits: String = chars.collect();
    digits.len() == 2 && digits.chars().all(|ch| ch.is_ascii_digit())
}

fn opening_title_name_part(title: &str) -> &str {
    let trimmed = title.trim();
    if let Some((prefix, rest)) = trimmed.split_once(" - ") {
        if is_eco_code(prefix) {
            return rest.trim();
        }
    }
    trimmed
}

fn normalize_repetitive_opening_name(title: &str) -> String {
    let base = opening_title_name_part(title)
        .split(',')
        .next()
        .unwrap_or_default()
        .trim();
    let without_variation = base
        .strip_suffix(" Variation")
        .or_else(|| base.strip_suffix(" variation"))
        .unwrap_or(base);
    normalize_opening_variant_key(without_variation)
}

fn has_more_descriptive_opening_name(title: &str) -> bool {
    opening_title_name_part(title)
        .split(',')
        .skip(1)
        .any(|part| !part.trim().is_empty())
}

fn descriptive_opening_title_candidates(
    title_candidates: &[String],
    repeated_base_names: &HashSet<String>,
) -> Vec<String> {
    let Some(first_title) = title_candidates.first() else {
        return Vec::new();
    };
    let base = normalize_repetitive_opening_name(first_title);
    if !repeated_base_names.contains(&base) {
        return title_candidates.to_vec();
    }

    let mut out = Vec::new();
    for candidate in title_candidates.iter().rev() {
        if has_more_descriptive_opening_name(candidate) && !out.iter().any(|item| item == candidate)
        {
            out.push(candidate.clone());
        }
    }
    for candidate in title_candidates {
        if !out.iter().any(|item| item == candidate) {
            out.push(candidate.clone());
        }
    }
    out
}

fn opening_title_candidates(info: &OpeningInfo) -> Vec<String> {
    let eco = info.eco.trim();
    let raw_name = if info.variation.trim().is_empty() {
        info.opening.trim()
    } else {
        info.variation.trim()
    };
    let parts: Vec<String> = raw_name
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    let names = if parts.is_empty() {
        vec![raw_name.to_string()]
    } else {
        (0..parts.len())
            .map(|index| parts[..=index].join(", "))
            .collect()
    };
    let first_name = names
        .first()
        .map(String::as_str)
        .unwrap_or_default()
        .to_lowercase();
    if (eco.is_empty() || eco.eq_ignore_ascii_case("extra"))
        && matches!(first_name.as_str(), "empty board" | "starting position")
    {
        return Vec::new();
    }
    names
        .into_iter()
        .filter_map(|name| {
            let name = name.trim();
            if eco.is_empty() && name.is_empty() {
                None
            } else if eco.is_empty() {
                Some(name.to_string())
            } else if name.is_empty() {
                Some(eco.to_string())
            } else {
                Some(format!("{eco} - {name}"))
            }
        })
        .fold(Vec::<String>::new(), |mut out, title| {
            if !out.iter().any(|item| item == &title) {
                out.push(title);
            }
            out
        })
}

fn fen_from_position(position: &Chess) -> String {
    Fen::from_position(position.clone(), EnPassantMode::Legal).to_string()
}

fn build_simple_tree_from_game(game: &TempGame) -> Result<SimpleNode> {
    let mut root = SimpleNode {
        san: None,
        fen: fen_from_position(&game.position),
        children: Vec::new(),
    };
    append_game_tree(&mut root, &game.tree, &game.position)?;
    Ok(root)
}

fn append_game_tree(
    parent: &mut SimpleNode,
    tree: &GameTree,
    start_position: &Chess,
) -> Result<()> {
    let mut current_position = start_position.clone();
    let mut previous_position = current_position.clone();
    let mut current_path: Vec<usize> = Vec::new();
    let mut previous_parent_path: Vec<usize> = Vec::new();

    for node in tree.nodes() {
        match node {
            GameTreeNode::Move(san_plus) => {
                let chess_move = san_plus.san.to_move(&current_position)?;
                let mut next_position = current_position.clone();
                next_position.play_unchecked(&chess_move);
                let child = SimpleNode {
                    san: Some(san_plus.to_string()),
                    fen: fen_from_position(&next_position),
                    children: Vec::new(),
                };
                let parent_node = get_simple_node_mut(parent, &current_path)
                    .ok_or_else(|| Error::InvalidInput("Invalid PGN tree path".to_string()))?;
                parent_node.children.push(child);
                previous_position = current_position;
                previous_parent_path = current_path.clone();
                let child_index = parent_node.children.len() - 1;
                current_path.push(child_index);
                current_position = next_position;
            }
            GameTreeNode::Variation(branch) => {
                let branch_parent = get_simple_node_mut(parent, &previous_parent_path)
                    .ok_or_else(|| Error::InvalidInput("Invalid PGN variation path".to_string()))?;
                append_game_tree(branch_parent, branch, &previous_position)?;
            }
            GameTreeNode::Comment(_) | GameTreeNode::Nag(_) => {}
        }
    }

    Ok(())
}

fn get_simple_node_mut<'a>(root: &'a mut SimpleNode, path: &[usize]) -> Option<&'a mut SimpleNode> {
    let mut node = root;
    for index in path {
        node = node.children.get_mut(*index)?;
    }
    Some(node)
}

fn get_simple_node<'a>(root: &'a SimpleNode, path: &[u32]) -> Option<&'a SimpleNode> {
    let mut node = root;
    for index in path {
        node = node.children.get(*index as usize)?;
    }
    Some(node)
}

fn find_first_path_by_fen(root: &SimpleNode, fen: &str) -> Option<Vec<u32>> {
    let target = normalize_fen_key(fen);
    let mut queue = VecDeque::from([(root, Vec::<u32>::new())]);
    while let Some((node, path)) = queue.pop_front() {
        if normalize_fen_key(&node.fen) == target {
            return Some(path);
        }
        for (index, child) in node.children.iter().enumerate() {
            let index = u32::try_from(index).ok()?;
            let mut child_path = path.clone();
            child_path.push(index);
            queue.push_back((child, child_path));
        }
    }
    None
}

fn path_ply(path: &[u32]) -> u32 {
    u32::try_from(path.len()).unwrap_or(u32::MAX)
}

fn merge_node_metadata(_target: &mut SimpleNode, _source: &SimpleNode) {}

fn find_equivalent_child(children: &[SimpleNode], source: &SimpleNode) -> Option<usize> {
    let source_san = source.san.as_deref().unwrap_or_default();
    let source_fen = normalize_fen_key(&source.fen);
    children.iter().position(|child| {
        child.san.as_deref().unwrap_or_default() == source_san
            && normalize_fen_key(&child.fen) == source_fen
    })
}

fn merge_children(target_parent: &mut SimpleNode, source_children: &[SimpleNode]) {
    for source_child in source_children {
        if let Some(index) = find_equivalent_child(&target_parent.children, source_child) {
            let existing = &mut target_parent.children[index];
            merge_node_metadata(existing, source_child);
            merge_children(existing, &source_child.children);
        } else {
            target_parent.children.push(source_child.clone());
        }
    }
}

fn compare_paths(a: &[u32], b: &[u32]) -> std::cmp::Ordering {
    let max = a.len().max(b.len());
    for index in 0..max {
        match (a.get(index), b.get(index)) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(left), Some(right)) if left != right => return left.cmp(right),
            _ => {}
        }
    }
    std::cmp::Ordering::Equal
}

fn clone_node_as_pgn_root(node: &SimpleNode) -> SimpleNode {
    SimpleNode {
        san: None,
        fen: node.fen.clone(),
        children: Vec::new(),
    }
}

fn render_pgn(root: &SimpleNode, event: &str, eco: Option<&str>, orientation: &str) -> String {
    let date = Local::now().format("%Y.%m.%d").to_string();
    let mut out = String::new();
    out.push_str(&format!("[Event \"{}\"]\n", escape_tag(event)));
    out.push_str("[Site \"Obsidian Chess Studio\"]\n");
    out.push_str(&format!("[Date \"{date}\"]\n"));
    out.push_str("[Round \"?\"]\n[White \"?\"]\n[Black \"?\"]\n[Result \"*\"]\n");
    if let Some(eco) = eco.filter(|value| !value.trim().is_empty()) {
        out.push_str(&format!("[ECO \"{}\"]\n", escape_tag(eco)));
    }
    out.push_str(&format!("[Orientation \"{}\"]\n", escape_tag(orientation)));
    if normalize_fen_key(&root.fen)
        != normalize_fen_key("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
    {
        out.push_str("[SetUp \"1\"]\n");
        out.push_str(&format!("[FEN \"{}\"]\n", escape_tag(&root.fen)));
    }
    out.push('\n');
    out.push_str(&render_children(
        &root.children,
        &position_from_fen(&root.fen).unwrap_or_default(),
        true,
    ));
    if !out.ends_with(' ') && !out.ends_with('\n') {
        out.push(' ');
    }
    out.push_str("*\n\n");
    out
}

fn escape_tag(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn position_from_fen(fen: &str) -> Result<Chess> {
    let parsed: Fen = fen.parse()?;
    Ok(parsed.into_position(shakmaty::CastlingMode::Standard)?)
}

fn render_children(children: &[SimpleNode], position: &Chess, at_line_start: bool) -> String {
    if children.is_empty() {
        return String::new();
    }
    render_line_from_node_with_alternatives(&children[0], &children[1..], position, at_line_start)
}

fn render_line_from_node(node: &SimpleNode, position: &Chess, at_line_start: bool) -> String {
    render_line_from_node_with_alternatives(node, &[], position, at_line_start)
}

fn render_line_from_node_with_alternatives(
    node: &SimpleNode,
    alternatives: &[SimpleNode],
    position: &Chess,
    at_line_start: bool,
) -> String {
    let Some(san) = node.san.as_deref() else {
        return String::new();
    };
    let mut out = String::new();
    let fullmove = position.fullmoves().get();
    if at_line_start {
        if position.turn().is_white() {
            out.push_str(&format!("{fullmove}.{san}"));
        } else {
            out.push_str(&format!("{fullmove}...{san}"));
        }
    } else if position.turn().is_white() {
        out.push_str(&format!(" {fullmove}.{san}"));
    } else {
        out.push_str(&format!(" {san}"));
    }

    for variation in alternatives {
        out.push_str(" (");
        out.push_str(&render_line_from_node(variation, position, true));
        out.push(')');
    }

    let next_position = san
        .parse::<shakmaty::san::SanPlus>()
        .ok()
        .and_then(|san_plus| san_plus.san.to_move(position).ok())
        .map(|mv| {
            let mut next = position.clone();
            next.play_unchecked(&mv);
            next
        })
        .or_else(|| position_from_fen(&node.fen).ok());

    if let Some(next_position) = next_position {
        out.push_str(&render_children(&node.children, &next_position, false));
    }
    out
}

fn parse_eco_from_title(title: &str) -> Option<String> {
    let eco = title.split(" - ").next()?.trim();
    let chars: Vec<char> = eco.chars().collect();
    if chars.len() == 3
        && matches!(chars[0], 'A'..='E' | 'a'..='e')
        && chars[1].is_ascii_digit()
        && chars[2].is_ascii_digit()
    {
        Some(eco.to_uppercase())
    } else {
        None
    }
}

fn collect_simple_active_moves(
    node: &SimpleNode,
    position: &Chess,
    active_color_is_white: bool,
    active_moves_by_fen: &mut HashMap<String, HashSet<String>>,
) {
    for child in &node.children {
        if let Some(san) = child.san.as_deref() {
            if (position.turn() == shakmaty::Color::White) == active_color_is_white {
                active_moves_by_fen
                    .entry(normalize_fen_key(&fen_from_position(position)))
                    .or_default()
                    .insert(san.to_string());
            }
            let next_position = san
                .parse::<shakmaty::san::SanPlus>()
                .ok()
                .and_then(|san_plus| san_plus.san.to_move(position).ok())
                .map(|mv| {
                    let mut next = position.clone();
                    next.play_unchecked(&mv);
                    next
                })
                .or_else(|| position_from_fen(&child.fen).ok());
            if let Some(next_position) = next_position {
                collect_simple_active_moves(
                    child,
                    &next_position,
                    active_color_is_white,
                    active_moves_by_fen,
                );
            }
        }
    }
}

fn validate_generated_consistency(
    group_trees: &HashMap<String, SimpleNode>,
    active_color_is_white: bool,
) -> Result<()> {
    let mut active_moves_by_fen: HashMap<String, HashSet<String>> = HashMap::new();
    for tree in group_trees.values() {
        let position = position_from_fen(&tree.fen)?;
        collect_simple_active_moves(
            tree,
            &position,
            active_color_is_white,
            &mut active_moves_by_fen,
        );
    }
    let conflicts = active_moves_by_fen
        .values()
        .filter(|moves| moves.len() > 1)
        .count();
    if conflicts > 0 {
        return Err(Error::InvalidInput(format!(
            "Generated ECO opening variants would introduce {conflicts} consistency conflict(s). No files were changed."
        )));
    }
    Ok(())
}

fn read_all_games(path: &Path) -> Result<Vec<ParsedVariantGame>> {
    let file = fs::File::open(path)?;
    let mut reader = BufferedReader::new(file);
    let mut games = Vec::new();
    let orientation = read_orientation_header(path);
    loop {
        let mut importer = Importer::new(None);
        let game = reader
            .read_game(&mut importer)
            .map(|game| game.flatten())
            .map_err(|error| Error::InvalidInput(format!("Variant PGN parser error: {error}")))?;
        let Some(game) = game else {
            break;
        };
        games.push(ParsedVariantGame {
            root: build_simple_tree_from_game(&game)?,
            orientation: orientation.clone(),
        });
    }
    Ok(games)
}

fn read_orientation_header(path: &Path) -> String {
    let Ok(file) = fs::File::open(path) else {
        return "white".to_string();
    };
    let reader = BufReader::new(file);
    for line in reader.lines().take(128).flatten() {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('[') {
            continue;
        }
        if let Some(value) = trimmed
            .strip_prefix("[Orientation \"")
            .and_then(|rest| rest.split('"').next())
        {
            if value.trim().eq_ignore_ascii_case("black") {
                return "black".to_string();
            }
        }
    }
    "white".to_string()
}

fn child_indexes_by_parent(variants: &[VariantInfoDto]) -> HashMap<String, Vec<String>> {
    let mut by_key = HashMap::new();
    for variant in variants {
        by_key.insert(normalize_path_key(&variant.path), variant);
    }
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for variant in variants {
        let child_key = normalize_path_key(&variant.path);
        if let Some(parent) = &variant.parent_link {
            let parent_key = resolve_link_path(Path::new(&variant.path), &parent.path);
            if by_key.contains_key(&parent_key) {
                let entry = children.entry(parent_key).or_default();
                if !entry.contains(&child_key) {
                    entry.push(child_key.clone());
                }
            }
        }

        for child in &variant.child_links {
            if child.path.trim().is_empty() {
                continue;
            }
            let linked_child_key = resolve_link_path(Path::new(&variant.path), &child.path);
            if linked_child_key == child_key || !by_key.contains_key(&linked_child_key) {
                continue;
            }
            let entry = children.entry(child_key.clone()).or_default();
            if !entry.contains(&linked_child_key) {
                entry.push(linked_child_key);
            }
        }
    }
    children
}

fn ordered_subtree_keys(root_key: &str, variants: &[VariantInfoDto]) -> Vec<String> {
    let children = child_indexes_by_parent(variants);
    let mut out = Vec::new();
    let mut visited = HashSet::new();
    fn walk(
        key: &str,
        children: &HashMap<String, Vec<String>>,
        visited: &mut HashSet<String>,
        out: &mut Vec<String>,
    ) {
        if !visited.insert(key.to_string()) {
            return;
        }
        out.push(key.to_string());
        if let Some(items) = children.get(key) {
            for child in items {
                walk(child, children, visited, out);
            }
        }
    }
    walk(root_key, &children, &mut visited, &mut out);
    out
}

fn aggregate_variant_family_tree(
    root_key: &str,
    variants: &[VariantInfoDto],
    variant_by_key: &HashMap<String, VariantInfoDto>,
    trees_by_key: &HashMap<String, Vec<ParsedVariantGame>>,
) -> Result<SimpleNode> {
    let root_games = trees_by_key.get(root_key).ok_or_else(|| {
        Error::InvalidInput("No readable PGN found for this variant family.".to_string())
    })?;
    let mut aggregate_root = root_games[0].root.clone();
    for game in root_games.iter().skip(1) {
        if normalize_fen_key(&game.root.fen) == normalize_fen_key(&aggregate_root.fen) {
            merge_children(&mut aggregate_root, &game.root.children);
        } else if let Some(path) = find_first_path_by_fen(&aggregate_root, &game.root.fen) {
            let path = path.iter().map(|value| *value as usize).collect::<Vec<_>>();
            if let Some(node) = get_simple_node_mut(&mut aggregate_root, &path) {
                merge_children(node, &game.root.children);
            }
        }
    }

    let source_keys = ordered_subtree_keys(root_key, variants);
    let mut base_path_by_key: HashMap<String, Vec<u32>> =
        HashMap::from([(root_key.to_string(), Vec::new())]);
    for key in &source_keys {
        if key == root_key {
            continue;
        }
        let Some(variant) = variant_by_key.get(key) else {
            continue;
        };
        let Some(games) = trees_by_key.get(key) else {
            continue;
        };

        let mut attach_path: Option<Vec<u32>> = None;
        if let Some(parent) = &variant.parent_link {
            let parent_key = resolve_link_path(Path::new(&variant.path), &parent.path);
            if let Some(parent_base) = base_path_by_key.get(&parent_key) {
                let mut path = parent_base.clone();
                path.extend(parent.anchor_path.iter().copied());
                attach_path = Some(path);
            }
            if attach_path.is_none() {
                attach_path = find_first_path_by_fen(&aggregate_root, &parent.anchor_fen);
            }
        }
        if attach_path.is_none() {
            attach_path = find_first_path_by_fen(&aggregate_root, &games[0].root.fen);
        }
        let Some(path) = attach_path else {
            continue;
        };
        let path_usize = path.iter().map(|value| *value as usize).collect::<Vec<_>>();
        if let Some(node) = get_simple_node_mut(&mut aggregate_root, &path_usize) {
            base_path_by_key.insert(key.clone(), path);
            for game in games {
                merge_children(node, &game.root.children);
            }
        }
    }

    Ok(aggregate_root)
}

#[tauri::command]
#[specta::specta]
pub fn variants_compress_variant_family(
    variants_dir: String,
    target_path: String,
) -> Result<CompressVariantFamilyResult> {
    let variants = variants_list_fast(variants_dir)?;
    let root_key = normalize_path_key(&target_path);
    let variant_by_key: HashMap<String, VariantInfoDto> = variants
        .iter()
        .cloned()
        .map(|variant| (normalize_path_key(&variant.path), variant))
        .collect();
    let root_variant = variant_by_key
        .get(&root_key)
        .cloned()
        .ok_or_else(|| Error::InvalidInput("Target variant was not found".to_string()))?;
    let source_keys = ordered_subtree_keys(&root_key, &variants);
    if source_keys.len() <= 1 {
        return Err(Error::InvalidInput(
            "This variant does not have descendants to compress.".to_string(),
        ));
    }

    let mut trees_by_key: HashMap<String, Vec<ParsedVariantGame>> = HashMap::new();
    for key in &source_keys {
        let Some(variant) = variant_by_key.get(key) else {
            continue;
        };
        if let Ok(games) = read_all_games(Path::new(&variant.path)) {
            if !games.is_empty() {
                trees_by_key.insert(key.clone(), games);
            }
        }
    }
    let root_games = trees_by_key.get(&root_key).ok_or_else(|| {
        Error::InvalidInput("No readable PGN found for this variant family.".to_string())
    })?;
    let orientation = root_games
        .first()
        .map(|game| game.orientation.as_str())
        .unwrap_or("white");
    let aggregate_root =
        aggregate_variant_family_tree(&root_key, &variants, &variant_by_key, &trees_by_key)?;

    let root_path = PathBuf::from(&root_variant.path);
    let event = root_variant
        .opening
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&root_variant.name);
    let pgn = render_pgn(
        &aggregate_root,
        event,
        root_variant
            .opening
            .as_deref()
            .and_then(parse_eco_from_title)
            .as_deref(),
        orientation,
    );
    fs::write(&root_path, pgn)?;

    let mut metadata = read_metadata(&root_path)?;
    let mut tags = metadata_tags(&metadata)
        .into_iter()
        .filter(|tag| !tag.starts_with("fen:") && !tag.starts_with("variantsCount:"))
        .collect::<Vec<_>>();
    tags.push(format!("fen:{}", aggregate_root.fen));
    tags.push(format!("variantsCount:{}", source_keys.len()));
    metadata["schemaVersion"] = json!(2);
    metadata["tags"] = json!(tags);
    metadata["links"]["children"] = json!([]);
    write_metadata(&root_path, &metadata)?;

    let cleanup_paths = source_keys
        .iter()
        .filter(|key| *key != &root_key)
        .filter_map(|key| variant_by_key.get(key).map(|variant| variant.path.clone()))
        .collect::<Vec<_>>();
    let removed = if cleanup_paths.is_empty() {
        0
    } else {
        variants_delete_files(cleanup_paths)?.deleted_pgn
    };

    Ok(CompressVariantFamilyResult {
        merged: u32::try_from(source_keys.len()).unwrap_or(u32::MAX),
        removed,
        root_path: root_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn variants_create_opening_variants(
    variants_dir: String,
    target_path: String,
) -> Result<CreateOpeningVariantsResult> {
    let variants = variants_list_fast(variants_dir.clone())?;
    let root_key = normalize_path_key(&target_path);
    let variant_by_key: HashMap<String, VariantInfoDto> = variants
        .iter()
        .cloned()
        .map(|variant| (normalize_path_key(&variant.path), variant))
        .collect();
    let root_variant = variant_by_key
        .get(&root_key)
        .cloned()
        .ok_or_else(|| Error::InvalidInput("Target variant was not found".to_string()))?;
    let source_keys = ordered_subtree_keys(&root_key, &variants);

    let mut trees_by_key: HashMap<String, Vec<ParsedVariantGame>> = HashMap::new();
    for key in &source_keys {
        let Some(variant) = variant_by_key.get(key) else {
            continue;
        };
        if let Ok(games) = read_all_games(Path::new(&variant.path)) {
            if !games.is_empty() {
                trees_by_key.insert(key.clone(), games);
            }
        }
    }

    let root_games = trees_by_key.get(&root_key).ok_or_else(|| {
        Error::InvalidInput("No readable PGN found for this variant family.".to_string())
    })?;
    let orientation = root_games
        .first()
        .map(|game| game.orientation.as_str())
        .unwrap_or("white");
    let active_color_is_white = !orientation.eq_ignore_ascii_case("black");
    let mut aggregate_root = root_games[0].root.clone();
    for game in root_games.iter().skip(1) {
        if normalize_fen_key(&game.root.fen) == normalize_fen_key(&aggregate_root.fen) {
            merge_children(&mut aggregate_root, &game.root.children);
        } else if let Some(path) = find_first_path_by_fen(&aggregate_root, &game.root.fen) {
            if let Some(node) = get_simple_node_mut(
                &mut aggregate_root,
                &path.iter().map(|value| *value as usize).collect::<Vec<_>>(),
            ) {
                merge_children(node, &game.root.children);
            }
        }
    }

    let mut base_path_by_key: HashMap<String, Vec<u32>> =
        HashMap::from([(root_key.clone(), Vec::new())]);
    for key in &source_keys {
        if key == &root_key {
            continue;
        }
        let Some(variant) = variant_by_key.get(key) else {
            continue;
        };
        let Some(games) = trees_by_key.get(key) else {
            continue;
        };
        let mut attach_path: Option<Vec<u32>> = None;
        if let Some(parent) = &variant.parent_link {
            let parent_key = if Path::new(&parent.path).is_absolute() {
                normalize_path_key(&parent.path)
            } else {
                normalize_path_key(
                    &parent_dir(Path::new(&variant.path))
                        .join(&parent.path)
                        .to_string_lossy(),
                )
            };
            if let Some(parent_base) = base_path_by_key.get(&parent_key) {
                let mut path = parent_base.clone();
                path.extend(parent.anchor_path.iter().copied());
                attach_path = Some(path);
            }
            if attach_path.is_none() {
                attach_path = find_first_path_by_fen(&aggregate_root, &parent.anchor_fen);
            }
        }
        if attach_path.is_none() {
            attach_path = find_first_path_by_fen(&aggregate_root, &games[0].root.fen);
        }
        let Some(path) = attach_path else {
            continue;
        };
        if let Some(node) = get_simple_node_mut(
            &mut aggregate_root,
            &path.iter().map(|value| *value as usize).collect::<Vec<_>>(),
        ) {
            base_path_by_key.insert(key.clone(), path);
            for game in games {
                merge_children(node, &game.root.children);
            }
        }
    }

    let mut opening_cache: HashMap<String, Vec<String>> = HashMap::new();
    let mut groups: Vec<OpeningGroup> = Vec::new();
    let mut groups_by_key: HashMap<String, usize> = HashMap::new();
    let mut boundary_by_fen: HashMap<String, String> = HashMap::new();

    fn resolve_titles(fen: &str, cache: &mut HashMap<String, Vec<String>>) -> Vec<String> {
        let key = normalize_fen_key(fen);
        if let Some(cached) = cache.get(&key) {
            return cached.clone();
        }
        let titles = get_opening_info_from_fen(fen)
            .map(|info| opening_title_candidates(&info))
            .unwrap_or_default();
        cache.insert(key, titles.clone());
        titles
    }

    fn get_or_create_group(
        title: String,
        title_candidates: Vec<String>,
        node: &SimpleNode,
        parent_id: Option<String>,
        groups: &mut Vec<OpeningGroup>,
        groups_by_key: &mut HashMap<String, usize>,
        boundary_by_fen: &mut HashMap<String, String>,
    ) -> String {
        let key = normalize_opening_variant_key(&title);
        if let Some(index) = groups_by_key.get(&key).copied() {
            let group_id = groups[index].id.clone();
            let should_add_parent_link = parent_id
                .as_deref()
                .map(|parent_id| parent_id != group_id)
                .unwrap_or(false);
            let group = &mut groups[index];
            group.source_nodes.push(node.clone());
            for candidate in title_candidates {
                if !group.title_candidates.iter().any(|item| {
                    normalize_opening_variant_key(item) == normalize_opening_variant_key(&candidate)
                }) {
                    group.title_candidates.push(candidate);
                }
            }
            boundary_by_fen.insert(normalize_fen_key(&node.fen), group.id.clone());
            if should_add_parent_link {
                if let Some(parent_id) = parent_id {
                    if let Some(parent) = groups.iter_mut().find(|group| group.id == parent_id) {
                        if !parent.children.contains(&group_id) {
                            parent.children.push(group_id.clone());
                        }
                    }
                }
            }
            return group_id;
        }
        let id = format!("opening-variant-{}", groups.len());
        let group = OpeningGroup {
            id: id.clone(),
            title,
            title_candidates,
            fen: node.fen.clone(),
            source_nodes: vec![node.clone()],
            parent_id: parent_id.clone(),
            parent_anchor_san: node.san.clone(),
            children: Vec::new(),
            file_stem: String::new(),
            file_path: None,
        };
        groups.push(group);
        groups_by_key.insert(key, groups.len() - 1);
        boundary_by_fen.insert(normalize_fen_key(&node.fen), id.clone());
        if let Some(parent_id) = parent_id {
            if let Some(parent) = groups.iter_mut().find(|group| group.id == parent_id) {
                if !parent.children.contains(&id) {
                    parent.children.push(id.clone());
                }
            }
        }
        id
    }

    fn walk_openings(
        node: &SimpleNode,
        current_group_id: Option<String>,
        current_title: Option<String>,
        active_color_is_white: bool,
        cache: &mut HashMap<String, Vec<String>>,
        groups: &mut Vec<OpeningGroup>,
        groups_by_key: &mut HashMap<String, usize>,
        boundary_by_fen: &mut HashMap<String, String>,
    ) {
        let mut active_group_id = current_group_id.clone();
        let mut active_title = current_title.clone();
        let can_start_group_here = node.san.is_none()
            || position_from_fen(&node.fen)
                .map(|position| {
                    (position.turn() == shakmaty::Color::White) != active_color_is_white
                })
                .unwrap_or(false);
        if can_start_group_here {
            let title_candidates = resolve_titles(&node.fen, cache);
            if !title_candidates.is_empty() {
                let current_key = current_title.as_deref().map(normalize_opening_variant_key);
                let current_index = current_key.as_ref().and_then(|key| {
                    title_candidates
                        .iter()
                        .position(|candidate| normalize_opening_variant_key(candidate) == *key)
                });
                let title = if let Some(index) = current_index {
                    title_candidates
                        .iter()
                        .skip(index.saturating_add(1))
                        .find(|candidate| {
                            Some(normalize_opening_variant_key(candidate)) != current_key
                        })
                        .cloned()
                } else {
                    title_candidates
                        .iter()
                        .find(|candidate| {
                            Some(normalize_opening_variant_key(candidate)) != current_key
                        })
                        .cloned()
                };
                if let Some(title) = title {
                    let group_id = get_or_create_group(
                        title.clone(),
                        title_candidates.clone(),
                        node,
                        active_group_id.clone(),
                        groups,
                        groups_by_key,
                        boundary_by_fen,
                    );
                    active_group_id = Some(group_id);
                    active_title = Some(title);
                }
            }
        }
        for child in &node.children {
            walk_openings(
                child,
                active_group_id.clone(),
                active_title.clone(),
                active_color_is_white,
                cache,
                groups,
                groups_by_key,
                boundary_by_fen,
            );
        }
    }

    let root_titles = resolve_titles(&aggregate_root.fen, &mut opening_cache);
    let root_group_id = root_titles.first().cloned().map(|title| {
        get_or_create_group(
            title,
            root_titles.clone(),
            &aggregate_root,
            None,
            &mut groups,
            &mut groups_by_key,
            &mut boundary_by_fen,
        )
    });
    for child in &aggregate_root.children {
        walk_openings(
            child,
            root_group_id.clone(),
            root_titles.first().cloned(),
            active_color_is_white,
            &mut opening_cache,
            &mut groups,
            &mut groups_by_key,
            &mut boundary_by_fen,
        );
    }

    if groups.is_empty() {
        return Err(Error::InvalidInput(
            "No ECO openings were found in this variant family.".to_string(),
        ));
    }

    let output_dir = parent_dir(Path::new(&root_variant.path));
    let mut cleanup_keys: HashSet<String> = HashSet::new();
    for variant in &variants {
        let variant_key = normalize_path_key(&variant.path);
        if variant_key == root_key || cleanup_keys.contains(&variant_key) {
            continue;
        }
        let metadata = read_metadata(Path::new(&variant.path)).unwrap_or_else(|_| json!({}));
        let tags = metadata_tags(&metadata);
        if !tags.iter().any(|tag| tag == "generatedBy:opening-variants") {
            continue;
        }
        let generated_root = tag_value(&tags, "generatedRoot:");
        let generated_for_current_root = generated_root
            .as_deref()
            .map(|path| normalize_path_key(path) == normalize_path_key(&root_variant.path))
            .unwrap_or(false);
        if generated_for_current_root {
            cleanup_keys.insert(variant_key);
        }
    }

    let root_replacement_id = groups
        .iter()
        .find(|group| group.parent_id.is_none())
        .map(|group| group.id.clone())
        .unwrap_or_else(|| groups[0].id.clone());
    let mut reserved = HashSet::new();
    for variant in &variants {
        let variant_key = normalize_path_key(&variant.path);
        if variant_key == root_key || cleanup_keys.contains(&variant_key) {
            continue;
        }
        if normalize_path_key(&parent_dir(Path::new(&variant.path)).to_string_lossy())
            == normalize_path_key(&output_dir.to_string_lossy())
        {
            reserved.insert(variant.name.to_lowercase());
        }
    }
    let mut base_name_counts: HashMap<String, usize> = HashMap::new();
    for group in &groups {
        if let Some(first_title) = group.title_candidates.first() {
            let base = normalize_repetitive_opening_name(first_title);
            if !base.is_empty() {
                *base_name_counts.entry(base).or_insert(0) += 1;
            }
        }
    }
    let repeated_base_names: HashSet<String> = base_name_counts
        .into_iter()
        .filter_map(|(base, count)| if count > 1 { Some(base) } else { None })
        .collect();
    for group in &mut groups {
        let title_candidates =
            descriptive_opening_title_candidates(&group.title_candidates, &repeated_base_names);
        let (title, stem) =
            make_unique_opening_file_stem(&title_candidates, &mut reserved, "variant");
        group.title = title;
        group.file_stem = stem;
    }

    let mut group_by_id: HashMap<String, OpeningGroup> = groups
        .iter()
        .cloned()
        .map(|group| (group.id.clone(), group))
        .collect();
    let mut anchors: HashMap<String, OpeningAnchor> = HashMap::new();

    fn edge_key(parent_id: &str, child_id: &str) -> String {
        format!("{parent_id}->{child_id}")
    }

    fn record_anchor(
        anchors: &mut HashMap<String, OpeningAnchor>,
        parent_id: &str,
        group: &OpeningGroup,
        node: &SimpleNode,
        path: &[u32],
    ) {
        let key = edge_key(parent_id, &group.id);
        if let Some(existing) = anchors.get(&key) {
            if compare_paths(&existing.anchor_path, path) != std::cmp::Ordering::Greater {
                return;
            }
        }
        anchors.insert(
            key,
            OpeningAnchor {
                anchor_fen: node.fen.clone(),
                anchor_path: path.to_vec(),
                anchor_ply: path_ply(path),
                label: node.san.clone().or_else(|| group.parent_anchor_san.clone()),
            },
        );
    }

    fn clone_for_group(
        node: &SimpleNode,
        owner_id: &str,
        root_replacement_id: &str,
        path: &[u32],
        boundary_by_fen: &HashMap<String, String>,
        group_by_id: &HashMap<String, OpeningGroup>,
        anchors: &mut HashMap<String, OpeningAnchor>,
    ) -> SimpleNode {
        let boundary_id = boundary_by_fen.get(&normalize_fen_key(&node.fen));
        if let Some(boundary_id) = boundary_id {
            if boundary_id != owner_id {
                if let Some(boundary_group) = group_by_id.get(boundary_id) {
                    let is_child = group_by_id
                        .get(owner_id)
                        .map(|owner| owner.children.contains(boundary_id))
                        .unwrap_or(false);
                    let is_root_level_child =
                        owner_id == root_replacement_id && boundary_group.parent_id.is_none();
                    if is_child || is_root_level_child {
                        record_anchor(anchors, owner_id, boundary_group, node, path);
                        return SimpleNode {
                            children: Vec::new(),
                            ..node.clone()
                        };
                    }
                }
            }
        }
        let children = node
            .children
            .iter()
            .enumerate()
            .map(|(index, child)| {
                let mut child_path = path.to_vec();
                let Ok(index) = u32::try_from(index) else {
                    return SimpleNode {
                        children: Vec::new(),
                        ..child.clone()
                    };
                };
                child_path.push(index);
                clone_for_group(
                    child,
                    owner_id,
                    root_replacement_id,
                    &child_path,
                    boundary_by_fen,
                    group_by_id,
                    anchors,
                )
            })
            .collect();
        SimpleNode {
            children,
            ..node.clone()
        }
    }

    let mut group_trees: HashMap<String, SimpleNode> = HashMap::new();
    for group in &groups {
        let mut group_root = if group.id == root_replacement_id {
            clone_node_as_pgn_root(&aggregate_root)
        } else {
            clone_node_as_pgn_root(&group.source_nodes[0])
        };
        if group.id == root_replacement_id {
            group_root.children = aggregate_root
                .children
                .iter()
                .enumerate()
                .map(|(index, child)| {
                    clone_for_group(
                        child,
                        &group.id,
                        &root_replacement_id,
                        &[u32::try_from(index).unwrap_or(u32::MAX)],
                        &boundary_by_fen,
                        &group_by_id,
                        &mut anchors,
                    )
                })
                .collect();
        } else {
            for source in &group.source_nodes {
                let children: Vec<SimpleNode> = source
                    .children
                    .iter()
                    .enumerate()
                    .map(|(index, child)| {
                        clone_for_group(
                            child,
                            &group.id,
                            &root_replacement_id,
                            &[u32::try_from(index).unwrap_or(u32::MAX)],
                            &boundary_by_fen,
                            &group_by_id,
                            &mut anchors,
                        )
                    })
                    .collect();
                if normalize_fen_key(&source.fen) == normalize_fen_key(&group_root.fen) {
                    merge_children(&mut group_root, &children);
                } else if let Some(path) = find_first_path_by_fen(&group_root, &source.fen) {
                    let path = path.iter().map(|value| *value as usize).collect::<Vec<_>>();
                    if let Some(target_node) = get_simple_node_mut(&mut group_root, &path) {
                        merge_children(target_node, &children);
                    }
                }
            }
        }
        group_trees.insert(group.id.clone(), group_root);
    }

    for group in &groups {
        let Some(tree) = group_trees.get(&group.id) else {
            continue;
        };
        for child_id in &group.children {
            let Some(child_group) = group_by_id.get(child_id) else {
                continue;
            };
            if let Some(path) = find_first_path_by_fen(tree, &child_group.fen) {
                if !path.is_empty() {
                    if let Some(anchor_node) = get_simple_node(tree, &path) {
                        anchors.insert(
                            edge_key(&group.id, child_id),
                            OpeningAnchor {
                                anchor_fen: anchor_node.fen.clone(),
                                anchor_path: path.clone(),
                                anchor_ply: path_ply(&path),
                                label: anchor_node
                                    .san
                                    .clone()
                                    .or_else(|| child_group.parent_anchor_san.clone()),
                            },
                        );
                    }
                }
            }
        }
    }
    for group in groups.iter().filter(|group| group.parent_id.is_none()) {
        let path = find_first_path_by_fen(&aggregate_root, &group.fen).unwrap_or_default();
        let node = get_simple_node(&aggregate_root, &path).unwrap_or(&aggregate_root);
        anchors.insert(
            edge_key(&root_replacement_id, &group.id),
            OpeningAnchor {
                anchor_fen: node.fen.clone(),
                anchor_path: path.clone(),
                anchor_ply: path_ply(&path),
                label: node.san.clone().or_else(|| group.parent_anchor_san.clone()),
            },
        );
    }

    validate_generated_consistency(&group_trees, active_color_is_white)?;

    let cleanup_paths: Vec<String> = variants
        .iter()
        .filter(|variant| cleanup_keys.contains(&normalize_path_key(&variant.path)))
        .map(|variant| variant.path.clone())
        .collect();
    let removed = if cleanup_paths.is_empty() {
        0
    } else {
        variants_delete_files(cleanup_paths)?.deleted_pgn
    };

    fs::create_dir_all(&output_dir)?;
    let root_path = PathBuf::from(&root_variant.path);
    if let Some(root_group) = groups
        .iter_mut()
        .find(|group| group.id == root_replacement_id)
    {
        root_group.file_path = Some(root_path.clone());
    }

    let created_at = Local::now().to_rfc3339();

    for group in &mut groups {
        if group.id == root_replacement_id {
            continue;
        }
        let path = output_dir.join(format!("{}.pgn", group.file_stem));
        if path.exists() {
            return Err(Error::InvalidInput("File already exists".to_string()));
        }
        let tree = group_trees
            .get(&group.id)
            .ok_or_else(|| Error::InvalidInput("Missing generated opening tree".to_string()))?;
        let pgn = render_pgn(
            tree,
            &group.title,
            parse_eco_from_title(&group.title).as_deref(),
            orientation,
        );
        fs::write(&path, pgn)?;
        let metadata = json!({
            "type": "variants",
            "tags": [
                format!("opening:{}", group.title),
                format!("fen:{}", group.fen),
                "generatedBy:opening-variants",
                format!("generatedRoot:{}", root_path.to_string_lossy()),
                format!("generatedAt:{created_at}")
            ],
            "schemaVersion": 2,
            "links": { "children": [] }
        });
        write_metadata(&path, &metadata)?;
        group.file_path = Some(path);
    }

    group_by_id = groups
        .iter()
        .cloned()
        .map(|group| (group.id.clone(), group))
        .collect();
    for group in &groups {
        let Some(path) = &group.file_path else {
            continue;
        };
        let mut metadata = read_metadata(path)?;
        let tree_fen = if group.id == root_replacement_id {
            group_trees
                .get(&group.id)
                .map(|tree| tree.fen.clone())
                .unwrap_or_else(|| group.fen.clone())
        } else {
            group.fen.clone()
        };
        let mut child_ids = group.children.clone();
        if group.id == root_replacement_id {
            for candidate in groups.iter().filter(|candidate| {
                candidate.id != root_replacement_id && candidate.parent_id.is_none()
            }) {
                if !child_ids.contains(&candidate.id) {
                    child_ids.push(candidate.id.clone());
                }
            }
        }
        let child_links: Vec<VariantLinkRefDto> = child_ids
            .iter()
            .filter_map(|child_id| {
                let child = group_by_id.get(child_id)?;
                let anchor = anchors.get(&edge_key(&group.id, child_id))?;
                let child_path = child.file_path.as_ref()?;
                Some(VariantLinkRefDto {
                    path: file_name(child_path),
                    name: child.file_stem.clone(),
                    anchor_fen: anchor.anchor_fen.clone(),
                    anchor_path: anchor.anchor_path.clone(),
                    anchor_ply: anchor.anchor_ply,
                    label: anchor.label.clone(),
                })
            })
            .collect();

        let parent_link = if group.id == root_replacement_id {
            metadata
                .get("links")
                .and_then(|links| links.get("parent"))
                .cloned()
        } else {
            let parent_group = group.parent_id.as_ref().and_then(|id| group_by_id.get(id));
            let parent_id = group.parent_id.as_deref().unwrap_or(&root_replacement_id);
            let parent_anchor = anchors.get(&edge_key(parent_id, &group.id));
            parent_anchor.map(|anchor| {
                let parent_path = parent_group
                    .and_then(|parent| parent.file_path.as_ref().map(|path| file_name(path)))
                    .unwrap_or_else(|| file_name(&root_path));
                let parent_name = parent_group
                    .map(|parent| parent.file_stem.clone())
                    .or_else(|| {
                        group_by_id
                            .get(&root_replacement_id)
                            .map(|root| root.file_stem.clone())
                    })
                    .unwrap_or_else(|| file_stem(&root_path));
                json!({
                    "path": parent_path,
                    "name": parent_name,
                    "anchorFen": anchor.anchor_fen.clone(),
                    "anchorPath": anchor.anchor_path.clone(),
                    "anchorPly": anchor.anchor_ply,
                    "label": anchor.label.clone()
                })
            })
        };

        metadata["schemaVersion"] = json!(2);
        if group.id == root_replacement_id {
            let root_dir = parent_dir(&root_path);
            let mut merged_children = metadata
                .get("links")
                .and_then(|links| links.get("children"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|child| {
                    let Some(child_path) = child.get("path").and_then(Value::as_str) else {
                        return true;
                    };
                    let child_key = if Path::new(child_path).is_absolute() {
                        normalize_path_key(child_path)
                    } else {
                        let resolved_child_path = root_dir.join(child_path);
                        normalize_path_key(resolved_child_path.to_string_lossy().as_ref())
                    };
                    !cleanup_keys.contains(&child_key)
                })
                .collect::<Vec<_>>();
            let mut existing_child_keys: HashSet<String> = merged_children
                .iter()
                .filter_map(|child| child.get("path").and_then(Value::as_str))
                .map(|path| path.to_lowercase())
                .collect();
            for child in child_links {
                if existing_child_keys.insert(child.path.to_lowercase()) {
                    merged_children.push(json!(child));
                }
            }
            metadata["links"]["children"] = json!(merged_children);
        } else {
            let mut tags = metadata_tags(&metadata)
                .into_iter()
                .filter(|tag| {
                    !tag.starts_with("opening:")
                        && !tag.starts_with("fen:")
                        && !tag.starts_with("generatedBy:opening-variants")
                        && !tag.starts_with("generatedRoot:")
                        && !tag.starts_with("generatedAt:")
                })
                .collect::<Vec<_>>();
            tags.push(format!("opening:{}", group.title));
            tags.push(format!("fen:{tree_fen}"));
            tags.push("generatedBy:opening-variants".to_string());
            tags.push(format!("generatedRoot:{}", root_path.to_string_lossy()));
            tags.push(format!("generatedAt:{created_at}"));
            metadata["tags"] = json!(tags);
            metadata["links"] = json!({ "children": child_links });
        }
        if let Some(parent) = parent_link {
            metadata["links"]["parent"] = parent;
        }
        write_metadata(path, &metadata)?;
    }

    Ok(CreateOpeningVariantsResult {
        created: u32::try_from(
            groups
                .iter()
                .filter(|group| group.id != root_replacement_id)
                .count(),
        )
        .unwrap_or(u32::MAX),
        removed,
        root_path: root_path.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn compress_variant_family_merges_descendants_into_parent_and_removes_children() {
        let dir = tempdir().unwrap();
        let root_path = dir.path().join("root.pgn");
        let child_path = dir.path().join("child.pgn");
        let after_e4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

        fs::write(
            &root_path,
            "[Event \"Root\"]\n[Site \"Obsidian Chess Studio\"]\n[Date \"2026.01.01\"]\n[Round \"?\"]\n[White \"?\"]\n[Black \"?\"]\n[Result \"*\"]\n[Orientation \"white\"]\n\n1. e4 *\n",
        )
        .unwrap();
        fs::write(
            root_path.with_extension("info"),
            json!({
                "type": "variants",
                "tags": ["opening:Root", "fen:rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"],
                "schemaVersion": 2,
                "links": {
                    "children": [{
                        "path": "child.pgn",
                        "name": "child",
                        "anchorFen": after_e4,
                        "anchorPath": [0],
                        "anchorPly": 1,
                        "label": "e4"
                    }]
                }
            })
            .to_string(),
        )
        .unwrap();

        fs::write(
            &child_path,
            format!(
                "[Event \"Child\"]\n[Site \"Obsidian Chess Studio\"]\n[Date \"2026.01.01\"]\n[Round \"?\"]\n[White \"?\"]\n[Black \"?\"]\n[Result \"*\"]\n[Orientation \"white\"]\n[SetUp \"1\"]\n[FEN \"{after_e4}\"]\n\n1... c5 *\n"
            ),
        )
        .unwrap();
        fs::write(
            child_path.with_extension("info"),
            json!({
                "type": "variants",
                "tags": ["opening:Child", format!("fen:{after_e4}")],
                "schemaVersion": 2,
                "links": {
                    "parent": {
                        "path": "root.pgn",
                        "name": "root",
                        "anchorFen": after_e4,
                        "anchorPath": [0],
                        "anchorPly": 1,
                        "label": "e4"
                    },
                    "children": []
                }
            })
            .to_string(),
        )
        .unwrap();

        let result = variants_compress_variant_family(
            dir.path().to_string_lossy().to_string(),
            root_path.to_string_lossy().to_string(),
        )
        .unwrap();

        assert_eq!(result.merged, 2);
        assert_eq!(result.removed, 1);
        assert!(!child_path.exists());
        assert!(!child_path.with_extension("info").exists());

        let merged_pgn = fs::read_to_string(&root_path).unwrap();
        assert!(merged_pgn.contains("1.e4 c5") || merged_pgn.contains("1. e4 c5"));

        let metadata: Value =
            serde_json::from_str(&fs::read_to_string(root_path.with_extension("info")).unwrap())
                .unwrap();
        assert_eq!(
            metadata
                .get("links")
                .and_then(|links| links.get("children"))
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
        let tags = metadata_tags(&metadata);
        assert!(tags.iter().any(|tag| tag == "variantsCount:2"));
    }
}
