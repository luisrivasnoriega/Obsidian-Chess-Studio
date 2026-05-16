use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use crate::db::pgn::{GameTree, GameTreeNode, Importer, TempGame};
use crate::error::{Error, Result};
use pgn_reader::BufferedReader;
use shakmaty::{fen::Fen, uci::UciMove, CastlingMode, Chess, Color, EnPassantMode, Position};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantLinkRefDto {
    pub path: String,
    pub name: String,
    pub anchor_fen: String,
    pub anchor_path: Vec<u32>,
    pub anchor_ply: u32,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum VariantBuildDbTypeDto {
    Local,
    LchAll,
    LchMaster,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantInfoDto {
    pub name: String,
    pub path: String,
    pub priority: Option<i32>,
    pub opening: Option<String>,
    pub fen: Option<String>,
    pub depth: Option<i32>,
    pub line_depth: Option<i32>,
    pub database: Option<String>,
    pub engine: Option<String>,
    pub engine_ms: Option<i32>,
    pub db_type: Option<VariantBuildDbTypeDto>,
    pub variants_count: Option<i32>,
    pub comments: Option<String>,
    pub parent_link: Option<VariantLinkRefDto>,
    pub child_links: Vec<VariantLinkRefDto>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantsDeleteFilesResult {
    pub deleted_pgn: u32,
    pub deleted_info: u32,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantValidationMoveOccurrenceDto {
    pub variant_name: String,
    pub variant_path: String,
    pub line: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantValidationMoveDto {
    pub san: String,
    pub uci: Option<String>,
    pub occurrences: Vec<VariantValidationMoveOccurrenceDto>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantValidationConflictDto {
    pub fen: String,
    pub moves: Vec<VariantValidationMoveDto>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantValidationReportDto {
    pub target_variant_name: String,
    pub target_variant_path: String,
    pub active_color: String,
    pub checked_variants: u32,
    pub checked_variant_paths: Vec<String>,
    pub checked_positions: u32,
    pub conflicts: Vec<VariantValidationConflictDto>,
    pub skipped_variants: Vec<String>,
    pub orientation_mismatches: Vec<String>,
}

#[derive(Default)]
struct PgnHeaderFallback {
    eco: Option<String>,
    fen: Option<String>,
    orientation: Option<String>,
}

fn tag_value(tags: &[String], prefix: &str) -> Option<String> {
    tags.iter()
        .find_map(|tag| tag.strip_prefix(prefix))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_i32(value: Option<String>) -> Option<i32> {
    value.and_then(|raw| raw.parse::<i32>().ok())
}

fn parse_db_type(tags: &[String]) -> Option<VariantBuildDbTypeDto> {
    match tag_value(tags, "dbType:").as_deref() {
        Some("local") => Some(VariantBuildDbTypeDto::Local),
        Some("lch_all") => Some(VariantBuildDbTypeDto::LchAll),
        Some("lch_master") => Some(VariantBuildDbTypeDto::LchMaster),
        _ => {
            let database = tag_value(tags, "database:")
                .unwrap_or_default()
                .to_lowercase();
            if database.starts_with("local") {
                Some(VariantBuildDbTypeDto::Local)
            } else if database.contains("lichess") {
                Some(VariantBuildDbTypeDto::LchAll)
            } else {
                None
            }
        }
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
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

fn unescape_pgn_tag_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut escaped = false;
    for ch in value.chars() {
        if escaped {
            out.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else {
            out.push(ch);
        }
    }
    out
}

fn parse_pgn_header_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return None;
    }

    let inner = &trimmed[1..trimmed.len() - 1];
    let first_space = inner.find(|ch: char| ch.is_whitespace())?;
    let tag = inner[..first_space].trim();
    let value_part = inner[first_space..].trim();
    if tag.is_empty() || !value_part.starts_with('"') {
        return None;
    }

    let mut escaped = false;
    let mut end_quote = None;
    for (index, ch) in value_part.char_indices().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            end_quote = Some(index);
            break;
        }
    }

    let end_quote = end_quote?;
    Some((
        tag.to_string(),
        unescape_pgn_tag_value(&value_part[1..end_quote]),
    ))
}

fn read_first_pgn_headers(path: &Path) -> PgnHeaderFallback {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return PgnHeaderFallback::default(),
    };

    let mut headers = PgnHeaderFallback::default();
    let reader = BufReader::new(file);
    for line in reader.lines().take(256).flatten() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if headers.eco.is_some() || headers.fen.is_some() {
                break;
            }
            continue;
        }
        if !trimmed.starts_with('[') {
            if headers.eco.is_some() || headers.fen.is_some() {
                break;
            }
            continue;
        }

        let Some((tag, value)) = parse_pgn_header_line(trimmed) else {
            continue;
        };
        match tag.as_str() {
            "ECO" if headers.eco.is_none() && !value.trim().is_empty() => {
                headers.eco = Some(value.trim().to_string());
            }
            "FEN" if headers.fen.is_none() && !value.trim().is_empty() => {
                headers.fen = Some(value.trim().to_string());
            }
            "Orientation" if headers.orientation.is_none() && !value.trim().is_empty() => {
                headers.orientation = Some(value.trim().to_string());
            }
            _ => {}
        }

        if headers.eco.is_some() && headers.fen.is_some() && headers.orientation.is_some() {
            break;
        }
    }

    headers
}

fn parse_link(value: Option<&Value>) -> Option<VariantLinkRefDto> {
    value
        .cloned()
        .and_then(|raw| serde_json::from_value::<VariantLinkRefDto>(raw).ok())
}

fn parse_child_links(value: Option<&Value>) -> Vec<VariantLinkRefDto> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| serde_json::from_value::<VariantLinkRefDto>(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn variant_info_from_pgn(path: &Path) -> Result<Option<VariantInfoDto>> {
    let info_path = path.with_extension("info");
    if !info_path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&info_path)?;
    let value: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };

    if value.get("type").and_then(Value::as_str) != Some("variants") {
        return Ok(None);
    }

    let tags = string_array(value.get("tags"));
    let opening_tag = tag_value(&tags, "opening:");
    let fen_tag = tag_value(&tags, "fen:");
    let pgn_headers = if opening_tag.is_none() || fen_tag.is_none() {
        read_first_pgn_headers(path)
    } else {
        PgnHeaderFallback::default()
    };
    let opening = opening_tag.or(pgn_headers.eco);
    let fen = fen_tag.or(pgn_headers.fen);
    let database = tag_value(&tags, "database:");
    let comments = tag_value(&tags, "comments:").or_else(|| tag_value(&tags, "references:"));
    let links = value.get("links");

    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();

    Ok(Some(VariantInfoDto {
        name,
        path: path.to_string_lossy().to_string(),
        priority: parse_i32(tag_value(&tags, "priority:")),
        opening,
        fen,
        depth: parse_i32(tag_value(&tags, "depth:")),
        line_depth: None,
        database,
        engine: tag_value(&tags, "engine:"),
        engine_ms: parse_i32(tag_value(&tags, "engineMs:")),
        db_type: parse_db_type(&tags),
        variants_count: parse_i32(tag_value(&tags, "variantsCount:")),
        comments,
        parent_link: parse_link(links.and_then(|value| value.get("parent"))),
        child_links: parse_child_links(links.and_then(|value| value.get("children"))),
    }))
}

fn collect_variants(dir: &Path, out: &mut Vec<VariantInfoDto>) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_variants(&path, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pgn"))
        {
            continue;
        }
        if let Some(info) = variant_info_from_pgn(&path)? {
            out.push(info);
        }
    }
    Ok(())
}

fn normalize_path_key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

fn file_name_key(path: &str) -> String {
    path.replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .last()
        .unwrap_or(path)
        .to_lowercase()
}

fn is_absolute_link_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized.starts_with('/') || normalized.as_bytes().get(1) == Some(&b':')
}

