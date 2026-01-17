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
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { useForm } from "@mantine/form";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import GenericHeader from "@/components/GenericHeader";
import { activeProfileIdAtom, activeTabAtom, profilesAtom, tabsAtom } from "@/state/atoms";
import { query_games } from "@/utils/db";
import { formatDateToPGN, parseDate } from "@/utils/format";
import {
  createEventGame,
  deleteManagedEvent,
  listManagedEvents,
  type ManagedEvent,
  upsertManagedEvent,
} from "@/utils/managedEvents";
import { getProfileDbPath } from "@/utils/profileDb";
import { createTab } from "@/utils/tabs";
import { unwrap } from "@/utils/unwrap";

type CreateFormValues = {
  name: string;
  location: string;
  startDate: Date | null;
  endDate: Date | null;
};

type CreateGameFormValues = {
  white: string;
  black: string;
  date: Date | null;
  round: string;
  result: "1-0" | "0-1" | "1/2-1/2" | "*";
};

export default function EventsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [_tabs, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);

  const profiles = useAtomValue(profilesAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [activeProfileId, profiles],
  );

  const [addGameModalOpened, setAddGameModalOpened] = useState(false);
  const [listGamesModalOpened, setListGamesModalOpened] = useState(false);
  const [activeEvent, setActiveEvent] = useState<ManagedEvent | null>(null);
  const [isCreatingGame, setIsCreatingGame] = useState(false);

  const form = useForm<CreateFormValues>({
    initialValues: {
      name: "",
      location: "",
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
      white: "",
      black: "",
      date: null,
      round: "",
      result: "*",
    },
    validate: {
      white: (value) =>
        value.trim().length === 0 ? t("features.events.games.validation.whiteRequired", "White is required") : null,
      black: (value) =>
        value.trim().length === 0 ? t("features.events.games.validation.blackRequired", "Black is required") : null,
    },
  });

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

  const { data: gamesForActiveEvent, isLoading: isLoadingEventGames } = useQuery({
    queryKey: ["managedEventGames", dbPath, activeEvent?.id],
    queryFn: async () => {
      if (!dbPath || !activeEvent?.id) return [];
      const res = await query_games(dbPath, {
        tournament_id: activeEvent.id,
        options: { direction: "asc", sort: "date", skipCount: true, pageSize: 200 },
      } as any);
      return res.data;
    },
    enabled: !!dbPath && !!activeEvent?.id && listGamesModalOpened,
    staleTime: 10_000,
  });

  const handleCreate = async (values: CreateFormValues) => {
    if (!dbPath) return;
    try {
      await upsertManagedEvent(dbPath, {
        name: values.name.trim(),
        eventType: "otb_tournament",
        location: values.location.trim() || null,
        startDate: formatDateToPGN(values.startDate) ?? null,
        endDate: formatDateToPGN(values.endDate) ?? null,
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

  const openListGamesModal = (event: ManagedEvent) => {
    setActiveEvent(event);
    setListGamesModalOpened(true);
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
    const white = values.white.trim();
    const black = values.black.trim();
    if (!white || !black) return;

    setIsCreatingGame(true);
    try {
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
      const site = "OTB";
      const pgn = `[Event "${eventName}"]\n[Site "${site}"]\n[Date "${date ?? "????.??.??"}"]\n[Round "${
        round ?? "?"
      }"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n\n${result}`;

      createTab({
        tab: { name: `${white} - ${black}`, type: "analysis" },
        setTabs,
        setActiveTab,
        pgn,
        srcInfo: { type: "db", db: dbPath, id: gameId },
      });
      navigate({ to: "/analysis" });

      setAddGameModalOpened(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifications.show({
        title: t("features.events.notifications.createGameFailedTitle", "Could not create game"),
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
      const game = unwrap(await (await import("@/bindings")).commands.getGame(dbPath, gameId));
      createTab({
        tab: { name: `${game.white} - ${game.black}`, type: "analysis" },
        setTabs,
        setActiveTab,
        pgn: game.moves,
        headers: game,
        srcInfo: { type: "db", db: dbPath, id: gameId },
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

  return (
    <>
      <GenericHeader title={t("features.sidebar.events", "Events")} pageKey="events" showViewToggle={false} />

      <Box px="md" pb="md">
        {!activeProfile ? (
          <Card withBorder>
            <Text>{t("features.events.noProfile", "Select a profile to manage events.")}</Text>
          </Card>
        ) : isLoadingDbPath ? (
          <Group justify="center" py="xl">
            <Loader size="sm" />
          </Group>
        ) : (
          <Stack gap="md">
            <Card withBorder>
              <form onSubmit={form.onSubmit(handleCreate)}>
                <Stack gap="sm">
                  <Text fw={600}>{t("features.events.create.title", "Create OTB tournament")}</Text>
                  <TextInput
                    label={t("features.events.fields.name", "Name")}
                    placeholder={t("features.events.fields.namePlaceholder", "Tournament name")}
                    required
                    {...form.getInputProps("name")}
                  />
                  <TextInput
                    label={t("features.events.fields.location", "Location")}
                    placeholder={t("features.events.fields.locationPlaceholder", "City, venue, etc.")}
                    {...form.getInputProps("location")}
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
                    <Button type="submit" leftSection={<IconPlus size={16} />}>
                      {t("common.create", "Create")}
                    </Button>
                  </Group>
                </Stack>
              </form>
            </Card>

            <Divider />

            <Card withBorder>
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
                <ScrollArea type="auto">
                  <Table striped highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th style={{ width: 80 }}>ID</Table.Th>
                        <Table.Th>{t("features.events.table.name", "Name")}</Table.Th>
                        <Table.Th style={{ width: 180 }}>{t("features.events.table.location", "Location")}</Table.Th>
                        <Table.Th style={{ width: 150 }}>{t("features.events.table.startDate", "Start")}</Table.Th>
                        <Table.Th style={{ width: 150 }}>{t("features.events.table.endDate", "End")}</Table.Th>
                        <Table.Th style={{ width: 220 }}>{t("features.events.table.actions", "Actions")}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {managedEvents.map((event) => (
                        <Table.Tr key={event.id}>
                          <Table.Td>#{event.id}</Table.Td>
                          <Table.Td>{event.name || "-"}</Table.Td>
                          <Table.Td>{event.location || "-"}</Table.Td>
                          <Table.Td>
                            {event.start_date ? (event.start_date as string).replace(/\./g, "-") : "-"}
                          </Table.Td>
                          <Table.Td>{event.end_date ? (event.end_date as string).replace(/\./g, "-") : "-"}</Table.Td>
                          <Table.Td>
                            <Group gap="xs" wrap="nowrap">
                              <Button size="xs" variant="default" onClick={() => openAddGamesModal(event)}>
                                {t("features.events.actions.addGame", "Add game")}
                              </Button>
                              <Button size="xs" variant="default" onClick={() => openListGamesModal(event)}>
                                {t("features.events.actions.listGames", "List games")}
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
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>
              )}
            </Card>
          </Stack>
        )}
      </Box>

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

            <Group grow>
              <DateInput
                label={t("features.events.games.date", "Date")}
                valueFormat="YYYY-MM-DD"
                clearable
                value={gameForm.values.date}
                onChange={(v) => gameForm.setFieldValue("date", parseDate(v) ?? null)}
              />
              <TextInput
                label={t("features.events.games.round", "Round")}
                placeholder={t("features.events.games.roundPlaceholder", "Round")}
                {...gameForm.getInputProps("round")}
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
            />

            <Group justify="flex-end">
              <Button variant="default" onClick={() => setAddGameModalOpened(false)} disabled={isCreatingGame}>
                {t("common.cancel", "Cancel")}
              </Button>
              <Button type="submit" loading={isCreatingGame}>
                {t("features.events.addGame.createAndOpen", "Create & open")}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <Modal
        opened={listGamesModalOpened}
        onClose={() => setListGamesModalOpened(false)}
        title={t("features.events.listGames.title", "Tournament games")}
        size="xl"
      >
        <Stack gap="sm">
          <Group justify="space-between">
            <Text fw={600}>{activeEvent?.name || "-"}</Text>
            <Text c="dimmed" size="sm">
              #{activeEvent?.id ?? "-"}
            </Text>
          </Group>

          {isLoadingEventGames ? (
            <Group justify="center" py="lg">
              <Loader size="sm" />
            </Group>
          ) : !gamesForActiveEvent || gamesForActiveEvent.length === 0 ? (
            <Text c="dimmed">{t("features.events.listGames.empty", "No games found.")}</Text>
          ) : (
            <ScrollArea type="auto" style={{ maxHeight: 520 }}>
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th style={{ width: 100 }}>ID</Table.Th>
                    <Table.Th style={{ width: 200 }}>{t("features.events.games.white", "White")}</Table.Th>
                    <Table.Th style={{ width: 200 }}>{t("features.events.games.black", "Black")}</Table.Th>
                    <Table.Th style={{ width: 120 }}>{t("features.events.games.result", "Result")}</Table.Th>
                    <Table.Th style={{ width: 150 }}>{t("features.events.games.date", "Date")}</Table.Th>
                    <Table.Th style={{ width: 120 }}>{t("features.events.games.actions", "Actions")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {gamesForActiveEvent.map((g) => (
                    <Table.Tr key={g.id}>
                      <Table.Td>#{g.id}</Table.Td>
                      <Table.Td>{g.white}</Table.Td>
                      <Table.Td>{g.black}</Table.Td>
                      <Table.Td>{g.result || "-"}</Table.Td>
                      <Table.Td>{g.date ? (parseDate(g.date)?.toISOString().slice(0, 10) ?? g.date) : "-"}</Table.Td>
                      <Table.Td>
                        <Button size="xs" variant="default" onClick={() => void handleAnalyzeDbGame(g.id)}>
                          {t("features.events.games.analyze", "Analyze")}
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={() => setListGamesModalOpened(false)}>
              {t("common.close", "Close")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
