import { query_games, query_players } from "@/utils/db";
import { appDataDir, resolve } from "@tauri-apps/api/path";
import { mkdir, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import { commands } from "@/bindings";
import { unwrap } from "@/utils/unwrap";
import { getProfileDbPath } from "@/utils/profileDb";
import { getChessComAccount } from "@/utils/chess.com/api";
import { getLichessAccount } from "@/utils/lichess/api";
import type { Profile } from "@/state/atoms";
import type { Session } from "@/utils/session";
import { getAccountPgnPath } from "@/utils/accountPgnPaths";
import { getAccountKey } from "@/utils/accountKeys";
import { rewritePgnAccountTags } from "@/utils/pgnAccountTags";
import {
  getAccountSyncState,
  listAccountSyncCompletedBatches,
  markAccountSyncBatchComplete,
  upsertAccountSyncState,
  type AccountSyncPlatform,
} from "@/utils/accountSyncState";
import { z } from "zod";

function parseUtc(date?: string | null, time?: string | null): number | null {
  if (!date || !time) return null;
  const [year, month, day] = date.split(".").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  if ([year, month, day, hour, minute, second].some((n) => Number.isNaN(n))) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

export async function getAccountSyncStateFromProfileDb(profileDbPath: string, accountKey: string) {
  try {
    const players = await query_players(profileDbPath, {
      name: accountKey,
      options: { page: 1, pageSize: 10, direction: "asc", sort: "id", skipCount: false },
    });

    const playerId =
      players.data.find((p) => (p.name ?? "").toLowerCase() === accountKey.toLowerCase())?.id ??
      players.data[0]?.id ??
      null;
    if (!playerId) return { lastGameDate: null as number | null, count: 0 };

    const games = await query_games(profileDbPath, {
      player1: playerId,
      sides: "Any",
      options: { page: 1, pageSize: 1, sort: "date", direction: "desc", skipCount: false },
    });

    const count = games.count ?? 0;
    const first = games.data[0];
    return { lastGameDate: parseUtc(first?.date ?? null, first?.time ?? null), count };
  } catch {
    return { lastGameDate: null as number | null, count: 0 };
  }
}

export type SyncBatchUpdate = {
  platform: AccountSyncPlatform;
  totalBatches: number;
  completedBatches: number;
  currentBatch: number;
  batchLabel: string;
};

const LICHESS_BATCH_SIZE = 500;
const NETWORK_CONNECT_TIMEOUT_MS = 5000;

function parsePgnUtcRange(pgn: string): { oldestUtcMs: number | null; newestUtcMs: number | null; gameCount: number } {
  const games = pgn
    .split(/\n\n(?=\[Event )/g)
    .map((g) => g.trim())
    .filter(Boolean);

  let oldest: number | null = null;
  let newest: number | null = null;
  let count = 0;

  for (const g of games) {
    const dateMatch = g.match(/\[UTCDate\s+\"(\d{4})\.(\d{2})\.(\d{2})\"\]/);
    const timeMatch = g.match(/\[UTCTime\s+\"(\d{2}):(\d{2}):(\d{2})\"\]/);
    if (!dateMatch || !timeMatch) continue;

    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    const second = Number(timeMatch[3]);
    if ([year, month, day, hour, minute, second].some((n) => Number.isNaN(n))) continue;
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);

    count += 1;
    oldest = oldest === null ? ms : Math.min(oldest, ms);
    newest = newest === null ? ms : Math.max(newest, ms);
  }

  return { oldestUtcMs: oldest, newestUtcMs: newest, gameCount: count };
}

const ChessComArchiveSchema = z.object({ archives: z.array(z.string()) });
const ChessComPlayerSchema = z.object({
  rating: z.number(),
  result: z.string(),
  username: z.string(),
});
const ChessComGameSchema = z.object({
  url: z.string(),
  pgn: z.string().nullish(),
  end_time: z.number(),
  white: ChessComPlayerSchema,
  black: ChessComPlayerSchema,
});
const ChessComGamesSchema = z.object({ games: z.array(ChessComGameSchema) });

async function getChessComArchives(player: string): Promise<string[]> {
  const url = `https://api.chess.com/pub/player/${player.toLowerCase()}/games/archives`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "User-Agent": "Obsidian Chess Studio" },
    connectTimeout: NETWORK_CONNECT_TIMEOUT_MS,
  });
  const data = ChessComArchiveSchema.parse(await response.json());
  return data.archives;
}

export async function syncSessionGamesToProfileDb(input: {
  profile: Profile;
  session: Session;
  onBatchUpdate?: (update: SyncBatchUpdate) => void;
}) {
  const profileId = input.profile.id;
  const profileTitle = input.profile.name || `Profile ${profileId}`;

  try {
    const dbDir = await resolve(await appDataDir(), "db");
    await mkdir(dbDir, { recursive: true });
  } catch {
    // Best-effort; downloads/conversion will surface errors if this fails.
  }

  const dbPath = await getProfileDbPath(profileId);

  if (input.session.lichess) {
    const username = input.session.lichess.username;
    const token = input.session.lichess.accessToken;
    const accountKey = getAccountKey("lichess", username);

    const updatedAccount = await getLichessAccount({ token, username });
    const { lastGameDate, count } = await getAccountSyncStateFromProfileDb(dbPath, accountKey);
    const totalGames = updatedAccount?.count?.all ?? input.session.lichess.account?.count?.all ?? 0;
    const gamesToDownload = Math.max(0, totalGames - count);

    const existingState = await getAccountSyncState({ dbPath, accountKey, platform: "lichess" });
    const hasResumeCursor = existingState?.cursor_until_ms != null;

    const mode: "backfill" | "incremental" = hasResumeCursor
      ? existingState?.mode === "backfill"
        ? "backfill"
        : "incremental"
      : count === 0 || lastGameDate == null
        ? "backfill"
        : "incremental";

    const sinceMs =
      mode === "incremental"
        ? hasResumeCursor
          ? (existingState?.since_ms ?? (lastGameDate != null ? lastGameDate + 1 : null))
          : lastGameDate != null
            ? lastGameDate + 1
            : null
        : null;

    const estimatedBatches =
      mode === "backfill"
        ? gamesToDownload > 0
          ? Math.ceil(gamesToDownload / LICHESS_BATCH_SIZE)
          : Math.ceil(totalGames / LICHESS_BATCH_SIZE)
        : gamesToDownload > 0
          ? Math.ceil(gamesToDownload / LICHESS_BATCH_SIZE)
          : 1;

    const appDir = await appDataDir();
    const pgnPath = await getAccountPgnPath({
      appDataDir: appDir,
      profileId,
      platform: "lichess",
      username,
    });

    let plannedTotalBatches = hasResumeCursor
      ? Math.max(existingState?.total_batches ?? 0, estimatedBatches)
      : estimatedBatches;
    let cursorUntilMs = hasResumeCursor ? (existingState?.cursor_until_ms as number) : Date.now();
    let completedBatches = hasResumeCursor ? (existingState?.completed_batches ?? 0) : 0;

    // Incremental sync: if our local DB is up-to-date, avoid downloading a large batch.
    // We do a cheap probe that requests only 1 game newer than `sinceMs`.
    if (!hasResumeCursor && mode === "incremental" && sinceMs != null && gamesToDownload === 0) {
      const probeFile = await resolve(appDir, "db", `tmp_lichess_probe_${profileId}_${username}.pgn`);
      const probeUrl = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=1&since=${sinceMs}&until=${Date.now()}`;
      try {
        const res = await fetch(probeUrl, {
          method: "GET",
          headers: {
            "User-Agent": "Obsidian Chess Studio",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          connectTimeout: NETWORK_CONNECT_TIMEOUT_MS,
        });
        if (!res.ok) throw new Error(`Lichess probe request failed (${res.status})`);
        await writeTextFile(probeFile, await res.text(), { append: false });
        const probePgn = await readTextFile(probeFile).catch(() => "");
        const { gameCount } = parsePgnUtcRange(probePgn);
        await remove(probeFile).catch(() => {});

        if (gameCount === 0) {
          await upsertAccountSyncState({
            dbPath,
            state: {
              account_key: accountKey,
              platform: "lichess",
              cursor_until_ms: null,
              since_ms: null,
              mode: "incremental",
              total_batches: 0,
              completed_batches: 0,
              running: false,
              updated_at_ms: Date.now(),
            },
          });

          const updatedSession: Session = {
            ...input.session,
            updatedAt: Date.now(),
            lichess: { ...input.session.lichess, account: updatedAccount ?? input.session.lichess.account },
          };

          return { updatedSession };
        }
      } catch {
        await remove(probeFile).catch(() => {});
      }
    }

    await upsertAccountSyncState({
      dbPath,
      state: {
        account_key: accountKey,
        platform: "lichess",
        cursor_until_ms: cursorUntilMs,
        since_ms: sinceMs,
        mode,
        total_batches: plannedTotalBatches,
        completed_batches: completedBatches,
        running: true,
        updated_at_ms: Date.now(),
      },
    });

    const minTimestampSeconds =
      mode === "incremental" && sinceMs != null ? Math.floor((sinceMs - 1) / 1000) : null;
    const tempFile = await resolve(appDir, "db", `tmp_lichess_${profileId}_${username}.pgn`);

    let syncError: unknown | null = null;

    try {
      while (true) {
        if (sinceMs != null && cursorUntilMs <= sinceMs) {
          break;
        }

        const currentBatch = completedBatches + 1;
        if (currentBatch > plannedTotalBatches) {
          plannedTotalBatches = currentBatch;
        }

        input.onBatchUpdate?.({
          platform: "lichess",
          totalBatches: plannedTotalBatches,
          completedBatches,
          currentBatch,
          batchLabel: `Lichess ${currentBatch}/${plannedTotalBatches}`,
        });

        const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=${LICHESS_BATCH_SIZE}${sinceMs != null ? `&since=${sinceMs}` : ""}&until=${cursorUntilMs}`;

        const res = await fetch(url, {
          method: "GET",
          headers: {
            "User-Agent": "Obsidian Chess Studio",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          connectTimeout: NETWORK_CONNECT_TIMEOUT_MS,
        });
        if (!res.ok) throw new Error(`Lichess batch request failed (${res.status})`);
        await writeTextFile(tempFile, await res.text(), { append: false });

        const pgn = await readTextFile(tempFile).catch(() => "");
        const { oldestUtcMs, newestUtcMs, gameCount } = parsePgnUtcRange(pgn);
        if (!pgn.trim() || gameCount === 0 || oldestUtcMs == null) {
          break;
        }

        // Incremental sync: if the newest game isn't newer than `sinceMs`, we can stop.
        if (sinceMs != null && newestUtcMs != null && newestUtcMs < sinceMs) {
          break;
        }

        // Normalize account tags in the batch and append it to the account PGN file for user export/debugging.
        await rewritePgnAccountTags(tempFile, "lichess", username);
        await writeTextFile(pgnPath, `${await readTextFile(tempFile)}\n`, { append: true }).catch(() => {});

        // Import this batch. The profile DB has dedupe protections, and `timestamp` further limits incremental sync.
        unwrap(await commands.convertPgn(tempFile, dbPath, minTimestampSeconds, profileTitle, null));

        completedBatches += 1;
        cursorUntilMs = Math.max(0, oldestUtcMs - 1);

        await upsertAccountSyncState({
          dbPath,
          state: {
            account_key: accountKey,
            platform: "lichess",
            cursor_until_ms: cursorUntilMs,
            since_ms: sinceMs,
            mode,
            total_batches: plannedTotalBatches,
            completed_batches: completedBatches,
            running: true,
            updated_at_ms: Date.now(),
          },
        });

        // Incremental sync: once we've reached (or crossed) `sinceMs`, there is nothing left to fetch.
        if (sinceMs != null && oldestUtcMs <= sinceMs) {
          break;
        }
      }
    } catch (e) {
      syncError = e;
    } finally {
      const isComplete = syncError == null;
      await upsertAccountSyncState({
        dbPath,
        state: {
          account_key: accountKey,
          platform: "lichess",
          cursor_until_ms: isComplete ? null : cursorUntilMs,
          since_ms: isComplete ? null : sinceMs,
          mode: isComplete ? "incremental" : mode,
          total_batches: isComplete ? completedBatches : plannedTotalBatches,
          completed_batches: completedBatches,
          running: false,
          updated_at_ms: Date.now(),
        },
      });
      await remove(tempFile).catch(() => {});
    }

    if (syncError) throw syncError;

    const updatedSession: Session = {
      ...input.session,
      updatedAt: Date.now(),
      lichess: { ...input.session.lichess, account: updatedAccount ?? input.session.lichess.account },
    };

    return { updatedSession };
  }

  if (input.session.chessCom) {
    const username = input.session.chessCom.username;
    const accountKey = getAccountKey("chesscom", username);

    const updatedStats = await getChessComAccount(username);

    const appDir = await appDataDir();
    const pgnPath = await getAccountPgnPath({
      appDataDir: appDir,
      profileId,
      platform: "chesscom",
      username,
    });

    const archives = (await getChessComArchives(username)).slice().reverse(); // Most recent first

    const completed = new Set(
      await listAccountSyncCompletedBatches({ dbPath, accountKey, platform: "chesscom" }).catch(() => []),
    );

    const archivesToProcess = archives.filter((a) => !completed.has(a));
    const totalBatches = archives.length;
    let completedBatches = archives.length - archivesToProcess.length;
    const mode: "backfill" | "incremental" = completedBatches < totalBatches ? "backfill" : "incremental";

    await upsertAccountSyncState({
      dbPath,
      state: {
        account_key: accountKey,
        platform: "chesscom",
        cursor_until_ms: null,
        since_ms: null,
        mode,
        total_batches: totalBatches,
        completed_batches: completedBatches,
        running: true,
        updated_at_ms: Date.now(),
      },
    });

    const tempFile = await resolve(appDir, "db", `tmp_chesscom_${profileId}_${username}.pgn`);

    let syncError: unknown | null = null;

    try {
      for (const archiveUrl of archivesToProcess) {
        const currentBatch = completedBatches + 1;
        input.onBatchUpdate?.({
          platform: "chesscom",
          totalBatches,
          completedBatches,
          currentBatch,
          batchLabel: `Chess.com ${currentBatch}/${totalBatches}`,
        });

        const response = await fetch(archiveUrl, {
          method: "GET",
          headers: { "User-Agent": "Obsidian Chess Studio" },
          connectTimeout: NETWORK_CONNECT_TIMEOUT_MS,
        });
        if (!response.ok) {
          throw new Error(`Chess.com archive request failed (${response.status})`);
        }
        const gamesPayload = ChessComGamesSchema.safeParse(await response.json());
        if (!gamesPayload.success) {
          throw new Error("Chess.com archive response validation failed");
        }

        const seenUrls = new Set<string>();
        const dedupedPgns = gamesPayload.data.games
          .filter((g) => g.pgn && g.url)
          .filter((g) => {
            if (seenUrls.has(g.url)) return false;
            seenUrls.add(g.url);
            return true;
          })
          .sort((a, b) => b.end_time - a.end_time)
          .map((g) => g.pgn as string);

        if (dedupedPgns.length > 0) {
          await writeTextFile(tempFile, dedupedPgns.join("\n"), { append: false });
          await rewritePgnAccountTags(tempFile, "chesscom", username);
          await writeTextFile(pgnPath, `${await readTextFile(tempFile)}\n`, { append: true }).catch(() => {});

          unwrap(
            await commands.convertPgn(
              tempFile,
              dbPath,
              null,
              profileTitle,
              null,
            ),
          );
        }

        await markAccountSyncBatchComplete({
          dbPath,
          accountKey,
          platform: "chesscom",
          batchId: archiveUrl,
          completedAtMs: Date.now(),
        });

        completedBatches += 1;
        await upsertAccountSyncState({
          dbPath,
          state: {
            account_key: accountKey,
            platform: "chesscom",
            cursor_until_ms: null,
            since_ms: null,
            mode,
            total_batches: totalBatches,
            completed_batches: completedBatches,
            running: true,
            updated_at_ms: Date.now(),
          },
        });
      }
    } catch (e) {
      syncError = e;
    } finally {
      await upsertAccountSyncState({
        dbPath,
        state: {
          account_key: accountKey,
          platform: "chesscom",
          cursor_until_ms: null,
          since_ms: null,
          mode: completedBatches >= totalBatches ? "incremental" : mode,
          total_batches: totalBatches,
          completed_batches: completedBatches,
          running: false,
          updated_at_ms: Date.now(),
        },
      });
      await remove(tempFile).catch(() => {});
    }

    if (syncError) throw syncError;

    const updatedSession: Session = {
      ...input.session,
      updatedAt: Date.now(),
      chessCom: { ...input.session.chessCom, stats: updatedStats ?? input.session.chessCom.stats },
    };

    return { updatedSession };
  }

  return { updatedSession: input.session };
}
