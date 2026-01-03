import { query_games, query_players } from "@/utils/db";
import { appDataDir, resolve } from "@tauri-apps/api/path";
import { mkdir } from "@tauri-apps/plugin-fs";
import { commands } from "@/bindings";
import { unwrap } from "@/utils/unwrap";
import { getProfileDbPath } from "@/utils/profileDb";
import { downloadChessCom, getChessComAccount } from "@/utils/chess.com/api";
import { downloadLichess, getLichessAccount } from "@/utils/lichess/api";
import type { Profile } from "@/state/atoms";
import type { Session } from "@/utils/session";
import { getAccountPgnPath } from "@/utils/accountPgnPaths";
import { getAccountKey } from "@/utils/accountKeys";
import { rewritePgnAccountTags } from "@/utils/pgnAccountTags";

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

export async function syncSessionGamesToProfileDb(input: { profile: Profile; session: Session }) {
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

    const appDir = await appDataDir();
    const pgnPath = await getAccountPgnPath({
      appDataDir: appDir,
      profileId,
      platform: "lichess",
      username,
    });
    await downloadLichess(
      username,
      lastGameDate,
      gamesToDownload,
      () => {},
      token,
      pgnPath,
      `lichess_${profileId}_${username}`,
    );
    await rewritePgnAccountTags(pgnPath, "lichess", username);

    unwrap(
      await commands.convertPgn(
        pgnPath,
        dbPath,
        lastGameDate ? lastGameDate / 1000 : null,
        profileTitle,
        null,
      ),
    );

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
    const { lastGameDate } = await getAccountSyncStateFromProfileDb(dbPath, accountKey);

    const appDir = await appDataDir();
    const pgnPath = await getAccountPgnPath({
      appDataDir: appDir,
      profileId,
      platform: "chesscom",
      username,
    });
    await downloadChessCom(username, lastGameDate, pgnPath, `chesscom_${profileId}_${username}`);
    await rewritePgnAccountTags(pgnPath, "chesscom", username);

    unwrap(
      await commands.convertPgn(
        pgnPath,
        dbPath,
        lastGameDate ? lastGameDate / 1000 : null,
        profileTitle,
        null,
      ),
    );

    const updatedSession: Session = {
      ...input.session,
      updatedAt: Date.now(),
      chessCom: { ...input.session.chessCom, stats: updatedStats ?? input.session.chessCom.stats },
    };

    return { updatedSession };
  }

  return { updatedSession: input.session };
}
