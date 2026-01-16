import { invoke } from "@tauri-apps/api/core";
import type { SiteStatsData } from "@/bindings";

type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };

async function invoke_result<T>(cmd: string, args?: Record<string, unknown>): Promise<Result<T, string>> {
  try {
    const data = await invoke<T>(cmd, args);
    return { status: "ok", data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "error", error: msg };
  }
}

// -----------------------------------------------------------------------------
// Types mirrored from `src-tauri/src/db/player_stats.rs`
// -----------------------------------------------------------------------------

export type DateRange = "SevenDays" | "ThirtyDays" | "NinetyDays" | "OneYear" | "All";
export type PlatformFilter = "All" | "Lichess" | "ChessCom";
export type TimeControlFilter = "Any" | "Bullet" | "Blitz" | "Rapid" | "Classical";

export interface PlayerStatsFilters {
  platform: PlatformFilter;
  time_control: TimeControlFilter;
  opponent_elo_bucket: string | null;
  date_range: DateRange | null;
}

export interface MonthData {
  name: string;
  count: number;
}

export interface EloBucket {
  value: string;
  label: string;
}

export interface GameStats {
  total: number;
  won: number;
  draw: number;
  lost: number;
  data_per_month: MonthData[];
  unknown_count: number;
}

export interface OpeningStats {
  name: string;
  games: number;
  won: number;
  draw: number;
  lost: number;
}

export interface RatingDataPoint {
  date: number;
  chesscom: number | null;
  lichess: number | null;
}

export interface PlatformInfo {
  key: string;
  label: string;
  stroke: string;
}

export interface RatingTimeline {
  data: RatingDataPoint[];
  dates: number[];
  platforms: PlatformInfo[];
}

export interface EloDomain {
  min: number;
  max: number;
}

export interface PlayerStyleLabel {
  label: string;
  description: string;
  color: string;
}

export interface PlayerSidebarEloSummary {
  bullet: string;
  blitz: string;
  rapid: string;
}

export interface PlayerSidebarPlatformSummary {
  all: PlayerSidebarEloSummary;
  lichess: PlayerSidebarEloSummary;
  chesscom: PlayerSidebarEloSummary;
}

export interface PlayerSidebarModel {
  has_data: boolean;
  style: PlayerStyleLabel;
  elo: PlayerSidebarPlatformSummary;
}

// -----------------------------------------------------------------------------
// Commands (snake_case = Rust `#[tauri::command]` function names)
// -----------------------------------------------------------------------------

export const playerStatsCommands = {
  calculatePlayerGameStats(site_stats_data: SiteStatsData[], filters: PlayerStatsFilters) {
    return invoke_result<GameStats>("calculate_player_game_stats", { siteStatsData: site_stats_data, filters });
  },
  calculatePlayerEloBuckets(site_stats_data: SiteStatsData[]) {
    return invoke_result<EloBucket[]>("calculate_player_elo_buckets", { siteStatsData: site_stats_data });
  },
  calculatePlayerSidebarModel(site_stats_data: SiteStatsData[]) {
    return invoke_result<PlayerSidebarModel>("calculate_player_sidebar_model", { siteStatsData: site_stats_data });
  },
  calculatePlayerOpeningsStats(site_stats_data: SiteStatsData[], filters: PlayerStatsFilters, color: boolean) {
    return invoke_result<OpeningStats[]>("calculate_player_openings_stats", {
      siteStatsData: site_stats_data,
      filters,
      color,
    });
  },
  calculatePlayerRatingTimeline(site_stats_data: SiteStatsData[], filters: PlayerStatsFilters) {
    return invoke_result<RatingTimeline>("calculate_player_rating_timeline", { siteStatsData: site_stats_data, filters });
  },
  calculatePlayerEloDomain(rating_timeline: RatingTimeline) {
    return invoke_result<EloDomain | null>("calculate_player_elo_domain", { ratingTimeline: rating_timeline });
  },
  mergePlayerSiteStats(site_stats_data_list: SiteStatsData[]) {
    return invoke_result<SiteStatsData[]>("merge_player_site_stats", { siteStatsDataList: site_stats_data_list });
  },
  fillMissingMonthsData(data: MonthData[]) {
    return invoke_result<MonthData[]>("fill_missing_months_data", { data });
  },
  mergeYearsData(data: MonthData[]) {
    return invoke_result<MonthData[]>("merge_years_data", { data });
  },
  calculateEarliestDateFromRange(date_range: DateRange, rating_dates: number[]) {
    return invoke_result<number | null>("calculate_earliest_date_from_range", { dateRange: date_range, ratingDates: rating_dates });
  },
};


