import type { Color } from "@lichess-org/chessground/types";
import { notifications } from "@mantine/notifications";
import { IconX } from "@tabler/icons-react";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, resolve } from "@tauri-apps/api/path";
import { fetch } from "@tauri-apps/plugin-http";
import { error } from "@tauri-apps/plugin-log";
import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { match, P } from "ts-pattern";
import { type BestMoves, commands, type EngineOptions, type GoMode, type NormalizedGame } from "@/bindings";
import { parsePGN, uciNormalize } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import {
  buildCoverageSourceSignature,
  type CoverageExplorerCacheEntry,
  getCoverageExplorerCache,
  setCoverageExplorerCache,
} from "@/utils/coverageExplorerCache";
import {
  getLichessGamesQueryParams,
  getMasterGamesQueryParams,
  type LichessGamesOptions,
  type MasterGamesOptions,
} from "@/utils/lichess/explorer";
import { isFailedToFetchError, isInNetworkCooldown, startNetworkCooldown } from "@/utils/networkCooldown";
import { countMainPly } from "@/utils/treeReducer";

const baseURL = "https://lichess.org/api";
const explorerURL = "https://explorer.lichess.ovh";
const tablebaseURL = "https://tablebase.lichess.ovh";

export const MIN_DATE = new Date(1952, 0, 1);

export type TablebaseCategory =
  | "win"
  | "unknown"
  | "maybe-win"
  | "cursed-win"
  | "draw"
  | "blessed-loss"
  | "maybe-loss"
  | "loss";

type TablebaseData = {
  checkmate: boolean;
  stalemate: boolean;
  variant_win: boolean;
  variant_loss: boolean;
  insufficient_material: boolean;
  dtz: number;
  precise_dtz: number;
  dtm: number;
  category: TablebaseCategory;
  moves: TablebaseMove[];
};

export type TablebaseMove = {
  uci: string;
  san: string;
  zeroing: boolean;
  checkmate: boolean;
  stalemate: boolean;
  variant_win: boolean;
  variant_loss: boolean;
  insufficient_material: boolean;
  dtz: number;
  precise_dtz: number;
  dtm: number;
  category: TablebaseCategory;
};

type LichessPerf = {
  games: number;
  rating: number;
  rd: number;
  prog: number;
  prov: boolean;
};

export type LichessAccount = {
  id: string;
  username: string;
  perfs?: {
    chess960?: LichessPerf;
    atomic?: LichessPerf;
    racingKings?: LichessPerf;
    ultraBullet?: LichessPerf;
    blitz?: LichessPerf;
    kingOfTheHill?: LichessPerf;
    bullet?: LichessPerf;
    correspondence?: LichessPerf;
    horde?: LichessPerf;
    puzzle?: LichessPerf;
    classical?: LichessPerf;
    rapid?: LichessPerf;
    racer?: {
      runs: number;
      score: number;
    };
    storm?: {
      runs: number;
      score: number;
    };
  };
  createdAt: number;
  disabled: boolean;
  tosViolation: boolean;
  profile: {
    country: string;
    location: string;
    bio: string;
    firstName: string;
    lastName: string;
    fideRating: number;
    uscfRating: number;
    ecfRating: number;
    links: string;
  };
  seenAt: number;
  patron: boolean;
  verified: boolean;
  playTime: {
    total: number;
    tv: number;
  };
  title: string;
  url: string;
  playing: string;
  completionRate: number;
  count: {
    all: number;
    rated: number;
    ai: number;
    draw: number;
    drawH: number;
    loss: number;
    lossH: number;
    win: number;
    winH: number;
    bookmark: number;
    playing: number;
    import: number;
    me: number;
  };
  streaming: boolean;
  followable: boolean;
  following: boolean;
  blocking: boolean;
  followsYou: boolean;
};

type PositionGames = {
  uci: string;
  id: string;
  winner: string | null;
  speed: string;
  mode: string;
  black: {
    name: string;
    rating: number;
  };
  white: {
    name: string;
    rating: number;
  };
  year: number;
  month: string;
}[];

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

