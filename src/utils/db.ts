import { useQuery } from "@tanstack/react-query";
import { appDataDir, resolve } from "@tauri-apps/api/path";
import { BaseDirectory, readDir } from "@tauri-apps/plugin-fs";
import { parsePgn, startingPosition } from "chessops/pgn";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { positionFromFen } from "@/utils/chessops";
import {
  commands,
  type DatabaseInfo,
  type GameQuery,
  type NormalizedGame,
  type Player,
  type PlayerQuery,
  type PuzzleDatabaseInfo,
  type QueryResponse,
} from "@/bindings";
import type { LocalOptions } from "@/components/panels/database/DatabasePanel";
import { unwrap } from "./unwrap";

export type { DatabaseInfo } from "@/bindings";

export type SuccessDatabaseInfo = Extract<DatabaseInfo, { type: "success" }>;

export type Sides = "WhiteBlack" | "BlackWhite" | "Any";

export type DownloadableDatabase = {
  title: string;
  game_count: number;
  player_count: number;
  storage_size: bigint;
  downloadLink: string;
  description?: string;
};
// TODO: These two types should follow the same format (camelCase vs snake_case)
export type DownloadablePuzzleDatabase = {
  title: string;
  description: string;
  puzzleCount: number;
  storageSize: bigint;
  downloadLink: string;
};

const DATABASES: DownloadableDatabase[] = [
  {
    title: "Lumbra's Gigabase",
    game_count: 9570564,
    player_count: 526520,
    storage_size: BigInt(2789040128),
    downloadLink: "https://pub-561e4f3376ea4e4eb2ffd01a876ba46e.r2.dev/LumbrasGigaBase2025-06.db3",
  },
  {
    title: "Caissabase 2024",
    game_count: 5404926,
    player_count: 321095,
    storage_size: BigInt(1318744064),
    downloadLink: "https://pub-561e4f3376ea4e4eb2ffd01a876ba46e.r2.dev/caissabase_2024.db3",
  },
  {
    title: "Ajedrez Data - Correspondence",
    game_count: 1524027,
    player_count: 40547,
    storage_size: BigInt(328458240),
    downloadLink: "https://pub-561e4f3376ea4e4eb2ffd01a876ba46e.r2.dev/AJ-COR.db3",
  },
  {
    title: "Ajedrez Data - OTB",
    game_count: 4279012,
    player_count: 144015,
    storage_size: BigInt(993509376),
    downloadLink: "https://pub-561e4f3376ea4e4eb2ffd01a876ba46e.r2.dev/AJ-OTB.db3",
  },
  {
    title: "MillionBase",
    game_count: 3451068,
    player_count: 284403,
    storage_size: BigInt(779833344),
    downloadLink: "https://pub-561e4f3376ea4e4eb2ffd01a876ba46e.r2.dev/mb-3.db3",
  },
  {
    title: "Position Cache",
    game_count: 0,
    player_count: 0,
    storage_size: BigInt(628700416),
    downloadLink: "https://pub-ea015655e3e044baaea19e7e0bf574f9.r2.dev/position_cache.db3",
    description:
      "Pre-calculated position cache with statistics and games for Lumbra's Gigabase, Caissabase 2024, Ajedrez Data (Correspondence & OTB), and MillionBase. This will overwrite your existing cache.",
  },
];

const PUZZLE_DATABASES: DownloadablePuzzleDatabase[] = [
  {
    title: "Lichess Puzzles",
    description: "A collection of all puzzles from Lichess.org",
    puzzleCount: 3080529,
    storageSize: BigInt(339046400),
    downloadLink: "https://pub-561e4f3376ea4e4eb2ffd01a876ba46e.r2.dev/puzzles.db3",
  },
  {
    title: "Lichess Puzzles 2025",
    description: "Latest puzzles from Lichess.org organized by themes in database format",
    puzzleCount: 5600086,
    storageSize: BigInt(3542036480), // 3,459,020 KB = 3,542,036,480 bytes
    downloadLink: "https://pub-ea015655e3e044baaea19e7e0bf574f9.r2.dev/Lichess%20Puzzles%202025.db3",
  },
];

export interface CompleteGame {
  game: NormalizedGame;
  currentMove: number[];
}

export type Speed = "UltraBullet" | "Bullet" | "Blitz" | "Rapid" | "Classical" | "Correspondence" | "Unknown";

function normalizeRange(range?: [number, number] | null): [number, number] | undefined {
  if (!range || range[1] - range[0] === 3000) {
    return undefined;
  }
  return range;
}

