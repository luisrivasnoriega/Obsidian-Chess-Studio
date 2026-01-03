import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Divider,
  Grid,
  Group,
  Modal,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconEdit, IconPlus, IconTrash } from "@tabler/icons-react";
import { listen } from "@tauri-apps/api/event";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import GenericHeader from "@/components/GenericHeader";
import { activeProfileIdAtom, profilesAtom, sessionsAtom, type Profile } from "@/state/atoms";
import { commands } from "@/bindings";
import { getChessComAccount } from "@/utils/chess.com/api";
import { getLichessAccount } from "@/utils/lichess/api";
import type { ChessComSession, LichessSession, Session } from "@/utils/session";
import { normalizeProfileName } from "@/utils/profiles";
import { genID } from "@/utils/tabs";
import { syncSessionGamesToProfileDb } from "@/utils/profileGameSync";
import { getProfileDbPath } from "@/utils/profileDb";
import { AddProfileAccountModal, type AddProfileAccountPayload } from "./components/AddProfileAccountModal";

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

  const [modalOpened, modal] = useDisclosure(false);
  const [accountModalOpened, accountModal] = useDisclosure(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftFideId, setDraftFideId] = useState("");

  const accountsByProfileId = useMemo(() => {
    const map = new Map<string, Array<{ platform: string; username: string }>>();
    for (const session of sessions) {
      const profileId = session.profileId;
      if (!profileId) continue;
      const meta = sessionMeta(session);
      const list = map.get(profileId) ?? [];
      list.push({ platform: meta.platform, username: meta.username });
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

  const profilesSelectData = useMemo(() => profiles.map((p) => ({ value: p.id, label: p.name })), [profiles]);
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) ?? null,
    [profiles, activeProfileId],
  );

  const openCreateModal = useCallback(() => {
    setEditingProfileId(null);
    setDraftName("");
    setDraftFideId("");
    modal.open();
  }, [modal]);

  const openAddAccountModal = useCallback(() => {
    accountModal.open();
  }, [accountModal]);

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

    const nameTaken = profiles.some(
      (p) => p.id !== editingProfileId && p.name.toLowerCase() === name.toLowerCase(),
    );
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
            ? { ...p, name, fideId: fideId || undefined, updatedAt: now }
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
  }, [
    commands,
    draftFideId,
    draftName,
    editingProfileId,
    getProfileDbPath,
    modal,
    profiles,
    setActiveProfileId,
    setProfiles,
    setSessions,
    t,
  ]);

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
      const id = `sync:${profile.id}:${username}`;
      notifications.show({
        id,
        title: t("accounts.processingGames", { defaultValue: "Processing Games..." }),
        message: `${profile.name} · ${username}`,
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
            message: `${profile.name} · ${username}`,
            color: "green",
            loading: false,
            autoClose: 2500,
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

  return (
    <>
      <GenericHeader
        title={t("profiles.title", { defaultValue: "Profiles" })}
        searchPlaceholder={undefined}
        showViewToggle={false}
        actions={
          <Group gap="xs" wrap="nowrap">
            <Button size="xs" variant="default" leftSection={<IconPlus size="1rem" />} onClick={openAddAccountModal}>
              {t("accounts.addAccount", { defaultValue: "Add Account" })}
            </Button>
            <Button size="xs" leftSection={<IconPlus size="1rem" />} onClick={openCreateModal}>
              {t("profiles.add", { defaultValue: "Add Profile" })}
            </Button>
          </Group>
        }
      />

      <Stack flex={1} px="md" pb="md" style={{ overflow: "hidden" }}>
        <Grid gutter="md">
          <Grid.Col span={{ base: 12, md: 5, lg: 4 }}>
            <Card withBorder radius="md" p="md">
              <Group justify="space-between" align="center">
                <Text fw={700}>{t("profiles.listTitle", { defaultValue: "Profiles" })}</Text>
                <Badge variant="light" color="gray">
                  {sortedProfiles.length}
                </Badge>
              </Group>
              <Divider my="sm" />
              <TextInput
                placeholder={t("profiles.searchPlaceholder", { defaultValue: "Search profiles..." })}
                value={profileQuery}
                onChange={(e) => setProfileQuery(e.currentTarget.value)}
                size="xs"
              />
              <Stack gap="xs">
                {sortedProfiles.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t("profiles.empty", { defaultValue: "No profiles yet." })}
                  </Text>
                ) : (
                  sortedProfiles.slice(0, 5).map((profile) => {
                    const isActive = profile.id === activeProfileId;
                    const accountsCount = (accountsByProfileId.get(profile.id) ?? []).length;
                    return (
                      <Card
                        key={profile.id}
                        withBorder
                        radius="md"
                        p="sm"
                        style={{
                          background: isActive ? "var(--mantine-color-dark-6)" : undefined,
                          borderColor: isActive ? "var(--mantine-color-teal-6)" : undefined,
                        }}
                      >
                        <Group justify="space-between" wrap="nowrap" align="flex-start">
                          <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                            <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                              <Text fw={700} truncate>
                                {profile.name}
                              </Text>
                              {isActive && (
                                <Badge size="xs" color="teal" variant="light">
                                  {t("profiles.active", { defaultValue: "Active" })}
                                </Badge>
                              )}
                            </Group>
                            <Group gap="xs" wrap="wrap">
                              <Badge size="xs" variant="light" color="gray">
                                {t("profiles.accountsCount", {
                                  defaultValue: "{{count}} accounts",
                                  count: accountsCount,
                                })}
                              </Badge>
                              {profile.fideId && (
                                <Badge size="xs" variant="light" color="yellow">
                                  FIDE {profile.fideId}
                                </Badge>
                              )}
                            </Group>
                          </Stack>

                          <Group gap={4} wrap="nowrap">
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
                        </Group>
                      </Card>
                    );
                  })
                )}
                {sortedProfiles.length > 5 && (
                  <Select
                    size="xs"
                    data={sortedProfiles.slice(5).map((p) => ({ value: p.id, label: p.name }))}
                    value={null}
                    onChange={(value) => {
                      if (!value) return;
                      setActiveProfile(value);
                    }}
                    placeholder={t("profiles.moreProfiles", { defaultValue: "More profiles..." })}
                    searchable
                    clearable={false}
                  />
                )}
              </Stack>
            </Card>
          </Grid.Col>

          <Grid.Col span={{ base: 12, md: 7, lg: 8 }}>
            <Card withBorder radius="md" p="md" style={{ height: "100%" }}>
              <Group justify="space-between" align="center">
                <Text fw={700}>{t("profiles.linkAccountsTitle", { defaultValue: "Link accounts" })}</Text>
                <Badge variant="light" color="gray">
                  {sessions.length}
                </Badge>
              </Group>
              <Text size="sm" c="dimmed" mt={4}>
                {t("profiles.linkAccountsHint", {
                  defaultValue: "Assign each account to a profile. All games will be stored in the profile database.",
                })}
              </Text>
              <Divider my="sm" />

              {sessions.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t("profiles.noAccounts", {
                    defaultValue: "No accounts found. Add accounts first in the Accounts page.",
                  })}
                </Text>
              ) : (
                <Table withTableBorder withColumnBorders highlightOnHover striped>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t("accounts.website", { defaultValue: "Website" })}</Table.Th>
                      <Table.Th>{t("accounts.username", { defaultValue: "Username" })}</Table.Th>
                      <Table.Th>{t("profiles.profile", { defaultValue: "Profile" })}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {sessions.map((session, idx) => {
                      const meta = sessionMeta(session);
                      const currentProfile = session.profileId ?? null;
                      return (
                        <Table.Tr key={`${meta.platform}:${meta.username}:${idx}`}>
                          <Table.Td style={{ width: 140 }}>
                            <Badge variant="light" color={meta.platform === "lichess" ? "red" : "blue"}>
                              {meta.platform === "chesscom" ? "Chess.com" : meta.platform}
                            </Badge>
                          </Table.Td>
                          <Table.Td>{meta.username}</Table.Td>
                          <Table.Td style={{ width: 260 }}>
                            <Select
                              size="xs"
                              data={profilesSelectData}
                              value={currentProfile}
                              onChange={(value) => {
                                if (!value) return;
                                assignSessionToProfile(idx, value);
                              }}
                              placeholder={t("profiles.selectProfile", { defaultValue: "Select profile" })}
                              searchable
                              clearable={false}
                            />
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              )}
            </Card>
          </Grid.Col>
        </Grid>
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
            <Button onClick={saveProfile}>
              {t("common.save", { defaultValue: "Save" })}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <AddProfileAccountModal
        opened={accountModalOpened}
        onClose={accountModal.close}
        profiles={profiles}
        defaultProfileId={activeProfileId ?? profiles[0]?.id ?? null}
        onAdd={(payload) => {
          void addAccountToProfile(payload);
        }}
      />
    </>
  );
}