export async function convertToNormalized(data: PositionGames, signal?: AbortSignal): Promise<NormalizedGame[]> {
  throwIfAborted(signal);
  const results = await Promise.allSettled(
    data.map(async (game, i) => {
      const pgn = await getLichessGame(game.id, signal);
      const { headers, root } = await parsePGN(pgn);
      const normalized: NormalizedGame = {
        ...headers,
        id: i,
        white_id: 0,
        black_id: 0,
        event_id: 0,
        site_id: 0,
        moves: pgn,
        ply_count: countMainPly(root),
        // ply_count: root,
      };
      return normalized;
    }),
  );
  throwIfAborted(signal);
  return results
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<NormalizedGame>).value);
}

type PositionData = {
  white: number;
  black: number;
  draws: number;
  moves: {
    uci: string;
    san: string;
    averageRating: number;
    white: number;
    black: number;
    draws: number;
  }[];
  recentGames?: PositionGames;
  topGames?: PositionGames;
};

function formatExplorerMonth(date: Date | null | undefined): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function normalizeLichessAllCacheConfig(options: LichessGamesOptions): string {
  return JSON.stringify({
    schema: "ocs.lichess-all-position-cache.v1",
    dbType: "lch_all",
    variant: options.variant ?? null,
    speeds: [...(options.speeds ?? [])].sort(),
    ratings: [...(options.ratings ?? [])].sort((a, b) => a - b),
    since: formatExplorerMonth(options.since),
    until: formatExplorerMonth(options.until),
    moves: typeof options.moves === "number" && options.moves >= 0 ? options.moves : null,
    topGames: typeof options.topGames === "number" && options.topGames >= 0 ? options.topGames : null,
    recentGames: typeof options.recentGames === "number" && options.recentGames >= 0 ? options.recentGames : null,
    player: (options.player ?? "").trim().toLowerCase(),
    color: options.color ?? "white",
  });
}

function positionDataFromCoverageCache(entry: CoverageExplorerCacheEntry): PositionData {
  const moves = entry.moves.map((move) => ({
    uci: "",
    san: move.san,
    averageRating: 0,
    white: move.white ?? 0,
    black: move.black ?? 0,
    draws: move.draw ?? 0,
  }));

  return {
    white: moves.reduce((sum, move) => sum + move.white, 0),
    black: moves.reduce((sum, move) => sum + move.black, 0),
    draws: moves.reduce((sum, move) => sum + move.draws, 0),
    moves,
    recentGames: [],
    topGames: [],
  };
}

function getExplorerHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    // Some edge/proxy setups reject requests without a UA.
    "User-Agent": "ObsidianChessStudio/1.0",
  };
  const trimmedToken = token?.trim();
  if (trimmedToken) {
    headers.Authorization = `Bearer ${trimmedToken}`;
  }
  return headers;
}

async function parseJsonResponse<T>(res: Response, context: string): Promise<T> {
  const raw = await res.text();
  let parsed: T | null = null;

  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw) as T;
    } catch {
      if (!res.ok) {
        const bodyPreview = raw.trim().slice(0, 160).replace(/\s+/g, " ");
        throw new Error(`${context} failed (${res.status}): non-JSON response: ${bodyPreview}`);
      }
      throw new Error(`${context} returned invalid JSON`);
    }
  }

  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)
        ? String((parsed as Record<string, unknown>).error)
        : raw.trim() || res.statusText || "request failed";
    throw new Error(`${context} failed (${res.status}): ${message}`);
  }

  if (parsed == null) {
    throw new Error(`${context} returned empty response`);
  }

  return parsed;
}

export async function getLichessAccount({
  token,
  username,
}: {
  token?: string;
  username?: string;
}): Promise<LichessAccount | null> {
  if (isInNetworkCooldown()) return null;

  try {
    const raw = await invoke<string | null>("get_lichess_account", {
      token: token ?? null,
      username: username ?? null,
    });

    if (!raw) {
      // Preserve previous UX: show the "not found" notification for username lookups.
      if (!token && username) {
        notifications.show({
          title: "Failed to fetch Lichess account",
          message: `Could not find account "${username}" on lichess.org`,
          color: "red",
          icon: <IconX />,
        });
      }
      return null;
    }

    return JSON.parse(raw) as LichessAccount;
  } catch (e) {
    if (isFailedToFetchError(e)) {
      startNetworkCooldown();
      // No notifications for transient connectivity issues.
      error(`Failed to fetch Lichess account: ${String(e)}`);
      return null;
    }
    throw e;
  }
}

