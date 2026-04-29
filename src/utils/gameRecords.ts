import { commands } from "@/bindings";
import { getGameStats, parsePGN } from "@/utils/chess";
import { getProfileDbPath } from "@/utils/profileDb";

export interface GameRecord {
  id: string;
  profileId?: string;
  white: {
    type: "human" | "engine";
    name?: string;
    engine?: string;
  };
  black: {
    type: "human" | "engine";
    name?: string;
    engine?: string;
  };
  result: string;
  timeControl?: string;
  timestamp: number;
  moves: string[];
  variant?: string;
  fen: string; // Final FEN position
  initialFen?: string; // Initial FEN position (if different from standard)
  pgn?: string; // Full PGN with headers and moves
  stats?: GameStats; // Calculated stats including estimatedElo (saved once during analysis)
}

const ACTIVE_PROFILE_STORAGE_KEY = "activeProfileId";

// In-session idempotency guard. We can still get multiple "game end" triggers from
// different UI paths; this prevents duplicate imports even if the caller misbehaves.
const inFlightSaves = new Map<string, Promise<void>>();
const completedSaveKeys = new Set<string>();

/** Stable key for dedupe: same game = same fen + move count + result. */
export function getGameRecordDedupeKey(r: GameRecord): string {
  return `${r.fen ?? ""}-${r.moves?.length ?? 0}-${r.result ?? ""}`;
}

/**
 * Saves a game to the profile DB (played_games.json is deprecated).
 * Requires an active profile and a PGN string. Dispatches "games:updated" on success.
 */
export async function saveGameRecord(record: GameRecord, dedupeKey?: string): Promise<void> {
  let profileId = record.profileId;
  if (!profileId && typeof window !== "undefined") {
    profileId = localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY) ?? undefined;
  }
  if (!profileId || !record.pgn?.trim()) {
    return;
  }

  const key = `${profileId}:${dedupeKey ?? getGameRecordDedupeKey(record)}`;
  if (completedSaveKeys.has(key)) return;
  const existing = inFlightSaves.get(key);
  if (existing) {
    await existing;
    return;
  }

  const humanName =
    record.white.type === "human"
      ? (record.white.name ?? "Human")
      : record.black.type === "human"
        ? (record.black.name ?? "Human")
        : "Human";

  const p = (async () => {
    const res = await commands.addProfileGamesFromPgn(profileId, humanName, record.pgn!);
    if (res.status === "ok") {
      completedSaveKeys.add(key);
      if (typeof window !== "undefined") {
        try {
          window.dispatchEvent(new Event("games:updated"));
        } catch {
          // ignore
        }
      }
    }
  })().finally(() => {
    inFlightSaves.delete(key);
  });

  inFlightSaves.set(key, p);
  await p;
}

/**
 * Returns recent games from the profile DB (played_games.json is deprecated).
 * When profileId is null, returns an empty array.
 */
export async function getRecentGames(profileId: string | null, limit = 20): Promise<GameRecord[]> {
  if (!profileId) return [];

  try {
    const res = await commands.dashboardGetGamesHistoryRows({
      profileId,
      gameHistoryLimit: limit,
      page: 1,
      pageSize: limit,
      eventFilterId: null,
      selectedOpponentId: null,
      opponentContains: null,
      timeControlCategory: null,
      resultFilter: null,
      playerColor: null,
      minMoves: null,
      sortBy: null,
      sortDirection: null,
      profileUsernames: [],
    });
    if (res.status !== "ok") return [];
    return res.data.rows
      .filter((row) => row.kind === "local")
      .map((row) => gamesHistoryRowToGameRecord(row, profileId));
  } catch {
    return [];
  }
}

function outcomeToResult(outcome: string, userColor: string): string {
  if (outcome === "draw") return "1/2-1/2";
  if (outcome === "unknown") return "*";
  if (outcome === "win") return userColor === "white" ? "1-0" : "0-1";
  if (outcome === "loss") return userColor === "white" ? "0-1" : "1-0";
  return "*";
}

function gamesHistoryRowToGameRecord(
  row: {
    analysisGameId: string;
    gameKey: string;
    opponent: string;
    color: string;
    outcome: string;
    pgn: string | null;
    timeControl: string | null;
    timestampMs: bigint;
    moves: number;
  },
  profileId: string,
): GameRecord {
  const result = outcomeToResult(row.outcome, row.color);
  const isUserWhite = row.color === "white";
  // moves: row.moves is full-move count; use length so filters like moves.length >= 5 work
  const halfMoves = Math.max(0, (row.moves ?? 0) * 2);
  return {
    id: row.analysisGameId,
    profileId,
    white: isUserWhite ? { type: "human", name: "You" } : { type: "engine", name: row.opponent },
    black: isUserWhite ? { type: "engine", name: row.opponent } : { type: "human", name: "You" },
    result,
    timeControl: row.timeControl ?? undefined,
    timestamp: Number(row.timestampMs),
    moves: Array.from({ length: halfMoves }, () => ""),
    fen: "",
    pgn: row.pgn ?? undefined,
  };
}

