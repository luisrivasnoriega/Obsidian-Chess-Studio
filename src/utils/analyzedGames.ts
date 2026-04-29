import { invoke } from "@tauri-apps/api/core";
import { appDataDir, resolve } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import type { GameStats } from "@/utils/gameRecords";

/**
 * Stores analyzed PGNs for Chess.com and Lichess games.
 * Key: game identifier (URL for Chess.com, ID for Lichess)
 * Value: analyzed PGN string
 */
interface AnalyzedGamesMap {
  [gameId: string]: string;
}

const LEGACY_ANALYZED_FILENAME = "analyzed_games.json";
const LEGACY_STATS_FILENAME = "game_stats.json";
const MIGRATION_FLAG = "analysisDb.migratedFromJson.v1";

type AnalyzedGameRow = { game_id: string; analyzed_pgn: string };
type StoredGameStats = {
  accuracy: number;
  acpl: number;
  estimatedElo?: number | null;
  resistance?: number | null;
  eloEstimatedBalanced?: number | null;
  opponentEstimatedElo?: number | null;
  opponentRatingElo?: number | null;
};
type StoredGameStatsRowBulk = {
  gameId: string;
  accuracy: number;
  acpl: number;
  estimatedElo?: number | null;
  resistance?: number | null;
  eloEstimatedBalanced?: number | null;
  opponentEstimatedElo?: number | null;
  opponentRatingElo?: number | null;
};

let migrationAttempted = false;

