import { invoke } from "@tauri-apps/api/core";
import type { LichessGameSpeed, LichessRating } from "@/utils/lichess/explorer";

const COVERAGE_TIER_RULE_VERSION = 3;
const COVERAGE_LOW_SAMPLE_MIN_GAMES = 5000;

export type CoverageExplorerCacheMove = {
  san: string;
  games: number;
};

export type CoverageExplorerCacheEntry = {
  source_signature: string;
  fen: string;
  total_games: number;
  moves: CoverageExplorerCacheMove[];
  fetched_at_ms: number;
  expires_at_ms: number;
};

type CoverageSourceConfig =
  | {
      dbType: "local";
      localDatabasePath: string | null;
    }
  | {
      dbType: "lch_all";
      lichessSpeeds: LichessGameSpeed[];
      lichessRatings: LichessRating[];
      lichessSince: Date | null;
      lichessUntil: Date | null;
      lichessPlayer: string;
      lichessColor: "white" | "black";
    }
  | {
      dbType: "lch_master";
      masterSince: Date | null;
      masterUntil: Date | null;
    };

function formatMonthTag(date: Date | null): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function buildCoverageSourceSignature(config: CoverageSourceConfig): string {
  if (config.dbType === "local") {
    return JSON.stringify({
      coverageTierRuleVersion: COVERAGE_TIER_RULE_VERSION,
      lowSampleMinGames: COVERAGE_LOW_SAMPLE_MIN_GAMES,
      dbType: "local",
      localDatabasePath: config.localDatabasePath ?? null,
    });
  }

  if (config.dbType === "lch_master") {
    return JSON.stringify({
      coverageTierRuleVersion: COVERAGE_TIER_RULE_VERSION,
      lowSampleMinGames: COVERAGE_LOW_SAMPLE_MIN_GAMES,
      dbType: "lch_master",
      masterSince: formatMonthTag(config.masterSince),
      masterUntil: formatMonthTag(config.masterUntil),
    });
  }

  return JSON.stringify({
    coverageTierRuleVersion: COVERAGE_TIER_RULE_VERSION,
    lowSampleMinGames: COVERAGE_LOW_SAMPLE_MIN_GAMES,
    dbType: "lch_all",
    lichessSpeeds: [...config.lichessSpeeds].sort(),
    lichessRatings: [...config.lichessRatings].sort((a, b) => a - b),
    lichessSince: formatMonthTag(config.lichessSince),
    lichessUntil: formatMonthTag(config.lichessUntil),
    lichessPlayer: config.lichessPlayer.trim().toLowerCase(),
    lichessColor: config.lichessColor,
  });
}

export async function getCoverageExplorerCache(
  sourceSignature: string,
  fen: string,
): Promise<CoverageExplorerCacheEntry | null> {
  const result = await invoke<CoverageExplorerCacheEntry | null>("coverage_cache_get", {
    sourceSignature,
    fen,
  });
  return result ?? null;
}

export async function setCoverageExplorerCache(
  sourceSignature: string,
  fen: string,
  moves: CoverageExplorerCacheMove[],
): Promise<void> {
  await invoke("coverage_cache_set", {
    sourceSignature,
    fen,
    moves,
  });
}
