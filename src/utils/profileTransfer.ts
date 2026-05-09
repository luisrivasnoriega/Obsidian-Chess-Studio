import { invoke } from "@tauri-apps/api/core";
import { appDataDir, resolve } from "@tauri-apps/api/path";
import {
  exists,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import type { Dispatch, SetStateAction } from "react";
import { commands } from "@/bindings";
import { type FileMetadata, normalizeFileInfoMetadata, processEntriesRecursively } from "@/features/files/utils/file";
import { getPuzzleVariantsDirectory, getVariantsDirectory } from "@/features/variants/utils/profileDir";
import type { Profile, ProfilePawnStructuresUiState, ProfileStatsUiState } from "@/state/atoms";
import { getAccountPgnPath } from "@/utils/accountPgnPaths";
import { readInfoMetadata } from "@/utils/files";
import {
  getPgnPuzzleProgressSnapshot,
  mergePgnPuzzleProgressSnapshot,
  type PgnPuzzleProgressSnapshot,
} from "@/utils/pgnPuzzleProgress";
import { getProfileDbPath } from "@/utils/profileDb";
import { normalizeProfileName } from "@/utils/profiles";
import {
  ensurePuzzleVariantProfileTags,
  PUZZLE_VARIANTS_TAG,
  parsePuzzleVariantTags,
} from "@/utils/puzzleVariantMetadata";
import type { Session } from "@/utils/session";
import { genID } from "@/utils/tabs";
import { unwrap } from "@/utils/unwrap";

type ProfileStatsUiStateByProfile = Record<string, ProfileStatsUiState>;
type ProfilePawnUiStateByProfile = Record<string, ProfilePawnStructuresUiState>;

export type ProfilePackageVariantEntry = {
  relativePath: string;
  pgn: string;
  info: unknown;
};

export type ProfilePackagePuzzleVariantEntry = {
  relativePath: string;
  pgn: string;
  info: unknown;
};

export type ProfilePackagePuzzleProgressEntry = {
  relativePath: string;
  progress: PgnPuzzleProgressSnapshot;
};

export type ProfilePackageAccountPgnEntry = {
  fileName: string;
  pgn: string;
};

export type ProfilePackageAnalyzedGameEntry = {
  gameId: string;
  analyzedPgn: string;
};

export type ProfilePackageGameStatsEntry = {
  gameId: string;
  accuracy: number;
  acpl: number;
  estimatedElo: number | null;
  resistance: number | null;
  eloEstimatedBalanced: number | null;
  opponentEstimatedElo: number | null;
  opponentRatingElo: number | null;
};

export type ProfileTransferPackageV1 = {
  schema: "ocs-profile-package";
  version: 1;
  exportedAt: string;
  profile: Profile;
  sessions: Session[];
  profileStatsUiState: unknown | null;
  profilePawnStructuresUiState: unknown | null;
  profileDbBase64: string;
  accountPgnFiles: ProfilePackageAccountPgnEntry[];
  variants: ProfilePackageVariantEntry[];
  puzzleVariants?: ProfilePackagePuzzleVariantEntry[];
  puzzleProgress?: ProfilePackagePuzzleProgressEntry[];
  analysis: {
    analyzedGames: ProfilePackageAnalyzedGameEntry[];
    gameStats: ProfilePackageGameStatsEntry[];
  };
};

export type ProfilePackageBuildSummary = {
  sessions: number;
  accountFiles: number;
  variants: number;
  puzzleVariants: number;
  puzzleProgress: number;
  analyzedGames: number;
  stats: number;
};

export type ProfilePackageImportSummary = {
  profileId: string;
  profileName: string;
  sessions: number;
  accountFiles: number;
  variants: number;
  puzzleVariants: number;
  puzzleProgress: number;
  analyzedGames: number;
  stats: number;
};

const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;

export function sessionMeta(session: { lichess?: { username: string }; chessCom?: { username: string } }) {
  if (session.lichess?.username) return { platform: "lichess" as const, username: session.lichess.username };
  if (session.chessCom?.username) return { platform: "chesscom" as const, username: session.chessCom.username };
  return { platform: "unknown" as const, username: "-" };
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function profileRelativePath(rootDir: string, targetPath: string): string {
  const root = rootDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = targetPath.replace(/\\/g, "/");
  const rootLower = root.toLowerCase();
  const targetLower = target.toLowerCase();
  if (targetLower.startsWith(`${rootLower}/`)) {
    return target.slice(root.length + 1);
  }
  return target.split("/").filter(Boolean).pop() ?? target;
}

export function sanitizePackageRelativePath(input: string): string | null {
  const normalized = input.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!normalized || ABSOLUTE_PATH_RE.test(normalized) || normalized.includes("\0")) {
    return null;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  const candidate = segments.join("/");
  if (!candidate.toLowerCase().endsWith(".pgn")) {
    return null;
  }
  return candidate;
}

export function parentDir(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return normalized;
  }
  return normalized.slice(0, index);
}

export function safePgnFileName(value: string): string | null {
  const name = value.trim();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return null;
  }
  if (!name.toLowerCase().endsWith(".pgn")) {
    return null;
  }
  return name;
}

