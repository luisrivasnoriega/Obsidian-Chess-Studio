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
type StoredGameStats = { accuracy: number; acpl: number; estimatedElo?: number | null };
type StoredGameStatsRowBulk = { gameId: string; accuracy: number; acpl: number; estimatedElo?: number | null };

let migrationAttempted = false;

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
export async function saveAnalyzedGame(gameId: string, analyzedPgn: string): Promise<void> {
  await migrateLegacyJsonToSqlite();
  await invoke("analysis_db_set_analyzed_game", { gameId, analyzedPgn });
}

/**
 * Get an analyzed PGN for a game
 * @param gameId - Unique identifier (URL for Chess.com, ID for Lichess)
 * @returns The analyzed PGN string if found, null otherwise
 */
export async function getAnalyzedGame(gameId: string): Promise<string | null> {
  await migrateLegacyJsonToSqlite();
  return (await invoke<string | null>("analysis_db_get_analyzed_game", { gameId })) ?? null;
}

/**
 * Get all analyzed games
 * @returns Map of game IDs to analyzed PGNs
 */
export async function getAllAnalyzedGames(): Promise<AnalyzedGamesMap> {
  await migrateLegacyJsonToSqlite();
  const rows = (await invoke<AnalyzedGameRow[]>("analysis_db_get_all_analyzed_games")) ?? [];
  return rows.reduce<AnalyzedGamesMap>((acc, row) => {
    if (row?.game_id && row?.analyzed_pgn) acc[row.game_id] = row.analyzed_pgn;
    return acc;
  }, {});
}

/**
 * Remove an analyzed game
 * @param gameId - Unique identifier (URL for Chess.com, ID for Lichess)
 */
export async function removeAnalyzedGame(gameId: string): Promise<void> {
  await migrateLegacyJsonToSqlite();
  await invoke("analysis_db_delete_entries", { gameIds: [gameId] });
}

/**
 * Remove all analyzed games for a specific account
 * @param username - Username of the account
 * @param type - Type of account ("lichess" or "chesscom")
 */
export async function removeAnalyzedGamesForAccount(username: string, type: "lichess" | "chesscom"): Promise<void> {
  await migrateLegacyJsonToSqlite();
  const analyzedGames = await getAllAnalyzedGames();

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
    await invoke("analysis_db_delete_entries", { gameIds: idsToDelete });
  }
}

/**
 * Remove ALL analyzed games (clear all analysis)
 */
export async function clearAllAnalyzedGames(): Promise<void> {
  await migrateLegacyJsonToSqlite();
  await invoke("analysis_db_clear_analyzed_pgns");
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
export async function saveGameStats(gameId: string, stats: GameStats): Promise<void> {
  await migrateLegacyJsonToSqlite();
  await invoke("analysis_db_set_game_stats", {
    gameId,
    stats: {
      accuracy: stats.accuracy,
      acpl: stats.acpl,
      estimatedElo: stats.estimatedElo ?? null,
    },
  });
}

/**
 * Get game stats for a game
 * @param gameId - Unique identifier (URL for Chess.com, ID for Lichess)
 * @returns The game stats if found, null otherwise
 */
export async function getGameStats(gameId: string): Promise<GameStats | null> {
  await migrateLegacyJsonToSqlite();
  const stats = (await invoke<StoredGameStats | null>("analysis_db_get_game_stats", { gameId })) ?? null;
  if (!stats) return null;
  return {
    accuracy: stats.accuracy,
    acpl: stats.acpl,
    ...(stats.estimatedElo != null ? { estimatedElo: stats.estimatedElo } : {}),
  };
}

export async function getGameStatsBulk(gameIds: string[]): Promise<Map<string, GameStats>> {
  await migrateLegacyJsonToSqlite();
  if (!gameIds.length) return new Map();
  const rows = (await invoke<StoredGameStatsRowBulk[]>("analysis_db_get_game_stats_bulk", { gameIds })) ?? [];
  const out = new Map<string, GameStats>();
  for (const row of rows) {
    if (!row?.gameId) continue;
    out.set(row.gameId, {
      accuracy: row.accuracy,
      acpl: row.acpl,
      ...(row.estimatedElo != null ? { estimatedElo: row.estimatedElo } : {}),
    });
  }
  return out;
}

export async function getAnalyzedGamesBulk(gameIds: string[]): Promise<Map<string, string>> {
  await migrateLegacyJsonToSqlite();
  if (!gameIds.length) return new Map();
  const rows = (await invoke<AnalyzedGameRow[]>("analysis_db_get_analyzed_games_bulk", { gameIds })) ?? [];
  const out = new Map<string, string>();
  for (const row of rows) {
    if (!row?.game_id || !row?.analyzed_pgn) continue;
    out.set(row.game_id, row.analyzed_pgn);
  }
  return out;
}
