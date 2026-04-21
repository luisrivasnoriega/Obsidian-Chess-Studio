import {
  Alert,
  Badge,
  Button,
  Card,
  Collapse,
  Divider,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { IconDeviceFloppy, IconDownload, IconKey, IconTrash } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import GenericHeader from "@/components/GenericHeader";
import { activeProfileIdAtom, profilesAtom } from "@/state/atoms";

type ChessbaseCredentialsSummary = {
  username: string | null;
  has_password: boolean;
};

type ChessbaseSessionStatus = {
  connected: boolean;
  username: string | null;
  state: "ready" | "connecting" | "error";
  last_error: string | null;
};

type ChessbaseQuickSearchCount = {
  returned: number;
  total: number;
};

type ChessbasePreparedDownload = {
  query: string;
  maxGames: number;
  downloadedGames: number;
};

type ChessbaseImportPreparedResult = {
  downloadedGames: number;
  importedGames: number;
};

type PendingDownload = {
  query: string;
  maxGames: number;
  downloadedGames: number;
};

async function getChessbaseCredentials(): Promise<ChessbaseCredentialsSummary> {
  return invoke<ChessbaseCredentialsSummary>("chessbase_get_credentials");
}

export default function ChessbasePage() {
  const { t } = useTranslation();
  const profiles = useAtomValue(profilesAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<ChessbaseSessionStatus | null>(null);
  const pollTimer = useRef<number | null>(null);
  const [pendingDownload, setPendingDownload] = useState<PendingDownload | null>(null);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(activeProfileId);
  const [quickSearchCount, setQuickSearchCount] = useState<ChessbaseQuickSearchCount | null>(null);
  const [showCredentials, setShowCredentials] = useState(true);

  const credentialsQuery = useQuery({
    queryKey: ["chessbase", "credentials"],
    queryFn: getChessbaseCredentials,
  });

  const form = useForm({
    initialValues: {
      username: "",
      password: "",
      quickSearch: "",
      maxGames: 100,
    },
  });

  const hasPassword = credentialsQuery.data?.has_password ?? false;
  const isSessionReady = sessionStatus?.state === "ready";

  useEffect(() => {
    const username = credentialsQuery.data?.username ?? "";
    if (username && !form.values.username) {
      form.setFieldValue("username", username);
    }
  }, [credentialsQuery.data?.username, form]);

  useEffect(() => {
    // Hide credential fields if a password is already stored.
    setShowCredentials(!hasPassword);
  }, [hasPassword]);

  useEffect(() => {
    if (!selectedProfileId) setSelectedProfileId(activeProfileId);
  }, [activeProfileId, selectedProfileId]);

  const connectBackground = useCallback(
    async (showToast: boolean) => {
      const status = await invoke<ChessbaseSessionStatus>("chessbase_login_background");
      setSessionStatus(status);

      if (showToast) {
        const message =
          status.state === "ready"
            ? t("chessbase.sessionConnected")
            : status.state === "error"
              ? (status.last_error ?? t("chessbase.sessionError"))
              : t("chessbase.sessionConnecting");

        notifications.show({
          title: t("chessbase.title"),
          message,
          color: status.state === "ready" ? "green" : status.state === "error" ? "red" : "yellow",
        });
      }

      return status;
    },
    [t],
  );

  const onSave = async () => {
    const username = form.values.username.trim();
    const password = form.values.password;
    if (!username || !password) {
      notifications.show({
        title: t("common.error"),
        message: t("chessbase.missingCredentials"),
        color: "red",
      });
      return;
    }

    try {
      await invoke("chessbase_set_credentials", { username, password });
      notifications.show({ title: t("chessbase.title"), message: t("chessbase.saved"), color: "green" });
      form.setFieldValue("password", "");
      await credentialsQuery.refetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notifications.show({ title: t("common.error"), message: msg, color: "red" });
    }
  };

  const onClear = async () => {
    try {
      await invoke("chessbase_clear_credentials");
      await invoke("chessbase_clear_prepared_download");
      notifications.show({ title: t("chessbase.title"), message: t("chessbase.cleared"), color: "green" });
      form.setValues({ username: "", password: "" });
      setSessionStatus(null);
      setQuickSearchCount(null);
      setPendingDownload(null);
      await credentialsQuery.refetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notifications.show({ title: t("common.error"), message: msg, color: "red" });
    }
  };

  const onLoginBackground = async () => {
    try {
      setIsLoggingIn(true);
      const username = form.values.username.trim();
      const password = form.values.password;
      if (username && password) {
        await invoke("chessbase_set_credentials", { username, password });
        form.setFieldValue("password", "");
        await credentialsQuery.refetch();
      } else if (!hasPassword) {
        notifications.show({
          title: t("common.error"),
          message: t("chessbase.missingCredentials"),
          color: "red",
        });
        return;
      }

      await connectBackground(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notifications.show({ title: t("common.error"), message: msg, color: "red" });
    } finally {
      setIsLoggingIn(false);
    }
  };

  useEffect(() => {
    // Auto-connect when credentials are already stored.
    if (!hasPassword) return;
    if (sessionStatus) return;

    void (async () => {
      try {
        setIsLoggingIn(true);
        await connectBackground(false);
        const prepared = await invoke<ChessbasePreparedDownload | null>("chessbase_get_prepared_download");
        if (prepared) {
          setPendingDownload({
            query: prepared.query,
            maxGames: prepared.maxGames,
            downloadedGames: prepared.downloadedGames,
          });
        }
      } finally {
        setIsLoggingIn(false);
      }
    })();
  }, [connectBackground, hasPassword, sessionStatus]);

  useEffect(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }

    if (!sessionStatus || sessionStatus.state !== "connecting") return;

    pollTimer.current = window.setInterval(() => {
      void (async () => {
        try {
          const status = await invoke<ChessbaseSessionStatus>("chessbase_login_background");
          setSessionStatus(status);
          if (status.state !== "connecting" && pollTimer.current !== null) {
            window.clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
        } catch {
          if (pollTimer.current !== null) {
            window.clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
        }
      })();
    }, 1000);

    return () => {
      if (pollTimer.current !== null) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [sessionStatus]);

  const onDownloadQuickSearch = async () => {
    const query = form.values.quickSearch.trim();
    const maxGames = Number(form.values.maxGames) || 50;
    if (!query) {
      notifications.show({
        title: t("common.error"),
        message: t("chessbase.quickSearchMissing"),
        color: "red",
      });
      return;
    }

    try {
      setIsDownloading(true);
      const prepared = await invoke<ChessbasePreparedDownload>("chessbase_prepare_download", {
        query,
        maxGames,
      });

      if (!prepared.downloadedGames || prepared.downloadedGames === 0) {
        notifications.show({
          title: t("common.error"),
          message: t("chessbase.noGamesFound"),
          color: "yellow",
        });
        return;
      }
      notifications.show({
        title: t("chessbase.title"),
        message: t("chessbase.downloaded", { count: prepared.downloadedGames }),
        color: "green",
      });

      setPendingDownload({
        query: prepared.query,
        maxGames: prepared.maxGames,
        downloadedGames: prepared.downloadedGames,
      });
      setSaveModalOpen(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notifications.show({ title: t("common.error"), message: msg, color: "red" });
    } finally {
      setIsDownloading(false);
    }
  };

  const onCheckQuickSearchCount = async () => {
    const query = form.values.quickSearch.trim();
    if (!query) {
      notifications.show({
        title: t("common.error"),
        message: t("chessbase.quickSearchMissing"),
        color: "red",
      });
      return;
    }

    try {
      setIsSearching(true);
      const res = await invoke<ChessbaseQuickSearchCount>("chessbase_quick_search_count", { query });
      setQuickSearchCount(res);
      form.setFieldValue("maxGames", Math.max(1, Math.min(res.total, 1000)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notifications.show({ title: t("common.error"), message: msg, color: "red" });
    } finally {
      setIsSearching(false);
    }
  };

  const onOpenSaveModal = () => {
    if (!pendingDownload) {
      notifications.show({ title: t("common.error"), message: t("chessbase.nothingToSave"), color: "yellow" });
      return;
    }
    if (profiles.length === 0) {
      notifications.show({ title: t("common.error"), message: t("chessbase.noProfiles"), color: "yellow" });
      return;
    }
    setSaveModalOpen(true);
  };

  const onSaveToProfile = async () => {
    if (!pendingDownload) return;
    if (!selectedProfileId) return;

    try {
      setIsSaving(true);
      const res = await invoke<ChessbaseImportPreparedResult>("chessbase_import_prepared_download", {
        profileId: selectedProfileId,
      });
      const inserted = res.importedGames ?? 0;

      const profileName = profiles.find((p) => p.id === selectedProfileId)?.name ?? selectedProfileId;
      notifications.show({
        title: t("chessbase.title"),
        message: t("chessbase.importedToProfile", { count: inserted, profile: profileName }),
        color: "green",
      });
      setSaveModalOpen(false);
      setPendingDownload(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notifications.show({ title: t("common.error"), message: msg, color: "red" });
    } finally {
      setIsSaving(false);
    }
  };

  const quickSearchInputProps = form.getInputProps("quickSearch");

  return (
    <>
      <GenericHeader title={t("chessbase.title")} />
      <Stack flex={1} style={{ minHeight: 0 }}>
        <ScrollArea h="100%" offsetScrollbars>
          <Stack px="md" pb="xl" gap="md">
            <Text c="dimmed">{t("chessbase.description")}</Text>

            {credentialsQuery.isError && (
              <Alert color="red" title={t("common.error")}>
                {String(credentialsQuery.error)}
              </Alert>
            )}

            <Card withBorder radius="md" p="md">
              <Group justify="space-between" align="flex-end" wrap="wrap">
                <Stack gap={2}>
                  <Text fw={700}>{t("chessbase.connectionTitle")}</Text>
                  <Text size="sm" c="dimmed">
                    {credentialsQuery.data?.username ? credentialsQuery.data.username : t("chessbase.noUsername")}
                  </Text>
                </Stack>
                <Group gap="xs" wrap="wrap" justify="flex-end">
                  {sessionStatus && (
                    <Badge
                      color={
                        sessionStatus.state === "ready" ? "green" : sessionStatus.state === "error" ? "red" : "yellow"
                      }
                      variant="light"
                      title={sessionStatus.last_error ?? undefined}
                    >
                      {sessionStatus.state === "ready"
                        ? t("chessbase.sessionConnected")
                        : sessionStatus.state === "error"
                          ? t("chessbase.sessionError")
                          : t("chessbase.sessionConnecting")}
                    </Badge>
                  )}
                  <Badge color={hasPassword ? "green" : "gray"} variant="light">
                    {hasPassword ? t("chessbase.passwordStored") : t("chessbase.passwordNotStored")}
                  </Badge>
                </Group>
              </Group>

              <Divider my="sm" />

              {hasPassword && !isSessionReady && sessionStatus?.state !== "error" && (
                <Alert mt="sm" color="yellow" title={t("chessbase.sessionConnecting")}>
                  {t("chessbase.connectingHint")}
                </Alert>
              )}

              {sessionStatus?.state === "error" && (
                <Alert mt="sm" color="red" title={t("chessbase.sessionError")}>
                  {sessionStatus.last_error ?? t("chessbase.sessionErrorUnknown")}
                </Alert>
              )}

              <Group mt="sm" gap="xs" wrap="wrap">
                {!hasPassword && (
                  <Button
                    leftSection={<IconKey size="1rem" />}
                    size="sm"
                    loading={isLoggingIn}
                    onClick={() => void onLoginBackground()}
                  >
                    {t("chessbase.loginBackground")}
                  </Button>
                )}
                {hasPassword && (
                  <>
                    <Button size="sm" variant="default" loading={isLoggingIn} onClick={() => void onLoginBackground()}>
                      {t("chessbase.reconnect")}
                    </Button>
                    <Button size="sm" variant="default" onClick={() => setShowCredentials((v) => !v)}>
                      {showCredentials ? t("chessbase.hideCredentials") : t("chessbase.editCredentials")}
                    </Button>
                    <Button
                      size="sm"
                      variant="light"
                      color="red"
                      leftSection={<IconTrash size="1rem" />}
                      onClick={() => void onClear()}
                    >
                      {t("chessbase.clear")}
                    </Button>
                  </>
                )}
              </Group>

              <Collapse expanded={showCredentials}>
                <Stack mt="sm" gap="sm">
                  <TextInput
                    label={t("chessbase.usernameLabel")}
                    placeholder={t("chessbase.usernamePlaceholder")}
                    leftSection={<IconKey size="1rem" />}
                    size="sm"
                    {...form.getInputProps("username")}
                  />

                  <PasswordInput
                    label={t("chessbase.passwordLabel")}
                    placeholder={t("chessbase.passwordPlaceholder")}
                    leftSection={<IconKey size="1rem" />}
                    size="sm"
                    {...form.getInputProps("password")}
                  />

                  <Group justify="flex-end" gap="xs" wrap="wrap">
                    <Button size="sm" leftSection={<IconDeviceFloppy size="1rem" />} onClick={() => void onSave()}>
                      {t("chessbase.save")}
                    </Button>
                    <Button
                      leftSection={<IconKey size="1rem" />}
                      size="sm"
                      loading={isLoggingIn}
                      onClick={() => void onLoginBackground()}
                    >
                      {t("chessbase.loginBackground")}
                    </Button>
                  </Group>
                </Stack>
              </Collapse>
            </Card>

            <Card withBorder radius="md" p="md">
              <Group justify="space-between" align="flex-end" wrap="wrap">
                <Stack gap={2}>
                  <Text fw={700}>{t("chessbase.searchTitle")}</Text>
                  <Text size="sm" c="dimmed">
                    {t("chessbase.searchSubtitle")}
                  </Text>
                </Stack>
                {pendingDownload && (
                  <Badge
                    variant="light"
                    color="blue"
                    style={{ cursor: "pointer" }}
                    onClick={onOpenSaveModal}
                    title={t("chessbase.saveToProfile")}
                  >
                    {t("chessbase.lastDownload", { count: pendingDownload.downloadedGames })}
                  </Badge>
                )}
              </Group>

              <Divider my="sm" />

              <Stack gap="sm">
                <Group align="flex-end" wrap="nowrap">
                  <TextInput
                    label={t("chessbase.quickSearchLabel")}
                    placeholder={t("chessbase.quickSearchPlaceholder")}
                    style={{ flex: 1 }}
                    size="sm"
                    {...quickSearchInputProps}
                    onChange={(e) => {
                      quickSearchInputProps.onChange(e);
                      setQuickSearchCount(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      if (!isSessionReady) return;
                      void onCheckQuickSearchCount();
                    }}
                  />
                  <Button
                    size="sm"
                    variant="default"
                    loading={isSearching}
                    disabled={!isSessionReady}
                    onClick={() => void onCheckQuickSearchCount()}
                  >
                    {t("chessbase.search")}
                  </Button>
                </Group>

                {quickSearchCount && (
                  <Text size="sm" c="dimmed">
                    {t("chessbase.quickSearchTotal", { total: quickSearchCount.total })}
                  </Text>
                )}

                <NumberInput
                  label={t("chessbase.maxGamesLabel")}
                  min={1}
                  max={quickSearchCount ? Math.max(1, Math.min(quickSearchCount.total, 1000)) : 1000}
                  clampBehavior="strict"
                  size="sm"
                  {...form.getInputProps("maxGames")}
                />

                <Group justify="space-between" wrap="wrap">
                  <Button
                    leftSection={<IconDownload size="1rem" />}
                    loading={isDownloading}
                    disabled={!isSessionReady}
                    onClick={() => void onDownloadQuickSearch()}
                  >
                    {t("chessbase.download")}
                  </Button>
                </Group>
              </Stack>
            </Card>

            <Modal
              opened={saveModalOpen}
              onClose={() => setSaveModalOpen(false)}
              title={t("chessbase.saveToProfileTitle")}
              centered
            >
              <Stack>
                <Select
                  label={t("chessbase.profileLabel")}
                  data={profiles.map((p) => ({ value: p.id, label: p.name }))}
                  value={selectedProfileId}
                  onChange={setSelectedProfileId}
                  placeholder={t("chessbase.profilePlaceholder")}
                  searchable
                  required
                />

                {pendingDownload && (
                  <Text size="sm" c="dimmed">
                    {t("chessbase.pendingDownloadSummary", {
                      query: pendingDownload.query,
                      games: pendingDownload.downloadedGames,
                    })}
                  </Text>
                )}

                <Group justify="flex-end">
                  <Button variant="default" onClick={() => setSaveModalOpen(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    leftSection={<IconDeviceFloppy size="1rem" />}
                    loading={isSaving}
                    disabled={!selectedProfileId || !pendingDownload}
                    onClick={() => void onSaveToProfile()}
                  >
                    {t("chessbase.saveToProfile")}
                  </Button>
                </Group>
              </Stack>
            </Modal>
          </Stack>
        </ScrollArea>
      </Stack>
    </>
  );
}
