import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Profile } from "@/state/atoms";
import { getAccountKey } from "@/utils/accountKeys";
import type { AccountSyncPlatform } from "@/utils/accountSyncState";
import { getChessComAccount } from "@/utils/chess.com/api";
import { getLichessAccount } from "@/utils/lichess/api";
import type { Session } from "@/utils/session";

type BackendAccountImportStats = {
  last_game_utc_ms: number | null;
  count: number;
};

type BackendAccountSyncProgress = {
  profile_id: string;
  account_key: string;
  platform: string;
  total_batches: number;
  completed_batches: number;
  current_batch: number;
  batch_label: string;
  cooldown_seconds?: number | null;
};

type BackendAccountSyncResult = {
  imported_games: number;
};

type BackendFideBroadcastImportResult = {
  imported_games?: number;
  importedGames?: number;
  discovered_tournaments?: number;
  discoveredTournaments?: number;
  processed_tournaments?: number;
  processedTournaments?: number;
};

function parseAccountKey(accountKey: string): { platform: AccountSyncPlatform; username: string } | null {
  const match = accountKey.match(/^(lichess|chesscom):(.*)$/i);
  if (!match) return null;
  const platform = match[1]?.toLowerCase() as AccountSyncPlatform;
  const username = match[2] ?? "";
  if (!username) return null;
  return { platform, username };
}

function extractProfileIdFromDbPath(dbPath: string): string | null {
  const normalized = dbPath.replaceAll("\\", "/");
  const match = normalized.match(/\/profile_(.+)\.db3$/i);
  return match?.[1] ?? null;
}

export async function getAccountSyncStateFromProfileDb(profileDbPath: string, accountKey: string) {
  try {
    const profileId = extractProfileIdFromDbPath(profileDbPath);
    const meta = parseAccountKey(accountKey);
    if (!profileId || !meta) return { lastGameDate: null as number | null, count: 0 };

    const stats = await invoke<BackendAccountImportStats>("get_account_import_stats", {
      profileId,
      platform: meta.platform,
      username: meta.username,
    });

    return { lastGameDate: stats.last_game_utc_ms ?? null, count: stats.count ?? 0 };
  } catch {
    return { lastGameDate: null as number | null, count: 0 };
  }
}

export type SyncBatchUpdate = {
  platform: AccountSyncPlatform | "fide";
  totalBatches: number;
  completedBatches: number;
  currentBatch: number;
  batchLabel: string;
  cooldownSeconds?: number;
};

export async function syncSessionGamesToProfileDb(input: {
  profile: Profile;
  session: Session;
  onBatchUpdate?: (update: SyncBatchUpdate) => void;
}) {
  const profileId = input.profile.id;
  const profileTitle = input.profile.name || `Profile ${profileId}`;

  if (input.session.lichess) {
    const username = input.session.lichess.username;
    const token = input.session.lichess.accessToken ?? input.profile.lichessToken ?? null;
    const accountKey = getAccountKey("lichess", username);
    let unlisten: (() => void) | null = null;
    let result: BackendAccountSyncResult | null = null;
    try {
      unlisten = await listen<BackendAccountSyncProgress>("account-sync-progress", ({ payload }) => {
        if (payload.profile_id !== profileId) return;
        if (payload.account_key !== accountKey) return;
        input.onBatchUpdate?.({
          platform: "lichess",
          totalBatches: payload.total_batches,
          completedBatches: payload.completed_batches,
          currentBatch: payload.current_batch,
          batchLabel: payload.batch_label,
          cooldownSeconds: payload.cooldown_seconds ?? undefined,
        });
      });

      result = await invoke<BackendAccountSyncResult>("sync_account_games_to_profile_db", {
        profileId,
        profileTitle,
        platform: "lichess",
        username,
        token,
      });
    } finally {
      unlisten?.();
    }

    const updatedAccount = await getLichessAccount({ token: token ?? undefined, username });

    const updatedSession: Session = {
      ...input.session,
      updatedAt: Date.now(),
      lichess: { ...input.session.lichess, account: updatedAccount ?? input.session.lichess.account },
    };

    return { updatedSession, importedGames: result?.imported_games ?? 0 };
  }

  if (input.session.chessCom) {
    const username = input.session.chessCom.username;
    const accountKey = getAccountKey("chesscom", username);
    let unlisten: (() => void) | null = null;
    let result: BackendAccountSyncResult | null = null;
    try {
      unlisten = await listen<BackendAccountSyncProgress>("account-sync-progress", ({ payload }) => {
        if (payload.profile_id !== profileId) return;
        if (payload.account_key !== accountKey) return;
        input.onBatchUpdate?.({
          platform: "chesscom",
          totalBatches: payload.total_batches,
          completedBatches: payload.completed_batches,
          currentBatch: payload.current_batch,
          batchLabel: payload.batch_label,
          cooldownSeconds: payload.cooldown_seconds ?? undefined,
        });
      });

      result = await invoke<BackendAccountSyncResult>("sync_account_games_to_profile_db", {
        profileId,
        profileTitle,
        platform: "chesscom",
        username,
        token: null,
      });
    } finally {
      unlisten?.();
    }

    const updatedStats = await getChessComAccount(username);

    const updatedSession: Session = {
      ...input.session,
      updatedAt: Date.now(),
      chessCom: { ...input.session.chessCom, stats: updatedStats ?? input.session.chessCom.stats },
    };

    return { updatedSession, importedGames: result?.imported_games ?? 0 };
  }

  return { updatedSession: input.session, importedGames: 0 };
}

export async function importFideBroadcastGamesToProfileDb(input: {
  profile: Profile;
  fideUrl?: string;
  onBatchUpdate?: (update: SyncBatchUpdate) => void;
}) {
  const profileId = input.profile.id;
  const profileTitle = input.profile.name || `Profile ${profileId}`;
  const fideUrl = input.fideUrl?.trim() || input.profile.fideId?.trim() || "";
  const fideId = fideUrl.match(/\/fide\/(\d+)/i)?.[1] ?? fideUrl.replace(/\D/g, "");

  if (!fideUrl || !fideId) {
    throw new Error("A FIDE ID or Lichess FIDE profile URL is required.");
  }

  const accountKey = `fide:${fideId}`;
  let unlisten: (() => void) | null = null;
  let result: BackendFideBroadcastImportResult | null = null;

  try {
    unlisten = await listen<BackendAccountSyncProgress>("account-sync-progress", ({ payload }) => {
      if (payload.profile_id !== profileId) return;
      if (payload.account_key !== accountKey) return;
      input.onBatchUpdate?.({
        platform: "fide",
        totalBatches: payload.total_batches,
        completedBatches: payload.completed_batches,
        currentBatch: payload.current_batch,
        batchLabel: payload.batch_label,
        cooldownSeconds: payload.cooldown_seconds ?? undefined,
      });
    });

    result = await invoke<BackendFideBroadcastImportResult>("import_fide_broadcast_games_to_profile", {
      profileId,
      profileTitle,
      fideUrl,
    });
  } finally {
    unlisten?.();
  }

  return {
    importedGames: result?.imported_games ?? result?.importedGames ?? 0,
    discoveredTournaments: result?.discovered_tournaments ?? result?.discoveredTournaments ?? 0,
    processedTournaments: result?.processed_tournaments ?? result?.processedTournaments ?? 0,
  };
}