export async function query_games(db: string, query: GameQuery): Promise<QueryResponse<NormalizedGame[]>> {
  try {
    const timeControlCategory =
      (query as unknown as { time_control_category?: string | null }).time_control_category ?? null;
    return unwrap(
      await commands.getGames(db, {
        player1: query.player1,
        range1: normalizeRange(query.range1),
        player2: query.player2,
        range2: normalizeRange(query.range2),
        tournament_id: query.tournament_id,
        sides: query.sides,
        outcome: query.outcome,
        start_date: query.start_date,
        end_date: query.end_date,
        position: null,
        time_control_category: timeControlCategory,
        // Always include game_details_limit - use null if undefined.
        // IMPORTANT: At runtime we MUST send a JSON-safe value (string/number/null).
        // The generated TS binding currently expects `bigint`, so we cast for typing while
        // keeping the runtime value as a string (see __tests__/dbBigIntSerialization.test.ts).
        game_details_limit:
          query.game_details_limit == null ? null : (String(query.game_details_limit) as unknown as bigint),
        wanted_result: query.wanted_result ?? null,
        options: {
          skipCount: query.options?.skipCount ?? false,
          page: query.options?.page,
          pageSize: query.options?.pageSize,
          sort: query.options?.sort || "id",
          direction: query.options?.direction || "desc",
        },
      } as any),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("no such table") && message.toLowerCase().includes("games")) {
      return { data: [], count: 0 };
    }
    throw error;
  }
}

export async function query_players(db: string, query: PlayerQuery): Promise<QueryResponse<Player[]>> {
  try {
    return unwrap(
      await commands.getPlayers(db, {
        options: {
          skipCount: query.options.skipCount || false,
          page: query.options.page,
          pageSize: query.options.pageSize,
          sort: query.options.sort,
          direction: query.options.direction,
        },
        name: query.name,
        range: normalizeRange(query.range),
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("no such table") && message.toLowerCase().includes("players")) {
      return { data: [], count: 0 };
    }
    throw error;
  }
}

export async function getDatabases(): Promise<DatabaseInfo[]> {
  const files = await readDir("db", { baseDir: BaseDirectory.AppData });
  const dbs = files.filter((file) => file.name?.endsWith(".db3"));
  return (await Promise.allSettled(dbs.map((db) => getDatabase(db.name))))
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<DatabaseInfo>).value);
}

async function getDatabase(name: string): Promise<DatabaseInfo> {
  const appDataDirPath = await appDataDir();
  const path = await resolve(appDataDirPath, "db", name);
  const res = await commands.getDbInfo(path);
  if (res.status === "ok") {
    return {
      type: "success",
      ...res.data,
      file: path,
    };
  }
  return {
    type: "error",
    filename: path,
    file: path,
    error: res.error,
    indexed: false,
  };
}

export function useDefaultDatabases(opened: boolean) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["default-dbs"],
    queryFn: async () => {
      return DATABASES as SuccessDatabaseInfo[];
    },
    enabled: opened,
    staleTime: Infinity,
  });
  return {
    defaultDatabases: data,
    error,
    isLoading,
  };
}

export async function getDefaultPuzzleDatabases(): Promise<(PuzzleDatabaseInfo & { downloadLink: string })[]> {
  return PUZZLE_DATABASES as (PuzzleDatabaseInfo & {
    downloadLink: string;
  })[];
}

export interface Opening {
  move: string;
  white: number;
  black: number;
  draw: number;
}

/**
 * Recalculate opening stats from limited games.
 * This ensures stats reflect only the games that are actually returned (after limit is applied).
 */
function recalculateOpeningsFromGames(
  games: NormalizedGame[],
  currentFen: string,
): Opening[] {
  const openingsMap = new Map<string, { move: string; white: number; black: number; draw: number }>();
  
  // Parse current position - normalize FEN by removing move counters for comparison
  const currentPos = positionFromFen(currentFen);
  if (!currentPos) {
    return [];
  }
  
  // Normalize FEN for comparison (remove move counters and halfmove clock)
  const normalizeFen = (fen: string): string => {
    const parts = fen.split(" ");
    // Keep only position, active color, castling, en passant (first 4 parts)
    return parts.slice(0, 4).join(" ");
  };
  const normalizedCurrentFen = normalizeFen(currentFen);
  
  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  
  for (const game of games) {
    try {
      // Parse PGN to find the next move after current position
      const parsed = parsePgn(game.moves);
      if (!parsed || parsed.length === 0) {
        skippedCount++;
        continue;
      }
      
      const gameData = parsed[0];
      let pos = startingPosition(gameData.headers).unwrap();
      let currentNode = gameData.moves;
      
      // Navigate to current position
      let foundPosition = false;
      while (currentNode) {
        const fen = makeFen(pos.toSetup());
        const normalizedFen = normalizeFen(fen);
        if (normalizedFen === normalizedCurrentFen) {
          foundPosition = true;
          break;
        }
        
        const nextNode = currentNode.children?.[0];
        if (!nextNode) break;
        
        const move = parseSan(pos, nextNode.data.san);
        if (!move) break;
        
        pos.play(move);
        currentNode = nextNode;
      }
      
      if (!foundPosition || !currentNode) {
        skippedCount++;
        continue;
      }
      
      // Get next move
      const nextNode = currentNode.children?.[0];
      if (!nextNode) {
        // Game ended at this position
        const move = "*";
        const existing = openingsMap.get(move) || { move, white: 0, black: 0, draw: 0 };
        if (game.result === "1-0") existing.white++;
        else if (game.result === "0-1") existing.black++;
        else if (game.result === "1/2-1/2") existing.draw++;
        openingsMap.set(move, existing);
        processedCount++;
        continue;
      }
      
      const nextMove = nextNode.data.san;
      const existing = openingsMap.get(nextMove) || { move: nextMove, white: 0, black: 0, draw: 0 };
      if (game.result === "1-0") existing.white++;
      else if (game.result === "0-1") existing.black++;
      else if (game.result === "1/2-1/2") existing.draw++;
      openingsMap.set(nextMove, existing);
      processedCount++;
    } catch (error) {
      // Skip games that can't be parsed
      errorCount++;
      continue;
    }
  }
  
  return Array.from(openingsMap.values());
}