export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function toI64NumberOrNull(value: unknown): number | null {
  const numeric = toNumberOrNull(value);
  if (numeric == null) return null;
  if (!Number.isFinite(numeric)) return null;
  if (Math.abs(numeric) > Number.MAX_SAFE_INTEGER) return null;
  return Math.round(numeric);
}

function normalizePuzzleProgressSnapshot(raw: unknown): PgnPuzzleProgressSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<PgnPuzzleProgressSnapshot>;
  const solved = Array.isArray(record.solved)
    ? record.solved.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    : [];
  const attempted = Array.isArray(record.attempted)
    ? record.attempted.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    : [];
  const firstAttemptRaw = record.firstAttempt && typeof record.firstAttempt === "object" ? record.firstAttempt : {};
  const firstAttempt: PgnPuzzleProgressSnapshot["firstAttempt"] = {};
  for (const [key, result] of Object.entries(firstAttemptRaw)) {
    if (result === "correct" || result === "incorrect") {
      firstAttempt[key] = result;
    }
  }
  const solveTimesRaw = record.solveTimes && typeof record.solveTimes === "object" ? record.solveTimes : {};
  const solveTimes: PgnPuzzleProgressSnapshot["solveTimes"] = {};
  for (const [key, value] of Object.entries(solveTimesRaw)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      solveTimes[key] = Math.round(value);
    }
  }
  return { solved, attempted, firstAttempt, solveTimes };
}

export function validateProfileTransferPackage(raw: string): ProfileTransferPackageV1 {
  const parsed = JSON.parse(raw) as Partial<ProfileTransferPackageV1> | null;
  if (
    !parsed ||
    parsed.schema !== "ocs-profile-package" ||
    parsed.version !== 1 ||
    !parsed.profile ||
    typeof parsed.profile.id !== "string" ||
    typeof parsed.profile.name !== "string" ||
    typeof parsed.profileDbBase64 !== "string"
  ) {
    throw new Error("Invalid profile package format.");
  }
  return parsed as ProfileTransferPackageV1;
}

