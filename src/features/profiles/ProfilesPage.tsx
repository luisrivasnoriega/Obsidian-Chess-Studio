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
  IconEdit,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { appDataDir, resolve } from "@tauri-apps/api/path";
import { remove } from "@tauri-apps/plugin-fs";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { playerStatsCommands } from "@/bindings/playerStats";
import type { SortState } from "@/components/GenericHeader";
import GenericHeader from "@/components/GenericHeader";
import { DatabaseDetails } from "@/features/databases/DatabasesPage";
import Databases, {
  buildSessionsSignature,
  computePersonalInfoSignature,
  fetchMergedPlayerInfo,
  fetchPersonalInfoForProfile,
  getMergedPlayerInfoQueryKey,
  getPersonalInfoQueryKey,
} from "@/features/profiles/components/PersonalCardPanels/Databases";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { activeProfileIdAtom, type Profile, profilesAtom, referenceDbAtom, sessionsAtom } from "@/state/atoms";
import { getAccountKey } from "@/utils/accountKeys";
import { getAccountPgnPath } from "@/utils/accountPgnPaths";
import { getAccountSyncState } from "@/utils/accountSyncState";
import { getAccountProtectionStatus, type Platform, validateCredentials } from "@/utils/accountVerification";
import { getChessComAccount } from "@/utils/chess.com/api";
import { type DatabaseInfo, getDatabases } from "@/utils/db";
import { parseDate } from "@/utils/format";
import { getLichessAccount } from "@/utils/lichess/api";
import { isFailedToFetchError } from "@/utils/networkCooldown";
import { createSiteStatsSignature } from "@/utils/playerStats";
import { getProfileDbPath, profileDbFilename, setProfileLichessToken } from "@/utils/profileDb";
import { getAccountSyncStateFromProfileDb, syncSessionGamesToProfileDb } from "@/utils/profileGameSync";
import { normalizeProfileName } from "@/utils/profiles";
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