/** played_games.json is deprecated; no migration needed. */
export async function migrateLegacyGameRecordsProfileId(_profileId: string): Promise<void> {
  // No-op: local games are now in profile DB
}

/**
 * Returns all games from the profile DB (played_games.json is deprecated).
 * When profileId is null, returns an empty array.
 */
export async function getAllGames(profileId: string | null): Promise<GameRecord[]> {
  return getRecentGames(profileId, 5000);
}

/** played_games.json is deprecated; count is from profile DB. When profileId not passed, uses activeProfileId from localStorage. */
export async function countGamesOnDate(date: Date = new Date(), profileId?: string | null): Promise<number> {
  const pid = profileId ?? (typeof window !== "undefined" ? localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY) : null);
  if (!pid) return 0;
  const games = await getRecentGames(pid, 5000);
  const y = date.getFullYear();
  const m = date.getMonth();
  const day = date.getDate();
  return games.filter((r) => {
    const t = new Date(r.timestamp);
    return t.getFullYear() === y && t.getMonth() === m && t.getDate() === day;
  }).length;
}

export async function clearAllGames(): Promise<void> {
  // played_games.json is deprecated; clearing is not supported (profile DB is source of truth)
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new Event("games:updated"));
    } catch {
      // ignore
    }
  }
}

/** played_games.json is deprecated; updates are not supported for profile DB games. */
export async function updateGameRecord(_gameId: string, _updates: Partial<GameRecord>): Promise<void> {
  // No-op: stats are stored in analysis DB; profile DB games are immutable
}

/**
 * Loads a single game by id from profile DB (played_games.json is deprecated).
 * When called with one argument, uses activeProfileId from localStorage.
 * Returns null if not found or when profileId is null.
 */
export async function getGameRecordById(profileIdOrGameId: string | null, gameId?: string): Promise<GameRecord | null> {
  const profileId = gameId !== undefined ? profileIdOrGameId : localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY);
  const id = gameId !== undefined ? gameId : profileIdOrGameId;
  if (!profileId || !id) return null;
  const games = await getRecentGames(profileId, 1000);
  return games.find((r) => r.id === id) ?? null;
}

/**
 * Deletes a game from the profile DB (played_games.json is deprecated).
 * When profileId is null, no-op.
 */
export async function deleteGameRecord(profileId: string | null, gameId: string): Promise<void> {
  if (!profileId) return;
  try {
    const dbPath = await getProfileDbPath(profileId);
    const id = Number.parseInt(gameId, 10);
    if (Number.isNaN(id)) return;
    await commands.deleteDbGame(dbPath, id);
    if (typeof window !== "undefined") {
      try {
        window.dispatchEvent(new Event("games:updated"));
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

export interface GameStats {
  accuracy: number;
  acpl: number; // Average Centipawns Loss
  estimatedElo?: number; // Estimated Elo based on ACPL (calculated once during analysis)
  resistance?: number; // Elo-scale practical resistance faced in this game
  eloEstimatedBalanced?: number; // Estimated Elo adjusted by opposition resistance
  opponentEstimatedElo?: number; // Opponent estimated Elo for backend balanced-Elo calculation input
  opponentRatingElo?: number; // Opponent reference rating Elo for backend balanced-Elo calculation input
}

/**
 * Calculate accuracy and ACPL for a game record from its PGN.
 * Returns null if PGN is not available or doesn't contain evaluations.
 */
export async function calculateGameStats(game: GameRecord): Promise<GameStats | null> {
  if (!game.pgn) {
    return null;
  }

  try {
    // Parse the PGN to get the game tree with evaluations
    const tree = await parsePGN(game.pgn, game.initialFen);

    // Calculate stats using the same function used in the analysis panel
    const stats = getGameStats(tree.root);

    // Determine which color the user played
    const isUserWhite = game.white.type === "human";
    const userColor = isUserWhite ? "white" : "black";

    // Get stats for the user's color
    const accuracy = userColor === "white" ? stats.whiteAccuracy : stats.blackAccuracy;
    const acpl = userColor === "white" ? stats.whiteCPL : stats.blackCPL;

    // Return null if no evaluations were found (accuracy and ACPL would be 0)
    if (accuracy === 0 && acpl === 0) {
      return null;
    }

    return {
      accuracy,
      acpl,
    };
  } catch {
    // If parsing fails, return null
    return null;
  }
}
