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
  Paper,
  Modal,
  Pagination,
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
import { IconCheck, IconEdit, IconPlus, IconTrash, IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { listen } from "@tauri-apps/api/event";
import { appDataDir, resolve } from "@tauri-apps/api/path";
import { mkdir, remove } from "@tauri-apps/plugin-fs";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import GenericHeader from "@/components/GenericHeader";
import Databases from "@/features/profiles/components/PersonalCardPanels/Databases";
import { DatabaseDetails } from "@/features/databases/DatabasesPage";
import { activeProfileIdAtom, type Profile, profilesAtom, referenceDbAtom, sessionsAtom } from "@/state/atoms";
import { getAccountPgnPath } from "@/utils/accountPgnPaths";
import { downloadChessCom, getChessComAccount } from "@/utils/chess.com/api";
import { type DatabaseInfo, getDatabases } from "@/utils/db";
import { downloadLichess, getLichessAccount } from "@/utils/lichess/api";
import { rewritePgnAccountTags } from "@/utils/pgnAccountTags";
import { unwrap } from "@/utils/unwrap";
import { getProfileDbPath, profileDbFilename } from "@/utils/profileDb";
import { getAccountSyncStateFromProfileDb, syncSessionGamesToProfileDb } from "@/utils/profileGameSync";
import { normalizeProfileName } from "@/utils/profiles";
import type { ChessComSession, LichessSession, Session } from "@/utils/session";
import { genID } from "@/utils/tabs";
import { getAccountKey } from "@/utils/accountKeys";
import { parseDate } from "@/utils/format";
import type { SortState } from "@/components/GenericHeader";
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

export default function ProfilesPage() {
  const { t } = useTranslation();
  const [profileQuery, setProfileQuery] = useState("");

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
  const [addAccountDefaultProfileId, setAddAccountDefaultProfileId] = useState<string | null>(null);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftFideId, setDraftFideId] = useState("");
  const [profilesPage, setProfilesPage] = useState(1);
  const profilesPerPage = 5;
  const [sortBy, setSortBy] = useState<SortState>({ field: "lastActivity", direction: "desc" });
  const [lastActivityMap, setLastActivityMap] = useState<Map<string, number | null>>(new Map());

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
  }, [filteredProfiles, sessionsByProfileId, sessions]);

  // Auto-update statistics and download games for all accounts of all profiles
  useEffect(() => {
    if (sessions.length === 0) return;

    const run = async () => {
      try {
        const dbDir = await resolve(await appDataDir(), "db");
        await mkdir(dbDir, { recursive: true });
      } catch {
        // Best-effort; downloads/conversion will surface errors if this fails.
      }

      const profileNameById = new Map(profiles.map((p) => [p.id, p.name] as const));

      const getDbSyncState = async (
        dbFile: string,
        platform: "lichess" | "chesscom",
        username: string,
      ): Promise<{ lastGameDate: number | null; count: number }> => {
        try {
          const accountKey = getAccountKey(platform, username);
          return await getAccountSyncStateFromProfileDb(dbFile, accountKey);
        } catch {
          return { lastGameDate: null, count: 0 };
        }
      };

      // Separate sessions by platform for rate limiting
      const lichessSessions: Array<{ session: Session; profileId: string }> = [];
      const chessComSessions: Array<{ session: Session; profileId: string }> = [];

      for (const session of sessions) {
        const profileId = session.profileId ?? activeProfileId;
        if (!profileId) continue;

        if (session.lichess) {
          lichessSessions.push({ session, profileId });
        }
        if (session.chessCom) {
          chessComSessions.push({ session, profileId });
        }
      }

      // Process Lichess accounts (no rate limiting needed)
      for (const { session, profileId } of lichessSessions) {
        try {
          const username = session.lichess!.username;
          const token = session.lichess!.accessToken;

          const dbPath = await getProfileDbPath(profileId);
          const dbTitle = profileNameById.get(profileId) ?? `Profile ${profileId}`;

          const updatedAccount = await getLichessAccount({ token, username });
          if (updatedAccount) {
            setSessions((prev) =>
              prev.map((s) =>
                (s.profileId ?? activeProfileId) === profileId && s.lichess?.username === username
                  ? { ...s, updatedAt: Date.now(), lichess: { ...s.lichess, account: updatedAccount } }
                  : s,
              ),
            );
          }

          const { lastGameDate, count } = await getDbSyncState(dbPath, "lichess", username);
          const totalGames = updatedAccount?.count?.all ?? session.lichess!.account.count?.all ?? 0;
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
            await commands.convertPgn(pgnPath, dbPath, lastGameDate ? lastGameDate / 1000 : null, dbTitle, null),
          );
        } catch {
          // Best-effort: keep processing other accounts.
        }
      }

      // Process Chess.com accounts with rate limiting (1 request per second minimum)
      const CHESS_COM_DELAY_MS = 1200; // 1.2 seconds between requests to be safe
      for (let i = 0; i < chessComSessions.length; i++) {
        const { session, profileId } = chessComSessions[i]!;
        
        // Add delay before each request (except the first one)
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, CHESS_COM_DELAY_MS));
        }

        try {
          const username = session.chessCom!.username;

          const dbPath = await getProfileDbPath(profileId);
          const dbTitle = profileNameById.get(profileId) ?? `Profile ${profileId}`;

          const updatedStats = await getChessComAccount(username);
          if (updatedStats) {
            setSessions((prev) =>
              prev.map((s) =>
                (s.profileId ?? activeProfileId) === profileId && s.chessCom?.username === username
                  ? { ...s, updatedAt: Date.now(), chessCom: { ...s.chessCom, stats: updatedStats } }
                  : s,
              ),
            );
          }

          // Add delay before download
          await new Promise((resolve) => setTimeout(resolve, CHESS_COM_DELAY_MS));

          const { lastGameDate } = await getDbSyncState(dbPath, "chesscom", username);

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
            await commands.convertPgn(pgnPath, dbPath, lastGameDate ? lastGameDate / 1000 : null, dbTitle, null),
          );
        } catch {
          // Best-effort: keep processing other accounts.
        }
      }
    };

    void run();
  }, [activeProfileId, profiles, sessions, setSessions]);

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
    modal.open();
  }, [modal]);

  const openAddAccountModal = useCallback(() => {
    setAddAccountDefaultProfileId(activeProfileId ?? profiles[0]?.id ?? null);
    accountModal.open();
  }, [accountModal, activeProfileId, profiles]);

  const openAddAccountModalForProfile = useCallback(
    (profileId: string) => {
      setAddAccountDefaultProfileId(profileId);
      accountModal.open();
    },
    [accountModal],
  );

  const openEditModal = useCallback(
    (profile: Profile) => {
      setEditingProfileId(profile.id);
      setDraftName(profile.name);
      setDraftFideId(profile.fideId ?? "");
      modal.open();
    },
    [modal],
  );

  const saveProfile = useCallback(async () => {
    const now = Date.now();
    const name = normalizeProfileName(draftName);
    const fideId = cleanFideId(draftFideId);

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
        prev.map((p) => (p.id === editingProfileId ? { ...p, name, fideId: fideId || undefined, updatedAt: now } : p)),
      );

      setSessions((prev) =>
        prev.map((s) => (s.profileId === editingProfileId ? { ...s, player: name, updatedAt: now } : s)),
      );

      notifications.show({
        title: t("common.success", { defaultValue: "Success" }),
        message: t("profiles.updated", { defaultValue: "Profile updated." }),
        color: "green",
      });
      modal.close();
      return;
    }

    const next: Profile = { id: genID(), name, fideId: fideId || undefined, createdAt: now, updatedAt: now };
    setProfiles((prev) => [...prev, next]);
    setActiveProfileId(next.id);

    try {
      const dbPath = await getProfileDbPath(next.id);
      const result = await commands.initProfileDb(dbPath, next.name, null);
      if (result.status === "error") {
      }
    } catch (error) {
    }

    notifications.show({
      title: t("common.success", { defaultValue: "Success" }),
      message: t("profiles.created", { defaultValue: "Profile created." }),
      color: "green",
    });

    modal.close();
  }, [draftFideId, draftName, editingProfileId, modal, profiles, setActiveProfileId, setProfiles, setSessions, t]);

  const deleteProfile = useCallback(
    (profile: Profile) => {
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

      setSessions((prev) =>
        prev.filter((s) => {
          if (platform === "lichess") {
            return !((s.profileId ?? null) === profileId && s.lichess?.username === username);
          }
          return !((s.profileId ?? null) === profileId && s.chessCom?.username === username);
        }),
      );
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
      const username = session.lichess?.username ?? session.chessCom?.username ?? "account";
      const meta = sessionMeta(session);
      const id = `sync:${profile.id}:${username}`;
      notifications.show({
        id,
        title: t("accounts.processingGames", { defaultValue: "Processing Games..." }),
        message: `${profile.name} - ${username} (${meta.platform}) ${t("accounts.processing", { defaultValue: "processing" })}`,
        loading: true,
        autoClose: false,
      });

      void syncSessionGamesToProfileDb({ profile, session })
        .then((res) => {
          if (res.updatedSession) {
            upsertSession(res.updatedSession);
          }
          notifications.update({
            id,
            title: t("common.success", { defaultValue: "Success" }),
            message: `${profile.name} - ${username} (${meta.platform}) ${t("accounts.processing", { defaultValue: "processing" })}`,
            color: "green",
            loading: false,
            autoClose: 2500,
          });
          notifications.show({
            title: t("common.success", { defaultValue: "Success" }),
            message: `Termino de procesar la cuenta ${meta.platform} de ${username}`,
            color: "green",
          });
        })
        .catch(() => {
          notifications.update({
            id,
            title: t("common.error", { defaultValue: "Error" }),
            message: t("accounts.databaseLoadError", { defaultValue: "Error loading database" }),
            color: "red",
            loading: false,
            autoClose: 4000,
          });
        });
    },
    [t, upsertSession],
  );

  const addAccountToProfile = useCallback(
    async (payload: AddProfileAccountPayload) => {
      const profile = profiles.find((p) => p.id === payload.profileId) ?? null;
      if (!profile) return;

      const now = Date.now();
      const profileName = profile.name;

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
    [profiles, startBackgroundSync, upsertSession],
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

  const mutateDatabases = useCallback(() => {
    void loadDatabases();
  }, [loadDatabases]);

  const refreshPuzzleDatabases = useCallback(async () => {}, []);

  return (
    <>
      <GenericHeader
        title={t("profiles.title", { defaultValue: "Profiles" })}
        searchPlaceholder={undefined}
        showViewToggle={false}
        actions={undefined}
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

              <Box>
                <Table withTableBorder highlightOnHover striped>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th style={{ width: 240 }}>
                        <Text fw={600} size="sm">
                          <Group gap={4} style={{ cursor: "pointer" }} onClick={() => {
                            setSortBy((prev) => ({
                              field: "name",
                              direction: prev.field === "name" && prev.direction === "asc" ? "desc" : "asc",
                            }));
                          }}>
                            {t("profiles.profile", { defaultValue: "Profile" })}
                            {sortBy.field === "name" && (
                              sortBy.direction === "asc" ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />
                            )}
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
                          <Group gap={4} style={{ cursor: "pointer" }} onClick={() => {
                            setSortBy((prev) => ({
                              field: "lastActivity",
                              direction: prev.field === "lastActivity" && prev.direction === "asc" ? "desc" : "asc",
                            }));
                          }}>
                            {t("accounts.accountCard.lastActivity", { defaultValue: "Last Activity" })}
                            {sortBy.field === "lastActivity" && (
                              sortBy.direction === "asc" ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />
                            )}
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
                                onClick={() => openAddAccountModalForProfile(profile.id)}
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
                                onClick={() => deleteProfile(profile)}
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
              <Tabs defaultValue="database" keepMounted={false}>
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
                  <div style={{ height: "65vh", minHeight: 320, overflow: "hidden" }}>
                    <Databases
                      profileId={activeProfile?.id}
                      initialPlayer={activeProfile?.name}
                      visibleTabs={["openings"]}
                      showPlayerSelector={false}
                    />
                  </div>
                </Tabs.Panel>
                <Tabs.Panel value="stats" pt="sm">
                  <Text size="sm" c="dimmed">
                    {t("profiles.tabs.statsDesc", { defaultValue: "Stats content coming soon." })}
                  </Text>
                </Tabs.Panel>
                <Tabs.Panel value="pawnStructures" pt="sm">
                  <Paper
                    h="100%"
                    shadow="sm"
                    p="md"
                    withBorder
                    style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}
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
        onAdd={(payload) => {
          void addAccountToProfile(payload);
        }}
      />
    </>
  );
}
