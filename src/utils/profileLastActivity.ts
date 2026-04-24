import { getAccountKey } from "@/utils/accountKeys";
import { getProfileDbPath } from "@/utils/profileDb";
import { getAccountSyncStateFromProfileDb } from "@/utils/profileGameSync";
import type { Session } from "@/utils/session";

const SESSION_DB_ACTIVITY_CACHE_TTL_MS = 45_000;
const SESSION_DB_ACTIVITY_CACHE_LIMIT = 400;

type SessionDbActivityCacheEntry = {
  signature: string;
  value: number | null;
  cachedAt: number;
};

const sessionDbActivityCache = new Map<string, SessionDbActivityCacheEntry>();

function getSessionMeta(session: Session): { platform: "lichess" | "chesscom"; username: string } | null {
  if (session.lichess?.username) {
    return { platform: "lichess", username: session.lichess.username };
  }
  if (session.chessCom?.username) {
    return { platform: "chesscom", username: session.chessCom.username };
  }
  return null;
}

function getSessionDbCacheKey(session: Session): string | null {
  const meta = getSessionMeta(session);
  const profileId = session.profileId?.trim();
  if (!meta || !profileId || !meta.username) return null;
  return `${profileId}:${meta.platform}:${meta.username}`;
}

function getSessionActivitySignature(session: Session): string {
  const stats = session.chessCom?.stats;
  return [
    session.updatedAt ?? 0,
    session.lichess?.account?.seenAt ?? "",
    stats?.chess_bullet?.last?.date ?? "",
    stats?.chess_blitz?.last?.date ?? "",
    stats?.chess_rapid?.last?.date ?? "",
    stats?.chess_daily?.last?.date ?? "",
  ].join("|");
}

function rememberSessionDbActivity(key: string, entry: SessionDbActivityCacheEntry) {
  if (sessionDbActivityCache.has(key)) {
    sessionDbActivityCache.delete(key);
  }
  sessionDbActivityCache.set(key, entry);

  while (sessionDbActivityCache.size > SESSION_DB_ACTIVITY_CACHE_LIMIT) {
    const oldestKey = sessionDbActivityCache.keys().next().value;
    if (oldestKey == null) break;
    sessionDbActivityCache.delete(oldestKey);
  }
}

async function getSessionDbLastGameDate(session: Session): Promise<number | null> {
  const cacheKey = getSessionDbCacheKey(session);
  const meta = getSessionMeta(session);
  const profileId = session.profileId?.trim();
  if (!cacheKey || !meta || !profileId) return null;

  const signature = getSessionActivitySignature(session);
  const now = Date.now();
  const cached = sessionDbActivityCache.get(cacheKey);
  if (cached && cached.signature === signature && now - cached.cachedAt <= SESSION_DB_ACTIVITY_CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const profileDbPath = await getProfileDbPath(profileId);
    const accountKey = getAccountKey(meta.platform, meta.username);
    const { lastGameDate } = await getAccountSyncStateFromProfileDb(profileDbPath, accountKey);
    const value = lastGameDate ?? null;
    rememberSessionDbActivity(cacheKey, { signature, value, cachedAt: now });
    return value;
  } catch {
    rememberSessionDbActivity(cacheKey, { signature, value: null, cachedAt: now });
    return null;
  }
}

function getSessionLiveActivity(session: Session): number[] {
  const activityDates: number[] = [];

  if (session.lichess?.account?.seenAt) {
    activityDates.push(session.lichess.account.seenAt);
  }

  const stats = session.chessCom?.stats;
  if (stats) {
    const chessComLastDates = [
      stats.chess_bullet?.last?.date,
      stats.chess_blitz?.last?.date,
      stats.chess_rapid?.last?.date,
      stats.chess_daily?.last?.date,
    ]
      .filter((d): d is number => d != null)
      .map((d) => d * 1000);
    if (chessComLastDates.length > 0) {
      activityDates.push(Math.max(...chessComLastDates));
    }
  }

  return activityDates;
}

async function getSessionLastActivity(session: Session): Promise<number | null> {
  const activityDates = getSessionLiveActivity(session);
  const dbLastGameDate = await getSessionDbLastGameDate(session);
  if (dbLastGameDate != null) {
    activityDates.push(dbLastGameDate);
  }
  return activityDates.length > 0 ? Math.max(...activityDates) : null;
}

export async function loadProfilesLastActivityMap(input: {
  profileIds: string[];
  sessions: Session[];
}): Promise<Map<string, number | null>> {
  const sessionsByProfile = new Map<string, Session[]>();
  for (const session of input.sessions) {
    const profileId = session.profileId?.trim();
    if (!profileId) continue;
    const list = sessionsByProfile.get(profileId) ?? [];
    list.push(session);
    sessionsByProfile.set(profileId, list);
  }

  const activityMap = new Map<string, number | null>();
  for (const profileId of input.profileIds) {
    const linkedSessions = sessionsByProfile.get(profileId) ?? [];
    if (linkedSessions.length === 0) {
      activityMap.set(profileId, null);
      continue;
    }

    const lastDates = await Promise.all(linkedSessions.map((session) => getSessionLastActivity(session)));
    const validDates = lastDates.filter((d): d is number => d != null);
    activityMap.set(profileId, validDates.length > 0 ? Math.max(...validDates) : null);
  }

  return activityMap;
}

export function areLastActivityMapsEqual(left: Map<string, number | null>, right: Map<string, number | null>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}