fn resolve_linked_path(owner_path: &str, link_path: &str) -> String {
    if is_absolute_link_path(link_path) {
        return normalize_path_key(link_path);
    }
    let normalized_owner = owner_path.replace('\\', "/");
    let owner_dir = normalized_owner
        .rsplit_once('/')
        .map(|(dir, _)| dir)
        .unwrap_or("");
    normalize_path_key(&format!("{owner_dir}/{link_path}"))
}

fn resolve_variant_index(
    variants: &[VariantInfoDto],
    variant_by_key: &HashMap<String, usize>,
    variant_by_file_name: &HashMap<String, Vec<usize>>,
    owner: &VariantInfoDto,
    raw_path: &str,
    fallback_name: Option<&str>,
) -> Option<usize> {
    let resolved = resolve_linked_path(&owner.path, raw_path);
    if let Some(index) = variant_by_key.get(&resolved) {
        return Some(*index);
    }

    let raw_file_name = file_name_key(raw_path);
    if let Some(indexes) = variant_by_file_name.get(&raw_file_name) {
        return indexes.first().copied();
    }

    if let Some(name) = fallback_name {
        if let Some(indexes) = variant_by_file_name.get(&name.to_lowercase()) {
            return indexes.first().copied();
        }
    }

    variants
        .iter()
        .position(|variant| normalize_path_key(&variant.path) == resolved)
}