export async function fetchLastLichessGames(
  username: string,
  count: number = 5,
  showErrorNotification: boolean = false,
) {
  const url = `${baseURL}/games/user/${username}?max=${count}&pgnInJson=true&opening=true`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/x-ndjson" },
    });

    if (!response.ok) {
      // Don't show notification for 404 (user not found) or 403 (forbidden) - these are expected
      if (response.status === 404 || response.status === 403) {
        return [];
      }
      // Only throw for other errors if we should show notifications
      if (showErrorNotification) {
        throw new Error(`Failed to fetch games: ${response.statusText}`);
      }
      return [];
    }

    const text = await response.text();
    // Handle empty response (user has no games)
    if (!text.trim()) {
      return [];
    }

    const games = text
      .trim()
      .split("\n")
      .filter((line) => line.trim()) // Filter out empty lines
      .map((line) => JSON.parse(line));
    return games;
  } catch (e) {
    error(`Error fetching last Lichess games for ${username}: ${e}`);
    // Only show notification if explicitly requested
    if (showErrorNotification) {
      notifications.show({
        title: "Fetch Error",
        message: `Could not fetch recent games for ${username} from Lichess.`,
        color: "red",
        icon: <IconX />,
      });
    }
    return [];
  }
}

export async function getBestMoves(
  _tab: string,
  _goMode: GoMode,
  options: EngineOptions,
): Promise<[number, BestMoves[]] | null> {
  const [pos] = positionFromFen(options.fen);
  if (!pos) {
    return null;
  }
  for (const uci of options.moves) {
    const m = parseUci(uci);
    if (!m) {
      return null;
    }
    pos.play(m);
  }
  const data = await getCloudEvaluation(
    makeFen(pos.toSetup()),
    Number.parseInt(options.extraOptions.find((o) => o.name === "MultiPV")?.value ?? "1", 10),
  );
  return [
    100,
    data.pvs?.map((m, i) => {
      const uciMoves = m.moves.split(" ");
      const posCopy = pos.clone();
      const normalizedUciMoves: string[] = [];

      const sanMoves = uciMoves.map((m) => {
        const move = parseUci(m);
        if (!move) {
          throw new Error(`Invalid cloud evaluation move: ${m}`);
        }
        const san = makeSan(posCopy, move);
        normalizedUciMoves.push(
          uciNormalize(
            posCopy,
            move,
            options.extraOptions.some((o) => o.name === "UCI_Chess960" && o.value === "true"),
          ),
        );
        posCopy.play(move);
        return san;
      });

      return {
        score: {
          value: "cp" in m ? { type: "cp", value: m.cp } : { type: "mate", value: m.mate },
          wdl: null,
        },
        nodes: data.knodes * 1000,
        depth: data.depth,
        multipv: i + 1,
        nps: 0,
        sanMoves,
        uciMoves: normalizedUciMoves,
      };
    }) ?? [],
  ];
}

const cache = new Map<string, LichessCloudData>();

type LichessCloudData = {
  fen: string;
  knodes: number;
  depth: number;
  pvs: (LichessCp | LichessMate)[];
};

type LichessCp = {
  cp: number;
  moves: string;
};

type LichessMate = {
  mate: number;
  moves: string;
};