const DB_LOCKED_RE = /database is locked/i;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function invokeWithRetry<T>(
  command: string,
  payload: Record<string, unknown>,
  maxRetries = 5,
  baseDelayMs = 80,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await invoke<T>(command, payload);
    } catch (error) {
      lastError = error;
      const message = String(error);
      const shouldRetry = DB_LOCKED_RE.test(message) && attempt < maxRetries;
      if (!shouldRetry) break;
      await sleep(baseDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

function getActiveProfileIdFromStorage(): string | null {
  try {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("activeProfileId");
  } catch {
    return null;
  }
}

/**
 * `analysis.db3` is shared across profiles. If the caller does not explicitly provide a `profileId`
 * (i.e. it's `undefined`), we default to the current active profile id (if available).
 *
 * Passing `null` explicitly means "no profile" (legacy / global scope).
 */
function resolveProfileId(profileId?: string | null): string | null {
  if (profileId === undefined) return getActiveProfileIdFromStorage();
  return profileId;
}

async function migrateLegacyJsonToSqlite(): Promise<void> {
  if (migrationAttempted) return;
  migrationAttempted = true;

  try {
    if (typeof window !== "undefined" && localStorage.getItem(MIGRATION_FLAG) === "1") {
      return;
    }
  } catch {
    // ignore
  }

  try {
    const dir = await appDataDir();
    const analyzedFile = await resolve(dir, LEGACY_ANALYZED_FILENAME);
    const statsFile = await resolve(dir, LEGACY_STATS_FILENAME);

    if (await exists(analyzedFile)) {
      try {
        const text = await readTextFile(analyzedFile);
        const analyzedGames = JSON.parse(text) as Record<string, string>;
        for (const [gameId, analyzedPgn] of Object.entries(analyzedGames)) {
          if (!gameId || !analyzedPgn) continue;
          await invoke("analysis_db_set_analyzed_game", { gameId, analyzedPgn });
        }
      } catch {
        // ignore legacy parse errors
      }
    }

    if (await exists(statsFile)) {
      try {
        const text = await readTextFile(statsFile);
        const stats = JSON.parse(text) as Record<string, GameStats>;
        for (const [gameId, gameStats] of Object.entries(stats)) {
          if (!gameId || !gameStats) continue;
          if (typeof gameStats.accuracy !== "number" || typeof gameStats.acpl !== "number") continue;
          await invoke("analysis_db_set_game_stats", {
            gameId,
            stats: {
              accuracy: gameStats.accuracy,
              acpl: gameStats.acpl,
              estimatedElo: gameStats.estimatedElo ?? null,
              resistance: gameStats.resistance ?? null,
              eloEstimatedBalanced: gameStats.eloEstimatedBalanced ?? null,
              opponentEstimatedElo: gameStats.opponentEstimatedElo ?? null,
              opponentRatingElo: gameStats.opponentRatingElo ?? null,
            },
          });
        }
      } catch {
        // ignore legacy parse errors
      }
    }

    try {
      if (typeof window !== "undefined") localStorage.setItem(MIGRATION_FLAG, "1");
    } catch {
      // ignore
    }
  } catch {
    // ignore migration errors (best-effort)
  }
}

/**
 * Save an analyzed PGN for a game
 * @param gameId - Unique identifier (URL for Chess.com, ID for Lichess)
 * @param analyzedPgn - The analyzed PGN string
 */
export async function saveAnalyzedGame(gameId: string, analyzedPgn: string, profileId?: string | null): Promise<void> {
  await migrateLegacyJsonToSqlite();
  const pid = resolveProfileId(profileId);
  await invokeWithRetry("analysis_db_set_analyzed_game", { gameId, analyzedPgn, profileId: pid ?? null });
}

// Profile-aware helpers (analysis.db3 is shared across profiles)
export async function saveProfileAnalyzedGame(
  profileId: string,
  gameId: number | string,
  analyzedPgn: string,
): Promise<void> {
  return saveAnalyzedGame(String(gameId), analyzedPgn, profileId);
}

/**
 * Get an analyzed PGN for a game
 * @param gameId - Unique identifier (URL for Chess.com, ID for Lichess)
 * @returns The analyzed PGN string if found, null otherwise
 */
export async function getAnalyzedGame(gameId: string, profileId?: string | null): Promise<string | null> {
  await migrateLegacyJsonToSqlite();
  const pid = resolveProfileId(profileId);
  return (await invoke<string | null>("analysis_db_get_analyzed_game", { gameId, profileId: pid ?? null })) ?? null;
}

export async function getProfileAnalyzedGame(profileId: string, gameId: number | string): Promise<string | null> {
  return getAnalyzedGame(String(gameId), profileId);
}

/**
 * Get all analyzed games
 * @returns Map of game IDs to analyzed PGNs
 */
export async function getAllAnalyzedGames(profileId?: string | null): Promise<AnalyzedGamesMap> {
  await migrateLegacyJsonToSqlite();
  const pid = resolveProfileId(profileId);
  const rows =
    (await invoke<AnalyzedGameRow[]>("analysis_db_get_all_analyzed_games", { profileId: pid ?? null })) ?? [];
  return rows.reduce<AnalyzedGamesMap>((acc, row) => {
    if (row?.game_id && row?.analyzed_pgn) acc[row.game_id] = row.analyzed_pgn;
    return acc;
  }, {});
}

/**
 * Remove an analyzed game
 * @param gameId - Unique identifier (URL for Chess.com, ID for Lichess)
 */
export async function removeAnalyzedGame(gameId: string, profileId?: string | null): Promise<void> {
  await migrateLegacyJsonToSqlite();
  const pid = resolveProfileId(profileId);
  await invokeWithRetry("analysis_db_delete_entries", { gameIds: [gameId], profileId: pid ?? null });
}

/**
 * Remove all analyzed games for a specific account
 * @param username - Username of the account
 * @param type - Type of account ("lichess" or "chesscom")
 */
export async function removeAnalyzedGamesForAccount(
  username: string,
  type: "lichess" | "chesscom",
  profileId?: string | null,
): Promise<void> {
  await migrateLegacyJsonToSqlite();
  const analyzedGames = await getAllAnalyzedGames(profileId);

  const idsToDelete: string[] = [];
  for (const [gameId, pgn] of Object.entries(analyzedGames)) {
    let belongsToAccount = false;

    if (type === "lichess") {
      // For Lichess, gameId is the game ID, check if PGN contains the username
      // Lichess PGNs typically have White/Black headers with usernames
      const whiteMatch = pgn.match(/\[White\s+"([^"]+)"/);
      const blackMatch = pgn.match(/\[Black\s+"([^"]+)"/);
      const whiteName = whiteMatch ? whiteMatch[1] : "";
      const blackName = blackMatch ? blackMatch[1] : "";

      // Check if username matches either white or black player
      belongsToAccount =
        whiteName.toLowerCase() === username.toLowerCase() || blackName.toLowerCase() === username.toLowerCase();
    } else if (type === "chesscom") {
      // For Chess.com, gameId is the URL, check if URL contains the username
      // Chess.com URLs are like: https://www.chess.com/game/live/123456
      // We need to check the PGN headers for the username
      const whiteMatch = pgn.match(/\[White\s+"([^"]+)"/);
      const blackMatch = pgn.match(/\[Black\s+"([^"]+)"/);
      const whiteName = whiteMatch ? whiteMatch[1] : "";
      const blackName = blackMatch ? blackMatch[1] : "";

      // Check if username matches either white or black player
      belongsToAccount =
        whiteName.toLowerCase() === username.toLowerCase() || blackName.toLowerCase() === username.toLowerCase();
    }

    if (belongsToAccount) idsToDelete.push(gameId);
  }

  if (idsToDelete.length > 0) {
    const pid = resolveProfileId(profileId);
    await invokeWithRetry("analysis_db_delete_entries", { gameIds: idsToDelete, profileId: pid ?? null });
  }
}

/**
 * Remove ALL analyzed games (clear all analysis)
 */
export async function clearAllAnalyzedGames(): Promise<void> {
  await migrateLegacyJsonToSqlite();
  await invokeWithRetry("analysis_db_clear_analyzed_pgns", {});
}

/**
 * Stores game stats (accuracy, ACPL, estimatedElo) for Chess.com and Lichess games.
 * Key: game identifier (URL for Chess.com, ID for Lichess)
 * Value: GameStats object
 */
/**
 * Save game stats for a game
 * @param gameId - Unique identifier (URL for Chess.com, ID for Lichess)
 * @param stats - The game stats including estimatedElo
 */
export async function saveGameStats(gameId: string, stats: GameStats, profileId?: string | null): Promise<void> {
  await migrateLegacyJsonToSqlite();
  const pid = resolveProfileId(profileId);
  await invokeWithRetry("analysis_db_set_game_stats", {
    gameId,
    stats: {
      accuracy: stats.accuracy,
      acpl: stats.acpl,
      estimatedElo: stats.estimatedElo ?? null,
      resistance: stats.resistance ?? null,
      eloEstimatedBalanced: stats.eloEstimatedBalanced ?? null,
      opponentEstimatedElo: stats.opponentEstimatedElo ?? null,
      opponentRatingElo: stats.opponentRatingElo ?? null,
    },
    profileId: pid ?? null,
  });
}

export async function saveProfileGameStats(
  profileId: string,
  gameId: number | string,
  stats: GameStats,
): Promise<void> {
  return saveGameStats(String(gameId), stats, profileId);
}

/**
 * Get game stats for a game
 * @param gameId - Unique identifier (URL for Chess.com, ID for Lichess)
 * @returns The game stats if found, null otherwise
 */
export async function getGameStats(gameId: string, profileId?: string | null): Promise<GameStats | null> {
  await migrateLegacyJsonToSqlite();
  const pid = resolveProfileId(profileId);
  const stats =
    (await invoke<StoredGameStats | null>("analysis_db_get_game_stats", { gameId, profileId: pid ?? null })) ?? null;
  if (!stats) return null;
  return {
    accuracy: stats.accuracy,
    acpl: stats.acpl,
    ...(stats.estimatedElo != null ? { estimatedElo: stats.estimatedElo } : {}),
    ...(stats.resistance != null ? { resistance: stats.resistance } : {}),
    ...(stats.eloEstimatedBalanced != null ? { eloEstimatedBalanced: stats.eloEstimatedBalanced } : {}),
  };
}

export async function getGameStatsBulk(gameIds: string[], profileId?: string | null): Promise<Map<string, GameStats>> {
  await migrateLegacyJsonToSqlite();
  if (!gameIds.length) return new Map();
  const pid = resolveProfileId(profileId);
  const rows =
    (await invoke<StoredGameStatsRowBulk[]>("analysis_db_get_game_stats_bulk", { gameIds, profileId: pid ?? null })) ??
    [];
  const out = new Map<string, GameStats>();
  for (const row of rows) {
    if (!row?.gameId) continue;
    out.set(row.gameId, {
      accuracy: row.accuracy,
      acpl: row.acpl,
      ...(row.estimatedElo != null ? { estimatedElo: row.estimatedElo } : {}),
      ...(row.resistance != null ? { resistance: row.resistance } : {}),
      ...(row.eloEstimatedBalanced != null ? { eloEstimatedBalanced: row.eloEstimatedBalanced } : {}),
    });
  }
  return out;
}

export async function getAnalyzedGamesBulk(gameIds: string[], profileId?: string | null): Promise<Map<string, string>> {
  await migrateLegacyJsonToSqlite();
  if (!gameIds.length) return new Map();
  const pid = resolveProfileId(profileId);
  const rows =
    (await invoke<AnalyzedGameRow[]>("analysis_db_get_analyzed_games_bulk", { gameIds, profileId: pid ?? null })) ?? [];
  const out = new Map<string, string>();
  for (const row of rows) {
    if (!row?.game_id || !row?.analyzed_pgn) continue;
    out.set(row.game_id, row.analyzed_pgn);
  }
  return out;
}
