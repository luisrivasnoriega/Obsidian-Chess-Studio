import {
  ActionIcon,
  Box,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  Modal,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { useForm } from "@mantine/form";
import { useMediaQuery } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { DataTable, type DataTableSortStatus } from "mantine-datatable";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type GameQuery, type NormalizedGame } from "@/bindings";
import GenericHeader from "@/components/GenericHeader";
import { activeProfileIdAtom, activeTabAtom, profilesAtom, sessionsAtom, tabsAtom } from "@/state/atoms";
import {
  premiumActionButtonStyles,
  premiumKpiCardStyle,
  premiumMutedPanelStyle,
  premiumPanelStyle,
} from "@/styles/premiumSurface";
import { query_games } from "@/utils/db";
import { formatDateToPGN, parseDate } from "@/utils/format";
import {
  addEventGamesFromPgn,
  createEventGame,
  deleteManagedEvent,
  listManagedEvents,
  type ManagedEvent,
  type ManagedEventType,
  upsertManagedEvent,
} from "@/utils/managedEvents";
import { getProfileDbPath } from "@/utils/profileDb";
import { createTab } from "@/utils/tabs";
import { unwrap } from "@/utils/unwrap";

type CreateFormValues = {
  name: string;
  eventType: ManagedEventType;
  location: string;
  timeControl: string;
  startDate: Date | null;
  endDate: Date | null;
};

type CreateGameFormValues = {
  entryMode: "manual" | "pgn";
  profileSide: "manual" | "white" | "black";
  opponent: string;
  white: string;
  black: string;
  date: Date | null;
  round: string;
  result: "1-0" | "0-1" | "1/2-1/2" | "*";
  pgnText: string;
};

function escapePgnHeaderValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function overridePgnPlayerBySide(pgn: string, side: "manual" | "white" | "black", activePlayerName: string): string {
  if (side === "manual") return pgn;
  const trimmedName = activePlayerName.trim();
  if (!trimmedName) return pgn;

  const escaped = escapePgnHeaderValue(trimmedName);
  if (side === "white") {
    return pgn.replace(/^\[White\s+"([^"]*)"\]\s*$/gm, `[White "${escaped}"]`);
  }
  return pgn.replace(/^\[Black\s+"([^"]*)"\]\s*$/gm, `[Black "${escaped}"]`);
}

