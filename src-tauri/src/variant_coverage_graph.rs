use serde::{Deserialize, Serialize};
use shakmaty::{
    fen::Fen, san::SanPlus, CastlingMode, Chess, EnPassantMode, Position,
};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

use crate::coverage_explorer_cache::{coverage_cache_get, CoverageCacheMoveDto};
use crate::db::{
    search_position, GameQueryJs, GameSort, PositionQueryJs, QueryOptions, SortDirection,
};
use crate::error::{Error, Result};
use crate::AppState;

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
    pub graph_root: VariantCoverageGraphNodeDto,
    pub repertoire_color: VariantCoverageColorDto,
    pub generated_at: String,
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
    matches!(value, 0 | 1000 | 1200 | 1400 | 1600 | 1800 | 2000 | 2200 | 2500)
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
        Error::InvalidInput(format!("Failed to serialize coverage source signature: {err}"))
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

fn graph_cache_path_for_variant(variant_path: &str, source_signature: &str) -> Result<PathBuf> {
    let variant = Path::new(variant_path);
    let parent = variant.parent().ok_or_else(|| {
        Error::InvalidInput("variant_coverage_graph_cache_path: variant path has no parent".to_string())
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
    Ok(cache_dir.join(format!("{}-{signature_hash}.json", sanitize_file_stem(stem))))
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

fn get_next_fen_from_san(fen: &str, san: &str) -> Option<String> {
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
                "ultra_bullet" | "bullet" | "blitz" | "rapid" | "classical" | "correspondence" | "daily"
            )
        })
        .collect();
    values.sort();
    values.dedup();
    values
}

async fn fetch_profile_position_stats(
    app: AppHandle,
    state: State<'_, AppState>,
    db_path: &str,
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
            let query = GameQueryJs {
                options: Some(QueryOptions {
                    skip_count: true,
                    page: None,
                    page_size: None,
                    sort: GameSort::AverageElo,
                    direction: SortDirection::Desc,
                }),
                game_details_limit: Some(0),
                player1: matches!(repertoire_color, VariantCoverageColorDto::White).then_some(*player_id),
                player2: matches!(repertoire_color, VariantCoverageColorDto::Black).then_some(*player_id),
                position: Some(PositionQueryJs {
                    fen: fen.to_string(),
                    type_: "exact".to_string(),
                }),
                wanted_result: None,
                time_control_category: time_control_category.as_ref().cloned(),
                ..GameQueryJs::default()
            };

            let (stats, _) = search_position(
                PathBuf::from(db_path),
                query,
                app.clone(),
                "variants-coverage-profile".to_string(),
                state.clone(),
            )
            .await?;

            for row in stats {
                let san = row.move_.trim().to_string();
                if san.is_empty() {
                    continue;
                }
                let entry = merged_moves
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

fn active_side_win_rate(move_entry: &VariantCoverageMoveDto, repertoire_color: VariantCoverageColorDto) -> Option<f64> {
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

fn active_side_loss_rate(move_entry: &VariantCoverageMoveDto, repertoire_color: VariantCoverageColorDto) -> Option<f64> {
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

    if node.tier == VariantCoverageTierDto::Root && node.override_key.is_none() {
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
) -> VariantCoverageGraphNodeDto {
    node.children = node
        .children
        .into_iter()
        .map(|child| apply_profile_flags_to_node(child, positions))
        .collect();

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
    let raw = serde_json::to_string_pretty(&cache)
        .map_err(|err| Error::InvalidInput(format!("Failed to serialize coverage graph cache: {err}")))?;
    std::fs::write(path, raw)?;
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
    let has_result_breakdown = cache_entry.moves.iter().any(|row| {
        row.white.max(0) + row.black.max(0) + row.draw.max(0) > 0
    });
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

    fetch_profile_position_stats(
        app,
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
    let Some(db_path) = db_path.filter(|value| !value.trim().is_empty()) else {
        return Ok(apply_profile_flags_to_node(root, &HashMap::new()));
    };
    let mut unique_player_ids = player_ids;
    unique_player_ids.sort_unstable();
    unique_player_ids.dedup();
    if unique_player_ids.is_empty() {
        return Ok(apply_profile_flags_to_node(root, &HashMap::new()));
    }

    let categories = normalized_profile_time_control_categories(time_control_categories);
    let mut fen_keys = Vec::new();
    collect_override_fen_keys(&root, &mut fen_keys);
    fen_keys.sort();
    fen_keys.dedup();

    let mut profile_positions = HashMap::new();
    for fen_key in fen_keys {
        let Some(source_entry) = positions.get(&fen_key) else {
            continue;
        };
        let profile_entry = fetch_profile_position_stats(
            app.clone(),
            state.clone(),
            &db_path,
            &source_entry.fen,
            &unique_player_ids,
            repertoire_color,
            &categories,
        )
        .await?;
        profile_positions.insert(fen_key, profile_entry);
    }

    Ok(apply_profile_flags_to_node(root, &profile_positions))
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
