use chrono::Utc;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, san::SanPlus, CastlingMode, Chess, EnPassantMode, Position};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, State};

use crate::coverage_explorer_cache::{
    coverage_cache_get, coverage_cache_set, CoverageCacheMoveDto,
};
use crate::db::pgn::{GameTree, GameTreeNode, Importer, TempGame};
use crate::db::{
    coverage_search_position_stats, get_players, load_coverage_search_dataset,
    CoverageSearchDataset, CoverageSearchFilters, PlayerQuery, PlayerSort, QueryOptions,
    SortDirection,
};
use crate::error::{Error, Result};
use crate::opening::get_opening_info_from_fen;
use crate::variants_builder::{
    fetch_explorer, lichess_explorer_url, masters_explorer_url, LichessGamesOptionsDto,
    MasterGamesOptionsDto,
};
use crate::AppState;
use pgn_reader::BufferedReader;

const COVERAGE_GRAPH_CACHE_VERSION: i64 = 6;
const COVERAGE_GRAPH_CACHE_DIR: &str = ".coverage-graphs";
const COVERAGE_TIER_RULE_VERSION: i64 = 3;
const COVERAGE_LOW_SAMPLE_MIN_GAMES: i64 = 5000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VariantCoverageDatabaseTypeDto {
    Local,
    LchAll,
    LchMaster,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VariantCoverageColorDto {
    White,
    Black,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VariantCoverageTierDto {
    Root,
    Mainline,
    Secondary,
    Alternative,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VariantCoverageResponseRarityDto {
    LowFrequency,
    Novelty,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantCoverageBuildConfigPatchDto {
    pub db_type: Option<VariantCoverageDatabaseTypeDto>,
    pub local_database_path: Option<String>,
    pub lichess_speeds: Option<Vec<String>>,
    pub lichess_ratings: Option<Vec<i32>>,
    pub lichess_since: Option<String>,
    pub lichess_until: Option<String>,
    pub lichess_player: String,
    pub lichess_color: VariantCoverageColorDto,
    pub master_since: Option<String>,
    pub master_until: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantCoverageBuildConfigDto {
    pub db_type: VariantCoverageDatabaseTypeDto,
    pub local_database_path: Option<String>,
    pub lichess_speeds: Vec<String>,
    pub lichess_ratings: Vec<i32>,
    pub lichess_since: Option<String>,
    pub lichess_until: Option<String>,
    pub lichess_player: String,
    pub lichess_color: VariantCoverageColorDto,
    pub master_since: Option<String>,
    pub master_until: Option<String>,
    pub include_children: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantCoverageMoveDto {
    pub san: String,
    #[serde(default)]
    pub games: i64,
    #[serde(default)]
    pub white: i64,
    #[serde(default)]
    pub black: i64,
    #[serde(default)]
    pub draw: i64,
    #[serde(default)]
    pub percent: f64,
    pub tier: VariantCoverageTierDto,
    #[serde(default)]
    pub low_sample: bool,
    pub next_fen: Option<String>,
    pub active_win_rate: Option<f64>,
    pub active_loss_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantCoveragePositionDto {
    pub fen: String,
    pub total_games: i64,
    #[serde(default)]
    pub white: i64,
    #[serde(default)]
    pub black: i64,
    #[serde(default)]
    pub draw: i64,
    pub moves: Vec<VariantCoverageMoveDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantCoverageGraphNodeDto {
    pub id: String,
    pub label: String,
    pub opening_name: Option<String>,
    pub transposition_labels: Option<Vec<String>>,
    pub tier: VariantCoverageTierDto,
    pub percent: Option<f64>,
    pub response_percent: Option<f64>,
    pub response_rarity: Option<VariantCoverageResponseRarityDto>,
    pub fen: Option<String>,
    pub override_key: Option<String>,
    pub active_moves_used: Option<i64>,
    pub low_sample: Option<bool>,
    pub unmapped_response: Option<bool>,
    pub collapsed: Option<bool>,
    pub hidden_children_count: Option<i64>,
    pub active_win_rate: Option<f64>,
    pub active_loss_rate: Option<f64>,
    pub profile_win_rate: Option<f64>,
    pub profile_loss_rate: Option<f64>,
    pub complete_line: Option<bool>,
    pub engine_advantage: Option<String>,
    pub engine_ms: Option<i64>,
    pub engine_name: Option<String>,
    pub children: Vec<VariantCoverageGraphNodeDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantCoverageRawMoveDto {
    pub san: String,
    pub games: i64,
    #[serde(default)]
    pub white: i64,
    #[serde(default)]
    pub black: i64,
    #[serde(default)]
    pub draw: i64,
    pub next_fen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantCoverageGraphCacheDto {
    pub version: i64,
    pub source_signature: String,
    pub max_moves: i64,
    pub positions: HashMap<String, VariantCoveragePositionDto>,
    pub tier_overrides: Option<HashMap<String, VariantCoverageTierDto>>,
    pub label_overrides: Option<HashMap<String, String>>,
    #[serde(default)]
    pub critical_line_dismissed_fen_keys: Vec<String>,
    pub graph_root: VariantCoverageGraphNodeDto,
    pub repertoire_color: VariantCoverageColorDto,
    pub generated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VariantCoverageCriticalLineReasonDto {
    Source,
    Engine,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantCoverageCriticalLineNodeDto {
    pub id: String,
    pub label: String,
    pub opening_name: Option<String>,
    pub fen: Option<String>,
    pub path: Vec<String>,
    pub source_win_rate: Option<f64>,
    pub source_loss_rate: Option<f64>,
    pub profile_win_rate: Option<f64>,
    pub profile_loss_rate: Option<f64>,
    pub engine_advantage: Option<String>,
    pub reasons: Vec<VariantCoverageCriticalLineReasonDto>,
    pub node: VariantCoverageGraphNodeDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantCoverageCriticalLineReportDto {
    pub active_color: VariantCoverageColorDto,
    pub nodes: Vec<VariantCoverageCriticalLineNodeDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantCoverageLinkRefDto {
    pub path: String,
    pub name: String,
    pub anchor_fen: String,
    pub anchor_path: Vec<u32>,
    pub anchor_ply: u32,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantCoverageVariantInfoDto {
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
    pub db_type: Option<String>,
    pub variants_count: Option<i32>,
    pub comments: Option<String>,
    pub parent_link: Option<VariantCoverageLinkRefDto>,
    #[serde(default)]
    pub child_links: Vec<VariantCoverageLinkRefDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantCoverageGraphBuildRequestDto {
    pub target_key: String,
    pub variants: Vec<VariantCoverageVariantInfoDto>,
    pub build_config: VariantCoverageBuildConfigDto,
    pub requested_depth: i64,
    #[serde(default)]
    pub force_rebuild: bool,
    #[serde(default)]
    pub bypass_position_cache: bool,
    #[serde(default = "default_true")]
    pub persist_results: bool,
    #[serde(default)]
    pub mapped_only: bool,
    pub lichess_token: Option<String>,
    pub active_profile_id: Option<String>,
    #[serde(default)]
    pub profile_identity_names: Vec<String>,
    #[serde(default)]
    pub profile_time_control_categories: Vec<String>,
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantCoverageGraphBuildProgressDto {
    pub run_id: Option<String>,
    pub phase: String,
    pub variants_done: i64,
    pub variants_total: i64,
    pub positions_processed: i64,
    pub positions_pending: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VariantCoverageGraphBuildResultDto {
    pub graph_root: VariantCoverageGraphNodeDto,
    pub positions: HashMap<String, VariantCoveragePositionDto>,
    pub repertoire_color: VariantCoverageColorDto,
    pub source_signature: String,
    pub cache_path: Option<String>,
    pub cache_written: bool,
    pub loaded_from_cache: bool,
    pub priority_metadata_updated: bool,
    pub critical_line_dismissed_fen_keys: Vec<String>,
    pub max_moves: i64,
}

fn default_true() -> bool {
    true
}

fn get_tag_value(tags: &[String], prefix: &str) -> Option<String> {
    tags.iter()
        .find_map(|tag| tag.strip_prefix(prefix))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_csv_numbers(input: Option<String>) -> Vec<i32> {
    input
        .unwrap_or_default()
        .split(',')
        .filter_map(|value| value.trim().parse::<i32>().ok())
        .collect()
}

fn parse_csv_strings(input: Option<String>) -> Vec<String> {
    input
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn normalize_month_tag(input: Option<String>) -> Option<String> {
    let value = input?.trim().to_owned();
    if value.is_empty() {
        return None;
    }

    let normalized = value.replace(['.', '/'], "-");
    let parts: Vec<&str> = normalized.split('-').collect();
    if parts.len() < 2 {
        return None;
    }

    let year = parts[0].parse::<i32>().ok()?;
    let month_text = parts[1].chars().take(2).collect::<String>();
    let month = month_text.parse::<i32>().ok()?;
    if !(1..=12).contains(&month) {
        return None;
    }

    Some(format!("{year:04}-{month:02}"))
}

fn is_valid_lichess_speed(value: &str) -> bool {
    matches!(
        value,
        "ultraBullet" | "bullet" | "blitz" | "rapid" | "classical" | "correspondence"
    )
}

fn is_valid_lichess_rating(value: i32) -> bool {
    matches!(
        value,
        0 | 1000 | 1200 | 1400 | 1600 | 1800 | 2000 | 2200 | 2500
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalSourceSignature<'a> {
    coverage_tier_rule_version: i64,
    low_sample_min_games: i64,
    db_type: &'a str,
    local_database_path: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LichessAllSourceSignature<'a> {
    coverage_tier_rule_version: i64,
    low_sample_min_games: i64,
    db_type: &'a str,
    lichess_speeds: Vec<String>,
    lichess_ratings: Vec<i32>,
    lichess_since: Option<String>,
    lichess_until: Option<String>,
    lichess_player: String,
    lichess_color: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LichessMasterSourceSignature<'a> {
    coverage_tier_rule_version: i64,
    low_sample_min_games: i64,
    db_type: &'a str,
    master_since: Option<String>,
    master_until: Option<String>,
}

fn serialize_source_signature<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|err| {
        Error::InvalidInput(format!(
            "Failed to serialize coverage source signature: {err}"
        ))
    })
}

fn normalize_fen_key(fen: &str) -> String {
    let parts: Vec<&str> = fen.trim().split_whitespace().collect();
    if parts.len() < 4 {
        return fen.trim().to_string();
    }
    format!("{} {} {} {}", parts[0], parts[1], parts[2], parts[3])
}

fn build_tier_override_key(fen: &str, san: &str) -> String {
    format!("{}|{}", normalize_fen_key(fen), san.trim())
}

fn parse_engine_advantage_color(value: Option<&str>) -> Option<VariantCoverageColorDto> {
    let text = value?.trim();
    if text.is_empty() {
        return None;
    }

    let score_text = if let Some(rest) = text.strip_prefix('M').or_else(|| text.strip_prefix('m')) {
        rest
    } else {
        text
    };
    let mut end = 0usize;
    for (index, ch) in score_text.char_indices() {
        let is_score_char = ch.is_ascii_digit() || ch == '+' || ch == '-' || ch == '.';
        if !is_score_char {
            break;
        }
        end = index + ch.len_utf8();
    }
    if end == 0 {
        return None;
    }

    let score = score_text[..end].parse::<f64>().ok()?;
    if !score.is_finite() || score.abs() < 0.01 {
        return None;
    }
    if score > 0.0 {
        Some(VariantCoverageColorDto::White)
    } else {
        Some(VariantCoverageColorDto::Black)
    }
}

fn fen_side_to_move_color(fen: Option<&str>) -> Option<VariantCoverageColorDto> {
    match fen?.split_whitespace().nth(1)? {
        "w" => Some(VariantCoverageColorDto::White),
        "b" => Some(VariantCoverageColorDto::Black),
        _ => None,
    }
}

fn label_path_segment(label: &str) -> String {
    let value = label
        .split('|')
        .next()
        .unwrap_or(label)
        .split(" - ")
        .next()
        .unwrap_or(label)
        .trim();
    if value.is_empty() {
        "--".to_string()
    } else {
        value.to_string()
    }
}

fn critical_line_dismissal_key(fen: Option<&str>, fallback_id: &str) -> String {
    fen.map(normalize_fen_key)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback_id.to_string())
}

fn collect_critical_line_nodes(
    node: &VariantCoverageGraphNodeDto,
    active_color: VariantCoverageColorDto,
    parent_active_moves_used: i64,
    complete_lines_only: bool,
    dismissed_keys: &std::collections::HashSet<String>,
    path: &mut Vec<String>,
    out: &mut Vec<VariantCoverageCriticalLineNodeDto>,
) {
    path.push(label_path_segment(&node.label));

    let mut reasons = Vec::new();
    let active_moves_used = node.active_moves_used.unwrap_or(parent_active_moves_used);
    let side_to_move = fen_side_to_move_color(node.fen.as_deref());
    let node_ends_after_active_move = side_to_move == Some(opposite_coverage_color(active_color));
    let has_active_move_context = active_moves_used > 0 || node_ends_after_active_move;
    let is_active_player_node = has_active_move_context
        && node.unmapped_response != Some(true)
        && (node.tier == VariantCoverageTierDto::Root
            || active_moves_used > parent_active_moves_used
            || node_ends_after_active_move);

    let has_sufficient_sample = node.low_sample != Some(true);
    let is_complete_line_node = node.complete_line == Some(true) || node.children.is_empty();
    if is_active_player_node
        && has_sufficient_sample
        && (!complete_lines_only || is_complete_line_node)
    {
        if let (Some(win_rate), Some(loss_rate)) = (node.active_win_rate, node.active_loss_rate) {
            if win_rate.is_finite() && loss_rate.is_finite() && loss_rate > win_rate {
                reasons.push(VariantCoverageCriticalLineReasonDto::Source);
            }
        }

        if let Some(engine_color) = parse_engine_advantage_color(node.engine_advantage.as_deref()) {
            if engine_color != active_color {
                reasons.push(VariantCoverageCriticalLineReasonDto::Engine);
            }
        }
    }

    let dismissal_key = critical_line_dismissal_key(node.fen.as_deref(), &node.id);
    if !reasons.is_empty() && !dismissed_keys.contains(&dismissal_key) {
        out.push(VariantCoverageCriticalLineNodeDto {
            id: node.id.clone(),
            label: node.label.clone(),
            opening_name: node.opening_name.clone(),
            fen: node.fen.clone(),
            path: path.clone(),
            source_win_rate: node.active_win_rate,
            source_loss_rate: node.active_loss_rate,
            profile_win_rate: node.profile_win_rate,
            profile_loss_rate: node.profile_loss_rate,
            engine_advantage: node.engine_advantage.clone(),
            reasons,
            node: node.clone(),
        });
    }

    for child in &node.children {
        collect_critical_line_nodes(
            child,
            active_color,
            active_moves_used,
            complete_lines_only,
            dismissed_keys,
            path,
            out,
        );
    }

    path.pop();
}

fn hash_text_fnv1a(value: &str) -> String {
    let mut hash: u32 = 0x811c9dc5;
    for byte in value.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("{hash:08x}")
}

fn sanitize_file_stem(input: &str) -> String {
    let cleaned = input
        .chars()
        .filter(|ch| !matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.is_empty() {
        "coverage".to_string()
    } else {
        cleaned
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverageFileInfoMetadata {
    #[serde(default)]
    tags: Vec<String>,
    #[serde(flatten)]
    rest: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone)]
struct CoverageParsedTree {
    root: CoverageParsedNode,
    orientation: VariantCoverageColorDto,
}

#[derive(Debug, Clone)]
struct CoverageParsedNode {
    fen: String,
    san: Option<String>,
    children: Vec<CoverageParsedNode>,
}

#[derive(Debug, Clone)]
struct CoverageBranchAnchor {
    anchor_fen: String,
    anchor_path: Vec<u32>,
    anchor_ply: i64,
    labels: HashSet<String>,
}

#[derive(Debug, Clone)]
struct CoverageMappedLineMove {
    san: String,
    next_fen: String,
}

fn now_iso_string() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn emit_coverage_graph_build_progress(
    app: &AppHandle,
    progress: VariantCoverageGraphBuildProgressDto,
) {
    let _ = app.emit("variant_coverage_graph_build_progress", progress);
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

fn is_absolute_path_like(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || path.starts_with("\\\\")
        || (bytes.len() >= 3 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/'))
}

fn resolve_linked_path(owner_path: &str, link_path: &str) -> String {
    if is_absolute_path_like(link_path) {
        return normalize_path_key(link_path);
    }
    let owner_normalized = owner_path.replace('\\', "/");
    let owner_dir = owner_normalized
        .rsplit_once('/')
        .map(|(dir, _)| dir)
        .unwrap_or(owner_normalized.as_str());
    normalize_path_key(&format!("{owner_dir}/{link_path}"))
}

fn build_critical_line_cache_path(cache_file_path: &str) -> String {
    if cache_file_path.to_lowercase().ends_with(".json") {
        let end = cache_file_path.len().saturating_sub(5);
        format!("{}-critical-lines.json", &cache_file_path[..end])
    } else {
        format!("{cache_file_path}-critical-lines.json")
    }
}

fn read_info_metadata_for_variant(path: &str) -> CoverageFileInfoMetadata {
    let info_path = path.replace(".pgn", ".info");
    let Ok(raw) = fs::read_to_string(info_path) else {
        return CoverageFileInfoMetadata {
            rest: serde_json::Map::from_iter([(
                "type".to_string(),
                serde_json::Value::String("variants".to_string()),
            )]),
            ..CoverageFileInfoMetadata::default()
        };
    };
    serde_json::from_str(&raw).unwrap_or_else(|_| CoverageFileInfoMetadata {
        rest: serde_json::Map::from_iter([(
            "type".to_string(),
            serde_json::Value::String("variants".to_string()),
        )]),
        ..CoverageFileInfoMetadata::default()
    })
}

fn write_info_metadata_for_variant(path: &str, metadata: &CoverageFileInfoMetadata) -> Result<()> {
    let info_path = path.replace(".pgn", ".info");
    let raw = serde_json::to_string_pretty(metadata).map_err(|err| {
        Error::InvalidInput(format!("Failed to serialize variant metadata: {err}"))
    })?;
    fs::write(info_path, raw)?;
    Ok(())
}

fn parse_legacy_coverage_cache(
    metadata: &CoverageFileInfoMetadata,
) -> Option<VariantCoverageGraphCacheDto> {
    let value = metadata.rest.get("coverageGraphCache")?;
    let version = value.get("version")?.as_i64()?;
    if version != 3 && version != 4 {
        return None;
    }
    serde_json::from_value(value.clone()).ok()
}

fn merge_build_config_from_tags(
    base: VariantCoverageBuildConfigDto,
    tags: &[String],
) -> VariantCoverageBuildConfigDto {
    let parsed = variant_coverage_parse_build_config_tags(tags.to_vec());
    VariantCoverageBuildConfigDto {
        db_type: parsed.db_type.unwrap_or(base.db_type),
        local_database_path: parsed.local_database_path.or(base.local_database_path),
        lichess_speeds: parsed
            .lichess_speeds
            .filter(|value| !value.is_empty())
            .unwrap_or(base.lichess_speeds),
        lichess_ratings: parsed
            .lichess_ratings
            .filter(|value| !value.is_empty())
            .unwrap_or(base.lichess_ratings),
        lichess_since: parsed.lichess_since.or(base.lichess_since),
        lichess_until: parsed.lichess_until.or(base.lichess_until),
        lichess_player: if parsed.lichess_player.trim().is_empty() {
            base.lichess_player
        } else {
            parsed.lichess_player
        },
        lichess_color: parsed.lichess_color,
        master_since: parsed.master_since.or(base.master_since),
        master_until: parsed.master_until.or(base.master_until),
        include_children: base.include_children,
    }
}

fn build_fen_match_keys(fen: Option<&str>) -> Vec<String> {
    let value = fen.unwrap_or_default().trim();
    if value.is_empty() {
        return Vec::new();
    }
    let parts: Vec<&str> = value.split_whitespace().collect();
    let mut keys = Vec::new();
    keys.push(format!("fen4:{}", normalize_fen_key(value)));
    if let Some(board) = parts.first() {
        if let Some(turn) = parts.get(1) {
            keys.push(format!("board-turn:{board} {turn}"));
        }
        keys.push(format!("board:{board}"));
    }
    keys
}

fn coverage_tier_priority(tier: VariantCoverageTierDto) -> Option<i32> {
    match tier {
        VariantCoverageTierDto::Mainline => Some(1),
        VariantCoverageTierDto::Secondary => Some(2),
        VariantCoverageTierDto::Alternative => Some(3),
        VariantCoverageTierDto::Root => None,
    }
}

fn strip_account_key(value: &str) -> &str {
    let lower = value.to_lowercase();
    if lower.starts_with("lichess:") || lower.starts_with("chesscom:") {
        value.split_once(':').map(|(_, rest)| rest).unwrap_or(value)
    } else {
        value
    }
}

fn normalize_coverage_identity_name(value: Option<&str>) -> String {
    strip_account_key(value.unwrap_or_default())
        .trim()
        .to_lowercase()
}

fn graph_cache_path_for_variant(variant_path: &str, source_signature: &str) -> Result<PathBuf> {
    let variant = Path::new(variant_path);
    let parent = variant.parent().ok_or_else(|| {
        Error::InvalidInput(
            "variant_coverage_graph_cache_path: variant path has no parent".to_string(),
        )
    })?;
    let cache_dir = parent.join(COVERAGE_GRAPH_CACHE_DIR);
    std::fs::create_dir_all(&cache_dir)?;

    let file_name = variant
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("coverage");
    let stem = file_name
        .strip_suffix(".pgn")
        .or_else(|| file_name.strip_suffix(".PGN"))
        .unwrap_or(file_name);
    let signature_hash = hash_text_fnv1a(source_signature);
    Ok(cache_dir.join(format!(
        "{}-{signature_hash}.json",
        sanitize_file_stem(stem)
    )))
}

fn read_graph_cache_from_path(file_path: &str) -> Result<Option<VariantCoverageGraphCacheDto>> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Ok(None);
    }

    let raw = std::fs::read_to_string(path)?;
    if raw.trim().is_empty() {
        return Ok(None);
    }

    let mut parsed: VariantCoverageGraphCacheDto = match serde_json::from_str(&raw) {
        Ok(cache) => cache,
        Err(_) => return Ok(None),
    };

    if parsed.version != COVERAGE_GRAPH_CACHE_VERSION && parsed.version != 5 {
        return Ok(None);
    }
    if parsed.source_signature.trim().is_empty() || parsed.max_moves < 0 {
        return Ok(None);
    }

    parsed.version = COVERAGE_GRAPH_CACHE_VERSION;
    Ok(Some(parsed))
}

fn coverage_node(
    id: String,
    label: String,
    tier: VariantCoverageTierDto,
    fen: Option<String>,
) -> VariantCoverageGraphNodeDto {
    VariantCoverageGraphNodeDto {
        id,
        label,
        opening_name: None,
        transposition_labels: None,
        tier,
        percent: None,
        response_percent: None,
        response_rarity: None,
        fen,
        override_key: None,
        active_moves_used: None,
        low_sample: None,
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
        children: Vec::new(),
    }
}

fn get_parsed_node_mut<'a>(
    root: &'a mut CoverageParsedNode,
    path: &[usize],
) -> Option<&'a mut CoverageParsedNode> {
    let mut current = root;
    for index in path {
        current = current.children.get_mut(*index)?;
    }
    Some(current)
}

fn fen_from_position(position: &Chess) -> String {
    Fen::from_position(position.clone(), EnPassantMode::Legal).to_string()
}

fn append_game_tree_to_parsed_root(
    root: &mut CoverageParsedNode,
    tree: &GameTree,
    start_position: &Chess,
) -> Result<()> {
    let mut current_position = start_position.clone();
    let mut previous_position = current_position.clone();
    let mut current_path: Vec<usize> = Vec::new();
    let mut variation_parent_path: Vec<usize> = Vec::new();

    for item in tree.nodes() {
        match item {
            GameTreeNode::Move(san_plus) => {
                let parent_path = current_path.clone();
                let chess_move = san_plus.san.to_move(&current_position)?;
                let san = SanPlus::from_move(current_position.clone(), &chess_move).to_string();
                previous_position = current_position.clone();
                current_position.play_unchecked(&chess_move);
                let child = CoverageParsedNode {
                    fen: fen_from_position(&current_position),
                    san: Some(san),
                    children: Vec::new(),
                };
                let parent = get_parsed_node_mut(root, &parent_path).ok_or_else(|| {
                    Error::InvalidInput("Invalid parsed PGN node path".to_string())
                })?;
                parent.children.push(child);
                let child_index = parent.children.len().saturating_sub(1);
                variation_parent_path = parent_path;
                current_path = variation_parent_path.clone();
                current_path.push(child_index);
            }
            GameTreeNode::Variation(branch) => {
                let mut branch_root = CoverageParsedNode {
                    fen: fen_from_position(&previous_position),
                    san: None,
                    children: Vec::new(),
                };
                append_game_tree_to_parsed_root(&mut branch_root, branch, &previous_position)?;
                let parent =
                    get_parsed_node_mut(root, &variation_parent_path).ok_or_else(|| {
                        Error::InvalidInput("Invalid parsed PGN variation path".to_string())
                    })?;
                parent.children.extend(branch_root.children);
            }
            GameTreeNode::Comment(_) | GameTreeNode::Nag(_) => {}
        }
    }

    Ok(())
}

fn parsed_tree_from_game(game: TempGame) -> Result<CoverageParsedTree> {
    let root_fen = fen_from_position(&game.position);
    let orientation = match game.orientation.as_deref().map(str::trim) {
        Some("black") => VariantCoverageColorDto::Black,
        Some("white") => VariantCoverageColorDto::White,
        _ if !game.position.turn().is_white() => VariantCoverageColorDto::Black,
        _ => VariantCoverageColorDto::White,
    };
    let mut root = CoverageParsedNode {
        fen: root_fen,
        san: None,
        children: Vec::new(),
    };
    append_game_tree_to_parsed_root(&mut root, &game.tree, &game.position)?;
    Ok(CoverageParsedTree { root, orientation })
}

fn parse_variant_trees(path: &str) -> Vec<CoverageParsedTree> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut reader = BufferedReader::new_cursor(raw.as_bytes());
    let mut importer = Importer::new(None);
    let mut trees = Vec::new();

    loop {
        let game = match reader.read_game(&mut importer) {
            Ok(Some(Some(game))) => game,
            Ok(Some(None)) => continue,
            Ok(None) => break,
            Err(error) => {
                log::warn!(
                    "coverage graph PGN parse failed: path={} error={}",
                    path,
                    error
                );
                break;
            }
        };
        match parsed_tree_from_game(game) {
            Ok(tree) => trees.push(tree),
            Err(error) => {
                log::warn!(
                    "coverage graph PGN tree conversion failed: path={} error={}",
                    path,
                    error
                );
            }
        }
    }

    trees
}

fn compare_anchor_path(a_path: &[u32], b_path: &[u32]) -> std::cmp::Ordering {
    let max = a_path.len().max(b_path.len());
    for index in 0..max {
        match (a_path.get(index), b_path.get(index)) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(a), Some(b)) if a != b => return a.cmp(b),
            _ => {}
        }
    }
    std::cmp::Ordering::Equal
}

fn find_tree_branch_anchor(
    node: &CoverageParsedNode,
    path: &[u32],
    repertoire_color: VariantCoverageColorDto,
) -> Option<CoverageBranchAnchor> {
    if node.children.is_empty() {
        return None;
    }

    let side_to_move =
        fen_side_to_move_color(Some(&node.fen)).unwrap_or(VariantCoverageColorDto::White);
    let is_opponent_turn = side_to_move != repertoire_color;
    if (is_opponent_turn && node.children.len() > 1)
        || (!is_opponent_turn && node.children.len() > 1)
    {
        let labels = node
            .children
            .iter()
            .filter_map(|child| child.san.as_ref().map(|san| san.trim().to_string()))
            .filter(|san| !san.is_empty())
            .collect::<HashSet<_>>();
        return Some(CoverageBranchAnchor {
            anchor_fen: node.fen.clone(),
            anchor_path: path.to_vec(),
            anchor_ply: path.len() as i64,
            labels,
        });
    }

    if node.children.len() == 1 {
        let mut next_path = path.to_vec();
        next_path.push(0);
        return find_tree_branch_anchor(&node.children[0], &next_path, repertoire_color);
    }

    None
}

fn collect_tree_branch_candidates(
    node: &CoverageParsedNode,
    path: &[u32],
    repertoire_color: VariantCoverageColorDto,
    candidates: &mut HashMap<String, CoverageBranchAnchor>,
) {
    if node.children.is_empty() {
        return;
    }
    let side_to_move =
        fen_side_to_move_color(Some(&node.fen)).unwrap_or(VariantCoverageColorDto::White);
    if side_to_move != repertoire_color {
        let labels = node
            .children
            .iter()
            .filter_map(|child| child.san.as_ref().map(|san| san.trim().to_string()))
            .filter(|san| !san.is_empty())
            .collect::<HashSet<_>>();
        if !labels.is_empty() {
            let fen_key = normalize_fen_key(&node.fen);
            let candidate = candidates
                .entry(fen_key)
                .or_insert_with(|| CoverageBranchAnchor {
                    anchor_fen: node.fen.clone(),
                    anchor_path: path.to_vec(),
                    anchor_ply: path.len() as i64,
                    labels: HashSet::new(),
                });
            candidate.labels.extend(labels);
            if path.len() < candidate.anchor_path.len()
                || (path.len() == candidate.anchor_path.len()
                    && compare_anchor_path(path, &candidate.anchor_path)
                        == std::cmp::Ordering::Less)
            {
                candidate.anchor_fen = node.fen.clone();
                candidate.anchor_path = path.to_vec();
                candidate.anchor_ply = path.len() as i64;
            }
        }
    }

    for (index, child) in node.children.iter().enumerate() {
        let mut next_path = path.to_vec();
        next_path.push(index as u32);
        collect_tree_branch_candidates(child, &next_path, repertoire_color, candidates);
    }
}

fn collect_orientation_moves(
    node: &CoverageParsedNode,
    repertoire_color: VariantCoverageColorDto,
    out: &mut HashMap<String, HashSet<String>>,
) {
    let side_to_move =
        fen_side_to_move_color(Some(&node.fen)).unwrap_or(VariantCoverageColorDto::White);
    if side_to_move == repertoire_color {
        let moves = out.entry(normalize_fen_key(&node.fen)).or_default();
        for child in &node.children {
            if let Some(san) = child
                .san
                .as_deref()
                .map(str::trim)
                .filter(|san| !san.is_empty())
            {
                moves.insert(san.to_string());
            }
        }
    }
    for child in &node.children {
        collect_orientation_moves(child, repertoire_color, out);
    }
}

fn collect_mapped_moves(
    node: &CoverageParsedNode,
    out: &mut HashMap<String, HashMap<String, CoverageMappedLineMove>>,
) {
    for child in &node.children {
        if let Some(san) = child
            .san
            .as_deref()
            .map(str::trim)
            .filter(|san| !san.is_empty())
        {
            let source_key = normalize_fen_key(&node.fen);
            let next_key = normalize_fen_key(&child.fen);
            let move_key = format!("{san}|{next_key}");
            out.entry(source_key)
                .or_default()
                .entry(move_key)
                .or_insert_with(|| CoverageMappedLineMove {
                    san: san.to_string(),
                    next_fen: child.fen.clone(),
                });
        }
        collect_mapped_moves(child, out);
    }
}

fn format_opening_name_for_coverage_node(fen: &str) -> Option<String> {
    let info = get_opening_info_from_fen(fen).ok()?;
    let variation = info.variation.trim();
    let opening = info.opening.trim();
    let base = if !variation.is_empty() {
        variation
    } else {
        opening
    };
    if base.is_empty() {
        return None;
    }
    let eco = info.eco.trim();
    if eco.is_empty() {
        Some(base.to_string())
    } else {
        Some(format!("{eco} {base}"))
    }
}

fn explorer_moves_to_raw(
    moves: Vec<crate::variants_builder::ExplorerMove>,
) -> Vec<VariantCoverageRawMoveDto> {
    moves
        .into_iter()
        .map(|move_entry| {
            let games = i64::from(move_entry.white)
                + i64::from(move_entry.black)
                + i64::from(move_entry.draws);
            VariantCoverageRawMoveDto {
                san: move_entry.san,
                games,
                white: i64::from(move_entry.white),
                black: i64::from(move_entry.black),
                draw: i64::from(move_entry.draws),
                next_fen: None,
            }
        })
        .filter(|move_entry| !move_entry.san.trim().is_empty() && move_entry.games > 0)
        .collect()
}

fn position_moves_to_cache_moves(moves: &[VariantCoverageMoveDto]) -> Vec<CoverageCacheMoveDto> {
    moves
        .iter()
        .map(|move_entry| CoverageCacheMoveDto {
            san: move_entry.san.clone(),
            games: move_entry.games,
            white: move_entry.white,
            black: move_entry.black,
            draw: move_entry.draw,
        })
        .collect()
}

fn max_coverage_active_moves(node: &VariantCoverageGraphNodeDto) -> i64 {
    let own = node.active_moves_used.unwrap_or(0).max(0);
    node.children
        .iter()
        .fold(own, |max, child| max.max(max_coverage_active_moves(child)))
}

fn collect_engine_annotations_by_fen(
    node: &VariantCoverageGraphNodeDto,
    out: &mut HashMap<String, (String, Option<i64>, Option<String>)>,
) {
    if let Some(fen) = node.fen.as_deref() {
        if let Some(advantage) = node
            .engine_advantage
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            out.insert(
                normalize_fen_key(fen),
                (advantage.clone(), node.engine_ms, node.engine_name.clone()),
            );
        }
    }
    for child in &node.children {
        collect_engine_annotations_by_fen(child, out);
    }
}

fn apply_engine_annotations_by_fen(
    mut node: VariantCoverageGraphNodeDto,
    annotations: &HashMap<String, (String, Option<i64>, Option<String>)>,
) -> VariantCoverageGraphNodeDto {
    if let Some(fen) = node.fen.as_deref() {
        if let Some((advantage, engine_ms, engine_name)) = annotations.get(&normalize_fen_key(fen))
        {
            node.engine_advantage = Some(advantage.clone());
            node.engine_ms = *engine_ms;
            node.engine_name = engine_name.clone();
        }
    }
    node.children = node
        .children
        .into_iter()
        .map(|child| apply_engine_annotations_by_fen(child, annotations))
        .collect();
    node
}

struct CoverageGraphBuilder<'a> {
    app: AppHandle,
    state: State<'a, AppState>,
    run_id: Option<String>,
    config: VariantCoverageBuildConfigDto,
    source_signature: String,
    lichess_token: Option<String>,
    bypass_position_cache: bool,
    repertoire_color: VariantCoverageColorDto,
    profile_db_path: Option<String>,
    profile_player_ids: Vec<i32>,
    profile_time_control_categories: Vec<String>,
    positions: HashMap<String, VariantCoveragePositionDto>,
    profile_positions: HashMap<String, VariantCoveragePositionDto>,
    coverage_datasets: HashMap<String, CoverageSearchDataset>,
    tier_overrides: HashMap<String, VariantCoverageTierDto>,
    label_overrides: HashMap<String, String>,
    opening_names: HashMap<String, Option<String>>,
    variant_names_by_fen: HashMap<String, Vec<String>>,
    variants_done: i64,
    variants_total: i64,
    positions_processed: i64,
    positions_pending: i64,
    last_progress_at: std::time::Instant,
}

impl<'a> CoverageGraphBuilder<'a> {
    fn new(
        app: AppHandle,
        state: State<'a, AppState>,
        run_id: Option<String>,
        config: VariantCoverageBuildConfigDto,
        source_signature: String,
        lichess_token: Option<String>,
        bypass_position_cache: bool,
        repertoire_color: VariantCoverageColorDto,
        profile_db_path: Option<String>,
        profile_player_ids: Vec<i32>,
        profile_time_control_categories: Vec<String>,
        positions: HashMap<String, VariantCoveragePositionDto>,
        tier_overrides: HashMap<String, VariantCoverageTierDto>,
        label_overrides: HashMap<String, String>,
        opening_names: HashMap<String, Option<String>>,
        variant_names_by_fen: HashMap<String, Vec<String>>,
        variants_total: i64,
    ) -> Self {
        Self {
            app,
            state,
            run_id,
            config,
            source_signature,
            lichess_token,
            bypass_position_cache,
            repertoire_color,
            profile_db_path,
            profile_player_ids,
            profile_time_control_categories,
            positions,
            profile_positions: HashMap::new(),
            coverage_datasets: HashMap::new(),
            tier_overrides,
            label_overrides,
            opening_names,
            variant_names_by_fen,
            variants_done: 0,
            variants_total,
            positions_processed: 0,
            positions_pending: 0,
            last_progress_at: std::time::Instant::now()
                .checked_sub(std::time::Duration::from_secs(1))
                .unwrap_or_else(std::time::Instant::now),
        }
    }

    fn push_progress(&mut self, phase: &str, force: bool) {
        let now = std::time::Instant::now();
        if !force
            && now.duration_since(self.last_progress_at) < std::time::Duration::from_millis(150)
        {
            return;
        }
        self.last_progress_at = now;
        emit_coverage_graph_build_progress(
            &self.app,
            VariantCoverageGraphBuildProgressDto {
                run_id: self.run_id.clone(),
                phase: phase.to_string(),
                variants_done: self.variants_done,
                variants_total: self.variants_total,
                positions_processed: self.positions_processed,
                positions_pending: self.positions_pending,
            },
        );
    }

    fn seed_opening_names_from_graph(&mut self, root: &VariantCoverageGraphNodeDto) {
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            if let Some(fen) = node.fen.as_deref().filter(|fen| !fen.trim().is_empty()) {
                if node.opening_name.is_some() {
                    self.opening_names
                        .insert(normalize_fen_key(fen), node.opening_name.clone());
                }
            }
            for child in &node.children {
                stack.push(child);
            }
        }
    }

    fn get_opening_name_by_fen(&mut self, fen: Option<&str>) -> Option<String> {
        let normalized = fen?.trim();
        if normalized.is_empty() {
            return None;
        }
        let fen_key = normalize_fen_key(normalized);
        if let Some(value) = self.opening_names.get(&fen_key) {
            return value.clone();
        }
        let value = format_opening_name_for_coverage_node(normalized);
        self.opening_names.insert(fen_key, value.clone());
        value
    }

    fn resolve_opening_name(
        &mut self,
        fen: Option<&str>,
        fallback: Option<&str>,
    ) -> Option<String> {
        self.get_opening_name_by_fen(fen)
            .or_else(|| fallback.map(ToOwned::to_owned))
    }

    fn get_variant_names_for_fen(&self, fen: Option<&str>) -> Option<Vec<String>> {
        let mut names = Vec::new();
        for key in build_fen_match_keys(fen) {
            for name in self.variant_names_by_fen.get(&key).into_iter().flatten() {
                if !names.iter().any(|item| item == name) {
                    names.push(name.clone());
                }
            }
        }
        (!names.is_empty()).then_some(names)
    }

    fn format_coverage_node_label(
        &self,
        san: &str,
        percent: f64,
        variant_names: Option<Vec<String>>,
    ) -> String {
        match variant_names {
            Some(names) if !names.is_empty() => format!("{san} {percent}% - {}", names.join(" / ")),
            _ => format!("{san} {percent}%"),
        }
    }

    fn format_orientation_node_label(
        &self,
        san: &str,
        variant_names: Option<Vec<String>>,
    ) -> String {
        match variant_names {
            Some(names) if !names.is_empty() => format!("{san} - {}", names.join(" / ")),
            _ => san.to_string(),
        }
    }

    fn get_coverage_dataset(&mut self, db_path: &str) -> Result<CoverageSearchDataset> {
        let key = db_path.trim().to_string();
        if let Some(dataset) = self.coverage_datasets.get(&key) {
            return Ok(dataset.clone());
        }
        let dataset = load_coverage_search_dataset(PathBuf::from(&key), self.state.clone())?;
        self.coverage_datasets.insert(key, dataset.clone());
        Ok(dataset)
    }

    async fn fetch_source_position(&mut self, fen: &str) -> Result<VariantCoveragePositionDto> {
        match self.config.db_type {
            VariantCoverageDatabaseTypeDto::Local => {
                let path = self
                    .config
                    .local_database_path
                    .as_ref()
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
                    .ok_or(Error::MissingReferenceDatabase)?;
                let dataset = self.get_coverage_dataset(&path)?;
                let stats = coverage_search_position_stats(
                    &dataset,
                    fen,
                    CoverageSearchFilters::default(),
                )?;
                let moves = stats
                    .into_iter()
                    .map(|row| VariantCoverageRawMoveDto {
                        san: row.move_,
                        games: i64::from(row.white.max(0) + row.black.max(0) + row.draw.max(0)),
                        white: i64::from(row.white.max(0)),
                        black: i64::from(row.black.max(0)),
                        draw: i64::from(row.draw.max(0)),
                        next_fen: None,
                    })
                    .collect();
                Ok(classify_position_moves(
                    fen.to_string(),
                    moves,
                    Some(self.tier_overrides.clone()),
                    self.repertoire_color,
                ))
            }
            VariantCoverageDatabaseTypeDto::LchAll => {
                let player_text = self.config.lichess_player.trim();
                let player = (!player_text.is_empty()).then(|| player_text.to_string());
                let options = LichessGamesOptionsDto {
                    variant: None,
                    speeds: Some(self.config.lichess_speeds.clone()),
                    ratings: Some(
                        self.config
                            .lichess_ratings
                            .iter()
                            .filter_map(|value| u32::try_from(*value).ok())
                            .collect(),
                    ),
                    since: self.config.lichess_since.clone(),
                    until: self.config.lichess_until.clone(),
                    moves: None,
                    top_games: None,
                    recent_games: None,
                    player,
                    color: match self.config.lichess_color {
                        VariantCoverageColorDto::White => "white".to_string(),
                        VariantCoverageColorDto::Black => "black".to_string(),
                    },
                };
                let data = fetch_explorer(
                    lichess_explorer_url(fen, &options)?,
                    self.lichess_token.as_deref(),
                )
                .await?;
                Ok(classify_position_moves(
                    fen.to_string(),
                    explorer_moves_to_raw(data.moves),
                    Some(self.tier_overrides.clone()),
                    self.repertoire_color,
                ))
            }
            VariantCoverageDatabaseTypeDto::LchMaster => {
                let options = MasterGamesOptionsDto {
                    since: self.config.master_since.clone(),
                    until: self.config.master_until.clone(),
                    moves: None,
                    top_games: None,
                };
                let data = fetch_explorer(
                    masters_explorer_url(fen, &options)?,
                    self.lichess_token.as_deref(),
                )
                .await?;
                Ok(classify_position_moves(
                    fen.to_string(),
                    explorer_moves_to_raw(data.moves),
                    Some(self.tier_overrides.clone()),
                    self.repertoire_color,
                ))
            }
        }
    }

    async fn get_position_entry(&mut self, fen: &str) -> Result<VariantCoveragePositionDto> {
        let fen_key = normalize_fen_key(fen);
        if let Some(entry) = self.positions.get(&fen_key) {
            let needs_hydration = entry.moves.iter().any(|row| {
                row.low_sample == false
                    && (row.active_win_rate.is_none() || row.active_loss_rate.is_none())
            });
            if !needs_hydration {
                return Ok(entry.clone());
            }
            let hydrated = classify_position_moves(
                entry.fen.clone(),
                entry
                    .moves
                    .iter()
                    .map(|row| VariantCoverageRawMoveDto {
                        san: row.san.clone(),
                        games: row.games,
                        white: row.white,
                        black: row.black,
                        draw: row.draw,
                        next_fen: row.next_fen.clone(),
                    })
                    .collect(),
                Some(self.tier_overrides.clone()),
                self.repertoire_color,
            );
            self.positions.insert(fen_key, hydrated.clone());
            return Ok(hydrated);
        }

        if !self.bypass_position_cache {
            if let Ok(Some(cache_entry)) = coverage_cache_get(
                self.app.clone(),
                self.source_signature.clone(),
                fen.to_string(),
            ) {
                let has_result_breakdown = cache_entry
                    .moves
                    .iter()
                    .any(|row| row.white.max(0) + row.black.max(0) + row.draw.max(0) > 0);
                if has_result_breakdown {
                    let entry = classify_position_moves(
                        fen.to_string(),
                        cache_moves_to_raw(cache_entry.moves),
                        Some(self.tier_overrides.clone()),
                        self.repertoire_color,
                    );
                    self.positions.insert(fen_key, entry.clone());
                    return Ok(entry);
                }
            }
        }

        let entry = self.fetch_source_position(fen).await?;
        if !self.bypass_position_cache
            && self.config.db_type == VariantCoverageDatabaseTypeDto::Local
        {
            let _ = coverage_cache_set(
                self.app.clone(),
                self.source_signature.clone(),
                fen.to_string(),
                position_moves_to_cache_moves(&entry.moves),
                None,
            );
        }
        self.positions.insert(fen_key, entry.clone());
        Ok(entry)
    }

    async fn get_profile_position_entry(
        &mut self,
        fen: &str,
        active_moves_used: i64,
    ) -> Result<Option<VariantCoveragePositionDto>> {
        if active_moves_used > 3 {
            return Ok(None);
        }
        let Some(db_path) = self
            .profile_db_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Ok(None);
        };
        if self.profile_player_ids.is_empty() {
            return Ok(None);
        }
        let fen_key = normalize_fen_key(fen);
        if let Some(entry) = self.profile_positions.get(&fen_key) {
            return Ok(Some(entry.clone()));
        }
        let db_path = db_path.to_string();
        let player_ids = self.profile_player_ids.clone();
        let profile_categories = self.profile_time_control_categories.clone();
        let repertoire_color = self.repertoire_color;
        let dataset = self.get_coverage_dataset(&db_path)?;
        let entry = fetch_profile_position_stats_from_dataset(
            &dataset,
            fen,
            &player_ids,
            repertoire_color,
            &profile_categories,
        )?;
        self.profile_positions.insert(fen_key, entry.clone());
        Ok(Some(entry))
    }

    fn build_mapped_line_graph<'b>(
        &'b mut self,
        root_node: &'b mut VariantCoverageGraphNodeDto,
        target_root_fen: String,
        variant_trees_by_key: &'b HashMap<String, Vec<CoverageParsedTree>>,
        target_key: &'b str,
    ) -> BoxFuture<'b, Result<()>> {
        Box::pin(async move {
            let mut mapped_moves_by_fen: HashMap<String, HashMap<String, CoverageMappedLineMove>> =
                HashMap::new();
            for (tree_key, trees) in variant_trees_by_key {
                for tree in trees {
                    if tree.orientation != self.repertoire_color && tree_key != target_key {
                        continue;
                    }
                    collect_mapped_moves(&tree.root, &mut mapped_moves_by_fen);
                }
            }
            self.build_mapped_children(
                target_root_fen,
                root_node,
                0,
                HashSet::new(),
                &mapped_moves_by_fen,
            )
            .await
        })
    }

    fn build_mapped_children<'b>(
        &'b mut self,
        fen: String,
        parent_node: &'b mut VariantCoverageGraphNodeDto,
        active_moves_used: i64,
        path_edges: HashSet<String>,
        mapped_moves_by_fen: &'b HashMap<String, HashMap<String, CoverageMappedLineMove>>,
    ) -> BoxFuture<'b, Result<()>> {
        Box::pin(async move {
            let moves = mapped_moves_by_fen
                .get(&normalize_fen_key(&fen))
                .map(|items| items.values().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            if moves.is_empty() {
                parent_node.complete_line = Some(true);
                return Ok(());
            }

            self.positions_processed += 1;
            self.positions_pending = self.positions_pending.saturating_sub(1);
            self.push_progress("building", false);

            let side_to_move =
                fen_side_to_move_color(Some(&fen)).unwrap_or(VariantCoverageColorDto::White);
            let is_active_move = side_to_move == self.repertoire_color;
            let source_entry = self.get_position_entry(&fen).await.ok();
            let profile_entry = self
                .get_profile_position_entry(&fen, active_moves_used)
                .await
                .ok()
                .flatten();

            for mapped_move in moves {
                let next_fen_key = normalize_fen_key(&mapped_move.next_fen);
                let edge_key = format!(
                    "{}|{}|{}",
                    normalize_fen_key(&fen),
                    mapped_move.san,
                    next_fen_key
                );
                if path_edges.contains(&edge_key) {
                    continue;
                }

                let source_move = source_entry.as_ref().and_then(|entry| {
                    entry
                        .moves
                        .iter()
                        .find(|entry_move| {
                            entry_move
                                .next_fen
                                .as_deref()
                                .is_some_and(|next| normalize_fen_key(next) == next_fen_key)
                                || entry_move.san == mapped_move.san
                        })
                        .cloned()
                });
                let profile_move = profile_entry.as_ref().and_then(|profile| {
                    profile
                        .moves
                        .iter()
                        .find(|entry_move| {
                            entry_move
                                .next_fen
                                .as_deref()
                                .is_some_and(|next| normalize_fen_key(next) == next_fen_key)
                                || entry_move.san == mapped_move.san
                        })
                        .cloned()
                });
                let next_active_moves_used = active_moves_used + if is_active_move { 1 } else { 0 };
                let variant_names = self.get_variant_names_for_fen(Some(&mapped_move.next_fen));
                let label = if !is_active_move {
                    if let Some(percent) = source_move.as_ref().map(|entry| entry.percent) {
                        self.format_coverage_node_label(&mapped_move.san, percent, variant_names)
                    } else {
                        self.format_orientation_node_label(&mapped_move.san, variant_names)
                    }
                } else {
                    self.format_orientation_node_label(&mapped_move.san, variant_names)
                };

                let mut child = coverage_node(
                    format!(
                        "{}|mapped:{}|{}",
                        parent_node.id, mapped_move.san, next_fen_key
                    ),
                    label,
                    if is_active_move {
                        VariantCoverageTierDto::Root
                    } else {
                        source_move
                            .as_ref()
                            .map(|entry| entry.tier)
                            .unwrap_or(VariantCoverageTierDto::Mainline)
                    },
                    Some(mapped_move.next_fen.clone()),
                );
                child.opening_name = self.resolve_opening_name(
                    Some(&mapped_move.next_fen),
                    parent_node.opening_name.as_deref(),
                );
                child.percent = source_move.as_ref().map(|entry| entry.percent);
                child.low_sample = source_move.as_ref().map(|entry| entry.low_sample);
                child.override_key = Some(build_tier_override_key(&fen, &mapped_move.san));
                child.active_moves_used = Some(next_active_moves_used);
                child.active_win_rate =
                    source_move.as_ref().and_then(|entry| entry.active_win_rate);
                child.active_loss_rate = source_move
                    .as_ref()
                    .and_then(|entry| entry.active_loss_rate);
                child.profile_win_rate = profile_move
                    .as_ref()
                    .and_then(|entry| entry.active_win_rate);
                child.profile_loss_rate = profile_move
                    .as_ref()
                    .and_then(|entry| entry.active_loss_rate);
                child.complete_line = Some(false);

                parent_node.children.push(child);
                let child_node = parent_node
                    .children
                    .last_mut()
                    .expect("child was just pushed");
                let mut next_edges = path_edges.clone();
                next_edges.insert(edge_key);
                self.positions_pending += 1;
                self.push_progress("building", false);
                self.build_mapped_children(
                    mapped_move.next_fen,
                    child_node,
                    next_active_moves_used,
                    next_edges,
                    mapped_moves_by_fen,
                )
                .await?;
                child_node.complete_line = Some(child_node.children.is_empty());
            }

            parent_node.complete_line = Some(parent_node.children.is_empty());
            Ok(())
        })
    }

    fn expand_node<'b>(
        &'b mut self,
        fen: String,
        parent_node: &'b mut VariantCoverageGraphNodeDto,
        remaining_moves: i64,
        active_moves_used: i64,
        orientation_moves_by_fen: &'b HashMap<String, HashSet<String>>,
    ) -> BoxFuture<'b, Result<()>> {
        Box::pin(async move {
            if remaining_moves <= 0 {
                parent_node.complete_line = Some(parent_node.children.is_empty());
                return Ok(());
            }

            self.positions_processed += 1;
            self.positions_pending = self.positions_pending.saturating_sub(1);
            self.push_progress("building", false);

            let side_to_move =
                fen_side_to_move_color(Some(&fen)).unwrap_or(VariantCoverageColorDto::White);
            if side_to_move == self.repertoire_color {
                let orientation_moves = orientation_moves_by_fen
                    .get(&normalize_fen_key(&fen))
                    .map(|items| items.iter().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                if orientation_moves.is_empty() {
                    parent_node.complete_line = Some(parent_node.children.is_empty());
                    return Ok(());
                }

                let entry = self.get_position_entry(&fen).await?;
                let profile_entry = self
                    .get_profile_position_entry(&fen, active_moves_used)
                    .await?;
                for san in orientation_moves {
                    let next_fen = get_next_fen_from_san(&fen, &san);
                    let response_move = entry
                        .moves
                        .iter()
                        .find(|move_entry| move_entry.san == san)
                        .cloned();
                    let profile_move = profile_entry.as_ref().and_then(|profile| {
                        profile
                            .moves
                            .iter()
                            .find(|move_entry| move_entry.san == san)
                            .cloned()
                    });
                    let next_active_moves_used = active_moves_used + 1;
                    let variant_names = self.get_variant_names_for_fen(next_fen.as_deref());
                    let override_key = build_tier_override_key(&fen, &san);
                    let opening_name = self.resolve_opening_name(
                        next_fen.as_deref(),
                        parent_node.opening_name.as_deref(),
                    );

                    let mut child = coverage_node(
                        format!("{}|forced:{}|{}", parent_node.id, san, remaining_moves),
                        self.format_orientation_node_label(&san, variant_names),
                        VariantCoverageTierDto::Root,
                        next_fen.clone(),
                    );
                    child.opening_name = opening_name;
                    child.percent = response_move.as_ref().map(|move_entry| move_entry.percent);
                    child.override_key = Some(override_key);
                    child.active_moves_used = Some(next_active_moves_used);
                    child.active_win_rate = response_move
                        .as_ref()
                        .and_then(|move_entry| move_entry.active_win_rate);
                    child.active_loss_rate = response_move
                        .as_ref()
                        .and_then(|move_entry| move_entry.active_loss_rate);
                    child.profile_win_rate = profile_move
                        .as_ref()
                        .and_then(|move_entry| move_entry.active_win_rate);
                    child.profile_loss_rate = profile_move
                        .as_ref()
                        .and_then(|move_entry| move_entry.active_loss_rate);

                    parent_node.children.push(child);
                    if let Some(next_fen) = next_fen.filter(|value| !value.trim().is_empty()) {
                        let child_node = parent_node
                            .children
                            .last_mut()
                            .expect("child was just pushed");
                        self.positions_pending += 1;
                        self.push_progress("building", false);
                        self.expand_node(
                            next_fen,
                            child_node,
                            remaining_moves - 1,
                            next_active_moves_used,
                            orientation_moves_by_fen,
                        )
                        .await?;
                        child_node.complete_line = Some(child_node.children.is_empty());
                    }
                }
                parent_node.complete_line = Some(parent_node.children.is_empty());
                return Ok(());
            }

            let entry = self.get_position_entry(&fen).await?;
            let visible_moves = entry
                .moves
                .iter()
                .filter(|move_entry| {
                    let has_mapped_response = move_entry
                        .next_fen
                        .as_deref()
                        .map(normalize_fen_key)
                        .and_then(|key| {
                            orientation_moves_by_fen
                                .get(&key)
                                .map(|moves| !moves.is_empty())
                        })
                        .unwrap_or(false);
                    move_entry.tier != VariantCoverageTierDto::Alternative || has_mapped_response
                })
                .cloned()
                .collect::<Vec<_>>();
            let profile_entry = if visible_moves.is_empty() {
                None
            } else {
                self.get_profile_position_entry(&fen, active_moves_used)
                    .await?
            };

            for move_entry in visible_moves {
                let next_fen_key = move_entry.next_fen.as_deref().map(normalize_fen_key);
                let has_mapped_response = next_fen_key
                    .as_deref()
                    .and_then(|key| {
                        orientation_moves_by_fen
                            .get(key)
                            .map(|moves| !moves.is_empty())
                    })
                    .unwrap_or(false);
                let variant_names = self.get_variant_names_for_fen(move_entry.next_fen.as_deref());
                let profile_move = profile_entry.as_ref().and_then(|profile| {
                    profile
                        .moves
                        .iter()
                        .find(|profile_move| profile_move.san == move_entry.san)
                        .cloned()
                });

                let override_key = build_tier_override_key(&fen, &move_entry.san);
                let opening_name = self.resolve_opening_name(
                    move_entry.next_fen.as_deref(),
                    parent_node.opening_name.as_deref(),
                );
                let label_san = self
                    .label_overrides
                    .get(&build_tier_override_key(&fen, &move_entry.san))
                    .map(String::as_str)
                    .unwrap_or(&move_entry.san);
                let mut child = coverage_node(
                    format!("{}|{}|{}", parent_node.id, move_entry.san, remaining_moves),
                    self.format_coverage_node_label(label_san, move_entry.percent, variant_names),
                    move_entry.tier,
                    move_entry.next_fen.clone(),
                );
                child.opening_name = opening_name;
                child.percent = Some(move_entry.percent);
                child.low_sample = Some(move_entry.low_sample);
                child.override_key = Some(override_key);
                child.active_moves_used = Some(active_moves_used);
                child.active_win_rate = move_entry.active_win_rate;
                child.active_loss_rate = move_entry.active_loss_rate;
                child.profile_win_rate = profile_move
                    .as_ref()
                    .and_then(|profile_move| profile_move.active_win_rate);
                child.profile_loss_rate = profile_move
                    .as_ref()
                    .and_then(|profile_move| profile_move.active_loss_rate);

                parent_node.children.push(child);
                if remaining_moves >= 1 && has_mapped_response {
                    if let Some(next_fen) =
                        move_entry.next_fen.filter(|value| !value.trim().is_empty())
                    {
                        let child_node = parent_node
                            .children
                            .last_mut()
                            .expect("child was just pushed");
                        self.positions_pending += 1;
                        self.push_progress("building", false);
                        self.expand_node(
                            next_fen,
                            child_node,
                            remaining_moves,
                            active_moves_used,
                            orientation_moves_by_fen,
                        )
                        .await?;
                        child_node.complete_line = Some(child_node.children.is_empty());
                    }
                }
            }
            parent_node.complete_line = Some(parent_node.children.is_empty());
            Ok(())
        })
    }
}

fn enrich_graph_openings(
    builder: &mut CoverageGraphBuilder<'_>,
    mut node: VariantCoverageGraphNodeDto,
    inherited_opening_name: Option<String>,
) -> VariantCoverageGraphNodeDto {
    let opening_name =
        builder.resolve_opening_name(node.fen.as_deref(), inherited_opening_name.as_deref());
    let child_inherited = opening_name.clone();
    node.children = node
        .children
        .into_iter()
        .map(|child| enrich_graph_openings(builder, child, child_inherited.clone()))
        .collect();
    node.opening_name = opening_name;
    node
}

fn resolve_variant_by_link<'a>(
    owner: &VariantCoverageVariantInfoDto,
    raw_path: &str,
    fallback_name: Option<&str>,
    variant_by_key: &'a HashMap<String, VariantCoverageVariantInfoDto>,
    variant_by_file_name: &'a HashMap<String, Vec<String>>,
) -> Option<&'a VariantCoverageVariantInfoDto> {
    let resolved = resolve_linked_path(&owner.path, raw_path);
    if let Some(variant) = variant_by_key.get(&resolved) {
        return Some(variant);
    }
    if let Some(keys) = variant_by_file_name.get(&file_name_key(raw_path)) {
        if let Some(key) = keys.first() {
            return variant_by_key.get(key);
        }
    }
    if let Some(name) = fallback_name {
        if let Some(keys) = variant_by_file_name.get(&name.to_lowercase()) {
            if let Some(key) = keys.first() {
                return variant_by_key.get(key);
            }
        }
    }
    None
}

fn build_variant_link_maps(
    variants: &[VariantCoverageVariantInfoDto],
) -> (
    HashMap<String, VariantCoverageVariantInfoDto>,
    HashMap<String, HashSet<String>>,
    HashMap<String, String>,
) {
    let mut variant_by_key = HashMap::new();
    let mut variant_by_file_name: HashMap<String, Vec<String>> = HashMap::new();

    for variant in variants {
        let key = normalize_path_key(&variant.path);
        variant_by_key.insert(key.clone(), variant.clone());
        variant_by_file_name
            .entry(file_name_key(&variant.path))
            .or_default()
            .push(key);
    }

    let mut children_by_parent: HashMap<String, HashSet<String>> = HashMap::new();
    let mut parent_by_child: HashMap<String, String> = HashMap::new();

    for variant in variants {
        let self_key = normalize_path_key(&variant.path);
        if let Some(parent_link) = variant
            .parent_link
            .as_ref()
            .filter(|link| !link.path.trim().is_empty())
        {
            if let Some(parent_variant) = resolve_variant_by_link(
                variant,
                &parent_link.path,
                Some(&parent_link.name),
                &variant_by_key,
                &variant_by_file_name,
            ) {
                let parent_key = normalize_path_key(&parent_variant.path);
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
            let Some(child_variant) = resolve_variant_by_link(
                variant,
                &child_link.path,
                Some(&child_link.name),
                &variant_by_key,
                &variant_by_file_name,
            ) else {
                continue;
            };
            let child_key = normalize_path_key(&child_variant.path);
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

    (variant_by_key, children_by_parent, parent_by_child)
}

fn collect_subtree_keys_backend(
    root_key: &str,
    children_by_parent: &HashMap<String, HashSet<String>>,
    parent_by_child: &HashMap<String, String>,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut visited = HashSet::new();

    fn walk(
        key: &str,
        children_by_parent: &HashMap<String, HashSet<String>>,
        parent_by_child: &HashMap<String, String>,
        visited: &mut HashSet<String>,
        out: &mut Vec<String>,
    ) {
        if !visited.insert(key.to_string()) {
            return;
        }
        out.push(key.to_string());
        let mut children = children_by_parent
            .get(key)
            .map(|items| items.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        children.sort();
        for child_key in children {
            if parent_by_child
                .get(&child_key)
                .is_some_and(|parent| parent == key)
            {
                walk(
                    &child_key,
                    children_by_parent,
                    parent_by_child,
                    visited,
                    out,
                );
            }
        }
    }

    walk(
        root_key,
        children_by_parent,
        parent_by_child,
        &mut visited,
        &mut out,
    );
    out
}

fn san_sequence_for_anchor_path(root: &CoverageParsedNode, anchor_path: &[u32]) -> Vec<String> {
    let mut sequence = Vec::new();
    let mut node = root;
    for index in anchor_path {
        let Some(child) = node.children.get(*index as usize) else {
            return Vec::new();
        };
        if let Some(san) = child
            .san
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            sequence.push(san.to_string());
        }
        node = child;
    }
    sequence
}

fn collect_priority_updates_from_graph(
    root: &VariantCoverageGraphNodeDto,
    variant_keys_by_root_fen: &HashMap<String, HashSet<String>>,
    variant_keys_by_identity: &HashMap<String, HashSet<String>>,
) -> HashMap<String, i32> {
    let mut updates: HashMap<String, (i32, i64)> = HashMap::new();

    fn collect_identity_keys_from_node(node: &VariantCoverageGraphNodeDto) -> HashSet<String> {
        let mut identities = HashSet::new();
        let opening_key = normalize_coverage_identity_name(node.opening_name.as_deref());
        if !opening_key.is_empty() {
            identities.insert(opening_key);
        }
        if let Some(separator) = node.label.find(" - ") {
            let suffix = &node.label[separator + 3..];
            for name in suffix.split(" / ") {
                let key = normalize_coverage_identity_name(Some(name));
                if !key.is_empty() {
                    identities.insert(key);
                }
            }
        }
        identities
    }

    fn visit(
        node: &VariantCoverageGraphNodeDto,
        depth: i64,
        inherited_priority: Option<i32>,
        variant_keys_by_root_fen: &HashMap<String, HashSet<String>>,
        variant_keys_by_identity: &HashMap<String, HashSet<String>>,
        updates: &mut HashMap<String, (i32, i64)>,
    ) {
        let node_priority = coverage_tier_priority(node.tier);
        let effective_priority = node_priority.or(inherited_priority);
        if let Some(priority) = effective_priority {
            let mut keys = HashSet::new();
            for fen_key in build_fen_match_keys(node.fen.as_deref()) {
                if let Some(values) = variant_keys_by_root_fen.get(&fen_key) {
                    keys.extend(values.iter().cloned());
                }
            }
            for identity_key in collect_identity_keys_from_node(node) {
                if let Some(values) = variant_keys_by_identity.get(&identity_key) {
                    keys.extend(values.iter().cloned());
                }
            }
            for key in keys {
                let replace = updates
                    .get(&key)
                    .map(|(_, existing_depth)| depth < *existing_depth)
                    .unwrap_or(true);
                if replace {
                    updates.insert(key, (priority, depth));
                }
            }
        }
        let next_inherited = node_priority.or(inherited_priority);
        for child in &node.children {
            visit(
                child,
                depth + 1,
                next_inherited,
                variant_keys_by_root_fen,
                variant_keys_by_identity,
                updates,
            );
        }
    }

    visit(
        root,
        0,
        None,
        variant_keys_by_root_fen,
        variant_keys_by_identity,
        &mut updates,
    );
    updates
        .into_iter()
        .map(|(key, (priority, _))| (key, priority))
        .collect()
}

fn sync_variant_priority_metadata(
    graph_root: &VariantCoverageGraphNodeDto,
    subtree_keys: &[String],
    target_key: &str,
    variant_by_key: &HashMap<String, VariantCoverageVariantInfoDto>,
    variant_root_fens_by_key: &HashMap<String, Vec<String>>,
) -> Result<bool> {
    let priority_sync_keys = subtree_keys
        .iter()
        .filter(|key| key.as_str() != target_key)
        .cloned()
        .collect::<Vec<_>>();
    if priority_sync_keys.is_empty() {
        return Ok(false);
    }

    let mut variant_keys_by_root_fen: HashMap<String, HashSet<String>> = HashMap::new();
    let mut variant_keys_by_identity: HashMap<String, HashSet<String>> = HashMap::new();

    for key in &priority_sync_keys {
        let Some(variant) = variant_by_key.get(key) else {
            continue;
        };
        for identity in [Some(variant.name.as_str()), variant.opening.as_deref()] {
            let identity_key = normalize_coverage_identity_name(identity);
            if !identity_key.is_empty() {
                variant_keys_by_identity
                    .entry(identity_key)
                    .or_default()
                    .insert(key.clone());
            }
        }
        for root_fen in variant_root_fens_by_key.get(key).into_iter().flatten() {
            for fen_key in build_fen_match_keys(Some(root_fen)) {
                variant_keys_by_root_fen
                    .entry(fen_key)
                    .or_default()
                    .insert(key.clone());
            }
        }
    }

    let priority_updates = collect_priority_updates_from_graph(
        graph_root,
        &variant_keys_by_root_fen,
        &variant_keys_by_identity,
    );
    let mut updated = 0;
    for key in priority_sync_keys {
        let Some(variant) = variant_by_key.get(&key) else {
            continue;
        };
        let mut metadata = read_info_metadata_for_variant(&variant.path);
        metadata.tags.retain(|tag| !tag.starts_with("priority:"));
        if let Some(priority) = priority_updates.get(&key) {
            metadata.tags.push(format!("priority:{priority}"));
        }
        write_info_metadata_for_variant(&variant.path, &metadata)?;
        updated += 1;
    }

    Ok(updated > 0)
}

fn profile_db_path_for_id(app: &AppHandle, profile_id: Option<&str>) -> Option<String> {
    let profile_id = profile_id?.trim();
    if profile_id.is_empty() {
        return None;
    }
    app.path()
        .resolve(
            format!("db/profile_{profile_id}.db3"),
            BaseDirectory::AppData,
        )
        .ok()
        .map(|path| path.to_string_lossy().to_string())
}

async fn resolve_profile_player_ids_for_coverage(
    state: State<'_, AppState>,
    db_path: Option<&str>,
    candidate_names: &[String],
) -> Vec<i32> {
    let Some(db_path) = db_path.map(str::trim).filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    let mut names = candidate_names
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    if names.is_empty() {
        return Vec::new();
    }

    let raw_lower = names
        .iter()
        .map(|name| name.to_lowercase())
        .collect::<HashSet<_>>();
    let normalized = names
        .iter()
        .map(|name| normalize_coverage_identity_name(Some(name)))
        .filter(|name| !name.is_empty())
        .collect::<HashSet<_>>();
    let mut query_terms = HashSet::new();
    for name in &names {
        query_terms.insert(name.clone());
        let stripped = strip_account_key(name).trim().to_string();
        if !stripped.is_empty() && stripped.to_lowercase() != name.to_lowercase() {
            query_terms.insert(stripped);
        }
    }

    let mut ids = HashSet::new();
    for query_term in query_terms {
        for page in 1..=25 {
            let query = PlayerQuery {
                name: Some(query_term.clone()),
                range: None,
                options: QueryOptions {
                    skip_count: false,
                    page: Some(page),
                    page_size: Some(200),
                    sort: PlayerSort::Name,
                    direction: SortDirection::Asc,
                },
            };
            let Ok(response) = get_players(PathBuf::from(db_path), query, state.clone()).await
            else {
                break;
            };
            for player in response.data {
                let Some(player_name) = player
                    .name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                let player_lower = player_name.to_lowercase();
                let player_normalized = normalize_coverage_identity_name(Some(player_name));
                if raw_lower.contains(&player_lower) || normalized.contains(&player_normalized) {
                    ids.insert(player.id);
                }
            }
            let count = response.count.unwrap_or(0);
            if count > 0 && page * 200 >= count {
                break;
            }
            if count == 0 {
                break;
            }
        }
    }

    let mut out = ids.into_iter().collect::<Vec<_>>();
    out.sort_unstable();
    out
}

fn classify_tiers(sorted_moves: &[VariantCoverageRawMoveDto]) -> Vec<VariantCoverageTierDto> {
    let total: i64 = sorted_moves.iter().map(|row| row.games.max(0)).sum();
    if total <= 0 {
        return sorted_moves
            .iter()
            .map(|_| VariantCoverageTierDto::Alternative)
            .collect();
    }

    let mut cumulative = 0.0_f64;
    sorted_moves
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let pct = (row.games.max(0) as f64 / total as f64) * 100.0;
            let next_cumulative = cumulative + pct;
            let tier = if index == 0 {
                VariantCoverageTierDto::Mainline
            } else if next_cumulative <= 60.0 {
                VariantCoverageTierDto::Mainline
            } else if next_cumulative <= 80.0 {
                VariantCoverageTierDto::Secondary
            } else {
                VariantCoverageTierDto::Alternative
            };
            cumulative = next_cumulative;
            tier
        })
        .collect()
}

fn rounded_percent(part: i64, total: i64) -> f64 {
    if total <= 0 {
        return 0.0;
    }
    (((part.max(0) as f64 / total as f64) * 100.0) * 10.0).round() / 10.0
}

pub(crate) fn get_next_fen_from_san(fen: &str, san: &str) -> Option<String> {
    let parsed = Fen::from_ascii(fen.trim().as_bytes()).ok()?;
    let mut position: Chess = parsed.into_position(CastlingMode::Chess960).ok()?;
    let san_plus = SanPlus::from_ascii(san.trim().as_bytes()).ok()?;
    let mv = san_plus.san.to_move(&position).ok()?;
    position.play_unchecked(&mv);
    Some(Fen::from_position(position, EnPassantMode::Legal).to_string())
}

fn classify_position_moves(
    fen: String,
    moves: Vec<VariantCoverageRawMoveDto>,
    tier_overrides: Option<HashMap<String, VariantCoverageTierDto>>,
    repertoire_color: VariantCoverageColorDto,
) -> VariantCoveragePositionDto {
    let mut sorted_moves: Vec<VariantCoverageRawMoveDto> = moves
        .into_iter()
        .filter_map(|row| {
            let san = row.san.trim().to_string();
            if san.is_empty() {
                return None;
            }
            Some(VariantCoverageRawMoveDto {
                san,
                games: row.games.max(0),
                white: row.white.max(0),
                black: row.black.max(0),
                draw: row.draw.max(0),
                next_fen: row.next_fen,
            })
        })
        .collect();
    sorted_moves.sort_by(|a, b| b.games.cmp(&a.games));

    let total_games: i64 = sorted_moves.iter().map(|row| row.games).sum();
    let position_white: i64 = sorted_moves.iter().map(|row| row.white.max(0)).sum();
    let position_black: i64 = sorted_moves.iter().map(|row| row.black.max(0)).sum();
    let position_draw: i64 = sorted_moves.iter().map(|row| row.draw.max(0)).sum();
    let low_sample = total_games < COVERAGE_LOW_SAMPLE_MIN_GAMES;
    let computed_tiers = classify_tiers(&sorted_moves);
    let tier_overrides = tier_overrides.unwrap_or_default();

    let moves = sorted_moves
        .into_iter()
        .enumerate()
        .map(|(index, row)| {
            let override_key = build_tier_override_key(&fen, &row.san);
            let override_tier = tier_overrides.get(&override_key).copied();
            let computed_tier = computed_tiers
                .get(index)
                .copied()
                .unwrap_or(VariantCoverageTierDto::Alternative);
            let tier = match override_tier {
                Some(VariantCoverageTierDto::Mainline)
                | Some(VariantCoverageTierDto::Secondary)
                | Some(VariantCoverageTierDto::Alternative) => override_tier.unwrap(),
                _ => computed_tier,
            };
            let next_fen = row
                .next_fen
                .or_else(|| get_next_fen_from_san(&fen, &row.san));
            let mut move_entry = VariantCoverageMoveDto {
                san: row.san,
                games: row.games,
                white: row.white,
                black: row.black,
                draw: row.draw,
                percent: rounded_percent(row.games, total_games),
                tier,
                low_sample,
                next_fen,
                active_win_rate: None,
                active_loss_rate: None,
            };
            move_entry.active_win_rate = active_side_win_rate(&move_entry, repertoire_color);
            move_entry.active_loss_rate = active_side_loss_rate(&move_entry, repertoire_color);
            move_entry
        })
        .collect();

    VariantCoveragePositionDto {
        fen,
        total_games,
        white: position_white,
        black: position_black,
        draw: position_draw,
        moves,
    }
}

fn cache_moves_to_raw(moves: Vec<CoverageCacheMoveDto>) -> Vec<VariantCoverageRawMoveDto> {
    moves
        .into_iter()
        .map(|row| VariantCoverageRawMoveDto {
            san: row.san,
            games: row.games,
            white: row.white,
            black: row.black,
            draw: row.draw,
            next_fen: None,
        })
        .collect()
}

fn normalized_profile_time_control_categories(categories: Vec<String>) -> Vec<String> {
    let mut values: Vec<String> = categories
        .into_iter()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| {
            matches!(
                value.as_str(),
                "ultra_bullet"
                    | "bullet"
                    | "blitz"
                    | "rapid"
                    | "classical"
                    | "correspondence"
                    | "daily"
            )
        })
        .collect();
    values.sort();
    values.dedup();
    values
}

fn fetch_profile_position_stats_from_dataset(
    dataset: &CoverageSearchDataset,
    fen: &str,
    player_ids: &[i32],
    repertoire_color: VariantCoverageColorDto,
    time_control_categories: &[String],
) -> Result<VariantCoveragePositionDto> {
    let mut merged_moves: HashMap<String, VariantCoverageRawMoveDto> = HashMap::new();
    let category_filters: Vec<Option<String>> = if time_control_categories.is_empty() {
        vec![None]
    } else {
        time_control_categories
            .iter()
            .map(|category| Some(category.clone()))
            .collect()
    };

    for player_id in player_ids {
        for time_control_category in category_filters.iter() {
            let stats = coverage_search_position_stats(
                dataset,
                fen,
                CoverageSearchFilters {
                    player1: matches!(repertoire_color, VariantCoverageColorDto::White)
                        .then_some(*player_id),
                    player2: matches!(repertoire_color, VariantCoverageColorDto::Black)
                        .then_some(*player_id),
                    wanted_result: None,
                    time_control_category: time_control_category.as_deref(),
                    ..CoverageSearchFilters::default()
                },
            )?;

            for row in stats {
                let san = row.move_.trim().to_string();
                if san.is_empty() {
                    continue;
                }
                let entry =
                    merged_moves
                        .entry(san.clone())
                        .or_insert_with(|| VariantCoverageRawMoveDto {
                            san,
                            games: 0,
                            white: 0,
                            black: 0,
                            draw: 0,
                            next_fen: None,
                        });
                entry.white += i64::from(row.white.max(0));
                entry.black += i64::from(row.black.max(0));
                entry.draw += i64::from(row.draw.max(0));
                entry.games = entry.white + entry.black + entry.draw;
            }
        }
    }

    Ok(classify_position_moves(
        fen.to_string(),
        merged_moves.into_values().collect(),
        None,
        repertoire_color,
    ))
}

async fn fetch_profile_position_stats(
    state: State<'_, AppState>,
    db_path: &str,
    fen: &str,
    player_ids: &[i32],
    repertoire_color: VariantCoverageColorDto,
    time_control_categories: &[String],
) -> Result<VariantCoveragePositionDto> {
    if player_ids.is_empty() {
        return Ok(classify_position_moves(
            fen.to_string(),
            Vec::new(),
            None,
            repertoire_color,
        ));
    }
    let dataset = load_coverage_search_dataset(PathBuf::from(db_path), state)?;
    fetch_profile_position_stats_from_dataset(
        &dataset,
        fen,
        player_ids,
        repertoire_color,
        time_control_categories,
    )
}

fn active_side_win_rate(
    move_entry: &VariantCoverageMoveDto,
    repertoire_color: VariantCoverageColorDto,
) -> Option<f64> {
    let total = move_entry.games.max(0);
    if total <= 0 {
        return None;
    }
    let resolved_total = move_entry.white.max(0) + move_entry.black.max(0) + move_entry.draw.max(0);
    if resolved_total <= 0 {
        return None;
    }
    let wins = match repertoire_color {
        VariantCoverageColorDto::White => move_entry.white.max(0),
        VariantCoverageColorDto::Black => move_entry.black.max(0),
    };
    Some(((wins as f64 / total as f64) * 1000.0).round() / 10.0)
}

fn active_side_loss_rate(
    move_entry: &VariantCoverageMoveDto,
    repertoire_color: VariantCoverageColorDto,
) -> Option<f64> {
    let total = move_entry.games.max(0);
    if total <= 0 {
        return None;
    }
    let resolved_total = move_entry.white.max(0) + move_entry.black.max(0) + move_entry.draw.max(0);
    if resolved_total <= 0 {
        return None;
    }
    let losses = match repertoire_color {
        VariantCoverageColorDto::White => move_entry.black.max(0),
        VariantCoverageColorDto::Black => move_entry.white.max(0),
    };
    Some(((losses as f64 / total as f64) * 1000.0).round() / 10.0)
}

fn active_side_position_win_rate(
    position: &VariantCoveragePositionDto,
    repertoire_color: VariantCoverageColorDto,
) -> Option<f64> {
    let mut white = position.white.max(0);
    let mut black = position.black.max(0);
    let mut draw = position.draw.max(0);
    if white + black + draw <= 0 {
        white = position.moves.iter().map(|row| row.white.max(0)).sum();
        black = position.moves.iter().map(|row| row.black.max(0)).sum();
        draw = position.moves.iter().map(|row| row.draw.max(0)).sum();
    }
    let total = white + black + draw;
    if total <= 0 {
        return None;
    }
    let wins = match repertoire_color {
        VariantCoverageColorDto::White => white,
        VariantCoverageColorDto::Black => black,
    };
    Some(((wins as f64 / total as f64) * 1000.0).round() / 10.0)
}

fn active_side_position_loss_rate(
    position: &VariantCoveragePositionDto,
    repertoire_color: VariantCoverageColorDto,
) -> Option<f64> {
    let mut white = position.white.max(0);
    let mut black = position.black.max(0);
    let mut draw = position.draw.max(0);
    if white + black + draw <= 0 {
        white = position.moves.iter().map(|row| row.white.max(0)).sum();
        black = position.moves.iter().map(|row| row.black.max(0)).sum();
        draw = position.moves.iter().map(|row| row.draw.max(0)).sum();
    }
    let total = white + black + draw;
    if total <= 0 {
        return None;
    }
    let losses = match repertoire_color {
        VariantCoverageColorDto::White => black,
        VariantCoverageColorDto::Black => white,
    };
    Some(((losses as f64 / total as f64) * 1000.0).round() / 10.0)
}

fn opposite_coverage_color(color: VariantCoverageColorDto) -> VariantCoverageColorDto {
    match color {
        VariantCoverageColorDto::White => VariantCoverageColorDto::Black,
        VariantCoverageColorDto::Black => VariantCoverageColorDto::White,
    }
}

fn node_move_color(node: &VariantCoverageGraphNodeDto) -> Option<VariantCoverageColorDto> {
    fen_side_to_move_color(node.fen.as_deref()).map(opposite_coverage_color)
}

fn apply_position_flags_to_node(
    mut node: VariantCoverageGraphNodeDto,
    positions: &HashMap<String, VariantCoveragePositionDto>,
    repertoire_color: VariantCoverageColorDto,
) -> VariantCoverageGraphNodeDto {
    node.children = node
        .children
        .into_iter()
        .map(|child| apply_position_flags_to_node(child, positions, repertoire_color))
        .collect();

    let result_position = node
        .fen
        .as_deref()
        .and_then(|fen| positions.get(&normalize_fen_key(fen)));
    if let Some(entry) = result_position {
        let move_color = node_move_color(&node).unwrap_or(repertoire_color);
        node.low_sample = Some(entry.total_games < COVERAGE_LOW_SAMPLE_MIN_GAMES);
        node.active_win_rate = active_side_position_win_rate(entry, move_color);
        node.active_loss_rate = active_side_position_loss_rate(entry, move_color);
        return node;
    }

    let Some(override_key) = node.override_key.as_deref() else {
        return node;
    };
    let Some(separator) = override_key.rfind('|') else {
        return node;
    };
    if separator == 0 {
        return node;
    }

    let fen_key = &override_key[..separator];
    let san = &override_key[separator + 1..];
    let Some(entry) = positions.get(fen_key) else {
        return node;
    };

    node.low_sample = Some(entry.total_games < COVERAGE_LOW_SAMPLE_MIN_GAMES);
    if let Some(move_entry) = entry.moves.iter().find(|row| row.san == san) {
        node.active_win_rate = move_entry
            .active_win_rate
            .or_else(|| active_side_win_rate(move_entry, repertoire_color));
        node.active_loss_rate = move_entry
            .active_loss_rate
            .or_else(|| active_side_loss_rate(move_entry, repertoire_color));
    }
    node
}

fn apply_profile_flags_to_node(
    mut node: VariantCoverageGraphNodeDto,
    positions: &HashMap<String, VariantCoveragePositionDto>,
    repertoire_color: VariantCoverageColorDto,
) -> VariantCoverageGraphNodeDto {
    node.children = node
        .children
        .into_iter()
        .map(|child| apply_profile_flags_to_node(child, positions, repertoire_color))
        .collect();

    let result_position = node
        .fen
        .as_deref()
        .and_then(|fen| positions.get(&normalize_fen_key(fen)));
    if let Some(entry) = result_position {
        let move_color = node_move_color(&node).unwrap_or(repertoire_color);
        node.profile_win_rate = active_side_position_win_rate(entry, move_color);
        node.profile_loss_rate = active_side_position_loss_rate(entry, move_color);
        return node;
    }

    let Some(override_key) = node.override_key.as_deref() else {
        return node;
    };
    let Some(separator) = override_key.rfind('|') else {
        node.profile_win_rate = None;
        node.profile_loss_rate = None;
        return node;
    };
    if separator == 0 {
        node.profile_win_rate = None;
        node.profile_loss_rate = None;
        return node;
    }

    let fen_key = &override_key[..separator];
    let san = &override_key[separator + 1..];
    let Some(entry) = positions.get(fen_key) else {
        node.profile_win_rate = None;
        node.profile_loss_rate = None;
        return node;
    };

    if let Some(move_entry) = entry.moves.iter().find(|row| row.san == san) {
        node.profile_win_rate = move_entry.active_win_rate;
        node.profile_loss_rate = move_entry.active_loss_rate;
    } else {
        node.profile_win_rate = None;
        node.profile_loss_rate = None;
    }
    node
}

fn collect_override_fen_keys(node: &VariantCoverageGraphNodeDto, keys: &mut Vec<String>) {
    if let Some(fen) = node.fen.as_deref() {
        keys.push(normalize_fen_key(fen));
    }
    if let Some(override_key) = node.override_key.as_deref() {
        if let Some(separator) = override_key.rfind('|') {
            if separator > 0 {
                keys.push(override_key[..separator].to_string());
            }
        }
    }
    for child in node.children.iter() {
        collect_override_fen_keys(child, keys);
    }
}

fn trim_graph_node_by_depth(
    mut node: VariantCoverageGraphNodeDto,
    max_active_moves: i64,
) -> VariantCoverageGraphNodeDto {
    let used = node.active_moves_used.unwrap_or(0);
    if used >= max_active_moves {
        node.children.clear();
        return node;
    }
    node.children = node
        .children
        .into_iter()
        .map(|child| trim_graph_node_by_depth(child, max_active_moves))
        .collect();
    node
}

fn response_rarity(percent: Option<f64>) -> Option<VariantCoverageResponseRarityDto> {
    let value = percent?;
    if !value.is_finite() {
        return None;
    }
    if value < 5.0 {
        Some(VariantCoverageResponseRarityDto::Novelty)
    } else if value < 20.0 {
        Some(VariantCoverageResponseRarityDto::LowFrequency)
    } else {
        None
    }
}

fn merge_coverage_and_forced_label(coverage_label: &str, forced_label: &str) -> String {
    let forced_primary = forced_label
        .split('|')
        .next()
        .unwrap_or_default()
        .split("->")
        .next()
        .unwrap_or_default()
        .split(" - ")
        .next()
        .unwrap_or_default()
        .trim();

    let label = coverage_label.trim();
    let Some(percent_index) = label.find('%') else {
        if forced_primary.is_empty() {
            return label.to_string();
        }
        return format!("{label}, {forced_primary}");
    };

    let before_percent = &label[..percent_index];
    let percent_start = before_percent
        .rfind(|ch: char| ch.is_whitespace())
        .map(|idx| idx + 1)
        .unwrap_or(0);
    let move_san = before_percent[..percent_start].trim();
    let percent = label[percent_start..=percent_index].trim();
    if forced_primary.is_empty() {
        format!("{move_san} | {percent}")
    } else {
        format!("{move_san}, {forced_primary} | {percent}")
    }
}

fn apply_node_visibility_rules_node(
    mut node: VariantCoverageGraphNodeDto,
) -> Option<VariantCoverageGraphNodeDto> {
    node.children = node
        .children
        .into_iter()
        .filter_map(apply_node_visibility_rules_node)
        .collect();

    if node.tier == VariantCoverageTierDto::Root {
        return Some(node);
    }

    let has_forced_reply =
        node.children.len() == 1 && node.children[0].tier == VariantCoverageTierDto::Root;

    if node.collapsed.unwrap_or(false) {
        if has_forced_reply {
            let forced_reply = node.children.remove(0);
            let hidden_children_count = forced_reply.children.len() as i64;
            node.label = merge_coverage_and_forced_label(&node.label, &forced_reply.label);
            node.response_percent = forced_reply.percent;
            node.response_rarity = response_rarity(forced_reply.percent);
            node.fen = forced_reply.fen.or(node.fen);
            node.opening_name = forced_reply.opening_name.or(node.opening_name);
            node.active_moves_used = forced_reply.active_moves_used.or(node.active_moves_used);
            node.active_win_rate = forced_reply.active_win_rate;
            node.active_loss_rate = forced_reply.active_loss_rate;
            node.profile_win_rate = forced_reply.profile_win_rate;
            node.profile_loss_rate = forced_reply.profile_loss_rate;
            node.engine_advantage = forced_reply.engine_advantage;
            node.engine_name = forced_reply.engine_name;
            node.engine_ms = forced_reply.engine_ms;
            node.hidden_children_count = Some(hidden_children_count);
        }
        node.unmapped_response = Some(false);
        node.children.clear();
        return Some(node);
    }

    if has_forced_reply {
        let forced_reply = node.children.remove(0);
        node.label = merge_coverage_and_forced_label(&node.label, &forced_reply.label);
        node.response_percent = forced_reply.percent;
        node.response_rarity = response_rarity(forced_reply.percent);
        node.fen = forced_reply.fen.or(node.fen);
        node.opening_name = forced_reply.opening_name.or(node.opening_name);
        node.active_moves_used = forced_reply.active_moves_used.or(node.active_moves_used);
        node.active_win_rate = forced_reply.active_win_rate;
        node.active_loss_rate = forced_reply.active_loss_rate;
        node.profile_win_rate = forced_reply.profile_win_rate;
        node.profile_loss_rate = forced_reply.profile_loss_rate;
        node.engine_advantage = forced_reply.engine_advantage;
        node.engine_name = forced_reply.engine_name;
        node.engine_ms = forced_reply.engine_ms;
        node.unmapped_response = Some(false);
        node.children = forced_reply.children;
        return Some(node);
    }

    if node.tier == VariantCoverageTierDto::Alternative {
        return None;
    }
    node.unmapped_response = Some(true);
    Some(node)
}

#[tauri::command]
#[specta::specta]
pub async fn variant_coverage_build_graph(
    app: AppHandle,
    state: State<'_, AppState>,
    request: VariantCoverageGraphBuildRequestDto,
) -> Result<VariantCoverageGraphBuildResultDto> {
    let target_key = normalize_path_key(&request.target_key);
    let requested_depth = request.requested_depth.clamp(1, 20);
    let (variant_by_key, children_by_parent, parent_by_child) =
        build_variant_link_maps(&request.variants);
    let target_variant = variant_by_key.get(&target_key).cloned().ok_or_else(|| {
        Error::InvalidInput("Coverage graph target variant not found".to_string())
    })?;
    let target_metadata = read_info_metadata_for_variant(&target_variant.path);
    let resolved_config =
        merge_build_config_from_tags(request.build_config.clone(), &target_metadata.tags);

    if resolved_config.db_type != VariantCoverageDatabaseTypeDto::Local
        && request
            .lichess_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err(Error::InvalidInput(
            "Lichess token not found for the active profile.".to_string(),
        ));
    }

    let source_signature = variant_coverage_build_source_signature(resolved_config.clone())?;
    let subtree_keys =
        collect_subtree_keys_backend(&target_key, &children_by_parent, &parent_by_child);
    if subtree_keys.is_empty() {
        return Err(Error::InvalidInput(
            "Coverage graph target subtree is empty".to_string(),
        ));
    }

    let base_cache_path = graph_cache_path_for_variant(&target_variant.path, &source_signature)?
        .to_string_lossy()
        .to_string();
    let cache_path = if request.mapped_only {
        build_critical_line_cache_path(&base_cache_path)
    } else {
        base_cache_path
    };
    let existing_cache = read_graph_cache_from_path(&cache_path)?;
    let legacy_cache = existing_cache
        .as_ref()
        .is_none()
        .then(|| parse_legacy_coverage_cache(&target_metadata))
        .flatten();
    let source_compatible_cache = existing_cache
        .as_ref()
        .filter(|cache| cache.source_signature == source_signature)
        .or_else(|| {
            legacy_cache
                .as_ref()
                .filter(|cache| cache.source_signature == source_signature)
        });

    let profile_db_path = profile_db_path_for_id(&app, request.active_profile_id.as_deref());
    let profile_player_ids = resolve_profile_player_ids_for_coverage(
        state.clone(),
        profile_db_path.as_deref(),
        &request.profile_identity_names,
    )
    .await;
    let profile_categories =
        normalized_profile_time_control_categories(request.profile_time_control_categories.clone());

    if !request.force_rebuild {
        if let Some(cache) = existing_cache
            .as_ref()
            .filter(|cache| cache.source_signature == source_signature)
            .filter(|cache| request.mapped_only || cache.max_moves >= requested_depth)
        {
            let mut builder = CoverageGraphBuilder::new(
                app.clone(),
                state.clone(),
                request.run_id.clone(),
                resolved_config.clone(),
                source_signature.clone(),
                request.lichess_token.clone(),
                request.bypass_position_cache,
                cache.repertoire_color,
                profile_db_path.clone(),
                profile_player_ids.clone(),
                profile_categories.clone(),
                cache.positions.clone(),
                cache.tier_overrides.clone().unwrap_or_default(),
                cache.label_overrides.clone().unwrap_or_default(),
                HashMap::new(),
                HashMap::new(),
                subtree_keys.len() as i64,
            );
            builder.seed_opening_names_from_graph(&cache.graph_root);
            builder.variants_done = subtree_keys.len() as i64;
            builder.push_progress("preparing", true);

            let graph_with_openings =
                enrich_graph_openings(&mut builder, cache.graph_root.clone(), None);
            let graph_with_position_flags = apply_position_flags_to_node(
                graph_with_openings,
                &cache.positions,
                cache.repertoire_color,
            );
            let graph_with_profile_flags = variant_coverage_apply_profile_position_flags(
                app.clone(),
                state.clone(),
                graph_with_position_flags,
                cache.positions.clone(),
                profile_db_path.clone(),
                profile_player_ids.clone(),
                cache.repertoire_color,
                profile_categories.clone(),
            )
            .await?;
            let graph_root = if request.mapped_only {
                graph_with_profile_flags
            } else {
                trim_graph_node_by_depth(graph_with_profile_flags, requested_depth)
            };

            return Ok(VariantCoverageGraphBuildResultDto {
                graph_root,
                positions: cache.positions.clone(),
                repertoire_color: cache.repertoire_color,
                source_signature,
                cache_path: Some(cache_path),
                cache_written: false,
                loaded_from_cache: true,
                priority_metadata_updated: false,
                critical_line_dismissed_fen_keys: cache.critical_line_dismissed_fen_keys.clone(),
                max_moves: cache.max_moves,
            });
        }
    }

    let mut variants_done = 0_i64;
    let variants_total = subtree_keys.len() as i64;
    emit_coverage_graph_build_progress(
        &app,
        VariantCoverageGraphBuildProgressDto {
            run_id: request.run_id.clone(),
            phase: "preparing".to_string(),
            variants_done,
            variants_total,
            positions_processed: 0,
            positions_pending: 0,
        },
    );

    let mut variant_trees_by_key: HashMap<String, Vec<CoverageParsedTree>> = HashMap::new();
    let mut variant_root_fen_by_key: HashMap<String, String> = HashMap::new();
    let mut variant_root_fens_by_key: HashMap<String, Vec<String>> = HashMap::new();

    for key in &subtree_keys {
        let Some(variant) = variant_by_key.get(key) else {
            continue;
        };
        let trees = parse_variant_trees(&variant.path);
        if !trees.is_empty() {
            let mut root_fens = trees
                .iter()
                .map(|tree| tree.root.fen.clone())
                .filter(|fen| !fen.trim().is_empty())
                .collect::<Vec<_>>();
            if let Some(fen) = variant
                .fen
                .as_ref()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
            {
                root_fens.push(fen.to_string());
            }
            root_fens.sort();
            root_fens.dedup();
            variant_root_fen_by_key.insert(key.clone(), trees[0].root.fen.clone());
            variant_root_fens_by_key.insert(key.clone(), root_fens);
            variant_trees_by_key.insert(key.clone(), trees);
        }
        variants_done += 1;
        emit_coverage_graph_build_progress(
            &app,
            VariantCoverageGraphBuildProgressDto {
                run_id: request.run_id.clone(),
                phase: "preparing".to_string(),
                variants_done,
                variants_total,
                positions_processed: 0,
                positions_pending: 0,
            },
        );
    }

    let target_trees = variant_trees_by_key
        .get(&target_key)
        .cloned()
        .unwrap_or_default();
    let target_tree = target_trees.first();
    let repertoire_color = target_tree.map(|tree| tree.orientation).unwrap_or_else(|| {
        target_variant
            .fen
            .as_deref()
            .and_then(|fen| fen_side_to_move_color(Some(fen)))
            .unwrap_or(VariantCoverageColorDto::White)
    });

    let mut variant_names_by_fen: HashMap<String, Vec<String>> = HashMap::new();
    for key in &subtree_keys {
        let Some(variant) = variant_by_key.get(key) else {
            continue;
        };
        for root_fen in variant_root_fens_by_key.get(key).into_iter().flatten() {
            for fen_key in build_fen_match_keys(Some(root_fen)) {
                let names = variant_names_by_fen.entry(fen_key).or_default();
                if !names.iter().any(|name| name == &variant.name) {
                    names.push(variant.name.clone());
                }
            }
        }
    }

    let mut tree_branch_candidates_by_fen: HashMap<String, CoverageBranchAnchor> = HashMap::new();
    for tree in &target_trees {
        collect_tree_branch_candidates(
            &tree.root,
            &[],
            repertoire_color,
            &mut tree_branch_candidates_by_fen,
        );
    }
    let mut ordered_tree_branch_candidates = tree_branch_candidates_by_fen
        .values()
        .filter(|candidate| candidate.labels.len() >= 2)
        .cloned()
        .collect::<Vec<_>>();
    ordered_tree_branch_candidates.sort_by(|a, b| {
        a.anchor_ply
            .cmp(&b.anchor_ply)
            .then_with(|| compare_anchor_path(&a.anchor_path, &b.anchor_path))
            .then_with(|| b.labels.len().cmp(&a.labels.len()))
    });
    let tree_branch_anchor = ordered_tree_branch_candidates
        .into_iter()
        .next()
        .or_else(|| {
            target_tree.and_then(|tree| find_tree_branch_anchor(&tree.root, &[], repertoire_color))
        });

    let mut anchor_groups: HashMap<String, CoverageBranchAnchor> = HashMap::new();
    for link in &target_variant.child_links {
        let fen_key = normalize_fen_key(&link.anchor_fen);
        let label = link.label.as_deref().unwrap_or_default().trim();
        let entry = anchor_groups
            .entry(fen_key)
            .or_insert_with(|| CoverageBranchAnchor {
                anchor_fen: link.anchor_fen.clone(),
                anchor_path: link.anchor_path.clone(),
                anchor_ply: i64::from(link.anchor_ply),
                labels: HashSet::new(),
            });
        if !label.is_empty() {
            entry.labels.insert(label.to_string());
        }
        if i64::from(link.anchor_ply) < entry.anchor_ply {
            entry.anchor_ply = i64::from(link.anchor_ply);
        }
        if link.anchor_path.len() < entry.anchor_path.len() {
            entry.anchor_path = link.anchor_path.clone();
        }
    }
    let mut ordered_anchors = tree_branch_anchor
        .map(|anchor| vec![anchor])
        .unwrap_or_else(|| anchor_groups.into_values().collect());
    ordered_anchors.sort_by(|a, b| {
        a.anchor_ply
            .cmp(&b.anchor_ply)
            .then_with(|| compare_anchor_path(&a.anchor_path, &b.anchor_path))
            .then_with(|| b.labels.len().cmp(&a.labels.len()))
    });
    let first_branch_anchor = ordered_anchors.first().cloned();

    let mut orientation_moves_by_fen: HashMap<String, HashSet<String>> = HashMap::new();
    for (tree_key, trees) in &variant_trees_by_key {
        for tree in trees {
            if tree.orientation != repertoire_color && tree_key != &target_key {
                continue;
            }
            collect_orientation_moves(&tree.root, repertoire_color, &mut orientation_moves_by_fen);
        }
    }

    let source_compatible_positions = source_compatible_cache
        .filter(|_| !request.force_rebuild)
        .map(|cache| cache.positions.clone())
        .unwrap_or_default();
    let tier_overrides = source_compatible_cache
        .and_then(|cache| cache.tier_overrides.clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, tier)| *tier != VariantCoverageTierDto::Root)
        .collect::<HashMap<_, _>>();
    let label_overrides = source_compatible_cache
        .and_then(|cache| cache.label_overrides.clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, label)| !label.trim().is_empty())
        .collect::<HashMap<_, _>>();
    let mut preserved_engine_annotations = HashMap::new();
    if let Some(cache) = source_compatible_cache {
        collect_engine_annotations_by_fen(&cache.graph_root, &mut preserved_engine_annotations);
    }

    let mut builder = CoverageGraphBuilder::new(
        app.clone(),
        state.clone(),
        request.run_id.clone(),
        resolved_config.clone(),
        source_signature.clone(),
        request.lichess_token.clone(),
        request.bypass_position_cache,
        repertoire_color,
        profile_db_path.clone(),
        profile_player_ids.clone(),
        profile_categories.clone(),
        source_compatible_positions,
        tier_overrides.clone(),
        label_overrides.clone(),
        HashMap::new(),
        variant_names_by_fen,
        variants_total,
    );
    builder.variants_done = variants_total;
    builder.push_progress("preparing", true);

    let target_root_fen = variant_root_fen_by_key
        .get(&target_key)
        .cloned()
        .or_else(|| target_variant.fen.clone())
        .filter(|fen| !fen.trim().is_empty())
        .ok_or_else(|| {
            Error::InvalidInput("Could not determine root FEN for the selected variant".to_string())
        })?;

    let mut root_node = coverage_node(
        format!("coverage:{target_key}"),
        target_variant.name.clone(),
        VariantCoverageTierDto::Root,
        Some(target_root_fen.clone()),
    );
    root_node.active_moves_used = Some(0);
    root_node.opening_name = builder.get_opening_name_by_fen(Some(&target_root_fen));

    if request.mapped_only {
        builder.positions_pending += 1;
        builder.push_progress("building", true);
        builder
            .build_mapped_line_graph(
                &mut root_node,
                target_root_fen.clone(),
                &variant_trees_by_key,
                &target_key,
            )
            .await?;
    } else {
        let branch_start_fen = first_branch_anchor
            .as_ref()
            .map(|anchor| anchor.anchor_fen.clone())
            .unwrap_or_else(|| target_root_fen.clone());
        if let (Some(anchor), Some(tree)) = (first_branch_anchor.as_ref(), target_tree) {
            if !anchor.anchor_path.is_empty() {
                let san_sequence = san_sequence_for_anchor_path(&tree.root, &anchor.anchor_path);
                if !san_sequence.is_empty() {
                    let mut branch_parent = coverage_node(
                        format!("{}|prelude", root_node.id),
                        san_sequence.join(" "),
                        VariantCoverageTierDto::Root,
                        Some(branch_start_fen.clone()),
                    );
                    branch_parent.opening_name = builder.resolve_opening_name(
                        Some(&branch_start_fen),
                        root_node.opening_name.as_deref(),
                    );
                    branch_parent.active_moves_used = Some(0);
                    root_node.children.push(branch_parent);
                }
            }
        }

        builder.positions_pending += 1;
        builder.push_progress("building", true);
        if root_node.children.len() == 1
            && root_node.children[0].id == format!("{}|prelude", root_node.id)
        {
            let branch_parent = root_node.children.first_mut().expect("prelude exists");
            builder
                .expand_node(
                    branch_start_fen,
                    branch_parent,
                    requested_depth,
                    0,
                    &orientation_moves_by_fen,
                )
                .await?;
        } else {
            builder
                .expand_node(
                    branch_start_fen,
                    &mut root_node,
                    requested_depth,
                    0,
                    &orientation_moves_by_fen,
                )
                .await?;
        }
    }

    builder.positions_pending = 0;
    builder.push_progress("building", true);

    let positions_record = builder.positions.clone();
    let root_with_engine_annotations = if preserved_engine_annotations.is_empty() {
        root_node
    } else {
        apply_engine_annotations_by_fen(root_node, &preserved_engine_annotations)
    };
    let graph_with_position_flags = apply_position_flags_to_node(
        root_with_engine_annotations,
        &positions_record,
        repertoire_color,
    );
    let graph_with_profile_flags = apply_profile_flags_to_node(
        graph_with_position_flags,
        &builder.profile_positions,
        repertoire_color,
    );
    let max_moves = if request.mapped_only {
        max_coverage_active_moves(&graph_with_profile_flags)
    } else {
        requested_depth
    };

    let critical_line_dismissed_fen_keys = if request.mapped_only {
        Vec::new()
    } else {
        source_compatible_cache
            .map(|cache| cache.critical_line_dismissed_fen_keys.clone())
            .unwrap_or_default()
    };
    let cache = VariantCoverageGraphCacheDto {
        version: COVERAGE_GRAPH_CACHE_VERSION,
        source_signature: source_signature.clone(),
        max_moves,
        positions: positions_record.clone(),
        tier_overrides: Some(tier_overrides),
        label_overrides: Some(label_overrides),
        critical_line_dismissed_fen_keys: critical_line_dismissed_fen_keys.clone(),
        graph_root: graph_with_profile_flags.clone(),
        repertoire_color,
        generated_at: now_iso_string(),
    };

    let mut cache_written = false;
    if request.persist_results {
        variant_coverage_write_graph_cache(cache_path.clone(), cache)?;
        cache_written = true;
    }

    let priority_metadata_updated = if request.persist_results && !request.mapped_only {
        sync_variant_priority_metadata(
            &graph_with_profile_flags,
            &subtree_keys,
            &target_key,
            &variant_by_key,
            &variant_root_fens_by_key,
        )?
    } else {
        false
    };

    Ok(VariantCoverageGraphBuildResultDto {
        graph_root: graph_with_profile_flags,
        positions: positions_record,
        repertoire_color,
        source_signature,
        cache_path: request.persist_results.then_some(cache_path),
        cache_written,
        loaded_from_cache: false,
        priority_metadata_updated,
        critical_line_dismissed_fen_keys,
        max_moves,
    })
}

#[tauri::command]
#[specta::specta]
pub fn variant_coverage_parse_build_config_tags(
    tags: Vec<String>,
) -> VariantCoverageBuildConfigPatchDto {
    let database = get_tag_value(&tags, "database:");
    let raw_db_type = get_tag_value(&tags, "dbType:");

    let db_type = match raw_db_type.as_deref() {
        Some("local") => Some(VariantCoverageDatabaseTypeDto::Local),
        Some("lch_all") => Some(VariantCoverageDatabaseTypeDto::LchAll),
        Some("lch_master") => Some(VariantCoverageDatabaseTypeDto::LchMaster),
        _ => {
            let database_lower = database.as_deref().unwrap_or_default().to_lowercase();
            if database_lower.starts_with("local") {
                Some(VariantCoverageDatabaseTypeDto::Local)
            } else if database_lower.contains("lichess") {
                Some(VariantCoverageDatabaseTypeDto::LchAll)
            } else {
                None
            }
        }
    };

    let lichess_speeds: Vec<String> = parse_csv_strings(get_tag_value(&tags, "lchSpeeds:"))
        .into_iter()
        .filter(|value| is_valid_lichess_speed(value))
        .collect();
    let lichess_ratings: Vec<i32> = parse_csv_numbers(get_tag_value(&tags, "lchRatings:"))
        .into_iter()
        .filter(|value| is_valid_lichess_rating(*value))
        .collect();

    VariantCoverageBuildConfigPatchDto {
        db_type,
        local_database_path: get_tag_value(&tags, "dbPath:"),
        lichess_speeds: (!lichess_speeds.is_empty()).then_some(lichess_speeds),
        lichess_ratings: (!lichess_ratings.is_empty()).then_some(lichess_ratings),
        lichess_since: normalize_month_tag(get_tag_value(&tags, "lchSince:")),
        lichess_until: normalize_month_tag(get_tag_value(&tags, "lchUntil:")),
        lichess_player: get_tag_value(&tags, "lchPlayer:").unwrap_or_default(),
        lichess_color: if get_tag_value(&tags, "lchColor:").as_deref() == Some("black") {
            VariantCoverageColorDto::Black
        } else {
            VariantCoverageColorDto::White
        },
        master_since: normalize_month_tag(get_tag_value(&tags, "masterSince:")),
        master_until: normalize_month_tag(get_tag_value(&tags, "masterUntil:")),
    }
}

#[tauri::command]
#[specta::specta]
pub fn variant_coverage_build_source_signature(
    config: VariantCoverageBuildConfigDto,
) -> Result<String> {
    match config.db_type {
        VariantCoverageDatabaseTypeDto::Local => {
            let signature = LocalSourceSignature {
                coverage_tier_rule_version: COVERAGE_TIER_RULE_VERSION,
                low_sample_min_games: COVERAGE_LOW_SAMPLE_MIN_GAMES,
                db_type: "local",
                local_database_path: config.local_database_path.as_deref(),
            };
            serialize_source_signature(&signature)
        }
        VariantCoverageDatabaseTypeDto::LchMaster => {
            let signature = LichessMasterSourceSignature {
                coverage_tier_rule_version: COVERAGE_TIER_RULE_VERSION,
                low_sample_min_games: COVERAGE_LOW_SAMPLE_MIN_GAMES,
                db_type: "lch_master",
                master_since: normalize_month_tag(config.master_since),
                master_until: normalize_month_tag(config.master_until),
            };
            serialize_source_signature(&signature)
        }
        VariantCoverageDatabaseTypeDto::LchAll => {
            let mut lichess_speeds = config.lichess_speeds;
            lichess_speeds.sort();
            let mut lichess_ratings = config.lichess_ratings;
            lichess_ratings.sort();

            let signature = LichessAllSourceSignature {
                coverage_tier_rule_version: COVERAGE_TIER_RULE_VERSION,
                low_sample_min_games: COVERAGE_LOW_SAMPLE_MIN_GAMES,
                db_type: "lch_all",
                lichess_speeds,
                lichess_ratings,
                lichess_since: normalize_month_tag(config.lichess_since),
                lichess_until: normalize_month_tag(config.lichess_until),
                lichess_player: config.lichess_player.trim().to_lowercase(),
                lichess_color: match config.lichess_color {
                    VariantCoverageColorDto::White => "white",
                    VariantCoverageColorDto::Black => "black",
                },
            };
            serialize_source_signature(&signature)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn variant_coverage_graph_cache_path(
    variant_path: String,
    source_signature: String,
) -> Result<String> {
    let path = graph_cache_path_for_variant(&variant_path, &source_signature)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
#[specta::specta]
pub fn variant_coverage_read_graph_cache(
    file_path: String,
) -> Result<Option<VariantCoverageGraphCacheDto>> {
    read_graph_cache_from_path(&file_path)
}

#[tauri::command]
#[specta::specta]
pub fn variant_coverage_write_graph_cache(
    file_path: String,
    cache: VariantCoverageGraphCacheDto,
) -> Result<()> {
    let path = Path::new(&file_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp_path = path.with_file_name(format!(
        "{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("coverage-graph-cache.json")
    ));
    {
        let file = std::fs::File::create(&tmp_path)?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer(&mut writer, &cache).map_err(|err| {
            Error::InvalidInput(format!("Failed to serialize coverage graph cache: {err}"))
        })?;
        writer.flush()?;
    }
    match std::fs::rename(&tmp_path, path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            std::fs::remove_file(path)?;
            std::fs::rename(&tmp_path, path)?;
        }
        Err(err) => return Err(err.into()),
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn variant_coverage_trim_graph_by_depth(
    root: VariantCoverageGraphNodeDto,
    max_active_moves: i64,
) -> VariantCoverageGraphNodeDto {
    trim_graph_node_by_depth(root, max_active_moves.max(0))
}

#[tauri::command]
#[specta::specta]
pub fn variant_coverage_critical_line_report(
    root: VariantCoverageGraphNodeDto,
    active_color: VariantCoverageColorDto,
    complete_lines_only: Option<bool>,
    dismissed_keys: Option<Vec<String>>,
) -> VariantCoverageCriticalLineReportDto {
    let mut nodes = Vec::new();
    let mut path = Vec::new();
    let dismissed_keys = dismissed_keys
        .unwrap_or_default()
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    collect_critical_line_nodes(
        &root,
        active_color,
        0,
        complete_lines_only == Some(true),
        &dismissed_keys,
        &mut path,
        &mut nodes,
    );
    VariantCoverageCriticalLineReportDto {
        active_color,
        nodes,
    }
}

#[tauri::command]
#[specta::specta]
pub fn variant_coverage_classify_position(
    fen: String,
    moves: Vec<VariantCoverageRawMoveDto>,
    tier_overrides: Option<HashMap<String, VariantCoverageTierDto>>,
    repertoire_color: VariantCoverageColorDto,
) -> VariantCoveragePositionDto {
    classify_position_moves(fen, moves, tier_overrides, repertoire_color)
}

#[tauri::command]
#[specta::specta]
pub fn variant_coverage_get_cached_position(
    app: AppHandle,
    source_signature: String,
    fen: String,
    tier_overrides: Option<HashMap<String, VariantCoverageTierDto>>,
    repertoire_color: VariantCoverageColorDto,
) -> Result<Option<VariantCoveragePositionDto>> {
    let Some(cache_entry) = coverage_cache_get(app, source_signature, fen.clone())? else {
        return Ok(None);
    };
    let has_result_breakdown = cache_entry
        .moves
        .iter()
        .any(|row| row.white.max(0) + row.black.max(0) + row.draw.max(0) > 0);
    if !has_result_breakdown {
        return Ok(None);
    }

    Ok(Some(classify_position_moves(
        fen,
        cache_moves_to_raw(cache_entry.moves),
        tier_overrides,
        repertoire_color,
    )))
}

#[tauri::command]
#[specta::specta]
pub async fn variant_coverage_get_profile_position(
    app: AppHandle,
    state: State<'_, AppState>,
    db_path: String,
    fen: String,
    player_ids: Vec<i32>,
    repertoire_color: VariantCoverageColorDto,
    time_control_categories: Vec<String>,
) -> Result<VariantCoveragePositionDto> {
    let mut unique_player_ids = player_ids;
    unique_player_ids.sort_unstable();
    unique_player_ids.dedup();

    let _ = app;
    fetch_profile_position_stats(
        state,
        &db_path,
        &fen,
        &unique_player_ids,
        repertoire_color,
        &normalized_profile_time_control_categories(time_control_categories),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn variant_coverage_apply_profile_position_flags(
    app: AppHandle,
    state: State<'_, AppState>,
    root: VariantCoverageGraphNodeDto,
    positions: HashMap<String, VariantCoveragePositionDto>,
    db_path: Option<String>,
    player_ids: Vec<i32>,
    repertoire_color: VariantCoverageColorDto,
    time_control_categories: Vec<String>,
) -> Result<VariantCoverageGraphNodeDto> {
    let _ = app;
    let Some(db_path) = db_path.filter(|value| !value.trim().is_empty()) else {
        return Ok(apply_profile_flags_to_node(
            root,
            &HashMap::new(),
            repertoire_color,
        ));
    };
    let mut unique_player_ids = player_ids;
    unique_player_ids.sort_unstable();
    unique_player_ids.dedup();
    if unique_player_ids.is_empty() {
        return Ok(apply_profile_flags_to_node(
            root,
            &HashMap::new(),
            repertoire_color,
        ));
    }

    let categories = normalized_profile_time_control_categories(time_control_categories);
    let mut fen_keys = Vec::new();
    collect_override_fen_keys(&root, &mut fen_keys);
    fen_keys.sort();
    fen_keys.dedup();
    if fen_keys.is_empty() {
        return Ok(apply_profile_flags_to_node(
            root,
            &HashMap::new(),
            repertoire_color,
        ));
    }

    let dataset = load_coverage_search_dataset(PathBuf::from(&db_path), state.clone())?;
    let mut profile_positions = HashMap::new();
    for fen_key in fen_keys {
        let Some(source_entry) = positions.get(&fen_key) else {
            continue;
        };
        let profile_entry = fetch_profile_position_stats_from_dataset(
            &dataset,
            &source_entry.fen,
            &unique_player_ids,
            repertoire_color,
            &categories,
        )?;
        profile_positions.insert(fen_key, profile_entry);
    }

    Ok(apply_profile_flags_to_node(
        root,
        &profile_positions,
        repertoire_color,
    ))
}

#[tauri::command]
#[specta::specta]
pub fn variant_coverage_apply_position_flags(
    root: VariantCoverageGraphNodeDto,
    positions: HashMap<String, VariantCoveragePositionDto>,
    repertoire_color: VariantCoverageColorDto,
) -> VariantCoverageGraphNodeDto {
    apply_position_flags_to_node(root, &positions, repertoire_color)
}

#[tauri::command]
#[specta::specta]
pub fn variant_coverage_apply_node_visibility_rules(
    root: VariantCoverageGraphNodeDto,
) -> Option<VariantCoverageGraphNodeDto> {
    apply_node_visibility_rules_node(root)
}