fn normalize_fen_key(fen: &str) -> String {
    let parts: Vec<&str> = fen.split_whitespace().collect();
    if parts.len() < 4 {
        return fen.trim().to_string();
    }
    parts[..4].join(" ")
}

fn position_fen_key(position: &Chess) -> String {
    normalize_fen_key(&Fen::from_position(position.clone(), EnPassantMode::Legal).to_string())
}

fn active_color_from_headers(headers: &PgnHeaderFallback, game: &TempGame) -> String {
    match headers
        .orientation
        .as_deref()
        .map(str::trim)
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("black") => "black".to_string(),
        Some("white") => "white".to_string(),
        _ => {
            let fen = headers
                .fen
                .as_deref()
                .or(game.fen.as_deref())
                .unwrap_or_default();
            if fen.split_whitespace().nth(1) == Some("b") {
                "black".to_string()
            } else {
                "white".to_string()
            }
        }
    }
}

fn read_first_variant_game(path: &Path) -> Result<Option<TempGame>> {
    let file = fs::File::open(path)?;
    let mut reader = BufferedReader::new(file);
    let mut importer = Importer::new(None);
    reader
        .read_game(&mut importer)
        .map(|game| game.flatten())
        .map_err(|error| Error::InvalidInput(format!("Variant PGN parser error: {error}")))
}