export default function EventsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const _isMobile = useMediaQuery("(max-width: 48em)");
  const [_tabs, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);

  const profiles = useAtomValue(profilesAtom);
  const sessions = useAtomValue(sessionsAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [activeProfileId, profiles],
  );

  const [addGameModalOpened, setAddGameModalOpened] = useState(false);
  const [activeEvent, setActiveEvent] = useState<ManagedEvent | null>(null);
  const [isCreatingGame, setIsCreatingGame] = useState(false);
  const [expandedEventIds, setExpandedEventIds] = useState<number[]>([]);
  const [eventSortStatus, setEventSortStatus] = useState<DataTableSortStatus<ManagedEvent>>({
    columnAccessor: "id",
    direction: "asc",
  });

  const form = useForm<CreateFormValues>({
    initialValues: {
      name: "",
      eventType: "otb_tournament",
      location: "",
      timeControl: "",
      startDate: null,
      endDate: null,
    },
    validate: {
      name: (value) =>
        value.trim().length === 0 ? t("features.events.validation.nameRequired", "Name is required") : null,
    },
  });

  const gameForm = useForm<CreateGameFormValues>({
    initialValues: {
      entryMode: "manual",
      profileSide: "white",
      opponent: "",
      white: "",
      black: "",
      date: null,
      round: "",
      result: "*",
      pgnText: "",
    },
    validate: {
      white: (value, values) =>
        values.entryMode === "manual" && values.profileSide === "manual" && value.trim().length === 0
          ? t("features.events.games.validation.whiteRequired", "White is required")
          : null,
      black: (value, values) =>
        values.entryMode === "manual" && values.profileSide === "manual" && value.trim().length === 0
          ? t("features.events.games.validation.blackRequired", "Black is required")
          : null,
      opponent: (value, values) =>
        values.entryMode === "manual" && values.profileSide !== "manual" && value.trim().length === 0
          ? t("features.events.games.validation.opponentRequired", "Opponent is required")
          : null,
      pgnText: (value, values) =>
        values.entryMode === "pgn" && value.trim().length === 0
          ? t("features.events.games.validation.pgnRequired", "PGN is required")
          : null,
    },
  });

  const activeProfilePlayerName = useMemo(() => {
    if (!activeProfile) return "";
    const profileName = activeProfile.displayName?.trim() || activeProfile.name?.trim() || "";
    const profileSessions = sessions.filter((session) => session.profileId === activeProfile.id);
    const sessionPlayerNames = profileSessions
      .map(
        (session) =>
          session.player?.trim() || session.lichess?.username?.trim() || session.chessCom?.username?.trim() || "",
      )
      .filter((name) => name.length > 0);
    return sessionPlayerNames[0] ?? profileName;
  }, [activeProfile, sessions]);

  const { data: dbPath, isLoading: isLoadingDbPath } = useQuery<string | null>({
    queryKey: ["profileDbPath", activeProfileId],
    queryFn: async () => {
      if (!activeProfileId) return null;
      return await getProfileDbPath(activeProfileId);
    },
    enabled: !!activeProfileId,
    staleTime: Infinity,
  });

  const {
    data: managedEvents,
    isLoading: isLoadingEvents,
    error: eventsError,
  } = useQuery({
    queryKey: ["managedEvents", dbPath],
    queryFn: async () => {
      if (!dbPath) return [];
      return await listManagedEvents(dbPath);
    },
    enabled: !!dbPath,
    staleTime: 30_000,
  });

  const handleCreate = async (values: CreateFormValues) => {
    if (!dbPath) return;
    try {
      await upsertManagedEvent(dbPath, {
        name: values.name.trim(),
        eventType: values.eventType,
        location: values.location.trim() || null,
        startDate: formatDateToPGN(values.startDate) ?? null,
        endDate: formatDateToPGN(values.endDate) ?? null,
        timeControl: values.timeControl.trim() || null,
      });

      notifications.show({
        title: t("features.events.notifications.createdTitle", "Tournament created"),
        message: t("features.events.notifications.createdMessage", "Tournament saved successfully."),
        color: "green",
      });

      form.reset();
      await queryClient.invalidateQueries({ queryKey: ["managedEvents", dbPath] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifications.show({
        title: t("features.events.notifications.createFailedTitle", "Could not create tournament"),
        message,
        color: "red",
      });
    }
  };

  const openAddGamesModal = (event: ManagedEvent) => {
    setActiveEvent(event);
    gameForm.reset();
    setAddGameModalOpened(true);
  };

  const handleDeleteEvent = (event: ManagedEvent) => {
    if (!dbPath) return;

    modals.openConfirmModal({
      title: t("features.events.delete.confirmTitle", "Delete tournament"),
      children: (
        <Text size="sm">
          {t("features.events.delete.confirmMessage", "This will delete the tournament and all its games.")}
        </Text>
      ),
      labels: { confirm: t("common.delete", "Delete"), cancel: t("common.cancel", "Cancel") },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          const deleted = await deleteManagedEvent(dbPath, event.id);
          if (!deleted) return;
          notifications.show({
            title: t("features.events.notifications.deletedTitle", "Tournament deleted"),
            message: t("features.events.notifications.deletedMessage", "Tournament removed successfully."),
            color: "green",
          });
          await queryClient.invalidateQueries({ queryKey: ["managedEvents", dbPath] });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notifications.show({
            title: t("features.events.notifications.deleteFailedTitle", "Could not delete tournament"),
            message,
            color: "red",
          });
        }
      },
    });
  };

  const handleCreateGame = async (values: CreateGameFormValues) => {
    if (!dbPath || !activeEvent) return;

    setIsCreatingGame(true);
    try {
      if (values.entryMode === "pgn") {
        let pgnText = values.pgnText.trim();
        if (values.profileSide !== "manual") {
          const profileName = activeProfilePlayerName.trim();
          if (!profileName) {
            notifications.show({
              title: t("common.error"),
              message: t("features.events.addGame.activeProfileNameRequired", "Active profile name is required."),
              color: "red",
            });
            return;
          }
          pgnText = overridePgnPlayerBySide(pgnText, values.profileSide, profileName);
        }

        const inserted = await addEventGamesFromPgn(dbPath, activeEvent.id, pgnText);
        if (inserted > 0) {
          notifications.show({
            title: t("features.events.notifications.gamesAddedTitle", "Games imported"),
            message: t("features.events.notifications.gamesAddedMessage", "Imported {{count}} games.", {
              count: inserted,
            }),
            color: "green",
          });
        } else {
          notifications.show({
            title: t("features.events.notifications.noGamesAddedTitle", "No new games imported"),
            message: t(
              "features.events.notifications.noGamesAddedMessage",
              "No new games were inserted. The PGN may be duplicated or invalid.",
            ),
            color: "yellow",
          });
        }
      } else {
        let white = values.white.trim();
        let black = values.black.trim();
        if (values.profileSide !== "manual") {
          const profileName = activeProfilePlayerName.trim();
          const opponent = values.opponent.trim();
          if (!profileName || !opponent) {
            if (!profileName) {
              notifications.show({
                title: t("common.error"),
                message: t("features.events.addGame.activeProfileNameRequired", "Active profile name is required."),
                color: "red",
              });
            }
            return;
          }
          if (values.profileSide === "white") {
            white = profileName;
            black = opponent;
          } else {
            white = opponent;
            black = profileName;
          }
        }
        if (!white || !black) return;

        const date = formatDateToPGN(values.date) ?? null;
        const round = values.round.trim() || null;
        const result = values.result;

        const gameId = await createEventGame(dbPath, activeEvent.id, {
          white,
          black,
          date,
          round,
          result,
        });

        const eventName = (activeEvent.name ?? "").trim() || t("features.events.unnamedEvent", "Unnamed event");
        const eventType = (activeEvent.event_type ?? "otb_tournament") as ManagedEventType;
        const site = eventType === "online_tournament" ? "Online" : eventType === "league" ? "League" : "OTB";
        const timeControl = (activeEvent.time_control ?? "").trim();
        const tcHeader = timeControl ? `\n[TimeControl "${timeControl}"]` : "";
        const pgn = `[Event "${eventName}"]\n[Site "${site}"]${tcHeader}\n[Date "${date ?? "????.??.??"}"]\n[Round "${
          round ?? "?"
        }"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n\n${result}`;

        createTab({
          tab: { name: `${white} - ${black}`, type: "analysis" },
          setTabs,
          setActiveTab,
          pgn,
          srcInfo: { type: "db", db: dbPath, id: gameId },
          initialAnalysisTab: "analysis",
          initialAnalysisSubTab: "report",
          initialNotationView: "report",
        });
        navigate({ to: "/analysis" });
      }

      await queryClient.invalidateQueries({ queryKey: ["managedEventGames", dbPath, activeEvent.id] });
      setAddGameModalOpened(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifications.show({
        title:
          values.entryMode === "pgn"
            ? t("features.events.notifications.addGamesFailedTitle", "Could not import games")
            : t("features.events.notifications.createGameFailedTitle", "Could not create game"),
        message,
        color: "red",
      });
    } finally {
      setIsCreatingGame(false);
    }
  };

  const handleAnalyzeDbGame = async (gameId: number) => {
    if (!dbPath) return;
    try {
      const game = unwrap(await commands.getGame(dbPath, gameId));
      createTab({
        tab: { name: `${game.white} - ${game.black}`, type: "analysis" },
        setTabs,
        setActiveTab,
        pgn: game.moves,
        headers: game,
        srcInfo: { type: "db", db: dbPath, id: gameId },
        initialAnalysisTab: "analysis",
        initialAnalysisSubTab: "report",
        initialNotationView: "report",
      });
      navigate({ to: "/analysis" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifications.show({
        title: t("features.events.notifications.openGameFailedTitle", "Could not open game"),
        message,
        color: "red",
      });
    }
  };

  const eventTypeLabel = (event: ManagedEvent): string => {
    const v = (event.event_type ?? "otb_tournament") as ManagedEventType;
    if (v === "online_tournament") return t("features.events.eventTypes.onlineTournament", "Online Tournament");
    if (v === "league") return t("features.events.eventTypes.league", "League");
    return t("features.events.eventTypes.otbTournament", "OTB Tournament");
  };

  const sortedEvents = useMemo(() => {
    const events = [...(managedEvents ?? [])];
    const { columnAccessor, direction } = eventSortStatus;
    const dir = direction === "desc" ? -1 : 1;

    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const strCmp = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

    events.sort((a, b) => {
      if (columnAccessor === "id") return (a.id - b.id) * dir;
      if (columnAccessor === "name") return strCmp(str(a.name), str(b.name)) * dir;
      if (columnAccessor === "event_type") return strCmp(eventTypeLabel(a), eventTypeLabel(b)) * dir;
      if (columnAccessor === "location") return strCmp(str(a.location), str(b.location)) * dir;
      if (columnAccessor === "time_control") return strCmp(str(a.time_control), str(b.time_control)) * dir;
      if (columnAccessor === "start_date") return strCmp(str(a.start_date), str(b.start_date)) * dir;
      if (columnAccessor === "end_date") return strCmp(str(a.end_date), str(b.end_date)) * dir;
      return 0;
    });

    return events;
  }, [eventSortStatus, eventTypeLabel, managedEvents]);

  const totalEvents = managedEvents?.length ?? 0;
  const onlineEvents = useMemo(
    () => (managedEvents ?? []).filter((event) => event.event_type === "online_tournament").length,
    [managedEvents],
  );
  const leagueEvents = useMemo(
    () => (managedEvents ?? []).filter((event) => event.event_type === "league").length,
    [managedEvents],
  );
  const visibleEvents = sortedEvents.length;

  return (
    <>
      <GenericHeader title={t("features.sidebar.events", "Events")} pageKey="events" showViewToggle={false} />

      <Stack flex={1} style={{ minHeight: 0 }}>
        <ScrollArea h="100%" offsetScrollbars>
          <Stack px="md" pb="xl">
            {!activeProfile ? (
              <Card withBorder radius="lg" style={premiumMutedPanelStyle}>
                <Text>{t("features.events.noProfile", "Select a profile to manage events.")}</Text>
              </Card>
            ) : isLoadingDbPath ? (
              <Group justify="center" py="xl">
                <Loader size="sm" />
              </Group>
            ) : (
              <Stack gap="md">
                <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
                  <Card withBorder radius="lg" p="sm" style={premiumKpiCardStyle}>
                    <Group justify="space-between" wrap="nowrap">
                      <Stack gap={2}>
                        <Text size="xs" c="dimmed">
                          {t("features.events.kpis.total", "Events")}
                        </Text>
                        <Text fw={800} fz="lg">
                          {totalEvents}
                        </Text>
                      </Stack>
                      <ThemeIcon radius="md" variant="light" color="blue">
                        <IconPlus size={16} />
                      </ThemeIcon>
                    </Group>
                  </Card>
                  <Card withBorder radius="lg" p="sm" style={premiumKpiCardStyle}>
                    <Group justify="space-between" wrap="nowrap">
                      <Stack gap={2}>
                        <Text size="xs" c="dimmed">
                          {t("features.events.kpis.visible", "Visible")}
                        </Text>
                        <Text fw={800} fz="lg">
                          {visibleEvents}
                        </Text>
                      </Stack>
                      <ThemeIcon radius="md" variant="light" color="teal">
                        <IconPlus size={16} />
                      </ThemeIcon>
                    </Group>
                  </Card>
                  <Card withBorder radius="lg" p="sm" style={premiumKpiCardStyle}>
                    <Group justify="space-between" wrap="nowrap">
                      <Stack gap={2}>
                        <Text size="xs" c="dimmed">
                          {t("features.events.eventTypes.onlineTournament", "Online Tournament")}
                        </Text>
                        <Text fw={800} fz="lg">
                          {onlineEvents}
                        </Text>
                      </Stack>
                      <ThemeIcon radius="md" variant="light" color="cyan">
                        <IconPlus size={16} />
                      </ThemeIcon>
                    </Group>
                  </Card>
                  <Card withBorder radius="lg" p="sm" style={premiumKpiCardStyle}>
                    <Group justify="space-between" wrap="nowrap">
                      <Stack gap={2}>
                        <Text size="xs" c="dimmed">
                          {t("features.events.eventTypes.league", "League")}
                        </Text>
                        <Text fw={800} fz="lg">
                          {leagueEvents}
                        </Text>
                      </Stack>
                      <ThemeIcon radius="md" variant="light" color="grape">
                        <IconPlus size={16} />
                      </ThemeIcon>
                    </Group>
                  </Card>
                </SimpleGrid>

                <Card withBorder radius="lg" style={premiumPanelStyle}>
                  <form onSubmit={form.onSubmit(handleCreate)}>
                    <Stack gap="sm">
                      <Text fw={600}>{t("features.events.create.title", "Create event")}</Text>
                      <TextInput
                        label={t("features.events.fields.name", "Name")}
                        placeholder={t("features.events.fields.namePlaceholder", "Tournament name")}
                        required
                        {...form.getInputProps("name")}
                      />
                      <Select
                        label={t("features.events.fields.eventType", "Event type")}
                        value={form.values.eventType}
                        onChange={(value) =>
                          form.setFieldValue("eventType", (value as ManagedEventType) ?? "otb_tournament")
                        }
                        data={[
                          {
                            value: "otb_tournament",
                            label: t("features.events.eventTypes.otbTournament", "OTB Tournament"),
                          },
                          {
                            value: "online_tournament",
                            label: t("features.events.eventTypes.onlineTournament", "Online Tournament"),
                          },
                          { value: "league", label: t("features.events.eventTypes.league", "League") },
                        ]}
                        required
                      />
                      <TextInput
                        label={t("features.events.fields.location", "Location")}
                        placeholder={t("features.events.fields.locationPlaceholder", "City, venue, etc.")}
                        {...form.getInputProps("location")}
                      />
                      <TextInput
                        label={t("features.events.fields.timeControl", "Time control")}
                        placeholder={t("features.events.fields.timeControlPlaceholder", "e.g. 90+30")}
                        {...form.getInputProps("timeControl")}
                      />
                      <Group grow>
                        <DateInput
                          label={t("features.events.fields.startDate", "Start date")}
                          valueFormat="YYYY-MM-DD"
                          clearable
                          value={form.values.startDate}
                          onChange={(v) => form.setFieldValue("startDate", parseDate(v) ?? null)}
                        />
                        <DateInput
                          label={t("features.events.fields.endDate", "End date")}
                          valueFormat="YYYY-MM-DD"
                          clearable
                          value={form.values.endDate}
                          onChange={(v) => form.setFieldValue("endDate", parseDate(v) ?? null)}
                        />
                      </Group>
                      <Group justify="flex-end">
                        <Button
                          type="submit"
                          size="xs"
                          radius="xl"
                          styles={premiumActionButtonStyles}
                          leftSection={<IconPlus size={16} />}
                        >
                          {t("common.create", "Create")}
                        </Button>
                      </Group>
                    </Stack>
                  </form>
                </Card>

                <Divider />

                <Card withBorder radius="lg" p="md" style={premiumMutedPanelStyle}>
                  <Group justify="space-between" mb="xs">
                    <Text fw={600}>{t("features.events.list.title", "Registered tournaments")}</Text>
                    <Text c="dimmed" size="sm">
                      {activeProfile.displayName || activeProfile.name}
                    </Text>
                  </Group>

                  {eventsError ? (
                    <Text c="red">{String(eventsError)}</Text>
                  ) : isLoadingEvents ? (
                    <Group justify="center" py="lg">
                      <Loader size="sm" />
                    </Group>
                  ) : !managedEvents || managedEvents.length === 0 ? (
                    <Text c="dimmed">{t("features.events.list.empty", "No tournaments yet.")}</Text>
                  ) : (
                    <Box style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", maxWidth: "100%" }}>
                      <DataTable
                        withTableBorder
                        withColumnBorders
                        highlightOnHover
                        idAccessor="id"
                        records={sortedEvents}
                        sortStatus={eventSortStatus}
                        onSortStatusChange={setEventSortStatus}
                        rowExpansion={{
                          allowMultiple: true,
                          expanded: {
                            recordIds: expandedEventIds,
                            onRecordIdsChange: setExpandedEventIds,
                          },
                          content: ({ record }) =>
                            dbPath && (
                              <Box p="sm">
                                <EventGamesTable dbPath={dbPath} eventId={record.id} onAnalyze={handleAnalyzeDbGame} />
                              </Box>
                            ),
                        }}
                        columns={[
                          {
                            accessor: "id",
                            title: "ID",
                            width: 80,
                            sortable: true,
                            render: (event) => `#${event.id}`,
                          },
                          {
                            accessor: "name",
                            title: t("features.events.table.name", "Name"),
                            sortable: true,
                            render: (event) => event.name || "-",
                          },
                          {
                            accessor: "event_type",
                            title: t("features.events.table.eventType", "Type"),
                            width: 170,
                            sortable: true,
                            render: (event) => eventTypeLabel(event),
                          },
                          {
                            accessor: "location",
                            title: t("features.events.table.location", "Location"),
                            width: 200,
                            sortable: true,
                            render: (event) => event.location || "-",
                          },
                          {
                            accessor: "time_control",
                            title: t("features.events.table.timeControl", "Time control"),
                            width: 160,
                            sortable: true,
                            render: (event) => event.time_control || "-",
                          },
                          {
                            accessor: "start_date",
                            title: t("features.events.table.startDate", "Start"),
                            width: 140,
                            sortable: true,
                            render: (event) => (event.start_date ? String(event.start_date).replace(/\./g, "-") : "-"),
                          },
                          {
                            accessor: "end_date",
                            title: t("features.events.table.endDate", "End"),
                            width: 140,
                            sortable: true,
                            render: (event) => (event.end_date ? String(event.end_date).replace(/\./g, "-") : "-"),
                          },
                          {
                            accessor: "actions",
                            title: t("features.events.table.actions", "Actions"),
                            width: 180,
                            textAlign: "right",
                            render: (event) => (
                              <Group gap="xs" justify="flex-end" wrap="nowrap">
                                <Button
                                  size="xs"
                                  radius="xl"
                                  variant="light"
                                  styles={premiumActionButtonStyles}
                                  onClick={() => openAddGamesModal(event)}
                                >
                                  {t("features.events.actions.addGame", "Add game")}
                                </Button>
                                <ActionIcon
                                  size="lg"
                                  variant="subtle"
                                  color="red"
                                  onClick={() => handleDeleteEvent(event)}
                                >
                                  <IconTrash size={16} />
                                </ActionIcon>
                              </Group>
                            ),
                          },
                        ]}
                      />
                    </Box>
                  )}
                </Card>
              </Stack>
            )}
          </Stack>
        </ScrollArea>
      </Stack>

      <Modal
        opened={addGameModalOpened}
        onClose={() => setAddGameModalOpened(false)}
        title={t("features.events.addGame.title", "Add game")}
        size="md"
      >
        <form onSubmit={gameForm.onSubmit((values) => void handleCreateGame(values))}>
          <Stack gap="sm">
            <Text c="dimmed" size="sm">
              {activeEvent?.name ? `${activeEvent.name}` : ""}
            </Text>

            <SegmentedControl
              value={gameForm.values.entryMode}
              onChange={(value) =>
                gameForm.setFieldValue("entryMode", (value as CreateGameFormValues["entryMode"]) ?? "manual")
              }
              data={[
                { label: t("features.events.addGame.manualMode", "Manual"), value: "manual" },
                { label: t("features.events.addGame.pgnMode", "PGN"), value: "pgn" },
              ]}
              fullWidth
            />

            <Select
              label={t("features.events.addGame.profileSide", "Active profile plays as")}
              value={gameForm.values.profileSide}
              onChange={(value) =>
                gameForm.setFieldValue("profileSide", (value as CreateGameFormValues["profileSide"]) ?? "manual")
              }
              data={[
                { value: "white", label: t("features.events.addGame.profileAsWhite", "White") },
                { value: "black", label: t("features.events.addGame.profileAsBlack", "Black") },
                {
                  value: "manual",
                  label:
                    gameForm.values.entryMode === "pgn"
                      ? t("features.events.addGame.keepPgnPlayers", "Keep PGN players")
                      : t("features.events.addGame.manualPlayers", "Manual players"),
                },
              ]}
            />

            {gameForm.values.entryMode === "manual" ? (
              gameForm.values.profileSide === "manual" ? (
                <>
                  <TextInput
                    label={t("features.events.games.white", "White")}
                    placeholder={t("features.events.games.whitePlaceholder", "White player name")}
                    required
                    {...gameForm.getInputProps("white")}
                  />
                  <TextInput
                    label={t("features.events.games.black", "Black")}
                    placeholder={t("features.events.games.blackPlaceholder", "Black player name")}
                    required
                    {...gameForm.getInputProps("black")}
                  />
                </>
              ) : (
                <>
                  <TextInput
                    label={t("features.events.addGame.activeProfilePlayer", "Active profile player")}
                    value={activeProfilePlayerName}
                    readOnly
                  />
                  <TextInput
                    label={t("features.events.addGame.opponent", "Opponent")}
                    placeholder={t("features.events.addGame.opponentPlaceholder", "Opponent name")}
                    required
                    {...gameForm.getInputProps("opponent")}
                  />
                </>
              )
            ) : (
              <>
                {gameForm.values.profileSide !== "manual" ? (
                  <TextInput
                    label={t("features.events.addGame.activeProfilePlayer", "Active profile player")}
                    value={activeProfilePlayerName}
                    readOnly
                  />
                ) : null}
                <Textarea
                  label={t("features.events.addGame.pgnInput", "PGN")}
                  placeholder={t("features.events.addGame.pgnPlaceholder", "Paste one or multiple PGN games")}
                  minRows={8}
                  autosize
                  required
                  {...gameForm.getInputProps("pgnText")}
                />
              </>
            )}

            <Group grow>
              <DateInput
                label={t("features.events.games.date", "Date")}
                valueFormat="YYYY-MM-DD"
                clearable
                value={gameForm.values.date}
                onChange={(v) => gameForm.setFieldValue("date", parseDate(v) ?? null)}
                disabled={gameForm.values.entryMode === "pgn"}
              />
              <TextInput
                label={t("features.events.games.round", "Round")}
                placeholder={t("features.events.games.roundPlaceholder", "Round")}
                {...gameForm.getInputProps("round")}
                disabled={gameForm.values.entryMode === "pgn"}
              />
            </Group>

            <Select
              label={t("features.events.games.result", "Result")}
              value={gameForm.values.result}
              onChange={(value) => gameForm.setFieldValue("result", (value as CreateGameFormValues["result"]) ?? "*")}
              data={[
                { value: "*", label: t("features.events.games.resultOngoing", "Ongoing (*)") },
                { value: "1-0", label: t("chess.outcome.whiteWins", "White wins") },
                { value: "0-1", label: t("chess.outcome.blackWins", "Black wins") },
                { value: "1/2-1/2", label: t("chess.outcome.draw", "Draw") },
              ]}
              disabled={gameForm.values.entryMode === "pgn"}
            />

            <Group justify="flex-end">
              <Button variant="default" onClick={() => setAddGameModalOpened(false)} disabled={isCreatingGame}>
                {t("common.cancel", "Cancel")}
              </Button>
              <Button type="submit" loading={isCreatingGame}>
                {gameForm.values.entryMode === "pgn"
                  ? t("features.events.addGame.importOnly", "Import to event")
                  : t("features.events.addGame.createAndOpen", "Create & open")}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
}

function EventGamesTable({
  dbPath,
  eventId,
  onAnalyze,
}: {
  dbPath: string;
  eventId: number;
  onAnalyze: (gameId: number) => void;
}) {
  const { t } = useTranslation();
  const isMobile = useMediaQuery("(max-width: 48em)");

  const [search, setSearch] = useState("");
  const [roundFilter, setRoundFilter] = useState("");
  const [resultFilter, setResultFilter] = useState<"all" | CreateGameFormValues["result"]>("all");
  const [fromDate, setFromDate] = useState<Date | null>(null);
  const [toDate, setToDate] = useState<Date | null>(null);

  const [sortStatus, setSortStatus] = useState<DataTableSortStatus<NormalizedGame>>({
    columnAccessor: "date",
    direction: "desc",
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["managedEventGames", dbPath, eventId],
    queryFn: async () => {
      const query = {
        tournament_id: eventId,
        options: {
          skipCount: true,
          sort: "id",
          direction: "desc",
        },
      } satisfies GameQuery;

      const res = await query_games(dbPath, query);
      return res.data;
    },
    staleTime: 10_000,
    enabled: !!dbPath && eventId > 0,
  });

  const filteredSorted = useMemo(() => {
    const raw = data ?? [];
    const s = search.trim().toLowerCase();
    const r = roundFilter.trim().toLowerCase();

    const from = fromDate ? new Date(fromDate) : null;
    if (from) from.setHours(0, 0, 0, 0);
    const to = toDate ? new Date(toDate) : null;
    if (to) to.setHours(23, 59, 59, 999);

    let out = raw.filter((g) => {
      if (s) {
        const w = (g.white ?? "").toLowerCase();
        const b = (g.black ?? "").toLowerCase();
        if (!w.includes(s) && !b.includes(s)) return false;
      }
      if (r) {
        const gr = (g.round ?? "").toLowerCase();
        if (!gr.includes(r)) return false;
      }
      if (resultFilter !== "all") {
        if ((g.result ?? "*") !== resultFilter) return false;
      }

      const dateStr = g.date ? String(g.date).replace(/\\./g, "-") : "";
      const dt = dateStr ? parseDate(dateStr) : null;
      if (from && dt && dt < from) return false;
      if (to && dt && dt > to) return false;

      return true;
    });

    const { columnAccessor, direction } = sortStatus;
    const dir = direction === "desc" ? -1 : 1;

    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const strCmp = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true });

    const resultRank = (v: unknown) => {
      const rr = str(v);
      if (rr === "1-0") return 3;
      if (rr === "1/2-1/2") return 2;
      if (rr === "0-1") return 1;
      return 0;
    };

    out = [...out].sort((a, b) => {
      if (columnAccessor === "id") return ((a.id ?? 0) - (b.id ?? 0)) * dir;
      if (columnAccessor === "white") return strCmp(str(a.white), str(b.white)) * dir;
      if (columnAccessor === "black") return strCmp(str(a.black), str(b.black)) * dir;
      if (columnAccessor === "round") return strCmp(str(a.round), str(b.round)) * dir;
      if (columnAccessor === "result") return (resultRank(a.result) - resultRank(b.result)) * dir;
      if (columnAccessor === "date") return strCmp(str(a.date), str(b.date)) * dir;
      return 0;
    });

    return out;
  }, [data, fromDate, resultFilter, roundFilter, search, sortStatus, toDate]);

  return (
    <Stack gap="sm">
      <Group grow align="end">
        <TextInput
          label={t("features.events.games.filters.search", "Search")}
          placeholder={t("features.events.games.filters.searchPlaceholder", "Player name")}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <TextInput
          label={t("features.events.games.filters.round", "Round")}
          placeholder={t("features.events.games.roundPlaceholder", "Round")}
          value={roundFilter}
          onChange={(e) => setRoundFilter(e.currentTarget.value)}
        />
        <Select
          label={t("features.events.games.filters.result", "Result")}
          value={resultFilter}
          onChange={(value) => setResultFilter((value as typeof resultFilter) ?? "all")}
          data={[
            { value: "all", label: t("features.events.games.filters.resultAll", "All") },
            { value: "*", label: t("features.events.games.resultOngoing", "Ongoing (*)") },
            { value: "1-0", label: t("chess.outcome.whiteWins", "White wins") },
            { value: "0-1", label: t("chess.outcome.blackWins", "Black wins") },
            { value: "1/2-1/2", label: t("chess.outcome.draw", "Draw") },
          ]}
        />
        <DateInput
          label={t("features.events.games.filters.fromDate", "From")}
          valueFormat="YYYY-MM-DD"
          clearable
          value={fromDate}
          onChange={(v) => setFromDate(parseDate(v) ?? null)}
        />
        <DateInput
          label={t("features.events.games.filters.toDate", "To")}
          valueFormat="YYYY-MM-DD"
          clearable
          value={toDate}
          onChange={(v) => setToDate(parseDate(v) ?? null)}
        />
      </Group>

      {error ? (
        <Text c="red">{String(error)}</Text>
      ) : isMobile ? (
        <ScrollArea style={{ maxHeight: "400px" }} type="auto">
          <DataTable
            withTableBorder
            withColumnBorders
            highlightOnHover
            fetching={isLoading}
            idAccessor="id"
            records={filteredSorted}
            sortStatus={sortStatus}
            onSortStatusChange={setSortStatus}
            noRecordsText={t("features.events.listGames.empty", "No games found.")}
            columns={[
              { accessor: "id", title: "ID", width: 80, sortable: true, render: (g) => `#${g.id}` },
              { accessor: "round", title: t("features.events.games.round", "Round"), width: 90, sortable: true },
              {
                accessor: "date",
                title: t("features.events.games.date", "Date"),
                width: 140,
                sortable: true,
                render: (g) => (g.date ? String(g.date).replace(/\\./g, "-") : "-"),
              },
              { accessor: "white", title: t("features.events.games.white", "White"), sortable: true },
              { accessor: "black", title: t("features.events.games.black", "Black"), sortable: true },
              { accessor: "result", title: t("features.events.games.result", "Result"), width: 120, sortable: true },
              {
                accessor: "actions",
                title: t("features.events.games.actions", "Actions"),
                width: 120,
                textAlign: "right",
                render: (g) => (
                  <Button size="xs" variant="default" onClick={() => onAnalyze(g.id)}>
                    {t("features.events.games.analyze", "Analyze")}
                  </Button>
                ),
              },
            ]}
          />
        </ScrollArea>
      ) : (
        <DataTable
          withTableBorder
          withColumnBorders
          highlightOnHover
          fetching={isLoading}
          idAccessor="id"
          records={filteredSorted}
          sortStatus={sortStatus}
          onSortStatusChange={setSortStatus}
          noRecordsText={t("features.events.listGames.empty", "No games found.")}
          columns={[
            { accessor: "id", title: "ID", width: 80, sortable: true, render: (g) => `#${g.id}` },
            { accessor: "round", title: t("features.events.games.round", "Round"), width: 90, sortable: true },
            {
              accessor: "date",
              title: t("features.events.games.date", "Date"),
              width: 140,
              sortable: true,
              render: (g) => (g.date ? String(g.date).replace(/\\./g, "-") : "-"),
            },
            { accessor: "white", title: t("features.events.games.white", "White"), sortable: true },
            { accessor: "black", title: t("features.events.games.black", "Black"), sortable: true },
            { accessor: "result", title: t("features.events.games.result", "Result"), width: 120, sortable: true },
            {
              accessor: "actions",
              title: t("features.events.games.actions", "Actions"),
              width: 120,
              textAlign: "right",
              render: (g) => (
                <Button size="xs" variant="default" onClick={() => onAnalyze(g.id)}>
                  {t("features.events.games.analyze", "Analyze")}
                </Button>
              ),
            },
          ]}
        />
      )}
    </Stack>
  );
}
