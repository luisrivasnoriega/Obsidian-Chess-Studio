//! Player statistics calculation module.
//!
//! This module provides functions for calculating various player statistics
//! including game stats, ratings, openings, and ELO buckets.

use crate::db::{GameOutcome, SiteStatsData, StatsData};
use chrono::{NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};

// ============================================================================
// Types for statistics
// ============================================================================

#[derive(Debug, Clone, Serialize, Type)]
pub struct GameStats {
    pub total: usize,
    pub won: usize,
    pub draw: usize,
    pub lost: usize,
    pub data_per_month: Vec<MonthData>,
    pub unknown_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MonthData {
    pub name: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct EloBucket {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub enum DateRange {
    SevenDays,
    ThirtyDays,
    NinetyDays,
    OneYear,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub enum PlatformFilter {
    All,
    Lichess,
    ChessCom,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub enum TimeControlFilter {
    Any,
    Bullet,
    Blitz,
    Rapid,
    Classical,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PlayerStatsFilters {
    pub platform: PlatformFilter,
    pub time_control: TimeControlFilter,
    pub opponent_elo_bucket: Option<String>, // "all" or "1200" (start of range)
    pub date_range: Option<DateRange>,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct OpeningStats {
    pub name: String,
    pub games: usize,
    pub won: usize,
    pub draw: usize,
    pub lost: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RatingDataPoint {
    pub date: i64, // timestamp in milliseconds
    pub chesscom: Option<i32>,
    pub lichess: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RatingTimeline {
    pub data: Vec<RatingDataPoint>,
    pub dates: Vec<i64>,
    pub platforms: Vec<PlatformInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PlatformInfo {
    pub key: String,
    pub label: String,
    pub stroke: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct EloDomain {
    pub min: i32,
    pub max: i32,
}

// ============================================================================
// Player sidebar model (used by frontend PlayerSidebarCard)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PlayerStyleLabel {
    pub label: String,
    pub description: String,
    pub color: String,
}

impl Default for PlayerStyleLabel {
    fn default() -> Self {
        Self {
            label: "playerStyle.mixedStyle".to_string(),
            description: "playerStyle.mixedStyleDescription".to_string(),
            color: "gray".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct PlayerSidebarEloRow {
    pub label: String,
    pub bullet: String,
    pub blitz: String,
    pub rapid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct PlayerSidebarEloBlock {
    /// Display label (e.g. "Lichess", "Chess.com")
    pub platform: String,
    /// One row per platform (when multiple platforms exist) OR one row per account (when a single platform has multiple accounts).
    pub rows: Vec<PlayerSidebarEloRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct PlayerSidebarModel {
    pub has_data: bool,
    pub style: PlayerStyleLabel,
    pub elo: Vec<PlayerSidebarEloBlock>,
}

// ============================================================================
// ELO processing functions
// ============================================================================

/// Extract ELO values from various formats (number, string with ranges, etc.)
#[allow(dead_code)]
pub fn extract_opponent_elo_values(value: Option<i32>) -> Vec<f64> {
    match value {
        Some(elo) => vec![elo as f64],
        None => vec![],
    }
}

/// Parse opponent ELO range from value
#[allow(dead_code)]
pub fn parse_opponent_elo_range(value: Option<i32>) -> Option<(f64, f64)> {
    match value {
        Some(elo) => Some((elo as f64, elo as f64)),
        None => None,
    }
}

/// Calculate ELO buckets from game data
pub fn calculate_elo_buckets(site_stats_data: &[SiteStatsData]) -> Vec<EloBucket> {
    let mut buckets: HashSet<i32> = HashSet::new();

    for site in site_stats_data {
        for game in &site.data {
            if let Some(elo) = game.opponent_elo {
                let bucket_start = (elo / 200) * 200;
                buckets.insert(bucket_start);
            }
        }
    }

    let mut sorted: Vec<i32> = buckets.into_iter().collect();
    sorted.sort_unstable();

    sorted
        .into_iter()
        .map(|start| EloBucket {
            value: start.to_string(),
            label: format!("{}-{}", start, start + 199),
        })
        .collect()
}

// ============================================================================
// Date processing functions
// ============================================================================

const MILLISECONDS_PER_DAY: i64 = 24 * 60 * 60 * 1000;

/// Calculate earliest date based on date range
///
/// IMPORTANT: `rating_dates` must be sorted ascending.
/// Callers should sort before passing in.
pub fn calculate_earliest_date(date_range: DateRange, rating_dates: &[i64]) -> Option<i64> {
    if rating_dates.is_empty() {
        return None;
    }

    let last_date = *rating_dates.last()?;

    let days = match date_range {
        DateRange::SevenDays => 7,
        DateRange::ThirtyDays => 30,
        DateRange::NinetyDays => 90,
        DateRange::OneYear => 365,
        DateRange::All => return Some(*rating_dates.first()?),
    };

    Some(last_date - (days * MILLISECONDS_PER_DAY))
}

/// Parse month key from date string
///
/// Optimized: NO regex, NO allocations. Accepts:
/// - "YYYY-MM"
/// - "YYYY-MM-DD"
/// - "YYYY MM"
/// - "YYYY.MM.DD"
/// - "YYYY/MM/DD"
/// - "YYYY-1", "YYYY-01", etc.
fn parse_month_key(value: &str) -> Option<(i32, i32)> {
    let s = value.trim();
    if s.len() < 6 {
        return None;
    }

    let b = s.as_bytes();

    // Year: first 4 digits
    if b.len() < 4
        || !b[0].is_ascii_digit()
        || !b[1].is_ascii_digit()
        || !b[2].is_ascii_digit()
        || !b[3].is_ascii_digit()
    {
        return None;
    }

    let year = ((b[0] - b'0') as i32) * 1000
        + ((b[1] - b'0') as i32) * 100
        + ((b[2] - b'0') as i32) * 10
        + ((b[3] - b'0') as i32);

    // Skip separators after year ( '-', ' ', '.', '/', etc ) until we hit a digit
    let mut i = 4usize;
    while i < b.len() && !b[i].is_ascii_digit() {
        i += 1;
    }
    if i >= b.len() {
        return None;
    }

    // Month: 1-2 digits
    let mut month: i32 = 0;
    let mut digits = 0usize;
    while i < b.len() && b[i].is_ascii_digit() && digits < 2 {
        month = month * 10 + (b[i] - b'0') as i32;
        i += 1;
        digits += 1;
    }

    if digits == 0 || !(1..=12).contains(&month) {
        return None;
    }

    Some((year, month))
}

/// Get month key from date string
fn get_month_key(date: &str) -> Option<String> {
    let (year, month) = parse_month_key(date)?;
    Some(format!("{:04}-{:02}", year, month))
}

/// Fill missing months in data
///
/// If the input month strings are not parseable, we return the sorted input as-is
/// (no panics, no signature change).
pub fn fill_missing_months(data: &[MonthData]) -> Vec<MonthData> {
    if data.is_empty() {
        return vec![];
    }

    let mut month_data: Vec<MonthData> = data.to_vec();
    month_data.sort_by(|a, b| a.name.cmp(&b.name));

    let Some(start) = parse_month_key(&month_data[0].name) else {
        return month_data;
    };
    let Some(end) = parse_month_key(&month_data[month_data.len() - 1].name) else {
        return month_data;
    };

    let mut month_strings = Vec::new();
    let mut year = start.0;
    let mut month = start.1;

    while year < end.0 || (year == end.0 && month <= end.1) {
        month_strings.push(format!("{:04}-{:02}", year, month));
        month += 1;
        if month == 13 {
            month = 1;
            year += 1;
        }
    }

    let data_map: HashMap<String, usize> = month_data
        .iter()
        .map(|item| (item.name.clone(), item.count))
        .collect();

    month_strings
        .into_iter()
        .map(|m| MonthData {
            name: m.clone(),
            count: data_map.get(&m).copied().unwrap_or(0),
        })
        .collect()
}

/// Merge years in data
pub fn merge_years(data: &[MonthData]) -> Vec<MonthData> {
    let mut year_counts: HashMap<String, usize> = HashMap::new();

    for item in data {
        if item.name.len() >= 4 {
            let year = &item.name[..4];
            *year_counts.entry(year.to_string()).or_insert(0) += item.count;
        }
    }

    let mut result: Vec<MonthData> = year_counts
        .into_iter()
        .map(|(year, count)| MonthData { name: year, count })
        .collect();

    result.sort_by(|a, b| a.name.cmp(&b.name));
    result
}

// ============================================================================
// Game statistics functions
// ============================================================================

/// Extract game statistics from filtered games
pub fn extract_game_stats(games: &[StatsData]) -> GameStats {
    let total = games.len();

    let won = games
        .iter()
        .filter(|d| matches!(d.result, GameOutcome::Won))
        .count();
    let draw = games
        .iter()
        .filter(|d| matches!(d.result, GameOutcome::Drawn))
        .count();
    let lost = games
        .iter()
        .filter(|d| matches!(d.result, GameOutcome::Lost))
        .count();

    let mut month_counts: HashMap<String, usize> = HashMap::new();
    let mut unknown_count = 0;

    // Hot path: month parsing. Now optimized (no regex / no alloc per parse attempt).
    for game in games {
        if let Some(month_key) = get_month_key(&game.date) {
            *month_counts.entry(month_key).or_insert(0) += 1;
        } else {
            unknown_count += 1;
        }
    }

    let data_per_month: Vec<MonthData> = month_counts
        .into_iter()
        .map(|(month, count)| MonthData { name: month, count })
        .collect();

    GameStats {
        total,
        won,
        draw,
        lost,
        data_per_month,
        unknown_count,
    }
}

// ============================================================================
// Opening statistics functions
// ============================================================================

/// Aggregate openings statistics
pub fn aggregate_openings(data: &[StatsData], color: bool /* true white, false black */) -> Vec<OpeningStats> {
    let mut opening_map: HashMap<String, (usize, usize, usize)> = HashMap::new();

    for game in data.iter().filter(|d| d.is_player_white == color) {
        let entry = opening_map
            .entry(game.opening.clone())
            .or_insert((0, 0, 0));
        match game.result {
            GameOutcome::Won => entry.0 += 1,
            GameOutcome::Drawn => entry.1 += 1,
            GameOutcome::Lost => entry.2 += 1,
        }
    }

    opening_map
        .into_iter()
        .map(|(name, (won, draw, lost))| OpeningStats {
            name,
            games: won + draw + lost,
            won,
            draw,
            lost,
        })
        .collect()
}

/// Calculate score rate for an opening
#[allow(dead_code)]
pub fn get_score_rate(opening: &OpeningStats) -> f64 {
    if opening.games == 0 {
        return 0.0;
    }
    (opening.won as f64 + opening.draw as f64 * 0.5) / opening.games as f64
}

/// Sort openings by criteria
#[allow(dead_code)]
pub fn sort_openings(openings: &mut [OpeningStats], sort_by: &str) {
    match sort_by {
        "score_asc" => openings.sort_by(|a, b| {
            get_score_rate(a)
                .partial_cmp(&get_score_rate(b))
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        "score_desc" => openings.sort_by(|a, b| {
            get_score_rate(b)
                .partial_cmp(&get_score_rate(a))
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        _ => openings.sort_by(|a, b| b.games.cmp(&a.games)),
    }
}

// ============================================================================
// Rating timeline functions
// ============================================================================

/// Normalize platform name
fn normalize_platform(site: &str) -> String {
    let lower = site.to_lowercase();
    if lower.contains("lichess") {
        "lichess".to_string()
    } else if lower.contains("chess.com") || lower.contains("chesscom") {
        "chesscom".to_string()
    } else {
        "unknown".to_string()
    }
}

/// Parse date string to timestamp
///
/// Optimized fast-path:
/// - "YYYY-MM-DD"
/// - "YYYY.MM.DD"
/// - "YYYY/MM/DD"
/// - "YYYY MM DD" (si viene con espacios)
fn parse_date_to_timestamp(date: &str) -> Option<i64> {
    let s = date.trim();
    if s.len() < 10 {
        return None;
    }

    let b = s.as_bytes();

    // Parse year digits [0..4]
    if b.len() < 10
        || !b[0].is_ascii_digit()
        || !b[1].is_ascii_digit()
        || !b[2].is_ascii_digit()
        || !b[3].is_ascii_digit()
    {
        return None;
    }

    let year: i32 = ((b[0] - b'0') as i32) * 1000
        + ((b[1] - b'0') as i32) * 100
        + ((b[2] - b'0') as i32) * 10
        + ((b[3] - b'0') as i32);

    // Find month start: skip non-digits after year
    let mut i = 4usize;
    while i < b.len() && !b[i].is_ascii_digit() {
        i += 1;
    }
    if i + 1 >= b.len() {
        return None;
    }

    // Month: 1-2 digits
    let mut month: u32 = 0;
    let mut md = 0usize;
    while i < b.len() && b[i].is_ascii_digit() && md < 2 {
        month = month * 10 + (b[i] - b'0') as u32;
        i += 1;
        md += 1;
    }
    if md == 0 || month < 1 || month > 12 {
        return None;
    }

    // Find day start: skip non-digits after month
    while i < b.len() && !b[i].is_ascii_digit() {
        i += 1;
    }
    if i + 1 >= b.len() {
        return None;
    }

    // Day: 1-2 digits
    let mut day: u32 = 0;
    let mut dd = 0usize;
    while i < b.len() && b[i].is_ascii_digit() && dd < 2 {
        day = day * 10 + (b[i] - b'0') as u32;
        i += 1;
        dd += 1;
    }
    if dd == 0 || day < 1 || day > 31 {
        return None;
    }

    let parsed = NaiveDate::from_ymd_opt(year, month, day)?;
    Some(
        parsed
            .and_hms_opt(0, 0, 0)?
            .and_utc()
            .timestamp_millis(),
    )
}

fn parse_date_time_to_timestamp(date: &str, time: Option<&str>) -> Option<i64> {
    let day = parse_date_to_timestamp(date)?;
    let t = time.unwrap_or("").trim();
    if t.is_empty() {
        return Some(day);
    }

    let nt = NaiveTime::parse_from_str(t, "%H:%M:%S")
        .or_else(|_| NaiveTime::parse_from_str(t, "%H:%M"))
        .ok()?;

    let date_only = NaiveDateTime::from_timestamp_millis(day)?;
    let day_only = date_only.date();
    let dt = NaiveDateTime::new(day_only, nt);
    Some(Utc.from_utc_datetime(&dt).timestamp_millis())
}

/// Calculate rating timeline from games
///
/// NOTE: this function groups ratings under a single platform key based on the `site` argument.
/// If you intend to build a multi-platform timeline from mixed-site data, you likely want to
/// call this per platform or change the logic to detect platform per game.
pub fn calculate_rating_timeline(games: &[StatsData], site: &str) -> RatingTimeline {
    let normalized = normalize_platform(site);
    let platform_key: &'static str = if normalized == "chesscom" {
        "chesscom"
    } else if normalized == "lichess" {
        "lichess"
    } else {
        "unknown"
    };

    let mut per_platform: HashMap<String, HashMap<i64, i32>> = HashMap::new();

    for game in games {
        if let Some(date) = parse_date_to_timestamp(&game.date) {
            let platform_map = per_platform
                .entry(platform_key.to_string())
                .or_insert_with(HashMap::new);

            // Keep the max rating seen for that date.
            let existing = platform_map.get(&date).copied().unwrap_or(i32::MIN);
            if game.player_elo > existing {
                platform_map.insert(date, game.player_elo);
            }
        }
    }

    // Collect all unique dates
    let mut all_dates: HashSet<i64> = HashSet::new();
    for map in per_platform.values() {
        all_dates.extend(map.keys().copied());
    }
    let mut all_dates: Vec<i64> = all_dates.into_iter().collect();
    all_dates.sort_unstable();

    // Build data points
    let data: Vec<RatingDataPoint> = all_dates
        .iter()
        .map(|&date| {
            let mut entry = RatingDataPoint {
                date,
                chesscom: None,
                lichess: None,
            };

            for (key, map) in &per_platform {
                if let Some(&rating) = map.get(&date) {
                    match key.as_str() {
                        "chesscom" => entry.chesscom = Some(rating),
                        "lichess" => entry.lichess = Some(rating),
                        _ => {}
                    }
                }
            }

            entry
        })
        .collect();

    // Build platform info (stable ordering)
    let mut platform_keys: Vec<String> = per_platform.keys().cloned().collect();
    platform_keys.sort();

    let platforms: Vec<PlatformInfo> = platform_keys
        .into_iter()
        .map(|key| PlatformInfo {
            label: if key == "chesscom" {
                "Chess.com".to_string()
            } else if key == "lichess" {
                "Lichess".to_string()
            } else {
                "Unknown".to_string()
            },
            stroke: if key == "chesscom" {
                "var(--mantine-color-blue-filled)".to_string()
            } else if key == "lichess" {
                "var(--mantine-color-red-filled)".to_string()
            } else {
                "var(--mantine-color-gray-5)".to_string()
            },
            key,
        })
        .collect();

    RatingTimeline {
        data,
        dates: all_dates,
        platforms,
    }
}

/// Calculate ELO domain (min/max) for rating chart
pub fn calculate_elo_domain(rating_series: &RatingTimeline) -> Option<EloDomain> {
    if rating_series.data.is_empty() {
        return None;
    }

    let mut min = i32::MAX;
    let mut max = i32::MIN;

    for entry in &rating_series.data {
        if let Some(chesscom) = entry.chesscom {
            min = min.min(chesscom);
            max = max.max(chesscom);
        }
        if let Some(lichess) = entry.lichess {
            min = min.min(lichess);
            max = max.max(lichess);
        }
    }

    if min == i32::MAX || max == i32::MIN {
        return None;
    }

    Some(EloDomain {
        min: (min / 50) * 50,
        max: ((max + 49) / 50) * 50,
    })
}

// ============================================================================
// Filtering functions
// ============================================================================

/// Get time control from site and time control string
fn get_time_control(site: &str, time_control: &str) -> TimeControlFilter {
    // Ported from `src/utils/timeControl.ts`
    let website = if normalize_platform(site) == "chesscom" {
        "Chess.com"
    } else if normalize_platform(site) == "lichess" {
        "Lichess"
    } else {
        "Unknown"
    };

    let tc = time_control.trim().to_lowercase();

    // Chess.com daily like "1/86400"
    if website == "Chess.com" && tc.starts_with("1/") {
        return TimeControlFilter::Classical;
    }

    // Lichess correspondence uses "-"
    if website == "Lichess" && tc == "-" {
        return TimeControlFilter::Classical;
    }

    // Handle string-based time control names (for test data and some edge cases)
    if tc.contains("ultra") || tc.contains("ultra_bullet") {
        return TimeControlFilter::Bullet; // ultra-bullet is grouped into Bullet
    }
    if tc.contains("bullet") {
        return TimeControlFilter::Bullet;
    }
    if tc.contains("blitz") {
        return TimeControlFilter::Blitz;
    }
    if tc.contains("rapid") {
        return TimeControlFilter::Rapid;
    }
    if tc.contains("classical") || tc.contains("correspondence") || tc.contains("daily") {
        return TimeControlFilter::Classical;
    }

    // Try to parse as numeric time control (e.g., "180+0", "300+3")
    let mut parts = tc.split('+');
    let initial: f64 = parts.next().and_then(|s| s.trim().parse::<f64>().ok()).unwrap_or(0.0);
    let increment: f64 = parts.next().and_then(|s| s.trim().parse::<f64>().ok()).unwrap_or(0.0);
    if initial <= 0.0 && increment <= 0.0 {
        return TimeControlFilter::Any;
    }
    let total = initial + increment * 40.0;

    if website == "Chess.com" {
        if total < 180.0 {
            return TimeControlFilter::Bullet;
        }
        if total <= 500.0 {
            return TimeControlFilter::Blitz;
        }
        return TimeControlFilter::Rapid;
    }

    // Lichess time controls (ultra-bullet is grouped into Bullet for our UI).
    if total < 30.0 {
        return TimeControlFilter::Bullet;
    }
    if total < 180.0 {
        return TimeControlFilter::Bullet;
    }
    if total < 480.0 {
        return TimeControlFilter::Blitz;
    }
    if total < 1500.0 {
        return TimeControlFilter::Rapid;
    }
    TimeControlFilter::Classical
}

fn format_elo(value: i32) -> String {
    if value > 0 {
        value.to_string()
    } else {
        "-".to_string()
    }
}

/// Filter games based on criteria
pub fn filter_games(site_stats_data: &[SiteStatsData], filters: &PlayerStatsFilters) -> Vec<(StatsData, String)> {
    // Flatten all games with their site (owned return type)
    // Minor: avoid allocating Vecs inside flat_map.
    let mut games: Vec<(StatsData, String)> = Vec::new();
    for site_data in site_stats_data {
        // if you want: games.reserve(site_data.data.len());
        for game in &site_data.data {
            games.push((game.clone(), site_data.site.clone()));
        }
    }

    // Filter by platform
    match filters.platform {
        PlatformFilter::Lichess => games.retain(|(_, site)| normalize_platform(site) == "lichess"),
        PlatformFilter::ChessCom => games.retain(|(_, site)| normalize_platform(site) == "chesscom"),
        PlatformFilter::All => {}
    }

    // Filter by time control
    if !matches!(filters.time_control, TimeControlFilter::Any) {
        games.retain(|(game, site)| get_time_control(site, &game.time_control) == filters.time_control);
    }

    // Filter by opponent ELO bucket
    if let Some(bucket) = &filters.opponent_elo_bucket {
        if bucket != "all" {
            if let Ok(start) = bucket.parse::<i32>() {
                let end = start + 199;
                games.retain(|(game, _)| match game.opponent_elo {
                    Some(elo) => elo >= start && elo <= end,
                    None => false,
                });
            }
        }
    }

    // Filter by date range
    if let Some(date_range) = &filters.date_range {
        // OPTIMIZED: no sort, no building a full vec, no double parse.
        // We only need the max date as anchor.
        let mut max_date: Option<i64> = None;
        for (game, _) in &games {
            if let Some(ts) = parse_date_to_timestamp(&game.date) {
                max_date = Some(max_date.map_or(ts, |m| m.max(ts)));
            }
        }

        if let Some(last_date) = max_date {
            let earliest_date = match date_range {
                DateRange::All => i64::MIN,
                DateRange::SevenDays => last_date - 7 * MILLISECONDS_PER_DAY,
                DateRange::ThirtyDays => last_date - 30 * MILLISECONDS_PER_DAY,
                DateRange::NinetyDays => last_date - 90 * MILLISECONDS_PER_DAY,
                DateRange::OneYear => last_date - 365 * MILLISECONDS_PER_DAY,
            };

            games.retain(|(game, _)| {
                parse_date_to_timestamp(&game.date)
                    .map(|game_date| game_date >= earliest_date)
                    .unwrap_or(false)
            });
        }
    }

    games
}

// ============================================================================
// Merge functions
// ============================================================================

/// Merge site stats data from multiple sources
pub fn merge_site_stats_data(site_stats_data_list: &[SiteStatsData]) -> Vec<SiteStatsData> {
    let mut by_key: HashMap<String, SiteStatsData> = HashMap::new();

    for entry in site_stats_data_list {
        let key = format!("{}:{}", entry.site, entry.player);
        if let Some(existing) = by_key.get_mut(&key) {
            existing.data.extend(entry.data.clone());
        } else {
            by_key.insert(key, entry.clone());
        }
    }

    by_key.into_values().collect()
}

// ============================================================================
// Sidebar style computations are implemented in `player_style.rs` for strict
// parity with the previous frontend implementation.
// ============================================================================

pub fn compute_player_sidebar_model(site_stats_data: &[SiteStatsData]) -> PlayerSidebarModel {
    let has_data = site_stats_data.iter().any(|s| !s.data.is_empty());
    let style = super::player_style::analyze_player_style_label(site_stats_data);

    // ELO blocks:
    // - If the player has BOTH platforms, show one row per platform.
    // - If the player has only ONE platform and multiple accounts, show one row per account.
    // Keep latest rating (by game date) for bullet/blitz/rapid:
    // value = ([elos], [timestamps_ms]) indexed as [bullet, blitz, rapid].
    let mut by_platform_account: HashMap<(String, String), ([i32; 3], [i64; 3])> = HashMap::new();
    for site in site_stats_data {
        let platform = normalize_platform(&site.site);
        if platform == "unknown" {
            continue;
        }
        let account = site.player.trim().to_string();
        let account = if account.is_empty() { "(account)".to_string() } else { account };

        for game in &site.data {
            let tc = get_time_control(&site.site, &game.time_control);
            let idx = match tc {
                TimeControlFilter::Bullet => Some(0),
                TimeControlFilter::Blitz => Some(1),
                TimeControlFilter::Rapid => Some(2),
                _ => None,
            };
            let Some(i) = idx else { continue };
            let elo = game.player_elo;
            let ts = parse_date_time_to_timestamp(&game.date, game.time.as_deref())
                .or_else(|| parse_date_to_timestamp(&game.date));
            let Some(ts) = ts else { continue };
            let entry = by_platform_account
                .entry((platform.clone(), account.clone()))
                .or_insert(([0i32; 3], [i64::MIN; 3]));
            if ts >= entry.1[i] {
                entry.0[i] = elo;
                entry.1[i] = ts;
            }
        }
    }

    let mut platforms: HashSet<String> = HashSet::new();
    for ((platform, _account), (elos, _timestamps)) in &by_platform_account {
        if elos.iter().any(|v| *v > 0) {
            platforms.insert(platform.clone());
        }
    }

    fn platform_label(platform: &str) -> String {
        match platform {
            "lichess" => "Lichess".to_string(),
            "chesscom" => "Chess.com".to_string(),
            _ => platform.to_string(),
        }
    }

    let mut elo_blocks: Vec<PlayerSidebarEloBlock> = Vec::new();
    if platforms.len() >= 2 {
        let mut list: Vec<String> = platforms.into_iter().collect();
        list.sort();
        for platform in list {
            let mut agg_elos = [0i32; 3];
            let mut agg_timestamps = [i64::MIN; 3];
            for ((p, _account), (elos, timestamps)) in &by_platform_account {
                if p != &platform {
                    continue;
                }
                for i in 0..3 {
                    if timestamps[i] >= agg_timestamps[i] {
                        agg_timestamps[i] = timestamps[i];
                        agg_elos[i] = elos[i];
                    }
                }
            }
            let label = platform_label(&platform);
            elo_blocks.push(PlayerSidebarEloBlock {
                platform: label.clone(),
                rows: vec![PlayerSidebarEloRow {
                    label,
                    bullet: format_elo(agg_elos[0]),
                    blitz: format_elo(agg_elos[1]),
                    rapid: format_elo(agg_elos[2]),
                }],
            });
        }
    } else if platforms.len() == 1 {
        let platform = platforms.into_iter().next().unwrap();
        let mut accounts: Vec<(String, [i32; 3], [i64; 3])> = by_platform_account
            .iter()
            .filter_map(|((p, a), (elos, timestamps))| {
                if p == &platform {
                    Some((a.clone(), *elos, *timestamps))
                } else {
                    None
                }
            })
            .collect();
        accounts.sort_by(|a, b| a.0.cmp(&b.0));

        let label = platform_label(&platform);
        if accounts.len() <= 1 {
            let latest_elos = accounts.first().map(|a| a.1).unwrap_or([0i32; 3]);
            elo_blocks.push(PlayerSidebarEloBlock {
                platform: label.clone(),
                rows: vec![PlayerSidebarEloRow {
                    label,
                    bullet: format_elo(latest_elos[0]),
                    blitz: format_elo(latest_elos[1]),
                    rapid: format_elo(latest_elos[2]),
                }],
            });
        } else {
            elo_blocks.push(PlayerSidebarEloBlock {
                platform: label,
                rows: accounts
                    .into_iter()
                    .map(|(account, latest_elos, _timestamps)| PlayerSidebarEloRow {
                        label: account,
                        bullet: format_elo(latest_elos[0]),
                        blitz: format_elo(latest_elos[1]),
                        rapid: format_elo(latest_elos[2]),
                    })
                    .collect(),
            });
        }
    }

    PlayerSidebarModel {
        has_data,
        style,
        elo: elo_blocks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{GameOutcome, SiteStatsData, StatsData};
    use std::collections::HashMap;

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    fn game(
        date: &str,
        result: GameOutcome,
        is_player_white: bool,
        opening: &str,
        time_control: &str,
        player_elo: i32,
        opponent_elo: Option<i32>,
    ) -> StatsData {
        StatsData {
            date: date.to_string(),
            result,
            is_player_white,
            opening: opening.to_string(),
            time_control: time_control.to_string(),
            player_elo,
            opponent_elo,
            ..Default::default()
        }
    }

    fn site(site: &str, player: &str, data: Vec<StatsData>) -> SiteStatsData {
        SiteStatsData {
            site: site.to_string(),
            player: player.to_string(),
            data,
            ..Default::default()
        }
    }

    // -------------------------------------------------------------------------
    // ELO processing
    // -------------------------------------------------------------------------

    #[test]
    fn test_extract_opponent_elo_values_some_and_none() {
        assert_eq!(extract_opponent_elo_values(Some(1500)), vec![1500.0]);
        assert_eq!(extract_opponent_elo_values(None), Vec::<f64>::new());
    }

    #[test]
    fn test_parse_opponent_elo_range_some_and_none() {
        assert_eq!(parse_opponent_elo_range(Some(1800)), Some((1800.0, 1800.0)));
        assert_eq!(parse_opponent_elo_range(None), None);
    }

    #[test]
    fn test_calculate_elo_buckets_groups_by_200() {
        let data = vec![
            site(
                "Lichess",
                "Luis",
                vec![
                    game("2024-01-01", GameOutcome::Won, true, "A", "blitz", 1500, Some(1199)),
                    game("2024-01-02", GameOutcome::Won, true, "A", "blitz", 1500, Some(1200)),
                    game("2024-01-03", GameOutcome::Won, true, "A", "blitz", 1500, Some(1399)),
                    game("2024-01-04", GameOutcome::Won, true, "A", "blitz", 1500, Some(1400)),
                ],
            ),
            site(
                "Chess.com",
                "Luis",
                vec![game(
                    "2024-01-05",
                    GameOutcome::Won,
                    true,
                    "A",
                    "blitz",
                    1500,
                    Some(1601),
                )],
            ),
        ];

        let buckets = calculate_elo_buckets(&data);
        let labels: Vec<String> = buckets.into_iter().map(|b| b.label).collect();

        assert_eq!(
            labels,
            vec![
                "1000-1199".to_string(),
                "1200-1399".to_string(),
                "1400-1599".to_string(),
                "1600-1799".to_string(),
            ]
        );
    }

    // -------------------------------------------------------------------------
    // Date processing
    // -------------------------------------------------------------------------

    #[test]
    fn test_calculate_earliest_date_empty_dates_none() {
        assert_eq!(calculate_earliest_date(DateRange::SevenDays, &[]), None);
    }

    #[test]
    fn test_calculate_earliest_date_all_returns_first() {
        let dates = vec![10, 20, 30];
        assert_eq!(calculate_earliest_date(DateRange::All, &dates), Some(10));
    }

    #[test]
    fn test_calculate_earliest_date_ranges() {
        let last = 10_000_000i64;
        let dates = vec![1, last]; // assumed sorted

        assert_eq!(
            calculate_earliest_date(DateRange::SevenDays, &dates),
            Some(last - 7 * MILLISECONDS_PER_DAY)
        );
        assert_eq!(
            calculate_earliest_date(DateRange::ThirtyDays, &dates),
            Some(last - 30 * MILLISECONDS_PER_DAY)
        );
        assert_eq!(
            calculate_earliest_date(DateRange::NinetyDays, &dates),
            Some(last - 90 * MILLISECONDS_PER_DAY)
        );
        assert_eq!(
            calculate_earliest_date(DateRange::OneYear, &dates),
            Some(last - 365 * MILLISECONDS_PER_DAY)
        );
    }

    #[test]
    fn test_fill_missing_months_fills_gaps_and_keeps_counts() {
        let input = vec![
            MonthData {
                name: "2024-01".to_string(),
                count: 2,
            },
            MonthData {
                name: "2024-03".to_string(),
                count: 5,
            },
        ];

        let out = fill_missing_months(&input);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].name, "2024-01");
        assert_eq!(out[0].count, 2);
        assert_eq!(out[1].name, "2024-02");
        assert_eq!(out[1].count, 0);
        assert_eq!(out[2].name, "2024-03");
        assert_eq!(out[2].count, 5);
    }

    #[test]
    fn test_fill_missing_months_invalid_input_returns_sorted_original() {
        let input = vec![
            MonthData {
                name: "nope".to_string(),
                count: 1,
            },
            MonthData {
                name: "also-nope".to_string(),
                count: 2,
            },
        ];

        let out = fill_missing_months(&input);
        assert_eq!(out.len(), 2);
        assert!(out[0].name <= out[1].name);
        assert_eq!(out.iter().map(|m| m.count).sum::<usize>(), 3);
    }

    #[test]
    fn test_merge_years_sums_by_year() {
        let input = vec![
            MonthData {
                name: "2023-01".to_string(),
                count: 2,
            },
            MonthData {
                name: "2023-12".to_string(),
                count: 3,
            },
            MonthData {
                name: "2024-01".to_string(),
                count: 5,
            },
        ];

        let out = merge_years(&input);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "2023");
        assert_eq!(out[0].count, 5);
        assert_eq!(out[1].name, "2024");
        assert_eq!(out[1].count, 5);
    }

    // -------------------------------------------------------------------------
    // Game stats
    // -------------------------------------------------------------------------

    #[test]
    fn test_extract_game_stats_counts_and_unknown_dates() {
        let games = vec![
            game("2024-01-01", GameOutcome::Won, true, "Ruy", "blitz", 1500, Some(1500)),
            game("2024-01-12", GameOutcome::Drawn, true, "Ruy", "blitz", 1500, Some(1500)),
            game("2024-02-01", GameOutcome::Lost, true, "Ruy", "blitz", 1500, Some(1500)),
            game("unknown-date", GameOutcome::Lost, true, "Ruy", "blitz", 1500, Some(1500)),
        ];

        let stats = extract_game_stats(&games);
        assert_eq!(stats.total, 4);
        assert_eq!(stats.won, 1);
        assert_eq!(stats.draw, 1);
        assert_eq!(stats.lost, 2);
        assert_eq!(stats.unknown_count, 1);

        let mut keys: Vec<String> = stats.data_per_month.iter().map(|m| m.name.clone()).collect();
        keys.sort();
        assert_eq!(keys, vec!["2024-01".to_string(), "2024-02".to_string()]);
    }

    // -------------------------------------------------------------------------
    // Openings
    // -------------------------------------------------------------------------

    #[test]
    fn test_aggregate_openings_by_color() {
        let data = vec![
            game("2024-01-01", GameOutcome::Won, true, "Ruy", "blitz", 1500, Some(1400)),
            game("2024-01-02", GameOutcome::Lost, true, "Ruy", "blitz", 1500, Some(1400)),
            game("2024-01-03", GameOutcome::Drawn, true, "Italian", "blitz", 1500, Some(1400)),
            game("2024-01-04", GameOutcome::Won, false, "Sicilian", "blitz", 1500, Some(1400)),
        ];

        let white = aggregate_openings(&data, true);
        let mut map: HashMap<String, OpeningStats> = white.into_iter().map(|o| (o.name.clone(), o)).collect();

        let ruy = map.remove("Ruy").unwrap();
        assert_eq!(ruy.games, 2);
        assert_eq!(ruy.won, 1);
        assert_eq!(ruy.draw, 0);
        assert_eq!(ruy.lost, 1);

        let italian = map.remove("Italian").unwrap();
        assert_eq!(italian.games, 1);
        assert_eq!(italian.draw, 1);

        let black = aggregate_openings(&data, false);
        assert_eq!(black.len(), 1);
        assert_eq!(black[0].name, "Sicilian");
    }

    #[test]
    fn test_get_score_rate() {
        let o = OpeningStats {
            name: "X".to_string(),
            games: 4,
            won: 2,
            draw: 1,
            lost: 1,
        };
        assert!((get_score_rate(&o) - 0.625).abs() < 1e-9);

        let z = OpeningStats {
            name: "Z".to_string(),
            games: 0,
            won: 0,
            draw: 0,
            lost: 0,
        };
        assert_eq!(get_score_rate(&z), 0.0);
    }

    #[test]
    fn test_sort_openings_default_by_games_desc() {
        let mut v = vec![
            OpeningStats { name: "A".into(), games: 2, won: 2, draw: 0, lost: 0 },
            OpeningStats { name: "B".into(), games: 5, won: 0, draw: 5, lost: 0 },
            OpeningStats { name: "C".into(), games: 1, won: 1, draw: 0, lost: 0 },
        ];
        sort_openings(&mut v, "anything");
        assert_eq!(v[0].name, "B");
        assert_eq!(v[1].name, "A");
        assert_eq!(v[2].name, "C");
    }

    #[test]
    fn test_sort_openings_by_score_desc() {
        let mut v = vec![
            OpeningStats { name: "A".into(), games: 2, won: 0, draw: 2, lost: 0 }, // 0.5
            OpeningStats { name: "B".into(), games: 3, won: 3, draw: 0, lost: 0 }, // 1.0
            OpeningStats { name: "C".into(), games: 4, won: 0, draw: 0, lost: 4 }, // 0.0
        ];
        sort_openings(&mut v, "score_desc");
        assert_eq!(v[0].name, "B");
        assert_eq!(v[2].name, "C");
    }

    // -------------------------------------------------------------------------
    // Rating timeline + domain
    // -------------------------------------------------------------------------

    #[test]
    fn test_calculate_rating_timeline_keeps_max_rating_per_day() {
        let games = vec![
            game("2024-01-01", GameOutcome::Won, true, "X", "blitz", 1500, Some(1400)),
            game("2024-01-01", GameOutcome::Won, true, "X", "blitz", 1550, Some(1400)),
            game("2024-01-02", GameOutcome::Won, true, "X", "blitz", 1520, Some(1400)),
        ];

        let tl = calculate_rating_timeline(&games, "lichess.org");
        assert_eq!(tl.data.len(), 2);
        assert_eq!(tl.platforms.len(), 1);
        assert_eq!(tl.platforms[0].key, "lichess");

        let d1 = tl.data.iter().find(|p| p.lichess == Some(1550)).cloned();
        assert!(d1.is_some());
    }

    #[test]
    fn test_calculate_elo_domain_rounds_to_50() {
        let series = RatingTimeline {
            data: vec![
                RatingDataPoint { date: 1, chesscom: Some(1201), lichess: None },
                RatingDataPoint { date: 2, chesscom: Some(1279), lichess: Some(1302) },
            ],
            dates: vec![1, 2],
            platforms: vec![],
        };

        let domain = calculate_elo_domain(&series).unwrap();
        assert_eq!(domain.min, 1200);
        assert_eq!(domain.max, 1350);
    }

    // -------------------------------------------------------------------------
    // Filtering
    // -------------------------------------------------------------------------

    #[test]
    fn test_filter_games_platform() {
        let lichess_games = vec![game("2024-01-01", GameOutcome::Won, true, "A", "blitz", 1500, Some(1400))];
        let chesscom_games = vec![game("2024-01-02", GameOutcome::Won, true, "A", "blitz", 1500, Some(1400))];

        let site_stats = vec![
            site("Lichess.org", "Luis", lichess_games),
            site("Chess.com", "Luis", chesscom_games),
        ];

        let filters = PlayerStatsFilters {
            platform: PlatformFilter::Lichess,
            time_control: TimeControlFilter::Any,
            opponent_elo_bucket: None,
            date_range: None,
        };

        let out = filter_games(&site_stats, &filters);
        assert_eq!(out.len(), 1);
        assert_eq!(normalize_platform(&out[0].1), "lichess");
    }

    #[test]
    fn test_filter_games_time_control() {
        let site_stats = vec![site(
            "Lichess",
            "Luis",
            vec![
                game("2024-01-01", GameOutcome::Won, true, "A", "bullet", 1500, Some(1400)),
                game("2024-01-02", GameOutcome::Won, true, "A", "blitz", 1500, Some(1400)),
                game("2024-01-03", GameOutcome::Won, true, "A", "rapid", 1500, Some(1400)),
            ],
        )];

        let filters = PlayerStatsFilters {
            platform: PlatformFilter::All,
            time_control: TimeControlFilter::Blitz,
            opponent_elo_bucket: None,
            date_range: None,
        };

        let out = filter_games(&site_stats, &filters);
        assert_eq!(out.len(), 1);
        assert!(out[0].0.time_control.to_lowercase().contains("blitz"));
    }

    #[test]
    fn test_filter_games_opponent_elo_bucket() {
        let site_stats = vec![site(
            "Lichess",
            "Luis",
            vec![
                game("2024-01-01", GameOutcome::Won, true, "A", "blitz", 1500, Some(1199)),
                game("2024-01-02", GameOutcome::Won, true, "A", "blitz", 1500, Some(1200)),
                game("2024-01-03", GameOutcome::Won, true, "A", "blitz", 1500, Some(1399)),
                game("2024-01-04", GameOutcome::Won, true, "A", "blitz", 1500, Some(1400)),
            ],
        )];

        let filters = PlayerStatsFilters {
            platform: PlatformFilter::All,
            time_control: TimeControlFilter::Any,
            opponent_elo_bucket: Some("1200".to_string()),
            date_range: None,
        };

        let out = filter_games(&site_stats, &filters);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|(g, _)| {
            let elo = g.opponent_elo.unwrap();
            elo >= 1200 && elo <= 1399
        }));
    }

    #[test]
    fn test_filter_games_date_range_uses_last_game_date_anchor() {
        let site_stats = vec![site(
            "Lichess",
            "Luis",
            vec![
                game("2024-01-01", GameOutcome::Won, true, "A", "blitz", 1500, Some(1400)),
                game("2024-01-20", GameOutcome::Won, true, "A", "blitz", 1500, Some(1400)),
            ],
        )];

        let filters = PlayerStatsFilters {
            platform: PlatformFilter::All,
            time_control: TimeControlFilter::Any,
            opponent_elo_bucket: None,
            date_range: Some(DateRange::SevenDays),
        };

        let out = filter_games(&site_stats, &filters);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0.date, "2024-01-20");
    }

    // -------------------------------------------------------------------------
    // Merge site stats
    // -------------------------------------------------------------------------

    #[test]
    fn test_merge_site_stats_data_merges_same_site_and_player() {
        let a1 = site(
            "Lichess",
            "Luis",
            vec![game("2024-01-01", GameOutcome::Won, true, "A", "blitz", 1500, Some(1400))],
        );
        let a2 = site(
            "Lichess",
            "Luis",
            vec![game("2024-01-02", GameOutcome::Lost, true, "A", "blitz", 1500, Some(1400))],
        );
        let b = site(
            "Chess.com",
            "Luis",
            vec![game("2024-01-03", GameOutcome::Drawn, true, "A", "blitz", 1500, Some(1400))],
        );

        let merged = merge_site_stats_data(&[a1, a2, b]);
        assert_eq!(merged.len(), 2);

        let lichess = merged
            .iter()
            .find(|s| normalize_platform(&s.site) == "lichess")
            .unwrap();
        assert_eq!(lichess.data.len(), 2);
    }
}
