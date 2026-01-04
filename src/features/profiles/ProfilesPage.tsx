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
import { IconCheck, IconEdit, IconPlus, IconTrash } from "@tabler/icons-react";
import { listen } from "@tauri-apps/api/event";
import { appDataDir, resolve } from "@tauri-apps/api/path";
import { remove } from "@tauri-apps/plugin-fs";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import GenericHeader from "@/components/GenericHeader";
import Databases from "@/features/accounts/components/Databases";
import { DatabaseDetails } from "@/features/databases/DatabasesPage";
import { activeProfileIdAtom, type Profile, profilesAtom, referenceDbAtom, sessionsAtom } from "@/state/atoms";
import { getAccountPgnPath } from "@/utils/accountPgnPaths";
import { getChessComAccount } from "@/utils/chess.com/api";
import { type DatabaseInfo, getDatabases } from "@/utils/db";
import { getLichessAccount } from "@/utils/lichess/api";
import { getProfileDbPath, profileDbFilename } from "@/utils/profileDb";
import { syncSessionGamesToProfileDb } from "@/utils/profileGameSync";
import { normalizeProfileName } from "@/utils/profiles";
import type { ChessComSession, LichessSession, Session } from "@/utils/session";
import { genID } from "@/utils/tabs";
import { AddProfileAccountModal, type AddProfileAccountPayload } from "./components/AddProfileAccountModal";
import PawnStructuresPanel from "./components/PawnStructuresPanel";

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

  const sortedProfiles = useMemo(() => {
    const list = [...filteredProfiles];
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return list;
  }, [filteredProfiles]);

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
        console.warn("Failed to init profile db:", result.error);
      }
    } catch (error) {
      console.warn("Failed to init profile db:", error);
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
        message: `${profile.name} - ${username} (${meta.platform}) procesado`,
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
            message: `${profile.name} - ${username} (${meta.platform}) procesado`,
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
                      <Table.Th style={{ width: 240 }}>{t("profiles.profile", { defaultValue: "Profile" })}</Table.Th>
                      <Table.Th style={{ width: 120 }}>{t("profiles.fideId", { defaultValue: "FIDE ID" })}</Table.Th>
                      <Table.Th>{t("accounts.title", { defaultValue: "Accounts" })}</Table.Th>
                      <Table.Th style={{ width: 160 }}>{t("common.actions", { defaultValue: "Actions" })}</Table.Th>
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
                  <PawnStructuresPanel
                    playerName={activeProfile?.name ?? ""}
                    databaseFile={profileDatabase?.file ?? undefined}
                    profileId={activeProfile?.id ?? undefined}
                  />
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
