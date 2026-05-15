import { invoke } from "@tauri-apps/api/core";
import type { LichessGameSpeed, LichessRating } from "@/utils/lichess/explorer";

export type CoverageExplorerCacheMove = {
  san: string;
  games: number;
  white?: number;
  black?: number;
  draw?: number;
};

export type CoverageExplorerCacheEntry = {
  source_signature: string;
  config_json?: string | null;
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

export async function buildCoverageSourceSignature(config: CoverageSourceConfig): Promise<string> {
  if (config.dbType === "local") {
    return await invoke<string>("variant_coverage_build_source_signature", {
      config: {
        dbType: "local",
        localDatabasePath: config.localDatabasePath ?? null,
        lichessSpeeds: [],
        lichessRatings: [],
        lichessSince: null,
        lichessUntil: null,
        lichessPlayer: "",
        lichessColor: "white",
        masterSince: null,
        masterUntil: null,
        includeChildren: false,
      },
    });
  }

  if (config.dbType === "lch_master") {
    return await invoke<string>("variant_coverage_build_source_signature", {
      config: {
        dbType: "lch_master",
        localDatabasePath: null,
        lichessSpeeds: [],
        lichessRatings: [],
        lichessSince: null,
        lichessUntil: null,
        lichessPlayer: "",
        lichessColor: "white",
        masterSince: formatMonthTag(config.masterSince),
        masterUntil: formatMonthTag(config.masterUntil),
        includeChildren: false,
      },
    });
  }

  return await invoke<string>("variant_coverage_build_source_signature", {
    config: {
      dbType: "lch_all",
      localDatabasePath: null,
      lichessSpeeds: config.lichessSpeeds,
      lichessRatings: config.lichessRatings,
      lichessSince: formatMonthTag(config.lichessSince),
      lichessUntil: formatMonthTag(config.lichessUntil),
      lichessPlayer: config.lichessPlayer,
      lichessColor: config.lichessColor,
      masterSince: null,
      masterUntil: null,
      includeChildren: false,
    },
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
  configJson?: string | null,
): Promise<void> {
  await invoke("coverage_cache_set", {
    sourceSignature,
    fen,
    moves,
    configJson: configJson ?? null,
  });
}