export default function ProfilesPage() {
  const { t } = useTranslation();
  const { layout } = useResponsiveLayout();
  const queryClient = useQueryClient();
  const [profileQuery, setProfileQuery] = useState("");
  const [detailsTab, setDetailsTab] = useState<
    "database" | "overview" | "ratings" | "openings" | "stats" | "pawnStructures"
  >("database");
  const [syncingAccountIds, setSyncingAccountIds] = useState<Set<string>>(new Set());
  const syncingAccountIdsRef = useRef<Set<string>>(new Set());
  const deletedSessionKeysRef = useRef<Set<string>>(new Set());

  const [profiles, setProfiles] = useAtom(profilesAtom);
  const [activeProfileId, setActiveProfileId] = useAtom(activeProfileIdAtom);
  const [sessions, setSessions] = useAtom(sessionsAtom);
  const [referenceDb, setReferenceDb] = useAtom(referenceDbAtom);

  const [dbList, setDbList] = useState<DatabaseInfo[] | null>(null);
  const [dbLoading, setDbLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [convertLoading, setConvertLoading] = useState(false);

  const [modalOpened, modal] = useDisclosure(false);
  const [accountModalOpened, accountModal] = useDisclosure(false);
  const [verificationModalOpened, verificationModal] = useDisclosure(false);
  const [addAccountDefaultProfileId, setAddAccountDefaultProfileId] = useState<string | null>(null);
  const [pendingAccountPayload, setPendingAccountPayload] = useState<{
    payload: AddProfileAccountPayload;
    platform: Platform;
  } | null>(null);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftFideId, setDraftFideId] = useState("");
  const [draftLichessToken, setDraftLichessToken] = useState("");
  const [profilesPage, setProfilesPage] = useState(1);
  const profilesPerPage = 5;
  const [sortBy, setSortBy] = useState<SortState>({ field: "lastActivity", direction: "desc" });
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
  const sessionsSignature = useMemo(() => buildSessionsSignature(sessions), [sessions]);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!activeProfileId) return;
      if (sessions.length === 0) return;

      const personalInfoKey = getPersonalInfoQueryKey(activeProfileId, sessionsSignature);
      const personalInfo = await queryClient.fetchQuery({
        queryKey: personalInfoKey,
        queryFn: () => fetchPersonalInfoForProfile({ effectiveProfileId: activeProfileId, sessions }),
        staleTime: Infinity,
        gcTime: Infinity,
      });
      if (cancelled) return;

      const sig = computePersonalInfoSignature(personalInfo);
      if (!sig) return;

      const mergedKey = getMergedPlayerInfoQueryKey(sig);
      const mergedInfo = await queryClient.fetchQuery({
        queryKey: mergedKey,
        queryFn: () => fetchMergedPlayerInfo(personalInfo),
        staleTime: Infinity,
        gcTime: Infinity,
      });
      if (cancelled) return;

      const ssd = mergedInfo?.site_stats_data ?? [];
      const statsSig = createSiteStatsSignature(ssd);
      if (statsSig.games <= 0) return;

      await queryClient.prefetchQuery({
        queryKey: ["playerSidebarModel", statsSig.key],
        queryFn: async () => unwrap(await playerStatsCommands.calculatePlayerSidebarModel(ssd)),
        staleTime: Infinity,
        gcTime: Infinity,
      });
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, sessions, sessionsSignature, queryClient]);

  // Load last activity dates for all profiles
  useEffect(() => {
    let cancelled = false;
    const loadLastActivities = async () => {
      const activityMap = new Map<string, number | null>();

      for (const profile of filteredProfiles) {
        const linkedSessions = sessionsByProfileId.get(profile.id) ?? [];
        if (linkedSessions.length === 0) {
          activityMap.set(profile.id, null);
          continue;
        }

        const lastDates = await Promise.all(
          linkedSessions.map(async (session) => {
            const type = session.lichess ? "lichess" : "chesscom";
            const username = session.lichess?.username ?? session.chessCom?.username ?? "";
            if (!username || !session.profileId) return null;

            const activityDates: number[] = [];

            // For Lichess accounts, use seenAt (includes all activity: games, puzzles, etc.)
            if (session.lichess?.account?.seenAt) {
              // seenAt is in milliseconds, same as our Date.now()
              activityDates.push(session.lichess.account.seenAt);
            }

            // For Chess.com accounts, use the most recent last.date from stats
            if (session.chessCom?.stats) {
              const stats = session.chessCom.stats;
              const lastDates = [
                stats.chess_bullet?.last?.date,
                stats.chess_blitz?.last?.date,
                stats.chess_rapid?.last?.date,
                stats.chess_daily?.last?.date,
              ]
                .filter((d): d is number => d !== undefined && d !== null)
                .map((d) => d * 1000); // Convert from seconds to milliseconds

              if (lastDates.length > 0) {
                activityDates.push(Math.max(...lastDates));
              }
            }

            // Also check last game date from database
            try {
              const profileDbPath = await getProfileDbPath(session.profileId);
              const accountKey = getAccountKey(type, username);
              const { lastGameDate } = await getAccountSyncStateFromProfileDb(profileDbPath, accountKey);
              if (lastGameDate) {
                activityDates.push(lastGameDate);
              }
            } catch {
              // Ignore errors
            }

            // Return the most recent activity date
            return activityDates.length > 0 ? Math.max(...activityDates) : null;
          }),
        );

        const validDates = lastDates.filter((d): d is number => d !== null);
        const mostRecent = validDates.length > 0 ? Math.max(...validDates) : null;
        activityMap.set(profile.id, mostRecent);
      }

      if (!cancelled) {
        setLastActivityMap(activityMap);
      }
    };

    void loadLastActivities();
    return () => {
      cancelled = true;
    };
  }, [filteredProfiles, sessionsByProfileId]);

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

      try {
        const dbPath = await getProfileDbPath(profile.id);
        const result = await commands.deleteDatabase(dbPath);
        if (result.status === "error") {
          notifications.show({
            title: t("common.error"),
            message: t("common.errorUnknown", { defaultValue: "Something went wrong." }),
            color: "red",
          });
          return;
        }
      } catch {
        notifications.show({
          title: t("common.error"),
          message: t("common.errorUnknown", { defaultValue: "Something went wrong." }),
          color: "red",
        });
        return;
      }

      setProfiles((prev) => prev.filter((p) => p.id !== profile.id));

      if (activeProfileId === profile.id) {
        const remaining = profiles.filter((p) => p.id !== profile.id);
        setActiveProfileId(remaining[0]?.id ?? null);
      }

      notifications.show({
        title: t("common.success", { defaultValue: "Success" }),
        message: t("profiles.deleted", { defaultValue: "Profile deleted." }),
        color: "green",
      });
    },
    [activeProfileId, profiles, sessions, setActiveProfileId, setProfiles, t],
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
    },
    [profiles, upsertSession, verificationModal],
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
  }, [activeProfileId, profiles, upsertSession]);

  const refreshPuzzleDatabases = useCallback(async () => {}, []);

  return (
    <>
      <GenericHeader
        title={t("profiles.title", { defaultValue: "Profiles" })}
        searchPlaceholder={undefined}
        showViewToggle={false}
        actions={
          <Button
            size="xs"
            variant="default"
            leftSection={<IconRefresh size="1rem" />}
            onClick={() => {
              if (activeProfile) void syncProfileSessions(activeProfile);
            }}
            disabled={!activeProfile || activeProfileSyncableCount === 0 || isAccountSyncRunning}
          >
            {t("profiles.sync.active", { defaultValue: "Update active profile" })}
          </Button>
        }
      />

      <Stack flex={1} style={{ minHeight: 0 }}>
        <ScrollArea h="100%" offsetScrollbars>
          <Stack px="md" pb="xl">
            <Card withBorder radius="md" p="md">
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
                    variant="default"
                    leftSection={<IconPlus size="1rem" />}
                    onClick={openAddAccountModal}
                    disabled={isAccountSyncRunning}
                  >
                    {t("accounts.addAccount", { defaultValue: "Add Account" })}
                  </Button>
                  <Button size="xs" leftSection={<IconPlus size="1rem" />} onClick={openCreateModal}>
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

            <Card withBorder radius="md" p="md">
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
