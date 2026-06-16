import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Divider,
  Flex,
  Group,
  Modal,
  Pagination,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCloud,
  IconEdit,
  IconFileExport,
  IconFileImport,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { appDataDir, resolve } from "@tauri-apps/api/path";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
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
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { playerStatsCommands } from "@/bindings/playerStats";
import type { SortState } from "@/components/GenericHeader";
import GenericHeader from "@/components/GenericHeader";
import { DatabaseDetails } from "@/features/databases/DatabasesPage";
import { type FileMetadata, normalizeFileInfoMetadata, processEntriesRecursively } from "@/features/files/utils/file";
import Databases from "@/features/profiles/components/PersonalCardPanels/Databases";
import { getPuzzleVariantsDirectory, getVariantsDirectory } from "@/features/variants/utils/profileDir";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import {
  activeProfileIdAtom,
  defaultProfilesPageUiState,
  type Profile,
  profilePawnStructuresUiStateByProfileAtom,
  profileStatsUiStateByProfileAtom,
  profilesAtom,
  profilesPageUiStateAtom,
  referenceDbAtom,
  sessionsAtom,
} from "@/state/atoms";
import {
  premiumActionButtonStyles,
  premiumMutedPanelStyle,
  premiumPanelStyle,
  premiumTabListStyle,
} from "@/styles/premiumSurface";
import { getAccountKey } from "@/utils/accountKeys";
import { getAccountPgnPath } from "@/utils/accountPgnPaths";
import { getAccountSyncState } from "@/utils/accountSyncState";
import { getAccountProtectionStatus, type Platform, validateCredentials } from "@/utils/accountVerification";
import { getChessComAccount } from "@/utils/chess.com/api";
import { type DatabaseInfo, getDatabases } from "@/utils/db";
import { readInfoMetadata } from "@/utils/files";
import { parseDate } from "@/utils/format";
import { getLichessAccount } from "@/utils/lichess/api";
import { isFailedToFetchError } from "@/utils/networkCooldown";
import {
  describeProfileCloudSyncTarget,
  downloadProfilePackageFromCloud,
  getProfileCloudSyncTarget,
  saveProfileCloudLocalState,
  syncProfilePackageWithCloud,
  uploadProfilePackageToCloud,
} from "@/utils/profileCloudSync";
import { getProfileDbPath, profileDbFilename, setProfileLichessToken } from "@/utils/profileDb";
import { importFideBroadcastGamesToProfileDb, syncSessionGamesToProfileDb } from "@/utils/profileGameSync";
import { areLastActivityMapsEqual, loadProfilesLastActivityMap } from "@/utils/profileLastActivity";
import { normalizeProfileName } from "@/utils/profiles";
import {
  buildProfileTransferPackage,
  importProfileTransferPackage,
  validateProfileTransferPackage,
} from "@/utils/profileTransfer";
import {
  ensurePuzzleVariantProfileTags,
  PUZZLE_VARIANTS_TAG,
  parsePuzzleVariantTags,
} from "@/utils/puzzleVariantMetadata";
import type { ChessComSession, LichessSession, Session } from "@/utils/session";
import { genID } from "@/utils/tabs";
import { unwrap } from "@/utils/unwrap";
import { AccountVerificationModal, type AccountVerificationResult } from "./components/modals/AccountVerificationModal";
import { AddProfileAccountModal, type AddProfileAccountPayload } from "./components/modals/AddProfileAccountModal";
import PawnStructuresPanel from "./components/PersonalCardPanels/PawnStructuresPanel";

function sessionMeta(session: { lichess?: { username: string }; chessCom?: { username: string } }) {
  if (session.lichess?.username) return { platform: "lichess" as const, username: session.lichess.username };
  if (session.chessCom?.username) return { platform: "chesscom" as const, username: session.chessCom.username };
  return { platform: "unknown" as const, username: "-" };
}

function getUnknownErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // Ignore serialization errors.
  }
  return null;
}

function cleanFideId(value: string): string {
  return value.replace(/\D/g, "");
}