export async function getTournamentGames(file: string, id: number) {
  return await query_games(file, {
    options: {
      direction: "asc",
      sort: "id",
      skipCount: true,
    },
    tournament_id: id,
  });
}

export async function searchPosition(options: LocalOptions, tab: string) {
  if (!options.path) {
    throw new Error("Missing reference database");
  }

  let fen = (options.fen ?? "").trim();
  const type = options.type ?? "exact";

  // Remove trailing spaces from FEN (common issue)
  fen = fen.trimEnd();

  if (!fen) {
    throw new Error("Missing FEN for local database search");
  }

  // Ensure gameDetailsLimit is a valid number between 1 and 1000
  const parsedLimit =
    typeof options.gameDetailsLimit === "number" && Number.isFinite(options.gameDetailsLimit)
      ? options.gameDetailsLimit
      : Number.parseInt(String(options.gameDetailsLimit ?? ""), 10);
  const gameDetailsLimitValue = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(1000, Math.floor(parsedLimit)))
    : 10;

  // Convert result to wanted_result format (undefined for "any" to omit from payload)
  const wantedResult = options.result === "any" ? undefined : options.result;

  // If color is "any" and there's a player, we need to search for both white and black
  // and combine the results since the backend doesn't support OR queries
  if (options.color === "any" && options.player !== null) {
    // Request maximum games from each search (backend limits to 1000 per search)
    // We'll combine all results without applying the limit to show all games
    const searchLimit = 1000; // Backend maximum per search
    // Build base payload
    const basePayload = {
      position: {
        fen,
        type_: type,
      },
      game_details_limit: String(searchLimit) as unknown as bigint,
      options: {
        skipCount: true,
        sort: (options.sort || "averageElo") as "id" | "date" | "whiteElo" | "blackElo" | "averageElo" | "ply_count",
        direction: (options.direction || "desc") as "asc" | "desc",
      },
      ...(options.start_date ? { start_date: options.start_date } : {}),
      ...(options.end_date ? { end_date: options.end_date } : {}),
      ...(wantedResult ? { wanted_result: wantedResult } : {}),
    };

    // Search for player as white
    const whitePayload = {
      ...basePayload,
      player1: options.player,
    };

    // Search for player as black
    const blackPayload = {
      ...basePayload,
      player2: options.player,
    };

    // Execute both searches in parallel
    const [whiteRes, blackRes] = await Promise.all([
      commands.searchPosition(options.path, whitePayload, tab),
      commands.searchPosition(options.path, blackPayload, tab),
    ]);

    // Handle errors
    if (whiteRes.status === "error" && whiteRes.error !== "Search stopped") {
      unwrap(whiteRes);
      throw new Error(whiteRes.error);
    }
    if (blackRes.status === "error" && blackRes.error !== "Search stopped") {
      unwrap(blackRes);
      throw new Error(blackRes.error);
    }

    // Combine openings stats
    const whiteOpenings = whiteRes.status === "ok" ? whiteRes.data[0] : [];
    const blackOpenings = blackRes.status === "ok" ? blackRes.data[0] : [];
    const whiteGames = whiteRes.status === "ok" ? whiteRes.data[1] : [];
    const blackGames = blackRes.status === "ok" ? blackRes.data[1] : [];

    // Merge openings by move (combine stats)
    const openingsMap = new Map<string, { move: string; white: number; black: number; draw: number }>();

    for (const opening of whiteOpenings) {
      const existing = openingsMap.get(opening.move) || { move: opening.move, white: 0, black: 0, draw: 0 };
      existing.white += opening.white;
      existing.black += opening.black;
      existing.draw += opening.draw;
      openingsMap.set(opening.move, existing);
    }

    for (const opening of blackOpenings) {
      const existing = openingsMap.get(opening.move) || { move: opening.move, white: 0, black: 0, draw: 0 };
      existing.white += opening.white;
      existing.black += opening.black;
      existing.draw += opening.draw;
      openingsMap.set(opening.move, existing);
    }

    const combinedOpenings = Array.from(openingsMap.values());

    // Combine games (deduplicate by game ID)
    const gamesMap = new Map<number, NormalizedGame>();
    for (const game of whiteGames) {
      gamesMap.set(game.id, game);
    }
    for (const game of blackGames) {
      gamesMap.set(game.id, game);
    }
    let combinedGames = Array.from(gamesMap.values());
    const combinedGamesCountBeforeLimit = combinedGames.length;
    
    // Re-sort combined games according to the sort criteria
    // Both searches return sorted results, but we need to merge-sort them
    const sortField = options.sort || "averageElo";
    const sortDirection = options.direction || "desc";
    const sortMultiplier = sortDirection === "asc" ? 1 : -1;
    
    combinedGames.sort((a, b) => {
      let aValue: number | string | null | undefined;
      let bValue: number | string | null | undefined;
      
      switch (sortField) {
        case "id":
          aValue = a.id;
          bValue = b.id;
          break;
        case "date":
          aValue = a.date;
          bValue = b.date;
          break;
        case "whiteElo":
          aValue = a.white_elo;
          bValue = b.white_elo;
          break;
        case "blackElo":
          aValue = a.black_elo;
          bValue = b.black_elo;
          break;
        case "averageElo":
          aValue = a.white_elo != null && a.black_elo != null ? (a.white_elo + a.black_elo) / 2 : null;
          bValue = b.white_elo != null && b.black_elo != null ? (b.white_elo + b.black_elo) / 2 : null;
          break;
        case "ply_count":
          aValue = a.ply_count;
          bValue = b.ply_count;
          break;
        default:
          aValue = a.id;
          bValue = b.id;
      }
      
      // Handle null/undefined values
      if (aValue == null && bValue == null) return 0;
      if (aValue == null) return sortMultiplier;
      if (bValue == null) return -sortMultiplier;
      
      // Compare values
      if (typeof aValue === "number" && typeof bValue === "number") {
        return (aValue - bValue) * sortMultiplier;
      }
      if (typeof aValue === "string" && typeof bValue === "string") {
        return aValue.localeCompare(bValue) * sortMultiplier;
      }
      return 0;
    });
    
    // For "any color" with player, don't apply limit - show all combined games
    // The stats should reflect ALL games, not just the limited set
    // The backend already limits each search to 1000, so we get up to 2000 unique games
    // We should show all of them, not limit further
    const shouldApplyLimit = false; // Always show all combined games for "any color" with player
    
    // Use stats based on whether we applied limit or not
    let finalOpenings: Opening[];
    if (shouldApplyLimit) {
      // Recalculate openings stats from limited games to ensure stats reflect only returned games
      finalOpenings = recalculateOpeningsFromGames(combinedGames, fen);
    } else {
      // Use original combined stats since we're showing all games
      finalOpenings = combinedOpenings;
    }
    
    return [finalOpenings, combinedGames] as [Opening[], NormalizedGame[]];
  }

  // Build payload matching GameQueryJs type exactly
  // Only include fields that have values to avoid serialization issues
  // Rust expects game_details_limit as JSON-safe value (string/number/null). Do NOT send JS BigInt.
  const payload = {
    position: {
      fen,
      type_: type,
    },
    // Keep runtime as string, cast for TS binding (bigint) compatibility.
    game_details_limit: String(gameDetailsLimitValue) as unknown as bigint,
    options: {
      skipCount: true,
      sort: (options.sort || "averageElo") as "id" | "date" | "whiteElo" | "blackElo" | "averageElo" | "ply_count",
      direction: (options.direction || "desc") as "asc" | "desc",
    },
    ...(options.color === "white" && options.player !== null ? { player1: options.player } : {}),
    ...(options.color === "black" && options.player !== null ? { player2: options.player } : {}),
    ...(options.start_date ? { start_date: options.start_date } : {}),
    ...(options.end_date ? { end_date: options.end_date } : {}),
    ...(wantedResult ? { wanted_result: wantedResult } : {}),
  };

  if (!options.path) {
    throw new Error("Missing database path for position search.");
  }

  const res = await commands.searchPosition(options.path, payload, tab);

  if (res.status === "error") {
    if (res.error !== "Search stopped") {
      unwrap(res);
    }
    throw new Error(res.error);
  }

  return res.data;
}
