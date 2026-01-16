// Utility functions for converting between frontend and backend types for player statistics

import type {
  DateRange as BackendDateRange,
  PlatformFilter as BackendPlatformFilter,
  TimeControlFilter as BackendTimeControlFilter,
  PlayerStatsFilters,
} from "@/bindings/playerStats";
import type { SiteStatsData } from "@/bindings";
import type { DateRange } from "@/features/profiles/components/PersonalCardPanels/DateRangeTabs";
import type {
  PlatformFilter,
  TimeControlFilter,
} from "@/features/profiles/components/PersonalCardPanels/PlayerSidebarCard";

/**
 * Convert frontend DateRange to backend DateRange
 */
export function convertDateRangeToBackend(
  dateRange: DateRange | null,
): BackendDateRange | null {
  if (!dateRange) return null;

  switch (dateRange) {
    case "7d":
      return "SevenDays";
    case "30d":
      return "ThirtyDays";
    case "90d":
      return "NinetyDays";
    case "1y":
      return "OneYear";
    case "all":
      return "All";
    default:
      return null;
  }
}

/**
 * Convert frontend PlatformFilter to backend PlatformFilter
 */
export function convertPlatformFilterToBackend(
  platform: PlatformFilter,
): BackendPlatformFilter {
  switch (platform) {
    case "all":
      return "All";
    case "Chess.com":
      return "ChessCom";
    case "Lichess":
      return "Lichess";
    default:
      return "All";
  }
}

/**
 * Convert frontend TimeControlFilter to backend TimeControlFilter
 */
export function convertTimeControlFilterToBackend(
  timeControl: TimeControlFilter,
): BackendTimeControlFilter {
  switch (timeControl) {
    case "any":
      return "Any";
    case "bullet":
    case "ultra_bullet":
      return "Bullet";
    case "blitz":
      return "Blitz";
    case "rapid":
      return "Rapid";
    case "classical":
    case "correspondence":
      return "Classical";
    default:
      return "Any";
  }
}

/**
 * Create PlayerStatsFilters from frontend filter values
 */
export function createPlayerStatsFilters(
  platform: PlatformFilter,
  timeControl: TimeControlFilter,
  opponentEloBucket: string,
  dateRange: DateRange | null,
): PlayerStatsFilters {
  return {
    platform: convertPlatformFilterToBackend(platform),
    time_control: convertTimeControlFilterToBackend(timeControl),
    opponent_elo_bucket: opponentEloBucket === "all" ? null : opponentEloBucket,
    date_range: convertDateRangeToBackend(dateRange),
  };
}

/**
 * Create a stable, order-independent signature for `site_stats_data`.
 *
 * IMPORTANT:
 * - Do NOT put the full nested `site_stats_data` into react-query keys (too expensive).
 * - Do NOT rely on "first/last site" ordering, since merge order can vary.
 */
export function createSiteStatsSignature(siteStatsData: SiteStatsData[] | null | undefined): {
  key: string;
  games: number;
} {
  const ssd = siteStatsData ?? [];
  if (ssd.length === 0) return { key: "0|0|", games: 0 };

  const games = ssd.reduce((acc, s) => acc + (s.data?.length ?? 0), 0);
  const parts = ssd
    .map((s) => `${s.site ?? ""}:${s.player ?? ""}:${s.data?.length ?? 0}`)
    .sort();

  return { key: `${ssd.length}|${games}|${parts.join(",")}`, games };
}