function formatSyncError(e: unknown): string {
  if (e == null) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || String(e);
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

async function shouldSuppressAccountSyncToasts(input: {
  profileId: string;
  platform: "lichess" | "chesscom";
  username: string;
}): Promise<boolean> {
  try {
    const dbPath = await getProfileDbPath(input.profileId);
    const accountKey = getAccountKey(input.platform, input.username);
    const state = await getAccountSyncState({
      dbPath,
      accountKey,
      platform: input.platform,
    });
    if (!state) return false;
    if (state.running) return false;
    const ageMs = Date.now() - (state.updated_at_ms ?? 0);
    return ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function truncateMiddle(text: string, maxLen: number) {
  if (text.length <= maxLen) return text;
  const head = Math.floor((maxLen - 3) / 2);
  const tail = maxLen - 3 - head;
  return `${text.slice(0, head)}...${text.slice(text.length - tail)}`;
}

type ProfilePackageVariantEntry = {
  relativePath: string;
  pgn: string;
  info: unknown;
};

type ProfilePackagePuzzleVariantEntry = {
  relativePath: string;
  pgn: string;
  info: unknown;
};

type ProfilePackageAccountPgnEntry = {
  fileName: string;
  pgn: string;
};

type ProfilePackageAnalyzedGameEntry = {
  gameId: string;
  analyzedPgn: string;
};

type ProfilePackageGameStatsEntry = {
  gameId: string;
  accuracy: number;
  acpl: number;
  estimatedElo: number | null;
  resistance: number | null;
  eloEstimatedBalanced: number | null;
  opponentEstimatedElo: number | null;
  opponentRatingElo: number | null;
};

type ProfileTransferPackageV1 = {
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
  analysis: {
    analyzedGames: ProfilePackageAnalyzedGameEntry[];
    gameStats: ProfilePackageGameStatsEntry[];
  };
};

const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function profileRelativePath(rootDir: string, targetPath: string): string {
  const root = rootDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = targetPath.replace(/\\/g, "/");
  const rootLower = root.toLowerCase();
  const targetLower = target.toLowerCase();
  if (targetLower.startsWith(`${rootLower}/`)) {
    return target.slice(root.length + 1);
  }
  return target.split("/").filter(Boolean).pop() ?? target;
}

function sanitizePackageRelativePath(input: string): string | null {
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

function parentDir(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return normalized;
  }
  return normalized.slice(0, index);
}

function safePgnFileName(value: string): string | null {
  const name = value.trim();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return null;
  }
  if (!name.toLowerCase().endsWith(".pgn")) {
    return null;
  }
  return name;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function toI64NumberOrNull(value: unknown): number | null {
  const numeric = toNumberOrNull(value);
  if (numeric == null) return null;
  if (!Number.isFinite(numeric)) return null;
  if (Math.abs(numeric) > Number.MAX_SAFE_INTEGER) return null;
  return Math.round(numeric);
}

export default function ProfilesPage() {
  const { t } = useTranslation();
  const { layout } = useResponsiveLayout();
  const queryClient = useQueryClient();
  const [profilesPageUiState, setProfilesPageUiState] = useAtom(profilesPageUiStateAtom);
  const [profileQuery, setProfileQuery] = useState(profilesPageUiState.profileQuery);
  const [detailsTab, setDetailsTab] = useState<
    "database" | "overview" | "ratings" | "openings" | "stats" | "pawnStructures"
  >(profilesPageUiState.detailsTab);
  const [syncingAccountIds, setSyncingAccountIds] = useState<Set<string>>(new Set());
  const syncingAccountIdsRef = useRef<Set<string>>(new Set());
  const deletedSessionKeysRef = useRef<Set<string>>(new Set());

  const [profiles, setProfiles] = useAtom(profilesAtom);
  const [activeProfileId, setActiveProfileId] = useAtom(activeProfileIdAtom);
  const [sessions, setSessions] = useAtom(sessionsAtom);
  const [referenceDb, setReferenceDb] = useAtom(referenceDbAtom);
  const [profileStatsUiStateByProfile, setProfileStatsUiStateByProfile] = useAtom(profileStatsUiStateByProfileAtom);
  const [profilePawnUiStateByProfile, setProfilePawnUiStateByProfile] = useAtom(
    profilePawnStructuresUiStateByProfileAtom,
  );

  const [dbList, setDbList] = useState<DatabaseInfo[] | null>(null);
  const [dbLoading, setDbLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [convertLoading, setConvertLoading] = useState(false);
  const [profileTransferBusy, setProfileTransferBusy] = useState(false);
  const [cloudSyncBusy, setCloudSyncBusy] = useState(false);

  const [modalOpened, modal] = useDisclosure(false);
  const [accountModalOpened, accountModal] = useDisclosure(false);
  const [fideImportModalOpened, fideImportModal] = useDisclosure(false);
  const [verificationModalOpened, verificationModal] = useDisclosure(false);
  const [cloudSettingsOpened, cloudSettings] = useDisclosure(false);
  const [addAccountDefaultProfileId, setAddAccountDefaultProfileId] = useState<string | null>(null);
  const [pendingAccountPayload, setPendingAccountPayload] = useState<{
    payload: AddProfileAccountPayload;
    platform: Platform;
  } | null>(null);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [fideImportProfileId, setFideImportProfileId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftFideId, setDraftFideId] = useState("");
  const [draftFideImportUrl, setDraftFideImportUrl] = useState("");
  const [draftLichessToken, setDraftLichessToken] = useState("");
  const [profilesPage, setProfilesPage] = useState(Math.max(1, profilesPageUiState.profilesPage));
  const profilesPerPage = 5;
  const [sortBy, setSortBy] = useState<SortState>({
    field: profilesPageUiState.sortBy.field,
    direction: profilesPageUiState.sortBy.direction,
  });
  const [lastActivityMap, setLastActivityMap] = useState<Map<string, number | null>>(new Map());
  const backgroundSyncRetryTimersRef = useRef<Map<string, number>>(new Map());
  const backgroundSyncRetryAttemptsRef = useRef<Map<string, number>>(new Map());
  const syncNotificationIdsRef = useRef<Set<string>>(new Set());
  const useTabDropdown = layout.accounts.layoutType === "mobile";
  const isAccountSyncRunning = syncingAccountIds.size > 0;
  const detailsTabOptions = useMemo(
    () => [
      { value: "database", label: t("profiles.tabs.database", { defaultValue: "Database" }) },
      { value: "overview", label: t("accounts.personalCard.tabs.overview", { defaultValue: "Overview" }) },
      { value: "ratings", label: t("accounts.personalCard.tabs.ratings", { defaultValue: "Ratings" }) },
      { value: "openings", label: t("profiles.tabs.openings", { defaultValue: "Openings" }) },
      { value: "stats", label: t("profiles.tabs.stats", { defaultValue: "Stats" }) },
      { value: "pawnStructures", label: t("profiles.tabs.pawnStructures", { defaultValue: "Pawn structures" }) },
    ],
    [t],
  );

  const sessionsByProfileId = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of sessions) {
      const profileId = session.profileId ?? null;
      if (!profileId) continue;
      const list = map.get(profileId) ?? [];
      list.push(session);
      map.set(profileId, list);
    }
    return map;
  }, [sessions]);

  const filteredProfiles = useMemo(() => {
    const q = profileQuery.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) => p.name.toLowerCase().includes(q));
  }, [profileQuery, profiles]);

  const invalidateProfilePlayerStats = useCallback(
    (profileId: string) => {
      // Broad invalidation is OK here: these queries are only used for the player
      // sidebar/overview panels and we only do it when we *actually* import new games.
      queryClient.invalidateQueries({ queryKey: ["personalInfo", profileId] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["mergedPlayerInfo"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["profileSidebarStats", profileId] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["playerSidebarModel"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["playerEloBuckets"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["playerGameStats"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["profilePhaseStats"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["playerOpeningsWhite"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["playerOpeningsBlack"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["playerRatingTimeline"] }).catch(() => {});
    },
    [queryClient],
  );

  // Prefetch the active profile's sidebar model as soon as Profiles loads.
  // This makes switching to Overview/Ratings/Openings instant (no "thinking").
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!activeProfileId) return;

      await queryClient.prefetchQuery({
        queryKey: ["profileSidebarStats", activeProfileId],
        queryFn: async () => unwrap(await playerStatsCommands.getProfileSidebarStats(activeProfileId)),
        staleTime: Infinity,
        gcTime: Infinity,
      });
      if (cancelled) return;
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, queryClient]);

  // Load last activity dates for all profiles
  useEffect(() => {
    let cancelled = false;
    const loadLastActivities = async () => {
      const activityMap = await loadProfilesLastActivityMap({
        profileIds: filteredProfiles.map((profile) => profile.id),
        sessions,
      });

      if (!cancelled) {
        setLastActivityMap((prev) => (areLastActivityMapsEqual(prev, activityMap) ? prev : activityMap));
      }
    };

    void loadLastActivities();
    return () => {
      cancelled = true;
    };
  }, [filteredProfiles, sessions]);

  const profileDbFile = useMemo(() => (activeProfileId ? profileDbFilename(activeProfileId) : null), [activeProfileId]);

  const loadDatabases = useCallback(async () => {
    setDbLoading(true);
    try {
      const dbs = await getDatabases();
      setDbList(dbs);
    } catch {
      setDbList(null);
    } finally {
      setDbLoading(false);
    }
  }, []);

  const mutateDatabases = useCallback(() => {
    void loadDatabases();
  }, [loadDatabases]);

  const sortedProfiles = useMemo(() => {
    const list = [...filteredProfiles];
    list.sort((a, b) => {
      if (sortBy.field === "name") {
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      } else if (sortBy.field === "lastActivity") {
        const aDate = lastActivityMap.get(a.id) ?? null;
        const bDate = lastActivityMap.get(b.id) ?? null;

        // When sorting by lastActivity, nulls always go to the end
        if (aDate === null && bDate === null) return 0;
        if (aDate === null) return 1; // a goes to end
        if (bDate === null) return -1; // b goes to end

        // Both have dates, compare them
        const comparison = aDate - bDate;
        // For descending, we want most recent first, so reverse the comparison
        return sortBy.direction === "desc" ? -comparison : comparison;
      }
      return 0;
    });

    return list;
  }, [filteredProfiles, sortBy, lastActivityMap]);

  const totalProfilePages = useMemo(
    () => Math.max(1, Math.ceil(sortedProfiles.length / profilesPerPage)),
    [sortedProfiles.length],
  );

  useEffect(() => {
    setProfilesPage((page) => Math.min(page, totalProfilePages));
  }, [totalProfilePages]);

  const pagedProfiles = useMemo(() => {
    const start = (profilesPage - 1) * profilesPerPage;
    return sortedProfiles.slice(start, start + profilesPerPage);
  }, [profilesPage, sortedProfiles]);

  const profilesSelectData = useMemo(() => profiles.map((p) => ({ value: p.id, label: p.name })), [profiles]);
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) ?? null,
    [profiles, activeProfileId],
  );
  const fideImportProfile = useMemo(
    () => profiles.find((p) => p.id === fideImportProfileId) ?? null,
    [profiles, fideImportProfileId],
  );
  const activeProfileCloudSyncTarget = useMemo(
    () => getProfileCloudSyncTarget(activeProfile, sessions),
    [activeProfile, sessions],
  );
  const isActiveProfileCloudSyncTarget = useMemo(
    () => activeProfileCloudSyncTarget !== null,
    [activeProfileCloudSyncTarget],
  );
  const activeProfileSyncableCount = useMemo(() => {
    if (!activeProfile) return 0;
    const linkedSessions = sessionsByProfileId.get(activeProfile.id) ?? [];
    return linkedSessions.filter((session) => {
      const meta = sessionMeta(session);
      return (meta.platform === "lichess" || meta.platform === "chesscom") && meta.username !== "-";
    }).length;
  }, [activeProfile, sessionsByProfileId]);
  useEffect(() => {
    void loadDatabases();
  }, [loadDatabases]);

  const profileDatabase = useMemo(() => {
    if (!dbList || !profileDbFile) return null;
    const found = dbList.find(
      (db) =>
        db.filename?.toLowerCase() === profileDbFile.toLowerCase() ||
        db.file?.toLowerCase().endsWith(profileDbFile.toLowerCase()),
    );
    return found ? ({ ...found, dbType: "game" as const } as const) : null;
  }, [dbList, profileDbFile]);

  useEffect(() => {
    const normalizedSortField = sortBy.field === "name" ? "name" : "lastActivity";
    const normalizedSortDirection = sortBy.direction === "asc" ? "asc" : "desc";
    const normalizedPage = Math.max(1, profilesPage);
    const normalizedDetailsTab =
      detailsTab === "database" ||
      detailsTab === "overview" ||
      detailsTab === "ratings" ||
      detailsTab === "openings" ||
      detailsTab === "stats" ||
      detailsTab === "pawnStructures"
        ? detailsTab
        : defaultProfilesPageUiState.detailsTab;

    setProfilesPageUiState((prev) => {
      if (
        prev.profileQuery === profileQuery &&
        prev.detailsTab === normalizedDetailsTab &&
        prev.profilesPage === normalizedPage &&
        prev.sortBy.field === normalizedSortField &&
        prev.sortBy.direction === normalizedSortDirection
      ) {
        return prev;
      }
      return {
        profileQuery,
        detailsTab: normalizedDetailsTab,
        profilesPage: normalizedPage,
        sortBy: {
          field: normalizedSortField,
          direction: normalizedSortDirection,
        },
      };
    });
  }, [detailsTab, profileQuery, profilesPage, setProfilesPageUiState, sortBy.direction, sortBy.field]);

  const openCreateModal = useCallback(() => {
    setEditingProfileId(null);
    setDraftName("");
    setDraftFideId("");
    setDraftLichessToken("");
    modal.open();
  }, [modal]);

  const openAddAccountModal = useCallback(() => {
    if (isAccountSyncRunning) return;
    setAddAccountDefaultProfileId(activeProfileId ?? profiles[0]?.id ?? null);
    accountModal.open();
  }, [accountModal, activeProfileId, profiles, isAccountSyncRunning]);

  const openAddAccountModalForProfile = useCallback(
    (profileId: string) => {
      if (isAccountSyncRunning) return;
      setAddAccountDefaultProfileId(profileId);
      accountModal.open();
    },
    [accountModal, isAccountSyncRunning],
  );

  const openEditModal = useCallback(
    (profile: Profile) => {
      setEditingProfileId(profile.id);
      setDraftName(profile.name);
      setDraftFideId(profile.fideId ?? "");
      setDraftLichessToken(profile.lichessToken ?? "");
      modal.open();
    },
    [modal],
  );

  const openFideImportModal = useCallback(
    (profile: Profile) => {
      if (isAccountSyncRunning) return;
      setFideImportProfileId(profile.id);
      setDraftFideImportUrl(profile.fideId ? `https://lichess.org/fide/${profile.fideId}` : "");
      fideImportModal.open();
    },
    [fideImportModal, isAccountSyncRunning],
  );

  const persistProfileToken = useCallback(async (profileId: string, tokenValue: string | undefined) => {
    try {
      await setProfileLichessToken(profileId, tokenValue ?? null);
    } catch {
      // best-effort; ignore errors
    }
  }, []);

  const saveProfile = useCallback(async () => {
    const now = Date.now();
    const name = normalizeProfileName(draftName);
    const fideId = cleanFideId(draftFideId);
    const trimmedLichessToken = draftLichessToken.trim();
    const lichessTokenValue = trimmedLichessToken ? trimmedLichessToken : undefined;

    if (!name) {
      notifications.show({
        title: t("common.error"),
        message: t("profiles.errors.missingName", { defaultValue: "Profile name is required." }),
        color: "red",
      });
      return;
    }

    const nameTaken = profiles.some((p) => p.id !== editingProfileId && p.name.toLowerCase() === name.toLowerCase());
    if (nameTaken) {
      notifications.show({
        title: t("common.error"),
        message: t("profiles.errors.duplicateName", { defaultValue: "A profile with this name already exists." }),
        color: "red",
      });
      return;
    }

    if (editingProfileId) {
      setProfiles((prev) =>
        prev.map((p) =>
          p.id === editingProfileId
            ? {
                ...p,
                name,
                fideId: fideId || undefined,
                lichessToken: lichessTokenValue,
                updatedAt: now,
              }
            : p,
        ),
      );

      setSessions((prev) =>
        prev.map((s) => (s.profileId === editingProfileId ? { ...s, player: name, updatedAt: now } : s)),
      );

      try {
        const dbPath = await getProfileDbPath(editingProfileId);
        await commands.initProfileDb(dbPath, name, null);
      } catch {
        // Keep profile edits non-blocking if DB metadata sync fails.
      }

      notifications.show({
        title: t("common.success", { defaultValue: "Success" }),
        message: t("profiles.updated", { defaultValue: "Profile updated." }),
        color: "green",
      });
      void persistProfileToken(editingProfileId, lichessTokenValue);
      modal.close();
      return;
    }

    const next: Profile = {
      id: genID(),
      name,
      fideId: fideId || undefined,
      lichessToken: lichessTokenValue,
      hasPremiumAccess: false,
      premiumUsername: undefined,
      createdAt: now,
      updatedAt: now,
    };
    setProfiles((prev) => [...prev, next]);
    setActiveProfileId(next.id);

    try {
      const dbPath = await getProfileDbPath(next.id);
      const result = await commands.initProfileDb(dbPath, next.name, null);
      if (result.status === "error") {
      }
    } catch (_error) {
      // Ignore initialization errors (best-effort)
    } finally {
      void persistProfileToken(next.id, lichessTokenValue);
    }

    notifications.show({
      title: t("common.success", { defaultValue: "Success" }),
      message: t("profiles.created", { defaultValue: "Profile created." }),
      color: "green",
    });

    modal.close();
  }, [
    draftFideId,
    draftLichessToken,
    draftName,
    editingProfileId,
    modal,
    persistProfileToken,
    profiles,
    setActiveProfileId,
    setProfiles,
    setSessions,
    t,
  ]);

  const deleteProfile = useCallback(
    async (profile: Profile) => {
      if (isAccountSyncRunning) {
        notifications.show({
          title: t("common.error"),
          message: t("profiles.sync.inProgress", { defaultValue: "A profile update is already running." }),
          color: "red",
        });
        return;
      }

      const linked = sessions.some((s) => s.profileId === profile.id);
      if (linked) {
        notifications.show({
          title: t("common.error"),
          message: t("profiles.errors.cannotDeleteLinked", {
            defaultValue: "Unlink accounts from this profile before deleting it.",
          }),
          color: "red",
        });
        return;
      }

      let dbPath = "";
      const deletingActiveProfile = activeProfileId === profile.id;
      const remainingProfiles = profiles.filter((p) => p.id !== profile.id);
      const nextActiveProfileId = remainingProfiles[0]?.id ?? null;
      const dbFilename = profileDbFilename(profile.id);
      let clearedReferenceDb = false;
      try {
        dbPath = await getProfileDbPath(profile.id);
        if (dbPath && referenceDb === dbPath) {
          setReferenceDb(null);
          clearedReferenceDb = true;
        }
        if (deletingActiveProfile) {
          setActiveProfileId(nextActiveProfileId);
          await queryClient.cancelQueries({
            predicate: (query) => {
              const keyText = JSON.stringify(query.queryKey);
              return (
                keyText.includes(profile.id) ||
                keyText.includes(dbFilename) ||
                (dbPath ? keyText.includes(dbPath) : false)
              );
            },
          });
          queryClient.removeQueries({
            predicate: (query) => {
              const keyText = JSON.stringify(query.queryKey);
              return (
                keyText.includes(profile.id) ||
                keyText.includes(dbFilename) ||
                (dbPath ? keyText.includes(dbPath) : false)
              );
            },
          });
          await new Promise((resolve) => window.setTimeout(resolve, 120));
        }
        const result = await commands.deleteDatabase(dbPath);
        if (result.status === "error") {
          if (deletingActiveProfile) {
            setActiveProfileId(profile.id);
          }
          if (clearedReferenceDb) {
            setReferenceDb(dbPath);
          }
          const errorMessage =
            typeof result.error === "string" && result.error.trim()
              ? result.error
              : t("common.errorUnknown", { defaultValue: "Something went wrong." });
          notifications.show({
            title: t("common.error"),
            message: errorMessage,
            color: "red",
          });
          return;
        }
      } catch (error) {
        if (deletingActiveProfile) {
          setActiveProfileId(profile.id);
        }
        if (clearedReferenceDb) {
          setReferenceDb(dbPath);
        }
        const errorMessage =
          formatSyncError(error) || t("common.errorUnknown", { defaultValue: "Something went wrong." });
        notifications.show({
          title: t("common.error"),
          message: errorMessage,
          color: "red",
        });
        return;
      }

      setProfiles((prev) => prev.filter((p) => p.id !== profile.id));
      setProfileStatsUiStateByProfile((prev) => {
        if (!(profile.id in prev)) return prev;
        const next = { ...prev };
        delete next[profile.id];
        return next;
      });
      setProfilePawnUiStateByProfile((prev) => {
        if (!(profile.id in prev)) return prev;
        const next = { ...prev };
        delete next[profile.id];
        return next;
      });

      notifications.show({
        title: t("common.success", { defaultValue: "Success" }),
        message: t("profiles.deleted", { defaultValue: "Profile deleted." }),
        color: "green",
      });
    },
    [
      activeProfileId,
      isAccountSyncRunning,
      profiles,
      queryClient,
      referenceDb,
      sessions,
      setActiveProfileId,
      setProfilePawnUiStateByProfile,
      setProfileStatsUiStateByProfile,
      setProfiles,
      setReferenceDb,
      t,
    ],
  );

  const assignSessionToProfile = useCallback(
    (sessionIndex: number, profileId: string) => {
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) return;

      const now = Date.now();
      setSessions((prev) =>
        prev.map((s, idx) =>
          idx === sessionIndex ? { ...s, profileId: profile.id, player: profile.name, updatedAt: now } : s,
        ),
      );
    },
    [profiles, setSessions],
  );

  const setActiveProfile = useCallback(
    (profileId: string) => {
      setActiveProfileId(profileId);
      notifications.show({
        title: t("common.success", { defaultValue: "Success" }),
        message: t("profiles.activeSet", { defaultValue: "Active profile updated." }),
        color: "green",
      });
    },
    [setActiveProfileId, t],
  );

  const changeReferenceDatabase = useCallback(
    (file: string) => {
      commands.clearGames();
      setReferenceDb(file === referenceDb ? null : file);
    },
    [referenceDb, setReferenceDb],
  );

  const removeSession = useCallback(
    async (session: Session) => {
      const profileId = session.profileId ?? null;
      const platform = session.lichess ? "lichess" : "chesscom";
      const username = session.lichess?.username ?? session.chessCom?.username ?? null;
      if (!username) return;

      // Create a unique key for this session to track deletions
      const sessionKey = `${profileId ?? ""}:${platform}:${username}`;
      deletedSessionKeysRef.current.add(sessionKey);

      // Update state first to immediately remove from UI
      setSessions((prev) => {
        const filtered = prev.filter((s) => {
          if (platform === "lichess") {
            return !((s.profileId ?? null) === profileId && s.lichess?.username === username);
          }
          return !((s.profileId ?? null) === profileId && s.chessCom?.username === username);
        });
        return filtered;
      });

      // Then clean up files asynchronously
      const dbDir = await appDataDir();
      const pgnPath = await getAccountPgnPath({
        appDataDir: dbDir,
        profileId,
        platform,
        username,
      });
      const legacyPgnPath = await resolve(dbDir, "db", `${username}_${platform}.pgn`);

      try {
        try {
          await remove(pgnPath);
        } catch {}
        try {
          await remove(legacyPgnPath);
        } catch {}
        try {
          const { removeAnalyzedGamesForAccount } = await import("@/utils/analyzedGames");
          await removeAnalyzedGamesForAccount(username, platform);
        } catch {}
      } catch {}

      // Keep the deletion key for a short time to prevent restoration
      setTimeout(() => {
        deletedSessionKeysRef.current.delete(sessionKey);
      }, 5000);
    },
    [setSessions],
  );

  const upsertSession = useCallback(
    (session: Session) => {
      setSessions((prev) => {
        const meta = sessionMeta(session);
        const key = `${session.profileId ?? ""}:${meta.platform}:${meta.username}`;
        const next = prev.filter((s) => {
          const otherMeta = sessionMeta(s);
          const otherKey = `${s.profileId ?? ""}:${otherMeta.platform}:${otherMeta.username}`;
          return otherKey !== key;
        });
        return [...next, { ...session, updatedAt: session.updatedAt ?? Date.now() }];
      });
    },
    [setSessions],
  );

  const startBackgroundSync = useCallback(
    (profile: Profile, session: Session) => {
      void (async () => {
        const username = session.lichess?.username ?? session.chessCom?.username ?? "account";
        const meta = sessionMeta(session);
        const id = `sync:${profile.id}:${meta.platform}:${username}`;

        // Prevent duplicate syncs for the same account
        if (syncingAccountIdsRef.current.has(id)) {
          return; // Already syncing, skip
        }
        syncingAccountIdsRef.current.add(id);

        const showToasts =
          meta.platform === "lichess" || meta.platform === "chesscom"
            ? !(await shouldSuppressAccountSyncToasts({
                profileId: profile.id,
                platform: meta.platform,
                username,
              }))
            : true;

        if (showToasts) {
          notifications.show({
            id,
            title: t("accounts.processingGames", { defaultValue: "Processing Games..." }),
            message: `${profile.name} - ${username} (${meta.platform})`,
            loading: true,
            autoClose: false,
          });
          syncNotificationIdsRef.current.add(id);
        }

        const clearRetryTimer = () => {
          const existing = backgroundSyncRetryTimersRef.current.get(id) ?? null;
          if (existing != null) {
            window.clearTimeout(existing);
            backgroundSyncRetryTimersRef.current.delete(id);
          }
        };

        const cleanup = () => {
          clearRetryTimer();
          if (showToasts) {
            syncNotificationIdsRef.current.delete(id);
          }
          backgroundSyncRetryAttemptsRef.current.delete(id);
          syncingAccountIdsRef.current.delete(id);
          setSyncingAccountIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        };

        const runOnce = () => {
          void syncSessionGamesToProfileDb({
            profile,
            session,
            onBatchUpdate: showToasts
              ? (u) => {
                  if (u.cooldownSeconds != null) {
                    notifications.update({
                      id,
                      title: t("common.warning", { defaultValue: "Warning" }),
                      message: t("accounts.sync.cooldown", {
                        defaultValue: "Rate limit reached. Cooling down for {{seconds}}s...",
                        seconds: u.cooldownSeconds,
                      }),
                      color: "yellow",
                      loading: true,
                      autoClose: false,
                    });
                    return;
                  }
                  // Show optimization message or batch progress
                  const message =
                    u.totalBatches > 0
                      ? `${profile.name} - ${username} (${u.platform}) ${t("accounts.sync.batchProgress", {
                          defaultValue: "Batch {{current}} of {{total}}",
                          current: u.currentBatch,
                          total: u.totalBatches,
                        })}`
                      : u.batchLabel || `${profile.name} - ${username} (${u.platform})`;
                  notifications.update({
                    id,
                    message,
                    loading: u.batchLabel?.toLowerCase().includes("optimiz") ? true : u.totalBatches > 0,
                    autoClose: u.batchLabel?.toLowerCase().includes("complete") ? 3000 : false,
                  });
                }
              : undefined,
          })
            .then((res) => {
              if (res.updatedSession) {
                upsertSession(res.updatedSession);
              }
              // Reload Databases tab only if new games were imported
              if ((res.importedGames ?? 0) > 0) {
                void loadDatabases();
                invalidateProfilePlayerStats(profile.id);
              }
              if (showToasts) {
                notifications.update({
                  id,
                  title: t("common.success", { defaultValue: "Success" }),
                  message: `${profile.name} - ${username} (${meta.platform})`,
                  color: "green",
                  loading: false,
                  autoClose: 2500,
                });
              }
              cleanup();
            })
            .catch((e) => {
              if (isFailedToFetchError(e)) {
                const prevAttempts = backgroundSyncRetryAttemptsRef.current.get(id) ?? 0;
                const nextAttempts = prevAttempts + 1;
                backgroundSyncRetryAttemptsRef.current.set(id, nextAttempts);
                const delay = Math.min(60_000, 3_000 * 2 ** Math.min(6, nextAttempts - 1));

                if (showToasts) {
                  notifications.update({
                    id,
                    title: t("common.warning", { defaultValue: "Warning" }),
                    message: t("accounts.sync.networkRetry", {
                      defaultValue: "Network issue detected. Retrying soon...",
                    }),
                    color: "yellow",
                    loading: true,
                    autoClose: false,
                  });
                }

                clearRetryTimer();
                const timer = window.setTimeout(runOnce, delay);
                backgroundSyncRetryTimersRef.current.set(id, timer);
                return;
              }

              if (showToasts) {
                notifications.update({
                  id,
                  title: t("common.error", { defaultValue: "Error" }),
                  message: `${t("accounts.databaseLoadError", { defaultValue: "Error loading database" })}: ${truncateMiddle(formatSyncError(e), 600)}`,
                  color: "red",
                  loading: false,
                  autoClose: 4000,
                });
              }
              cleanup();
            });
        };

        runOnce();
      })();
    },
    [t, upsertSession, loadDatabases, invalidateProfilePlayerStats],
  );

  useEffect(() => {
    return () => {
      for (const timer of backgroundSyncRetryTimersRef.current.values()) {
        try {
          window.clearTimeout(timer);
        } catch {}
      }
      backgroundSyncRetryTimersRef.current.clear();
      for (const notificationId of syncNotificationIdsRef.current.values()) {
        try {
          notifications.hide(notificationId);
        } catch {}
      }
      syncNotificationIdsRef.current.clear();
    };
  }, []);

  const buildSyncId = useCallback((profile: Profile, session: Session) => {
    const meta = sessionMeta(session);
    return `sync:${profile.id}:${meta.platform}:${meta.username}`;
  }, []);

  const waitForSyncLifecycle = useCallback(async (syncId: string) => {
    const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

    const waitUntil = Date.now() + 2_000;
    while (Date.now() < waitUntil) {
      if (syncingAccountIdsRef.current.has(syncId)) break;
      await sleep(50);
    }

    while (syncingAccountIdsRef.current.has(syncId)) {
      await sleep(200);
    }
  }, []);

  const syncProfileSessions = useCallback(
    async (profile: Profile) => {
      if (isAccountSyncRunning) {
        notifications.show({
          title: t("common.warning", { defaultValue: "Warning" }),
          message: t("profiles.sync.inProgress", { defaultValue: "A profile update is already running." }),
          color: "yellow",
          autoClose: 3000,
        });
        return;
      }

      const linkedSessions = sessionsByProfileId.get(profile.id) ?? [];
      const syncableSessions = linkedSessions.filter((session) => {
        const meta = sessionMeta(session);
        return (meta.platform === "lichess" || meta.platform === "chesscom") && meta.username !== "-";
      });

      if (syncableSessions.length === 0) {
        notifications.show({
          title: t("common.warning", { defaultValue: "Warning" }),
          message: t("profiles.sync.noAccounts", { defaultValue: "This profile has no linked accounts to update." }),
          color: "yellow",
          autoClose: 3000,
        });
        return;
      }

      const orderedSessions = [...syncableSessions].sort((a, b) => {
        const aPlatform = sessionMeta(a).platform;
        const bPlatform = sessionMeta(b).platform;
        if (aPlatform === bPlatform) return 0;
        return aPlatform === "lichess" ? -1 : 1;
      });

      for (const session of orderedSessions) {
        const syncId = buildSyncId(profile, session);
        if (syncingAccountIdsRef.current.has(syncId)) continue;
        startBackgroundSync(profile, session);
        await waitForSyncLifecycle(syncId);
      }

      notifications.show({
        title: t("common.success", { defaultValue: "Success" }),
        message: t("profiles.sync.completed", {
          defaultValue: "Profile {{profile}} updated.",
          profile: profile.name,
        }),
        color: "green",
        autoClose: 2500,
      });
    },
    [buildSyncId, isAccountSyncRunning, sessionsByProfileId, startBackgroundSync, t, waitForSyncLifecycle],
  );

  const importProfileFideBroadcasts = useCallback(
    async (profile: Profile, fideUrl?: string) => {
      const source = fideUrl?.trim() || profile.fideId?.trim() || "";
      const fideId = source.match(/\/fide\/(\d+)/i)?.[1] ?? cleanFideId(source);
      if (!source || !fideId) {
        notifications.show({
          title: t("common.warning", { defaultValue: "Warning" }),
          message: t("profiles.fideImport.missingLink", {
            defaultValue: "Paste a Lichess FIDE profile link or FIDE ID before importing.",
          }),
          color: "yellow",
          autoClose: 3000,
        });
        return;
      }

      if (isAccountSyncRunning) {
        notifications.show({
          title: t("common.warning", { defaultValue: "Warning" }),
          message: t("profiles.sync.inProgress", { defaultValue: "A profile update is already running." }),
          color: "yellow",
          autoClose: 3000,
        });
        return;
      }

      const id = `sync:${profile.id}:fide:${fideId}`;
      syncingAccountIdsRef.current.add(id);
      setSyncingAccountIds((prev) => new Set(prev).add(id));

      notifications.show({
        id,
        title: t("profiles.fideImport.processing", { defaultValue: "Importing Lichess FIDE broadcasts..." }),
        message: profile.name,
        loading: true,
        autoClose: false,
      });
      syncNotificationIdsRef.current.add(id);

      try {
        const result = await importFideBroadcastGamesToProfileDb({
          profile,
          fideUrl: source,
          onBatchUpdate: (update) => {
            const message =
              update.totalBatches > 0
                ? `${profile.name} - ${t("accounts.sync.batchProgress", {
                    defaultValue: "Batch {{current}} of {{total}}",
                    current: update.currentBatch,
                    total: update.totalBatches,
                  })}: ${update.batchLabel}`
                : update.batchLabel || profile.name;
            notifications.update({
              id,
              message,
              loading: true,
              autoClose: false,
            });
          },
        });

        if (result.importedGames > 0) {
          await loadDatabases();
          invalidateProfilePlayerStats(profile.id);
          setLastActivityMap((prev) => {
            const next = new Map(prev);
            next.set(profile.id, Date.now());
            return next;
          });
        }

        notifications.update({
          id,
          title: t("common.success", { defaultValue: "Success" }),
          message: t("profiles.fideImport.completed", {
            defaultValue: "Imported {{games}} games from {{processed}} Lichess FIDE broadcast tournaments.",
            games: result.importedGames,
            processed: result.processedTournaments,
          }),
          color: "green",
          loading: false,
          autoClose: 3500,
        });
      } catch (error) {
        notifications.update({
          id,
          title: t("common.error", { defaultValue: "Error" }),
          message: truncateMiddle(formatSyncError(error), 600),
          color: "red",
          loading: false,
          autoClose: 5000,
        });
      } finally {
        syncNotificationIdsRef.current.delete(id);
        syncingAccountIdsRef.current.delete(id);
        setSyncingAccountIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [invalidateProfilePlayerStats, isAccountSyncRunning, loadDatabases, t],
  );

  const submitFideImport = useCallback(() => {
    if (!fideImportProfile) return;
    const source = draftFideImportUrl.trim();
    if (!source) {
      notifications.show({
        title: t("common.warning", { defaultValue: "Warning" }),
        message: t("profiles.fideImport.missingLink", {
          defaultValue: "Paste a Lichess FIDE profile link or FIDE ID before importing.",
        }),
        color: "yellow",
        autoClose: 3000,
      });
      return;
    }
    fideImportModal.close();
    void importProfileFideBroadcasts(fideImportProfile, source);
  }, [draftFideImportUrl, fideImportModal, fideImportProfile, importProfileFideBroadcasts, t]);

  useEffect(() => {
    try {
      const pendingSync = sessionStorage.getItem("profiles_sync_request");
      if (pendingSync !== "active") return;
      if (!activeProfile) return;
      sessionStorage.removeItem("profiles_sync_request");
      void syncProfileSessions(activeProfile);
    } catch {}
  }, [activeProfile, syncProfileSessions]);

  const addAccountToProfile = useCallback(
    async (payload: AddProfileAccountPayload, skipVerification = false) => {
      const profile = profiles.find((p) => p.id === payload.profileId) ?? null;
      if (!profile) return;

      const now = Date.now();
      const profileName = profile.name;

      // Verify account if not skipping verification
      if (!skipVerification) {
        const platform: Platform = payload.website === "lichess" ? "Lichess" : "Chesscom";
        const protectionStatus = await getAccountProtectionStatus(platform, payload.username);
        const profileHasPremiumAccess = profile.hasPremiumAccess === true;

        if (protectionStatus === "protected" && !profileHasPremiumAccess) {
          // Show verification modal
          setPendingAccountPayload({ payload, platform });
          verificationModal.open();
          return;
        }
      }

      // Continue with account addition
      if (payload.website === "chesscom") {
        const stats = await getChessComAccount(payload.username);
        if (!stats) return;

        const session: Session = {
          chessCom: { username: payload.username, stats } as ChessComSession,
          player: profileName,
          profileId: profile.id,
          updatedAt: now,
        };
        upsertSession(session);
        startBackgroundSync(profile, session);
        return;
      }

      if (payload.withLogin) {
        sessionStorage.setItem("lichess_profile_id", profile.id);
        sessionStorage.setItem("lichess_profile_name", profileName);
        sessionStorage.setItem("lichess_username", payload.username);
        await commands.authenticate(payload.username);
        return;
      }

      const account = await getLichessAccount({ username: payload.username });
      if (!account) return;
      const session: Session = {
        lichess: { username: payload.username, account } as LichessSession,
        player: profileName,
        profileId: profile.id,
        updatedAt: now,
      };
      upsertSession(session);
      startBackgroundSync(profile, session);
    },
    [profiles, startBackgroundSync, upsertSession, verificationModal],
  );

  const handleVerificationResult = useCallback(
    async (result: AccountVerificationResult) => {
      if (!pendingAccountPayload) return;

      if (!result.validated) {
        // User cancelled
        setPendingAccountPayload(null);
        return;
      }

      if (!result.username || !result.password) {
        notifications.show({
          title: t("common.error", { defaultValue: "Error" }),
          message: t("accounts.verification.missingCredentials", {
            defaultValue: "Username and password are required.",
          }),
          color: "red",
        });
        setPendingAccountPayload(null);
        return;
      }

      // Validate credentials
      const isValid = await validateCredentials(result.username, result.password);
      if (!isValid) {
        notifications.show({
          title: t("common.error", { defaultValue: "Error" }),
          message: t("accounts.verification.invalidCredentials", {
            defaultValue: "Invalid credentials. Cannot proceed with account download.",
          }),
          color: "red",
        });
        setPendingAccountPayload(null);
        return;
      }

      // Credentials are valid, continue with account addition
      const verifiedPremiumUsername = result.username?.trim();
      if (!verifiedPremiumUsername) {
        notifications.show({
          title: t("common.error", { defaultValue: "Error" }),
          message: t("accounts.verification.missingCredentials", {
            defaultValue: "Username and password are required.",
          }),
          color: "red",
        });
        setPendingAccountPayload(null);
        return;
      }

      const validatedAt = Date.now();
      const validatedProfileId = pendingAccountPayload.payload.profileId;
      setProfiles((prev) =>
        prev.map((profile) =>
          profile.id === validatedProfileId
            ? {
                ...profile,
                hasPremiumAccess: true,
                premiumUsername: verifiedPremiumUsername,
                premiumValidatedAt: validatedAt,
                updatedAt: validatedAt,
              }
            : profile,
        ),
      );
      setPendingAccountPayload(null);
      await addAccountToProfile(pendingAccountPayload.payload, true);
    },
    [pendingAccountPayload, addAccountToProfile, setProfiles, t],
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<string>("access_token", async (event) => {
      try {
        const token = event.payload;
        const profileId = sessionStorage.getItem("lichess_profile_id") || activeProfileId || "";
        const profile = profiles.find((p) => p.id === profileId) ?? null;
        if (!profile) return;

        const account = await getLichessAccount({ token });
        if (!account) return;

        const username = account.username;
        const session: Session = {
          lichess: { accessToken: token, username, account } as LichessSession,
          player: profile.name,
          profileId: profile.id,
          updatedAt: Date.now(),
        };

        upsertSession(session);
        startBackgroundSync(profile, session);
      } finally {
        sessionStorage.removeItem("lichess_profile_id");
        sessionStorage.removeItem("lichess_profile_name");
        sessionStorage.removeItem("lichess_username");
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      try {
        unlisten?.();
      } catch {}
    };
  }, [activeProfileId, profiles, startBackgroundSync, upsertSession]);

  const collectAllProfileGameIds = useCallback(async (profileId: string, profileUsernames: string[]) => {
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
  }, []);

  const exportProfileToFile = useCallback(async () => {
    if (!activeProfile) {
      notifications.show({
        title: t("common.warning", { defaultValue: "Warning" }),
        message: t("profiles.transfer.noActiveProfile", { defaultValue: "Select an active profile first." }),
        color: "yellow",
      });
      return;
    }

    try {
      setProfileTransferBusy(true);
      const profileId = activeProfile.id;
      const profileDbPath = await getProfileDbPath(profileId);
      if (!(await exists(profileDbPath))) {
        throw new Error(
          t("profiles.transfer.profileDbMissing", {
            defaultValue: "Could not find the profile database for export.",
          }),
        );
      }

      const profileDbBytes = await readFile(profileDbPath);
      const profileDbBase64 = bytesToBase64(new Uint8Array(profileDbBytes));

      const linkedSessions = sessions.filter((session) => session.profileId === profileId);
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
      if (await exists(puzzleVariantsDir)) {
        const puzzleVariantEntries = await readDir(puzzleVariantsDir);
        const allPuzzleVariantEntries = await processEntriesRecursively(puzzleVariantsDir, puzzleVariantEntries);
        const puzzleVariantsOnly = allPuzzleVariantEntries.filter(
          (entry): entry is FileMetadata =>
            entry.type === "file" &&
            entry.metadata.type === "puzzle" &&
            entry.metadata.tags.includes(PUZZLE_VARIANTS_TAG),
        );
        for (const puzzleVariantFile of puzzleVariantsOnly) {
          const parsedTags = parsePuzzleVariantTags(puzzleVariantFile.metadata.tags);
          if (parsedTags.profileId && parsedTags.profileId !== profileId) {
            continue;
          }

          const pgn = await readTextFile(puzzleVariantFile.path);
          const info = await readInfoMetadata(puzzleVariantFile.path, "puzzle");
          puzzleVariants.push({
            relativePath: profileRelativePath(puzzleVariantsDir, puzzleVariantFile.path),
            pgn,
            info: {
              ...info,
              type: "puzzle",
              tags: ensurePuzzleVariantProfileTags(info.tags, profileId),
            },
          });
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
        profile: activeProfile,
        sessions: linkedSessions,
        profileStatsUiState: profileStatsUiStateByProfile[profileId] ?? null,
        profilePawnStructuresUiState: profilePawnUiStateByProfile[profileId] ?? null,
        profileDbBase64,
        accountPgnFiles,
        variants,
        puzzleVariants,
        analysis: {
          analyzedGames,
          gameStats,
        },
      };

      const defaultNameBase = normalizeProfileName(activeProfile.name).replace(/[<>:"/\\|?*\s]+/g, "-") || "profile";
      const destination = await save({
        defaultPath: `${defaultNameBase}-${new Date().toISOString().slice(0, 10)}.ocs-profile.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!destination) {
        return;
      }

      await writeTextFile(destination, JSON.stringify(pkg, null, 2));
      notifications.show({
        title: t("common.success", { defaultValue: "Success" }),
        message: t("profiles.transfer.exportDone", {
          defaultValue:
            "Profile exported. Sessions: {{sessions}}, variants: {{variants}}, puzzle variants: {{puzzleVariants}}, analyzed games: {{analyzed}}.",
          sessions: linkedSessions.length,
          variants: variants.length,
          puzzleVariants: puzzleVariants.length,
          analyzed: analyzedGames.length,
        }),
        color: "green",
      });
    } catch (error) {
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message:
          error instanceof Error
            ? error.message
            : t("profiles.transfer.exportFailed", { defaultValue: "Failed to export the profile package." }),
        color: "red",
      });
    } finally {
      setProfileTransferBusy(false);
    }
  }, [activeProfile, collectAllProfileGameIds, profilePawnUiStateByProfile, profileStatsUiStateByProfile, sessions, t]);

  const importProfileFromFile = useCallback(async () => {
    try {
      setProfileTransferBusy(true);
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      const filePath = Array.isArray(selected) ? selected[0] : selected;
      if (!filePath || typeof filePath !== "string") {
        return;
      }

      const raw = await readTextFile(filePath);
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
        throw new Error(
          t("profiles.transfer.invalidPackage", {
            defaultValue: "Invalid profile package format.",
          }),
        );
      }

      const sourceProfile = parsed.profile as Profile;
      const sourceProfileId = sourceProfile.id.trim() || genID();
      let targetProfileId = sourceProfileId;
      if (profiles.some((profile) => profile.id === targetProfileId)) {
        targetProfileId = genID();
      }

      const normalizedName =
        normalizeProfileName(sourceProfile.name) || t("profiles.profile", { defaultValue: "Profile" });
      let targetProfileName = normalizedName;
      if (profiles.some((profile) => profile.name.toLowerCase() === targetProfileName.toLowerCase())) {
        let suffix = 2;
        while (
          profiles.some((profile) => profile.name.toLowerCase() === `${normalizedName} (${suffix})`.toLowerCase())
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

      const normalizedSessions = (Array.isArray(parsed.sessions) ? parsed.sessions : [])
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
      const profileDbBytes = base64ToBytes(parsed.profileDbBase64);
      await writeFile(profileDbPath, profileDbBytes);
      unwrap(await commands.initProfileDb(profileDbPath, targetProfileName, null));

      const appData = await appDataDir();
      const dbDir = await resolve(appData, "db");
      await mkdir(dbDir, { recursive: true });

      let accountFilesImported = 0;
      const accountPgnFiles = Array.isArray(parsed.accountPgnFiles) ? parsed.accountPgnFiles : [];
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
      const variants = Array.isArray(parsed.variants) ? parsed.variants : [];
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
      const puzzleVariants = Array.isArray(parsed.puzzleVariants) ? parsed.puzzleVariants : [];
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

      const analysis = parsed.analysis && typeof parsed.analysis === "object" ? parsed.analysis : null;
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

      setProfiles((prev) => [...prev, importedProfile]);
      setSessions((prev) => {
        const next = [...prev];
        for (const importedSession of normalizedSessions) {
          const meta = sessionMeta(importedSession);
          const key = `${targetProfileId}:${meta.platform}:${meta.username}`.toLowerCase();
          const existingIndex = next.findIndex((candidate) => {
            const candidateMeta = sessionMeta(candidate);
            const candidateKey =
              `${candidate.profileId ?? ""}:${candidateMeta.platform}:${candidateMeta.username}`.toLowerCase();
            return candidateKey === key;
          });
          if (existingIndex >= 0) {
            next[existingIndex] = importedSession;
          } else {
            next.push(importedSession);
          }
        }
        return next;
      });
      if (parsed.profileStatsUiState != null) {
        setProfileStatsUiStateByProfile((prev) => ({
          ...prev,
          [targetProfileId]: parsed.profileStatsUiState as any,
        }));
      }
      if (parsed.profilePawnStructuresUiState != null) {
        setProfilePawnUiStateByProfile((prev) => ({
          ...prev,
          [targetProfileId]: parsed.profilePawnStructuresUiState as any,
        }));
      }
      setActiveProfileId(targetProfileId);

      await loadDatabases();
      invalidateProfilePlayerStats(targetProfileId);
      try {
        window.dispatchEvent(new Event("puzzles:updated"));
        window.dispatchEvent(new Event("puzzle-variants:updated"));
      } catch {}

      notifications.show({
        title: t("common.success", { defaultValue: "Success" }),
        message: t("profiles.transfer.importDone", {
          defaultValue:
            "Profile imported as {{profile}}. Sessions: {{sessions}}, account files: {{accountFiles}}, variants: {{variants}}, puzzle variants: {{puzzleVariants}}, analyzed games: {{analyzed}}, stats: {{stats}}.",
          profile: targetProfileName,
          sessions: normalizedSessions.length,
          accountFiles: accountFilesImported,
          variants: variantsImported,
          puzzleVariants: puzzleVariantsImported,
          analyzed: analyzedImported,
          stats: statsImported,
        }),
        color: "green",
      });
    } catch (error) {
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message:
          error instanceof Error
            ? error.message
            : t("profiles.transfer.importFailed", { defaultValue: "Failed to import the profile package." }),
        color: "red",
      });
    } finally {
      setProfileTransferBusy(false);
    }
  }, [
    invalidateProfilePlayerStats,
    loadDatabases,
    profiles,
    setActiveProfileId,
    setProfilePawnUiStateByProfile,
    setProfileStatsUiStateByProfile,
    setProfiles,
    setSessions,
    t,
  ]);

  const buildActiveProfilePackageJson = useCallback(async () => {
    if (!activeProfile) {
      throw new Error(t("profiles.transfer.noActiveProfile", { defaultValue: "Select an active profile first." }));
    }
    if (!activeProfileCloudSyncTarget) {
      throw new Error(
        t("profiles.cloud.targetOnly", {
          defaultValue: "Cloud sync is currently limited to {{target}}.",
          target: "Isabella / Lichess bethfisher94 or Kevin / Chess.com kevin09877",
        }),
      );
    }
    const { pkg } = await buildProfileTransferPackage({
      profile: activeProfile,
      sessions,
      profileStatsUiStateByProfile,
      profilePawnUiStateByProfile,
    });
    return { packageJson: JSON.stringify(pkg) };
  }, [
    activeProfile,
    activeProfileCloudSyncTarget,
    profilePawnUiStateByProfile,
    profileStatsUiStateByProfile,
    sessions,
    t,
  ]);

  const applyCloudProfilePackageJson = useCallback(
    async (packageJson: string) => {
      let pkg: ReturnType<typeof validateProfileTransferPackage>;
      try {
        pkg = validateProfileTransferPackage(packageJson);
      } catch (error) {
        const reason = getUnknownErrorMessage(error) ?? "Invalid profile package format.";
        throw new Error(`Validate downloaded profile package: ${reason}`);
      }

      let summary: Awaited<ReturnType<typeof importProfileTransferPackage>>;
      try {
        summary = await importProfileTransferPackage({
          pkg,
          profiles,
          mode: "replace-existing",
          setProfiles,
          setSessions,
          setProfileStatsUiStateByProfile,
          setProfilePawnUiStateByProfile,
          setActiveProfileId,
        });
      } catch (error) {
        const reason = getUnknownErrorMessage(error) ?? "Unknown error.";
        throw new Error(`Import downloaded profile package: ${reason}`);
      }
      await loadDatabases();
      invalidateProfilePlayerStats(summary.profileId);
      return summary;
    },
    [
      invalidateProfilePlayerStats,
      loadDatabases,
      profiles,
      setActiveProfileId,
      setProfilePawnUiStateByProfile,
      setProfileStatsUiStateByProfile,
      setProfiles,
      setSessions,
    ],
  );

  const openCloudSettings = useCallback(() => {
    cloudSettings.open();
  }, [cloudSettings]);

  const syncActiveProfileWithCloud = useCallback(async () => {
    if (!activeProfile || !activeProfileCloudSyncTarget || cloudSyncBusy) return;
    try {
      setCloudSyncBusy(true);
      const { packageJson } = await buildActiveProfilePackageJson();
      const result = await syncProfilePackageWithCloud({
        targetUserId: activeProfileCloudSyncTarget.userId,
        profileId: activeProfile.id,
        packageJson,
      });

      if (result.status === "downloaded") {
        const summary = await applyCloudProfilePackageJson(result.packageJson);
        await saveProfileCloudLocalState(activeProfileCloudSyncTarget.userId, summary.profileId, result.state);
        notifications.show({
          title: t("common.success", { defaultValue: "Success" }),
          message: t("profiles.cloud.downloaded", {
            defaultValue: "Cloud profile downloaded as {{profile}}.",
            profile: summary.profileName,
          }),
          color: "green",
        });
        return;
      }

      if (result.status === "uploaded") {
        notifications.show({
          title: t("common.success", { defaultValue: "Success" }),
          message: t("profiles.cloud.uploaded", { defaultValue: "Profile uploaded to cloud." }),
          color: "green",
        });
        return;
      }

      if (result.status === "unchanged") {
        notifications.show({
          title: t("common.success", { defaultValue: "Success" }),
          message: t("profiles.cloud.unchanged", { defaultValue: "Cloud profile is already up to date." }),
          color: "green",
        });
        return;
      }

      notifications.show({
        title: t("common.warning", { defaultValue: "Warning" }),
        message: t("profiles.cloud.conflict", {
          defaultValue:
            "Cloud and local profile both changed. Use upload or download explicitly after deciding which copy to keep.",
        }),
        color: "yellow",
      });
    } catch (error) {
      const reason = getUnknownErrorMessage(error);
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message: reason
          ? t("profiles.cloud.failedWithReason", {
              defaultValue: "Cloud profile sync failed: {{reason}}",
              reason,
            })
          : t("profiles.cloud.failed", { defaultValue: "Cloud profile sync failed." }),
        color: "red",
      });
    } finally {
      setCloudSyncBusy(false);
    }
  }, [
    activeProfile,
    activeProfileCloudSyncTarget,
    applyCloudProfilePackageJson,
    buildActiveProfilePackageJson,
    cloudSyncBusy,
    t,
  ]);

  const uploadActiveProfileToCloud = useCallback(async () => {
    if (!activeProfile || !activeProfileCloudSyncTarget || cloudSyncBusy) return;
    try {
      setCloudSyncBusy(true);
      const { packageJson } = await buildActiveProfilePackageJson();
      await uploadProfilePackageToCloud({
        targetUserId: activeProfileCloudSyncTarget.userId,
        profileId: activeProfile.id,
        packageJson,
      });
      notifications.show({
        title: t("common.success", { defaultValue: "Success" }),
        message: t("profiles.cloud.uploaded", { defaultValue: "Profile uploaded to cloud." }),
        color: "green",
      });
    } catch (error) {
      const reason = getUnknownErrorMessage(error);
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message: reason
          ? t("profiles.cloud.failedWithReason", {
              defaultValue: "Cloud profile sync failed: {{reason}}",
              reason,
            })
          : t("profiles.cloud.failed", { defaultValue: "Cloud profile sync failed." }),
        color: "red",
      });
    } finally {
      setCloudSyncBusy(false);
    }
  }, [activeProfile, activeProfileCloudSyncTarget, buildActiveProfilePackageJson, cloudSyncBusy, t]);

  const downloadActiveProfileFromCloud = useCallback(async () => {
    if (!activeProfileCloudSyncTarget || cloudSyncBusy) return;
    try {
      setCloudSyncBusy(true);
      const result = await downloadProfilePackageFromCloud({ targetUserId: activeProfileCloudSyncTarget.userId });
      const summary = await applyCloudProfilePackageJson(result.packageJson);
      await saveProfileCloudLocalState(activeProfileCloudSyncTarget.userId, summary.profileId, result.state);
      notifications.show({
        title: t("common.success", { defaultValue: "Success" }),
        message: t("profiles.cloud.downloaded", {
          defaultValue: "Cloud profile downloaded as {{profile}}.",
          profile: summary.profileName,
        }),
        color: "green",
      });
    } catch (error) {
      const reason = getUnknownErrorMessage(error);
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message: reason
          ? t("profiles.cloud.failedWithReason", {
              defaultValue: "Cloud profile sync failed: {{reason}}",
              reason,
            })
          : t("profiles.cloud.failed", { defaultValue: "Cloud profile sync failed." }),
        color: "red",
      });
    } finally {
      setCloudSyncBusy(false);
    }
  }, [activeProfileCloudSyncTarget, applyCloudProfilePackageJson, cloudSyncBusy, t]);

  const refreshPuzzleDatabases = useCallback(async () => {}, []);

  return (
    <>
      <GenericHeader
        title={t("profiles.title", { defaultValue: "Profiles" })}
        searchPlaceholder={undefined}
        showViewToggle={false}
        actions={
          <Group gap="xs">
            {isActiveProfileCloudSyncTarget ? (
              <>
                <Button
                  size="xs"
                  radius="xl"
                  variant="light"
                  styles={premiumActionButtonStyles}
                  leftSection={<IconCloud size="1rem" />}
                  onClick={openCloudSettings}
                  disabled={profileTransferBusy || isAccountSyncRunning || cloudSyncBusy}
                >
                  {t("profiles.cloud.settings", { defaultValue: "Cloud settings" })}
                </Button>
                <Button
                  size="xs"
                  radius="xl"
                  variant="light"
                  styles={premiumActionButtonStyles}
                  leftSection={<IconCloud size="1rem" />}
                  onClick={() => void syncActiveProfileWithCloud()}
                  loading={cloudSyncBusy}
                  disabled={
                    !activeProfile ||
                    !isActiveProfileCloudSyncTarget ||
                    profileTransferBusy ||
                    isAccountSyncRunning ||
                    cloudSyncBusy
                  }
                >
                  {t("profiles.cloud.sync", { defaultValue: "Cloud sync" })}
                </Button>
              </>
            ) : null}
            <Button
              size="xs"
              radius="xl"
              variant="light"
              styles={premiumActionButtonStyles}
              leftSection={<IconFileImport size="1rem" />}
              onClick={() => void importProfileFromFile()}
              loading={profileTransferBusy}
              disabled={profileTransferBusy || isAccountSyncRunning || cloudSyncBusy}
            >
              {t("profiles.transfer.importFile", { defaultValue: "Import profile file" })}
            </Button>
            <Button
              size="xs"
              radius="xl"
              variant="light"
              styles={premiumActionButtonStyles}
              leftSection={<IconFileExport size="1rem" />}
              onClick={() => void exportProfileToFile()}
              loading={profileTransferBusy}
              disabled={!activeProfile || profileTransferBusy || isAccountSyncRunning || cloudSyncBusy}
            >
              {t("profiles.transfer.exportFile", { defaultValue: "Export profile file" })}
            </Button>
            <Button
              size="xs"
              radius="xl"
              variant="default"
              styles={premiumActionButtonStyles}
              leftSection={<IconRefresh size="1rem" />}
              onClick={() => {
                if (activeProfile) void syncProfileSessions(activeProfile);
              }}
              disabled={
                !activeProfile ||
                activeProfileSyncableCount === 0 ||
                isAccountSyncRunning ||
                profileTransferBusy ||
                cloudSyncBusy
              }
            >
              {t("profiles.sync.active", { defaultValue: "Update active profile" })}
            </Button>
          </Group>
        }
      />

      {isActiveProfileCloudSyncTarget ? (
        <Modal
          opened={cloudSettingsOpened}
          onClose={cloudSettings.close}
          title={t("profiles.cloud.settings", { defaultValue: "Cloud settings" })}
          centered
          size="lg"
        >
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              {t("profiles.cloud.targetOnly", {
                defaultValue: "Cloud sync is currently limited to {{target}}.",
                target: activeProfileCloudSyncTarget
                  ? describeProfileCloudSyncTarget(activeProfileCloudSyncTarget)
                  : "Isabella / Lichess bethfisher94 or Kevin / Chess.com kevin09877",
              })}
            </Text>
            <Text size="sm" c="dimmed">
              {t("profiles.cloud.backendConfigured", {
                defaultValue:
                  "Worker endpoint, sync key, and auth token are configured in the backend build environment.",
              })}
            </Text>
            <Group justify="space-between" mt="sm">
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => void uploadActiveProfileToCloud()}
                  loading={cloudSyncBusy}
                  disabled={!isActiveProfileCloudSyncTarget || cloudSyncBusy}
                >
                  {t("profiles.cloud.upload", { defaultValue: "Upload now" })}
                </Button>
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => void downloadActiveProfileFromCloud()}
                  loading={cloudSyncBusy}
                  disabled={cloudSyncBusy}
                >
                  {t("profiles.cloud.download", { defaultValue: "Download now" })}
                </Button>
              </Group>
              <Button size="xs" variant="default" onClick={cloudSettings.close}>
                {t("common.close", { defaultValue: "Close" })}
              </Button>
            </Group>
          </Stack>
        </Modal>
      ) : null}

      <Stack flex={1} style={{ minHeight: 0 }}>
        <ScrollArea h="100%" offsetScrollbars>
          <Stack px="md" pb="xl">
            <Card withBorder radius="lg" p="md" style={premiumPanelStyle}>
              <Flex gap="sm" justify="space-between" align="flex-end" wrap="wrap">
                <Stack gap={2}>
                  <Group gap="xs" wrap="nowrap">
                    <Text fw={700}>{t("profiles.listTitle", { defaultValue: "Profiles" })}</Text>
                    <Badge variant="light" color="gray">
                      {sortedProfiles.length}
                    </Badge>
                  </Group>
                  <Text size="sm" c="dimmed">
                    {t("profiles.linkAccountsHint", {
                      defaultValue:
                        "Assign each account to a profile. All games will be stored in the profile database.",
                    })}
                  </Text>
                </Stack>
                <Group gap="xs" wrap="nowrap">
                  <Button
                    size="xs"
                    radius="xl"
                    variant="light"
                    styles={premiumActionButtonStyles}
                    leftSection={<IconPlus size="1rem" />}
                    onClick={openAddAccountModal}
                    disabled={isAccountSyncRunning}
                  >
                    {t("accounts.addAccount", { defaultValue: "Add Account" })}
                  </Button>
                  <Button
                    size="xs"
                    radius="xl"
                    styles={premiumActionButtonStyles}
                    leftSection={<IconPlus size="1rem" />}
                    onClick={openCreateModal}
                  >
                    {t("profiles.add", { defaultValue: "Add Profile" })}
                  </Button>
                </Group>
              </Flex>

              <Divider my="sm" />

              <TextInput
                placeholder={t("profiles.searchPlaceholder", { defaultValue: "Search profiles..." })}
                value={profileQuery}
                onChange={(e) => {
                  setProfileQuery(e.currentTarget.value);
                  setProfilesPage(1);
                }}
                size="xs"
              />

              <Divider my="sm" />

              <Box style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", maxWidth: "100%" }}>
                <Table withTableBorder highlightOnHover striped style={{ minWidth: 860 }}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th style={{ width: 240 }}>
                        <Text fw={600} size="sm">
                          <Group
                            gap={4}
                            style={{ cursor: "pointer" }}
                            onClick={() => {
                              setSortBy((prev) => ({
                                field: "name",
                                direction: prev.field === "name" && prev.direction === "asc" ? "desc" : "asc",
                              }));
                            }}
                          >
                            {t("profiles.profile", { defaultValue: "Profile" })}
                            {sortBy.field === "name" &&
                              (sortBy.direction === "asc" ? (
                                <IconChevronUp size={14} />
                              ) : (
                                <IconChevronDown size={14} />
                              ))}
                          </Group>
                        </Text>
                      </Table.Th>
                      <Table.Th style={{ width: 120 }}>
                        <Text fw={600} size="sm">
                          {t("profiles.fideId", { defaultValue: "FIDE ID" })}
                        </Text>
                      </Table.Th>
                      <Table.Th style={{ width: 160 }}>
                        <Text fw={600} size="sm">
                          <Group
                            gap={4}
                            style={{ cursor: "pointer" }}
                            onClick={() => {
                              setSortBy((prev) => ({
                                field: "lastActivity",
                                direction: prev.field === "lastActivity" && prev.direction === "asc" ? "desc" : "asc",
                              }));
                            }}
                          >
                            {t("accounts.accountCard.lastActivity", { defaultValue: "Last Activity" })}
                            {sortBy.field === "lastActivity" &&
                              (sortBy.direction === "asc" ? (
                                <IconChevronUp size={14} />
                              ) : (
                                <IconChevronDown size={14} />
                              ))}
                          </Group>
                        </Text>
                      </Table.Th>
                      <Table.Th>
                        <Text fw={600} size="sm">
                          {t("accounts.title", { defaultValue: "Accounts" })}
                        </Text>
                      </Table.Th>
                      <Table.Th style={{ width: 160 }}>
                        <Text fw={600} size="sm">
                          {t("common.actions", { defaultValue: "Actions" })}
                        </Text>
                      </Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {pagedProfiles.map((profile) => {
                      const isActive = profile.id === activeProfileId;
                      const linkedSessions = sessionsByProfileId.get(profile.id) ?? [];
                      const syncableSessions = linkedSessions.filter((session) => {
                        const meta = sessionMeta(session);
                        return (meta.platform === "lichess" || meta.platform === "chesscom") && meta.username !== "-";
                      });

                      return (
                        <Table.Tr
                          key={profile.id}
                          style={{
                            background: isActive ? "var(--mantine-color-dark-6)" : undefined,
                          }}
                        >
                          <Table.Td>
                            <Group gap="xs" wrap="nowrap">
                              <Text fw={700} truncate>
                                {profile.name}
                              </Text>
                              {isActive && (
                                <Badge size="xs" color="teal" variant="light">
                                  {t("profiles.active", { defaultValue: "Active" })}
                                </Badge>
                              )}
                            </Group>
                            <Text size="xs" c="dimmed">
                              {t("profiles.accountsCount", {
                                defaultValue: "{{count}} accounts",
                                count: linkedSessions.length,
                              })}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm">{profile.fideId || "-"}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm" c="dimmed">
                              {(() => {
                                const lastActivity = lastActivityMap.get(profile.id);
                                if (lastActivity === null || lastActivity === undefined) {
                                  return "-";
                                }
                                return t("formatters.dateFormat", {
                                  date: parseDate(lastActivity),
                                  interpolation: { escapeValue: false },
                                });
                              })()}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Stack gap={6}>
                              {linkedSessions.map((session) => {
                                const meta = sessionMeta(session);
                                const sessionIndex = sessions.indexOf(session);
                                if (sessionIndex < 0) return null;
                                return (
                                  <Group
                                    key={`${profile.id}:${meta.platform}:${meta.username}`}
                                    gap="xs"
                                    wrap="nowrap"
                                    justify="space-between"
                                  >
                                    <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                                      <Badge
                                        size="xs"
                                        variant="light"
                                        color={meta.platform === "lichess" ? "red" : "blue"}
                                      >
                                        {meta.platform === "chesscom" ? "Chess.com" : meta.platform}
                                      </Badge>
                                      <Text size="sm" truncate>
                                        {meta.username}
                                      </Text>
                                    </Group>
                                    <Group gap="xs" wrap="nowrap">
                                      <Select
                                        size="xs"
                                        data={profilesSelectData}
                                        value={profile.id}
                                        onChange={(value) => {
                                          if (!value) return;
                                          assignSessionToProfile(sessionIndex, value);
                                        }}
                                        searchable
                                        clearable={false}
                                        w={180}
                                      />
                                      <ActionIcon
                                        size="sm"
                                        color="red"
                                        variant="subtle"
                                        onClick={() => void removeSession(session)}
                                        title={t("common.delete", { defaultValue: "Delete" })}
                                      >
                                        <IconTrash size={16} />
                                      </ActionIcon>
                                    </Group>
                                  </Group>
                                );
                              })}
                              {linkedSessions.length === 0 ? (
                                <Text size="sm" c="dimmed">
                                  {t("profiles.noAccounts", {
                                    defaultValue: "No accounts linked to this profile yet.",
                                  })}
                                </Text>
                              ) : null}
                            </Stack>
                          </Table.Td>
                          <Table.Td>
                            <Group gap={4} wrap="nowrap" justify="flex-end">
                              {!isActive && (
                                <ActionIcon
                                  variant="subtle"
                                  onClick={() => setActiveProfile(profile.id)}
                                  title={t("profiles.setActive", { defaultValue: "Set active" })}
                                >
                                  <IconCheck size={16} />
                                </ActionIcon>
                              )}
                              <ActionIcon
                                variant="subtle"
                                onClick={() => {
                                  void syncProfileSessions(profile);
                                }}
                                disabled={isAccountSyncRunning || syncableSessions.length === 0}
                                title={t("profiles.sync.profile", { defaultValue: "Update profile" })}
                              >
                                <IconRefresh size={16} />
                              </ActionIcon>
                              <ActionIcon
                                variant="subtle"
                                onClick={() => {
                                  openFideImportModal(profile);
                                }}
                                disabled={isAccountSyncRunning}
                                title={t("profiles.fideImport.action", {
                                  defaultValue: "Import Lichess FIDE broadcasts",
                                })}
                              >
                                <IconFileImport size={16} />
                              </ActionIcon>
                              <ActionIcon
                                variant="subtle"
                                onClick={() => openAddAccountModalForProfile(profile.id)}
                                disabled={isAccountSyncRunning}
                                title={t("accounts.addAccount", { defaultValue: "Add Account" })}
                              >
                                <IconPlus size={16} />
                              </ActionIcon>
                              <ActionIcon
                                variant="subtle"
                                onClick={() => openEditModal(profile)}
                                title={t("common.edit", { defaultValue: "Edit" })}
                              >
                                <IconEdit size={16} />
                              </ActionIcon>
                              <ActionIcon
                                variant="subtle"
                                color="red"
                                onClick={() => {
                                  void deleteProfile(profile);
                                }}
                                disabled={isAccountSyncRunning}
                                title={t("common.delete", { defaultValue: "Delete" })}
                              >
                                <IconTrash size={16} />
                              </ActionIcon>
                            </Group>
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </Box>
              {totalProfilePages > 1 && (
                <Center mt="sm">
                  <Pagination value={profilesPage} onChange={setProfilesPage} total={totalProfilePages} size="sm" />
                </Center>
              )}
            </Card>

            <Card withBorder radius="lg" p="md" style={premiumMutedPanelStyle}>
              {useTabDropdown && (
                <Select
                  label={t("profiles.tabs.selectSection", { defaultValue: "Section" })}
                  value={detailsTab}
                  onChange={(v) => setDetailsTab((v as typeof detailsTab) ?? "database")}
                  data={detailsTabOptions}
                  allowDeselect={false}
                  mb="sm"
                />
              )}
              <Tabs
                value={detailsTab}
                onChange={(v) => setDetailsTab((v as typeof detailsTab) ?? "database")}
                keepMounted={false}
                styles={{
                  list: premiumTabListStyle,
                }}
              >
                {!useTabDropdown && (
                  <Tabs.List>
                    <Tabs.Tab value="database">{t("profiles.tabs.database", { defaultValue: "Database" })}</Tabs.Tab>
                    <Tabs.Tab value="overview">
                      {t("accounts.personalCard.tabs.overview", { defaultValue: "Overview" })}
                    </Tabs.Tab>
                    <Tabs.Tab value="ratings">
                      {t("accounts.personalCard.tabs.ratings", { defaultValue: "Ratings" })}
                    </Tabs.Tab>
                    <Tabs.Tab value="openings">{t("profiles.tabs.openings", { defaultValue: "Openings" })}</Tabs.Tab>
                    <Tabs.Tab value="stats">{t("profiles.tabs.stats", { defaultValue: "Stats" })}</Tabs.Tab>
                    <Tabs.Tab value="pawnStructures">
                      {t("profiles.tabs.pawnStructures", { defaultValue: "Pawn structures" })}
                    </Tabs.Tab>
                  </Tabs.List>
                )}

                <Tabs.Panel value="database" pt="sm">
                  {!activeProfileId ? (
                    <Text size="sm" c="dimmed">
                      {t("profiles.selectProfile", { defaultValue: "Select profile" })}
                    </Text>
                  ) : dbLoading ? (
                    <Text size="sm" c="dimmed">
                      {t("common.loading", { defaultValue: "Loading..." })}
                    </Text>
                  ) : !profileDatabase ? (
                    <Text size="sm" c="dimmed">
                      {t("profiles.tabs.databaseMissing", { defaultValue: "No database found for this profile." })}
                    </Text>
                  ) : (
                    <DatabaseDetails
                      selectedDatabase={profileDatabase}
                      isReference={referenceDb === profileDatabase.file}
                      onChangeReference={changeReferenceDatabase}
                      mutate={mutateDatabases}
                      exportLoading={exportLoading}
                      setExportLoading={setExportLoading}
                      convertLoading={convertLoading}
                      setConvertLoading={setConvertLoading}
                      onSelect={() => {}}
                      refreshPuzzleDatabases={refreshPuzzleDatabases}
                    />
                  )}
                </Tabs.Panel>
                <Tabs.Panel value="overview" pt="sm" style={{ minHeight: 320 }}>
                  <Databases
                    profileId={activeProfile?.id}
                    initialPlayer={activeProfile?.name}
                    visibleTabs={["overview"]}
                    showPlayerSelector={false}
                  />
                </Tabs.Panel>
                <Tabs.Panel value="ratings" pt="sm" style={{ minHeight: 320 }}>
                  <Databases
                    profileId={activeProfile?.id}
                    initialPlayer={activeProfile?.name}
                    visibleTabs={["ratings"]}
                    showPlayerSelector={false}
                  />
                </Tabs.Panel>
                <Tabs.Panel value="openings" pt="sm" style={{ minHeight: 320 }}>
                  <div
                    style={{
                      height: useTabDropdown ? undefined : "65vh",
                      minHeight: 320,
                      overflow: useTabDropdown ? "visible" : "hidden",
                    }}
                  >
                    <Databases
                      profileId={activeProfile?.id}
                      initialPlayer={activeProfile?.name}
                      visibleTabs={["openings"]}
                      showPlayerSelector={false}
                    />
                  </div>
                </Tabs.Panel>
                <Tabs.Panel value="stats" pt="sm" style={{ minHeight: 320 }}>
                  <div
                    style={{
                      height: useTabDropdown ? undefined : "65vh",
                      minHeight: 320,
                      overflow: useTabDropdown ? "visible" : "hidden",
                    }}
                  >
                    <Databases
                      profileId={activeProfile?.id}
                      initialPlayer={activeProfile?.name}
                      visibleTabs={["stats"]}
                      showPlayerSelector={false}
                    />
                  </div>
                </Tabs.Panel>
                <Tabs.Panel value="pawnStructures" pt="sm">
                  <Paper
                    h="100%"
                    shadow="sm"
                    p="md"
                    withBorder
                    style={{
                      ...premiumMutedPanelStyle,
                      overflow: useTabDropdown ? "visible" : "hidden",
                      display: "flex",
                      flexDirection: "column",
                    }}
                  >
                    <PawnStructuresPanel
                      playerName={activeProfile?.name ?? ""}
                      databaseFile={profileDatabase?.file ?? undefined}
                      profileId={activeProfile?.id ?? undefined}
                    />
                  </Paper>
                </Tabs.Panel>
              </Tabs>
            </Card>
          </Stack>
        </ScrollArea>
      </Stack>

      <Modal
        opened={modalOpened}
        onClose={modal.close}
        title={
          editingProfileId
            ? t("profiles.editTitle", { defaultValue: "Edit profile" })
            : t("profiles.createTitle", { defaultValue: "Create profile" })
        }
        centered
        size="sm"
      >
        <Stack gap="md">
          <TextInput
            label={t("common.name", { defaultValue: "Name" })}
            placeholder={t("profiles.namePlaceholder", { defaultValue: "e.g. Magnus Carlsen" })}
            value={draftName}
            onChange={(e) => setDraftName(e.currentTarget.value)}
            autoFocus
          />
          <TextInput
            label={t("profiles.fideId", { defaultValue: "FIDE ID" })}
            placeholder={t("profiles.fideIdPlaceholder", { defaultValue: "Optional" })}
            value={draftFideId}
            onChange={(e) => setDraftFideId(cleanFideId(e.currentTarget.value))}
          />
          <TextInput
            label={t("features.dashboard.editProfile.lichessToken", { defaultValue: "Lichess Token" })}
            placeholder={t("features.dashboard.editProfile.lichessTokenPlaceholder", {
              defaultValue: "Enter your Lichess API token",
            })}
            description={t("features.dashboard.editProfile.lichessTokenDescription", {
              defaultValue:
                "Required for tournament scheduling. Get one at https://lichess.org/account/oauth/token/create",
            })}
            value={draftLichessToken}
            onChange={(e) => setDraftLichessToken(e.currentTarget.value)}
          />

          <Group justify="flex-end">
            <Button variant="default" onClick={modal.close}>
              {t("common.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button onClick={saveProfile}>{t("common.save", { defaultValue: "Save" })}</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={fideImportModalOpened}
        onClose={fideImportModal.close}
        title={t("profiles.fideImport.title", { defaultValue: "Import Lichess FIDE broadcasts" })}
        centered
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {t("profiles.fideImport.profileTarget", {
              defaultValue: "Destination profile database: {{profile}}",
              profile: fideImportProfile?.name ?? "-",
            })}
          </Text>
          <TextInput
            label={t("profiles.fideImport.linkLabel", { defaultValue: "Lichess FIDE profile link or FIDE ID" })}
            placeholder={t("profiles.fideImport.linkPlaceholder", {
              defaultValue: "https://lichess.org/fide/29667933/Player_Name",
            })}
            value={draftFideImportUrl}
            onChange={(event) => setDraftFideImportUrl(event.currentTarget.value)}
            autoFocus
          />

          <Group justify="flex-end">
            <Button variant="default" onClick={fideImportModal.close}>
              {t("common.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button leftSection={<IconFileImport size={16} />} onClick={submitFideImport}>
              {t("profiles.fideImport.start", { defaultValue: "Import" })}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <AddProfileAccountModal
        opened={accountModalOpened}
        onClose={accountModal.close}
        profiles={profiles}
        defaultProfileId={addAccountDefaultProfileId ?? activeProfileId ?? profiles[0]?.id ?? null}
        disabled={isAccountSyncRunning}
        onAdd={(payload) => {
          void addAccountToProfile(payload, false);
        }}
      />

      {pendingAccountPayload && (
        <AccountVerificationModal
          opened={verificationModalOpened}
          onClose={verificationModal.close}
          platform={pendingAccountPayload.payload.website}
          username={pendingAccountPayload.payload.username}
          onValidate={handleVerificationResult}
        />
      )}
    </>
  );
}