async function getCloudEvaluation(fen: string, multipv: number): Promise<LichessCloudData> {
  const cacheKey = `${fen}-${multipv}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const url = new URL(`${baseURL}/cloud-eval`);
  url.searchParams.append("fen", fen);
  url.searchParams.append("multiPv", multipv.toString());

  const response = await fetch(url.toString());
  const data = await parseJsonResponse<LichessCloudData>(response as unknown as Response, "Lichess cloud evaluation");
  cache.set(cacheKey, data);
  return data;
}

export async function getLichessGames(
  fen: string,
  options: LichessGamesOptions,
  token?: string,
  signal?: AbortSignal,
  useCoverageCache: boolean = true,
): Promise<PositionData> {
  const cacheConfigJson = normalizeLichessAllCacheConfig(options);
  const sourceSignature = cacheConfigJson;
  if (useCoverageCache) {
    try {
      const cached = await getCoverageExplorerCache(sourceSignature, fen);
      if (cached) {
        return positionDataFromCoverageCache(cached);
      }
    } catch {
      // Coverage cache is best effort and should not block explorer usage.
    }
  }

  const url = match(options.player)
    .with(P.union(undefined, ""), () => `${explorerURL}/lichess?${getLichessGamesQueryParams(fen, options)}`)
    .otherwise(() => `${explorerURL}/player?${getLichessGamesQueryParams(fen, options)}`);
  const res = await fetch(url, {
    method: "GET",
    headers: getExplorerHeaders(token),
    signal,
  });
  const payload = await parseJsonResponse<PositionData>(res as unknown as Response, "Lichess explorer");
  try {
    await setCoverageExplorerCache(
      sourceSignature,
      fen,
      (payload.moves ?? []).map((move) => ({
        san: move.san,
        games: move.white + move.black + move.draws,
        white: move.white,
        black: move.black,
        draw: move.draws,
      })),
      cacheConfigJson,
    );
  } catch {
    // Coverage cache is best effort and should not block explorer usage.
  }
  return payload;
}

export async function getMasterGames(
  fen: string,
  options: MasterGamesOptions,
  token?: string,
  signal?: AbortSignal,
): Promise<PositionData> {
  const sourceSignature = await buildCoverageSourceSignature({
    dbType: "lch_master",
    masterSince: options.since ?? null,
    masterUntil: options.until ?? null,
  });
  const url = `${explorerURL}/masters?${getMasterGamesQueryParams(fen, options)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: getExplorerHeaders(token),
    signal,
  });
  const payload = await parseJsonResponse<PositionData>(res as unknown as Response, "Lichess masters explorer");
  try {
    await setCoverageExplorerCache(
      sourceSignature,
      fen,
      (payload.moves ?? []).map((move) => ({
        san: move.san,
        games: move.white + move.black + move.draws,
        white: move.white,
        black: move.black,
        draw: move.draws,
      })),
    );
  } catch {
    // Coverage cache is best effort and should not block explorer usage.
  }
  return payload;
}

export async function getPlayerGames(fen: string, player: string, color: Color, token?: string) {
  return (
    await fetch(`${explorerURL}/player?fen=${fen}&player=${player}&color=${color}`, {
      method: "GET",
      headers: getExplorerHeaders(token),
    })
  ).json();
}

export async function downloadLichess(
  player: string,
  timestamp: number | null,
  games: number,
  _setProgress: (progress: number) => void,
  token?: string,
  outputPath?: string,
  downloadId?: string,
) {
  let url = `${baseURL}/games/user/${player}`;
  if (timestamp) {
    url += `?since=${timestamp}`;
  }
  const path = outputPath ?? (await resolve(await appDataDir(), "db", `${player}_lichess.pgn`));

  await commands.downloadFile(
    downloadId ?? `lichess_${player}`,
    url,
    path,
    token ?? null,
    null,
    games > 0 ? games * 900 : null, // approx. size of a game
  );
}

export async function getLichessGame(gameId: string, signal?: AbortSignal): Promise<string> {
  const response = await window.fetch(`https://lichess.org/game/export/${gameId.slice(0, 8)}`, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load lichess game ${gameId} - ${response.statusText}`);
  }
  return await response.text();
}

export async function getTablebaseInfo(fen: string): Promise<TablebaseData> {
  const res = await fetch(`${tablebaseURL}/standard?fen=${fen}`);
  if (!res.ok) {
    throw new Error(`Failed to load tablebase info for ${fen} - ${res.status}`);
  }
  return res.json();
}