fn collect_validation_moves(
    tree: &GameTree,
    start_position: Chess,
    active_color: Color,
    variant: &VariantInfoDto,
    path_moves: &mut Vec<String>,
    fen_moves: &mut HashMap<String, HashMap<String, VariantValidationMoveDto>>,
) -> Result<()> {
    let mut current_position = start_position;
    let mut previous_position = current_position.clone();
    let mut previous_path_moves = path_moves.clone();

    for node in tree.nodes() {
        match node {
            GameTreeNode::Move(san_plus) => {
                let before_position = current_position.clone();
                let before_path_moves = path_moves.clone();
                let move_san = san_plus.to_string();
                let chess_move = san_plus.san.to_move(&current_position)?;
                let move_uci =
                    Some(UciMove::from_move(&chess_move, CastlingMode::Standard).to_string());

                path_moves.push(move_san.clone());
                if before_position.turn() == active_color {
                    let fen_key = position_fen_key(&before_position);
                    let moves = fen_moves.entry(fen_key).or_default();
                    let entry =
                        moves
                            .entry(move_san.clone())
                            .or_insert_with(|| VariantValidationMoveDto {
                                san: move_san.clone(),
                                uci: move_uci.clone(),
                                occurrences: Vec::new(),
                            });
                    if entry.uci.is_none() {
                        entry.uci = move_uci.clone();
                    }
                    entry.occurrences.push(VariantValidationMoveOccurrenceDto {
                        variant_name: variant.name.clone(),
                        variant_path: variant.path.clone(),
                        line: path_moves.join(" "),
                    });
                }

                previous_position = before_position;
                previous_path_moves = before_path_moves;
                current_position.play_unchecked(&chess_move);
            }
            GameTreeNode::Variation(branch) => {
                let mut branch_path_moves = previous_path_moves.clone();
                collect_validation_moves(
                    branch,
                    previous_position.clone(),
                    active_color,
                    variant,
                    &mut branch_path_moves,
                    fen_moves,
                )?;
            }
            GameTreeNode::Comment(_) | GameTreeNode::Nag(_) => {}
        }
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn variants_list_fast(variants_dir: String) -> Result<Vec<VariantInfoDto>> {
    let mut variants = Vec::new();
    collect_variants(Path::new(&variants_dir), &mut variants)?;
    variants.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(variants)
}

#[tauri::command]
#[specta::specta]
pub fn variants_validate_consistency(
    variants_dir: String,
    target_path: String,
) -> Result<VariantValidationReportDto> {
    let mut variants = Vec::new();
    collect_variants(Path::new(&variants_dir), &mut variants)?;
    variants.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));

    let mut variant_by_key = HashMap::new();
    let mut variant_by_file_name: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, variant) in variants.iter().enumerate() {
        variant_by_key.insert(normalize_path_key(&variant.path), index);
        variant_by_file_name
            .entry(file_name_key(&variant.path))
            .or_default()
            .push(index);
    }

    let mut children_by_parent: HashMap<String, HashSet<String>> = HashMap::new();
    let mut parent_by_child: HashMap<String, String> = HashMap::new();
    for variant in &variants {
        let self_key = normalize_path_key(&variant.path);

        if let Some(parent_link) = variant.parent_link.as_ref() {
            if let Some(parent_index) = resolve_variant_index(
                &variants,
                &variant_by_key,
                &variant_by_file_name,
                variant,
                &parent_link.path,
                Some(&parent_link.name),
            ) {
                let parent_key = normalize_path_key(&variants[parent_index].path);
                if parent_key != self_key {
                    parent_by_child.insert(self_key.clone(), parent_key.clone());
                    children_by_parent
                        .entry(parent_key)
                        .or_default()
                        .insert(self_key.clone());
                }
            }
        }

        for child_link in &variant.child_links {
            if child_link.path.trim().is_empty() {
                continue;
            }
            if let Some(child_index) = resolve_variant_index(
                &variants,
                &variant_by_key,
                &variant_by_file_name,
                variant,
                &child_link.path,
                Some(&child_link.name),
            ) {
                let child_key = normalize_path_key(&variants[child_index].path);
                if child_key == self_key {
                    continue;
                }
                children_by_parent
                    .entry(self_key.clone())
                    .or_default()
                    .insert(child_key.clone());
                parent_by_child
                    .entry(child_key)
                    .or_insert_with(|| self_key.clone());
            }
        }
    }

    let target_key = normalize_path_key(&target_path);
    let mut family_root_key = target_key.clone();
    let mut visited_roots = HashSet::new();
    while visited_roots.insert(family_root_key.clone()) {
        let Some(parent_key) = parent_by_child.get(&family_root_key) else {
            break;
        };
        family_root_key = parent_key.clone();
    }

    let target_variant_index = variant_by_key
        .get(&family_root_key)
        .copied()
        .ok_or_else(|| Error::InvalidInput("Variant family root was not found".to_string()))?;
    let target_variant = &variants[target_variant_index];

    let mut subtree_keys = Vec::new();
    let mut visited = HashSet::new();
    let mut stack = vec![family_root_key.clone()];
    while let Some(current_key) = stack.pop() {
        if !visited.insert(current_key.clone()) {
            continue;
        }
        subtree_keys.push(current_key.clone());
        let mut child_keys = children_by_parent
            .get(&current_key)
            .map(|children| children.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        child_keys.sort();
        for child_key in child_keys.into_iter().rev() {
            if parent_by_child.get(&child_key) == Some(&current_key) {
                stack.push(child_key);
            }
        }
    }

    let mut fen_moves: HashMap<String, HashMap<String, VariantValidationMoveDto>> = HashMap::new();
    let mut skipped_variants = Vec::new();
    let mut orientation_mismatches = Vec::new();
    let mut active_color: Option<String> = None;
    let mut checked_variants = 0_u32;
    let mut checked_variant_paths = Vec::new();

    for key in subtree_keys {
        let Some(index) = variant_by_key.get(&key).copied() else {
            continue;
        };
        let variant = &variants[index];
        let path = Path::new(&variant.path);

        let headers = read_first_pgn_headers(path);
        let game = match read_first_variant_game(path) {
            Ok(Some(game)) => game,
            Ok(None) => {
                skipped_variants.push(variant.name.clone());
                continue;
            }
            Err(_) => {
                skipped_variants.push(variant.name.clone());
                continue;
            }
        };

        let variant_orientation = active_color_from_headers(&headers, &game);
        if active_color.is_none() {
            active_color = Some(variant_orientation.clone());
        } else if active_color.as_deref() != Some(variant_orientation.as_str()) {
            orientation_mismatches.push(format!("{} ({})", variant.name, variant_orientation));
        }

        let color = if active_color.as_deref() == Some("black") {
            Color::Black
        } else {
            Color::White
        };

        let mut path_moves = Vec::new();
        if collect_validation_moves(
            &game.tree,
            game.position.clone(),
            color,
            variant,
            &mut path_moves,
            &mut fen_moves,
        )
        .is_err()
        {
            skipped_variants.push(variant.name.clone());
            continue;
        }

        checked_variants = checked_variants.saturating_add(1);
        checked_variant_paths.push(variant.path.clone());
    }

    let Some(active_color) = active_color else {
        return Err(Error::InvalidInput(
            "No readable variants were found".to_string(),
        ));
    };

    let mut conflicts = Vec::new();
    for (fen, moves_map) in fen_moves.iter() {
        if moves_map.len() <= 1 {
            continue;
        }
        let mut moves = moves_map.values().cloned().collect::<Vec<_>>();
        moves.sort_by(|a, b| a.san.cmp(&b.san));
        conflicts.push(VariantValidationConflictDto {
            fen: fen.clone(),
            moves,
        });
    }
    conflicts.sort_by(|a, b| a.fen.cmp(&b.fen));

    Ok(VariantValidationReportDto {
        target_variant_name: target_variant.name.clone(),
        target_variant_path: target_variant.path.clone(),
        active_color,
        checked_variants,
        checked_variant_paths,
        checked_positions: u32::try_from(fen_moves.len()).unwrap_or(u32::MAX),
        conflicts,
        skipped_variants,
        orientation_mismatches,
    })
}

#[tauri::command]
#[specta::specta]
pub fn variants_delete_files(paths: Vec<String>) -> Result<VariantsDeleteFilesResult> {
    let mut deleted_pgn = 0_u32;
    let mut deleted_info = 0_u32;

    for raw_path in paths {
        let path = PathBuf::from(raw_path);
        if path.exists() {
            fs::remove_file(&path)?;
            deleted_pgn = deleted_pgn.saturating_add(1);
        }

        let info_path = path.with_extension("info");
        if info_path.exists() {
            fs::remove_file(info_path)?;
            deleted_info = deleted_info.saturating_add(1);
        }
    }

    Ok(VariantsDeleteFilesResult {
        deleted_pgn,
        deleted_info,
    })
}