async function replaceProfileDbFromPackage(profileDbPath: string, profileDbBytes: Uint8Array): Promise<void> {
  const replacementPath = `${profileDbPath}.cloud-import-${Date.now()}.tmp`;
  await writeFile(replacementPath, profileDbBytes);
  try {
    await invoke("replace_profile_db_file", {
      target: profileDbPath,
      replacement: replacementPath,
    });
  } catch (error) {
    try {
      await remove(replacementPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw error;
  }
}

async function collectAllProfileGameIds(profileId: string, profileUsernames: string[]) {
  const ids = new Set<string>();
  const pageSize = 500;
  const maxPages = 4000;
  const gameHistoryLimit = 1_000_000;

  let page = 1;
  let totalCount = 0;
  while (page <= maxPages) {
    const res = unwrap(
      await commands.dashboardGetGamesHistoryRows({
        profileId,
        profileUsernames,
        gameHistoryLimit,
        page,
        pageSize,
        eventFilterId: null,
        selectedOpponentId: null,
        opponentContains: null,
        timeControlCategory: null,
        resultFilter: null,
        sourceFilter: null,
        playerColor: null,
        minMoves: null,
        sortBy: "date",
        sortDirection: "desc",
        includeBasePgn: null,
        includeAnalyzedPgn: null,
        includeAnalysisStats: null,
      }),
    );
    const rows = res.rows ?? [];
    totalCount = res.totalCount ?? totalCount;
    for (const row of rows) {
      if (row.analysisGameId) {
        ids.add(String(row.analysisGameId));
      }
    }
    if (rows.length === 0) break;
    if (totalCount > 0 && page * pageSize >= totalCount) break;
    page += 1;
  }

  return ids;
}

export async function buildProfileTransferPackage(input: {
  profile: Profile;
  sessions: Session[];
  profileStatsUiStateByProfile: ProfileStatsUiStateByProfile;
  profilePawnUiStateByProfile: ProfilePawnUiStateByProfile;
}): Promise<{ pkg: ProfileTransferPackageV1; summary: ProfilePackageBuildSummary }> {
  const profileId = input.profile.id;
  const profileDbPath = await getProfileDbPath(profileId);
  if (!(await exists(profileDbPath))) {
    throw new Error("Could not find the profile database for export.");
  }

  const profileDbBytes = await readFile(profileDbPath);
  const profileDbBase64 = bytesToBase64(new Uint8Array(profileDbBytes));

  const linkedSessions = input.sessions.filter((session) => session.profileId === profileId);
  const profileUsernames = linkedSessions
    .map((session) => session.lichess?.username ?? session.chessCom?.username ?? null)
    .filter((value): value is string => !!value);

  const appData = await appDataDir();
  const dbDir = await resolve(appData, "db");
  const accountPgnFiles: ProfilePackageAccountPgnEntry[] = [];
  const seenAccountFileNames = new Set<string>();
  if (await exists(dbDir)) {
    const entries = await readDir(dbDir);
    for (const entry of entries) {
      if (!entry.isFile) continue;
      const fileName = entry.name ?? "";
      if (!fileName.toLowerCase().endsWith(".pgn")) continue;
      const expectedPrefix = `profile_${profileId}_`;
      if (!fileName.startsWith(expectedPrefix)) continue;
      const filePath = await resolve(dbDir, fileName);
      const pgn = await readTextFile(filePath);
      accountPgnFiles.push({ fileName, pgn });
      seenAccountFileNames.add(fileName.toLowerCase());
    }
  }

  for (const session of linkedSessions) {
    const meta = sessionMeta(session);
    if (meta.platform !== "lichess" && meta.platform !== "chesscom") continue;
    if (!meta.username || meta.username === "-") continue;

    const scopedPath = await getAccountPgnPath({
      appDataDir: appData,
      profileId,
      platform: meta.platform,
      username: meta.username,
    });
    const scopedFileName = scopedPath.replace(/\\/g, "/").split("/").pop() ?? "";
    if (scopedFileName && !seenAccountFileNames.has(scopedFileName.toLowerCase()) && (await exists(scopedPath))) {
      const pgn = await readTextFile(scopedPath);
      accountPgnFiles.push({ fileName: scopedFileName, pgn });
      seenAccountFileNames.add(scopedFileName.toLowerCase());
    }

    const legacyFileName = `${meta.username}_${meta.platform}.pgn`;
    if (seenAccountFileNames.has(legacyFileName.toLowerCase())) continue;
    const legacyPath = await resolve(dbDir, legacyFileName);
    if (await exists(legacyPath)) {
      const pgn = await readTextFile(legacyPath);
      accountPgnFiles.push({ fileName: legacyFileName, pgn });
      seenAccountFileNames.add(legacyFileName.toLowerCase());
    }
  }

  const variantsDir = await getVariantsDirectory(profileId);
  const variants: ProfilePackageVariantEntry[] = [];
  if (await exists(variantsDir)) {
    const variantEntries = await readDir(variantsDir);
    const allVariantEntries = await processEntriesRecursively(variantsDir, variantEntries);
    const variantsOnly = allVariantEntries.filter(
      (entry): entry is FileMetadata => entry.type === "file" && entry.metadata.type === "variants",
    );
    for (const variantFile of variantsOnly) {
      const pgn = await readTextFile(variantFile.path);
      const info = await readInfoMetadata(variantFile.path, "variants");
      variants.push({
        relativePath: profileRelativePath(variantsDir, variantFile.path),
        pgn,
        info,
      });
    }
  }

  const puzzleVariantsDir = await getPuzzleVariantsDirectory(profileId);
  const puzzleVariants: ProfilePackagePuzzleVariantEntry[] = [];
  const puzzleProgress: ProfilePackagePuzzleProgressEntry[] = [];
  if (await exists(puzzleVariantsDir)) {
    const puzzleVariantEntries = await readDir(puzzleVariantsDir);
    const allPuzzleVariantEntries = await processEntriesRecursively(puzzleVariantsDir, puzzleVariantEntries);
    const puzzleVariantsOnly = allPuzzleVariantEntries.filter(
      (entry): entry is FileMetadata =>
        entry.type === "file" && entry.metadata.type === "puzzle" && entry.metadata.tags.includes(PUZZLE_VARIANTS_TAG),
    );
    for (const puzzleVariantFile of puzzleVariantsOnly) {
      const parsedTags = parsePuzzleVariantTags(puzzleVariantFile.metadata.tags);
      if (parsedTags.profileId && parsedTags.profileId !== profileId) {
        continue;
      }

      const pgn = await readTextFile(puzzleVariantFile.path);
      const info = await readInfoMetadata(puzzleVariantFile.path, "puzzle");
      const relativePath = profileRelativePath(puzzleVariantsDir, puzzleVariantFile.path);
      puzzleVariants.push({
        relativePath,
        pgn,
        info: {
          ...info,
          type: "puzzle",
          tags: ensurePuzzleVariantProfileTags(info.tags, profileId),
        },
      });

      const progress = getPgnPuzzleProgressSnapshot(puzzleVariantFile.path);
      if (
        progress.solved.length > 0 ||
        progress.attempted.length > 0 ||
        Object.keys(progress.firstAttempt).length > 0 ||
        Object.keys(progress.solveTimes).length > 0
      ) {
        puzzleProgress.push({ relativePath, progress });
      }
    }
  }

  const analyzedRows = unwrap(await commands.analysisDbGetAllAnalyzedGames(profileId));
  const analyzedGames: ProfilePackageAnalyzedGameEntry[] = analyzedRows.map((row) => ({
    gameId: row.game_id,
    analyzedPgn: row.analyzed_pgn,
  }));

  const analysisGameIds = await collectAllProfileGameIds(profileId, profileUsernames);
  for (const row of analyzedRows) {
    if (row.game_id) analysisGameIds.add(String(row.game_id));
  }

  const statsRows =
    analysisGameIds.size > 0
      ? unwrap(await commands.analysisDbGetGameStatsBulk(Array.from(analysisGameIds), profileId))
      : [];
  const gameStats: ProfilePackageGameStatsEntry[] = statsRows.map((row) => ({
    gameId: String(row.gameId),
    accuracy: row.accuracy,
    acpl: row.acpl,
    estimatedElo: toNumberOrNull(row.estimatedElo),
    resistance: toNumberOrNull(row.resistance),
    eloEstimatedBalanced: toNumberOrNull(row.eloEstimatedBalanced),
    opponentEstimatedElo: null,
    opponentRatingElo: null,
  }));

  const pkg: ProfileTransferPackageV1 = {
    schema: "ocs-profile-package",
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: input.profile,
    sessions: linkedSessions,
    profileStatsUiState: input.profileStatsUiStateByProfile[profileId] ?? null,
    profilePawnStructuresUiState: input.profilePawnUiStateByProfile[profileId] ?? null,
    profileDbBase64,
    accountPgnFiles,
    variants,
    puzzleVariants,
    puzzleProgress,
    analysis: {
      analyzedGames,
      gameStats,
    },
  };

  return {
    pkg,
    summary: {
      sessions: linkedSessions.length,
      accountFiles: accountPgnFiles.length,
      variants: variants.length,
      puzzleVariants: puzzleVariants.length,
      puzzleProgress: puzzleProgress.length,
      analyzedGames: analyzedGames.length,
      stats: gameStats.length,
    },
  };
}

export async function importProfileTransferPackage(input: {
  pkg: ProfileTransferPackageV1;
  profiles: Profile[];
  mode?: "copy" | "replace-existing";
  setProfiles: Dispatch<SetStateAction<Profile[]>>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setProfileStatsUiStateByProfile: Dispatch<SetStateAction<ProfileStatsUiStateByProfile>>;
  setProfilePawnUiStateByProfile: Dispatch<SetStateAction<ProfilePawnUiStateByProfile>>;
  setActiveProfileId: (profileId: string) => void;
}): Promise<ProfilePackageImportSummary> {
  const sourceProfile = input.pkg.profile as Profile;
  const sourceProfileId = sourceProfile.id.trim() || genID();
  const mode = input.mode ?? "copy";
  let targetProfileId = sourceProfileId;
  if (mode === "copy" && input.profiles.some((profile) => profile.id === targetProfileId)) {
    targetProfileId = genID();
  }

  const normalizedName = normalizeProfileName(sourceProfile.name) || "Profile";
  let targetProfileName = normalizedName;
  const shouldAvoidNameCollision = mode === "copy" || !input.profiles.some((profile) => profile.id === targetProfileId);
  if (
    shouldAvoidNameCollision &&
    input.profiles.some((profile) => profile.name.toLowerCase() === targetProfileName.toLowerCase())
  ) {
    let suffix = 2;
    while (
      input.profiles.some((profile) => profile.name.toLowerCase() === `${normalizedName} (${suffix})`.toLowerCase())
    ) {
      suffix += 1;
    }
    targetProfileName = `${normalizedName} (${suffix})`;
  }

  const now = Date.now();
  const importedProfile: Profile = {
    ...sourceProfile,
    id: targetProfileId,
    name: targetProfileName,
    createdAt: typeof sourceProfile.createdAt === "number" ? sourceProfile.createdAt : now,
    updatedAt: now,
  };

  const normalizedSessions = (Array.isArray(input.pkg.sessions) ? input.pkg.sessions : [])
    .map((value) => value as Session)
    .map((session) => {
      const meta = sessionMeta(session);
      if (meta.platform === "unknown" || !meta.username || meta.username === "-") return null;
      return {
        ...session,
        profileId: targetProfileId,
        player: targetProfileName,
        updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : now,
      } as Session;
    })
    .filter((session): session is Session => !!session);

  const profileDbPath = await getProfileDbPath(targetProfileId);
  const profileDbBytes = base64ToBytes(input.pkg.profileDbBase64);
  await replaceProfileDbFromPackage(profileDbPath, profileDbBytes);
  unwrap(await commands.initProfileDb(profileDbPath, targetProfileName, null));

  const appData = await appDataDir();
  const dbDir = await resolve(appData, "db");
  await mkdir(dbDir, { recursive: true });

  let accountFilesImported = 0;
  const accountPgnFiles = Array.isArray(input.pkg.accountPgnFiles) ? input.pkg.accountPgnFiles : [];
  for (const entry of accountPgnFiles) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Partial<ProfilePackageAccountPgnEntry>;
    if (typeof item.fileName !== "string" || typeof item.pgn !== "string") continue;
    const safeName = safePgnFileName(item.fileName);
    if (!safeName) continue;
    const sourcePrefix = `profile_${sourceProfileId}_`;
    const normalizedSuffix = safeName.startsWith(sourcePrefix)
      ? safeName.slice(sourcePrefix.length)
      : safeName.startsWith("profile_")
        ? safeName.replace(/^profile_[^_]+_/, "")
        : safeName;
    const targetName = `profile_${targetProfileId}_${normalizedSuffix}`;
    const targetPath = await resolve(dbDir, targetName);
    await writeTextFile(targetPath, item.pgn);
    accountFilesImported += 1;
  }

  let variantsImported = 0;
  const variantsDir = await getVariantsDirectory(targetProfileId);
  await mkdir(variantsDir, { recursive: true });
  const variants = Array.isArray(input.pkg.variants) ? input.pkg.variants : [];
  for (const entry of variants) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Partial<ProfilePackageVariantEntry>;
    const cleanRelativePath =
      typeof item.relativePath === "string" ? sanitizePackageRelativePath(item.relativePath) : null;
    if (!cleanRelativePath || typeof item.pgn !== "string") continue;

    const targetPgnPath = await resolve(variantsDir, cleanRelativePath);
    await mkdir(parentDir(targetPgnPath), { recursive: true });
    await writeTextFile(targetPgnPath, item.pgn);

    const normalizedInfo = normalizeFileInfoMetadata(item.info, "variants");
    const targetInfoPath = targetPgnPath.replace(/\.pgn$/i, ".info");
    await writeTextFile(targetInfoPath, JSON.stringify(normalizedInfo, null, 2));
    variantsImported += 1;
  }

  let puzzleVariantsImported = 0;
  const puzzleVariantsDir = await getPuzzleVariantsDirectory(targetProfileId);
  await mkdir(puzzleVariantsDir, { recursive: true });
  const puzzleVariants = Array.isArray(input.pkg.puzzleVariants) ? input.pkg.puzzleVariants : [];
  for (const entry of puzzleVariants) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Partial<ProfilePackagePuzzleVariantEntry>;
    const cleanRelativePath =
      typeof item.relativePath === "string" ? sanitizePackageRelativePath(item.relativePath) : null;
    if (!cleanRelativePath || typeof item.pgn !== "string") continue;

    const targetPgnPath = await resolve(puzzleVariantsDir, cleanRelativePath);
    await mkdir(parentDir(targetPgnPath), { recursive: true });
    await writeTextFile(targetPgnPath, item.pgn);

    const normalizedInfo = normalizeFileInfoMetadata(item.info, "puzzle");
    const targetInfo = {
      ...normalizedInfo,
      type: "puzzle" as const,
      tags: ensurePuzzleVariantProfileTags(normalizedInfo.tags, targetProfileId),
    };
    const targetInfoPath = targetPgnPath.replace(/\.pgn$/i, ".info");
    await writeTextFile(targetInfoPath, JSON.stringify(targetInfo, null, 2));
    puzzleVariantsImported += 1;
  }

  let puzzleProgressImported = 0;
  const puzzleProgress = Array.isArray(input.pkg.puzzleProgress) ? input.pkg.puzzleProgress : [];
  for (const entry of puzzleProgress) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Partial<ProfilePackagePuzzleProgressEntry>;
    const cleanRelativePath =
      typeof item.relativePath === "string" ? sanitizePackageRelativePath(item.relativePath) : null;
    const progress = normalizePuzzleProgressSnapshot(item.progress);
    if (!cleanRelativePath || !progress) continue;

    const targetPgnPath = await resolve(puzzleVariantsDir, cleanRelativePath);
    mergePgnPuzzleProgressSnapshot(targetPgnPath, progress);
    puzzleProgressImported += 1;
  }

  const analysis = input.pkg.analysis && typeof input.pkg.analysis === "object" ? input.pkg.analysis : null;
  const analyzedGamesRaw = Array.isArray(analysis?.analyzedGames) ? analysis.analyzedGames : [];
  const gameStatsRaw = Array.isArray(analysis?.gameStats) ? analysis.gameStats : [];

  let analyzedImported = 0;
  for (const entry of analyzedGamesRaw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Partial<ProfilePackageAnalyzedGameEntry>;
    if (typeof item.gameId !== "string" || typeof item.analyzedPgn !== "string") continue;
    unwrap(await commands.analysisDbSetAnalyzedGame(item.gameId, item.analyzedPgn, targetProfileId));
    analyzedImported += 1;
  }

  let statsImported = 0;
  for (const entry of gameStatsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Partial<ProfilePackageGameStatsEntry>;
    if (typeof item.gameId !== "string") continue;
    if (typeof item.accuracy !== "number" || typeof item.acpl !== "number") continue;

    unwrap(
      await commands.analysisDbSetGameStats(
        item.gameId,
        {
          accuracy: item.accuracy,
          acpl: item.acpl,
          estimatedElo: toI64NumberOrNull(item.estimatedElo),
          resistance: item.resistance ?? null,
          eloEstimatedBalanced: toI64NumberOrNull(item.eloEstimatedBalanced),
          opponentEstimatedElo: toI64NumberOrNull(item.opponentEstimatedElo),
          opponentRatingElo: toI64NumberOrNull(item.opponentRatingElo),
        } as any,
        targetProfileId,
      ),
    );
    statsImported += 1;
  }

  input.setProfiles((prev) => {
    const existingIndex = prev.findIndex((profile) => profile.id === targetProfileId);
    if (existingIndex < 0) {
      return [...prev, importedProfile];
    }
    const next = [...prev];
    next[existingIndex] = importedProfile;
    return next;
  });

  input.setSessions((prev) => {
    const base =
      mode === "replace-existing" ? prev.filter((session) => session.profileId !== targetProfileId) : [...prev];
    for (const importedSession of normalizedSessions) {
      const meta = sessionMeta(importedSession);
      const key = `${targetProfileId}:${meta.platform}:${meta.username}`.toLowerCase();
      const existingIndex = base.findIndex((candidate) => {
        const candidateMeta = sessionMeta(candidate);
        const candidateKey =
          `${candidate.profileId ?? ""}:${candidateMeta.platform}:${candidateMeta.username}`.toLowerCase();
        return candidateKey === key;
      });
      if (existingIndex >= 0) {
        base[existingIndex] = importedSession;
      } else {
        base.push(importedSession);
      }
    }
    return base;
  });

  if (input.pkg.profileStatsUiState != null) {
    input.setProfileStatsUiStateByProfile((prev) => ({
      ...prev,
      [targetProfileId]: input.pkg.profileStatsUiState as any,
    }));
  }
  if (input.pkg.profilePawnStructuresUiState != null) {
    input.setProfilePawnUiStateByProfile((prev) => ({
      ...prev,
      [targetProfileId]: input.pkg.profilePawnStructuresUiState as any,
    }));
  }
  input.setActiveProfileId(targetProfileId);

  try {
    window.dispatchEvent(new Event("puzzles:updated"));
    window.dispatchEvent(new Event("puzzle-variants:updated"));
    window.dispatchEvent(new Event("pgn-puzzles:progress-updated"));
  } catch {}

  return {
    profileId: targetProfileId,
    profileName: targetProfileName,
    sessions: normalizedSessions.length,
    accountFiles: accountFilesImported,
    variants: variantsImported,
    puzzleVariants: puzzleVariantsImported,
    puzzleProgress: puzzleProgressImported,
    analyzedGames: analyzedImported,
    stats: statsImported,
  };
}
