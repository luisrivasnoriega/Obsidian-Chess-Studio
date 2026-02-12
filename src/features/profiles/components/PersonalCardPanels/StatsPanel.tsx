import {
  Box,
  Button,
  DEFAULT_THEME,
  Divider,
  Flex,
  Group,
  Modal,
  Progress,
  Select,
  Stack,
  Table,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NormalizedGame, PlayerGameInfo } from "@/bindings";
import { commands } from "@/bindings";
import type { EloBucket } from "@/bindings/playerStats";
import { playerStatsCommands } from "@/bindings/playerStats";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { createPlayerStatsFilters, createSiteStatsSignature } from "@/utils/playerStats";
import { getProfileDbPath } from "@/utils/profileDb";
import { getProfilePhaseGames, type PhaseGameRow } from "@/utils/profilePhaseGames";
import { getProfilePhaseOutcomes, type PhaseOutcomeBucket } from "@/utils/profilePhaseOutcomes";
import { createTab } from "@/utils/tabs";
import { unwrap } from "@/utils/unwrap";
import { DateRange } from "./DateRangeTabs";
import { PanelLoadGate } from "./PanelLoadGate";
import PlayerSidebarCard, { type PlatformFilter, type TimeControlFilter } from "./PlayerSidebarCard";

type StatGroupBy = "phase";

type PhaseKey = "opening" | "middlegame" | "endgame";

function createPgnFromNormalizedGame(game: NormalizedGame): string {
  const resultTag = game.result || "*";
  const movesText = (game.moves || "").trim();
  const hasResult = /(?:1-0|0-1|1\/2-1\/2|\*)$/.test(movesText);
  const movetext = movesText ? (hasResult ? movesText : `${movesText} ${resultTag}`) : resultTag;

  let pgn = `[Event "${game.event || "Online Game"}"]\n`;
  pgn += `[Site "${game.site || "Online"}"]\n`;
  pgn += `[Date "${game.date || "????.??.??"}"]\n`;
  if (game.round) {
    pgn += `[Round "${game.round}"]\n`;
  }
  pgn += `[White "${game.white || "White"}"]\n`;
  pgn += `[Black "${game.black || "Black"}"]\n`;
  pgn += `[Result "${resultTag}"]\n`;
  if (game.white_elo) {
    pgn += `[WhiteElo "${game.white_elo}"]\n`;
  }
  if (game.black_elo) {
    pgn += `[BlackElo "${game.black_elo}"]\n`;
  }
  if (game.time_control) {
    pgn += `[TimeControl "${game.time_control}"]\n`;
  }
  if (game.eco) {
    pgn += `[ECO "${game.eco}"]\n`;
  }
  pgn += "\n";
  pgn += movetext;
  return pgn;
}

function PhaseBar({ won, drawn, lost }: { won: number; drawn: number; lost: number }) {
  const total = won + drawn + lost;
  if (total <= 0) {
    return (
      <Progress.Root size="lg">
        <Progress.Section value={100} color="dark.4">
          <Progress.Label />
        </Progress.Section>
      </Progress.Root>
    );
  }

  return (
    <Progress.Root size="lg">
      <Progress.Section value={(won / total) * 100} color="green">
        <Progress.Label>{won / total >= 0.2 ? `${Math.round((won / total) * 100)}%` : undefined}</Progress.Label>
      </Progress.Section>
      <Progress.Section value={(drawn / total) * 100} color="gray">
        <Progress.Label>{drawn / total >= 0.2 ? `${Math.round((drawn / total) * 100)}%` : undefined}</Progress.Label>
      </Progress.Section>
      <Progress.Section value={(lost / total) * 100} color="red">
        <Progress.Label>{lost / total >= 0.2 ? `${Math.round((lost / total) * 100)}%` : undefined}</Progress.Label>
      </Progress.Section>
    </Progress.Root>
  );
}

function phaseLabel(t: (key: string, opts?: any) => string, phase: PhaseKey) {
  switch (phase) {
    case "opening":
      return t("common.opening", { defaultValue: "Opening" });
    case "middlegame":
      return t("common.middlegame", { defaultValue: "Middlegame" });
    case "endgame":
      return t("common.endgame", { defaultValue: "Endgame" });
  }
}

export default function StatsPanel({
  playerName,
  info,
  profileId,
  isLoading,
}: {
  playerName: string;
  info: PlayerGameInfo;
  profileId?: string;
  isLoading?: boolean;
}) {
  const { t } = useTranslation();
  const isStackedLayout = useMediaQuery(`(width < ${DEFAULT_THEME.breakpoints.md})`);
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [activeTab, setActiveTab] = useAtom(activeTabAtom);

  const statsSig = useMemo(() => createSiteStatsSignature(info?.site_stats_data), [info?.site_stats_data]);

  const { data: eloBuckets = [] } = useQuery<EloBucket[]>({
    queryKey: ["playerEloBuckets", statsSig.key],
    queryFn: async () => unwrap(await playerStatsCommands.calculatePlayerEloBuckets(info?.site_stats_data ?? [])),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: statsSig.games > 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const opponentEloOptions = useMemo(() => {
    return [
      { value: "all", label: t("common.all", { defaultValue: "All" }) },
      ...eloBuckets.map((bucket) => ({ value: bucket.value, label: bucket.label })),
    ];
  }, [eloBuckets, t]);

  const [opponentEloBucket, setOpponentEloBucket] = useState<string>("all");
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [timeControl, setTimeControl] = useState<TimeControlFilter>("any");
  const [dateRange, setDateRange] = useState<DateRange | null>(DateRange.AllTime);
  const [groupBy, setGroupBy] = useState<StatGroupBy>("phase");
  const [detailsPhase, setDetailsPhase] = useState<PhaseKey | null>(null);
  const [detailsPage, setDetailsPage] = useState(1);

  const { data: sidebarModel } = useQuery({
    queryKey: ["playerSidebarModel", statsSig.key],
    queryFn: async () => unwrap(await playerStatsCommands.calculatePlayerSidebarModel(info?.site_stats_data ?? [])),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: statsSig.games > 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const filters = useMemo(
    () => createPlayerStatsFilters(platform, timeControl, opponentEloBucket, dateRange),
    [platform, timeControl, opponentEloBucket, dateRange],
  );

  const {
    data: buckets = [],
    isLoading: isLoadingBuckets,
    isFetching: isFetchingBuckets,
  } = useQuery<PhaseOutcomeBucket[]>({
    queryKey: [
      "profilePhaseStats",
      profileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
      groupBy,
    ],
    queryFn: async () => {
      if (!profileId) return [];
      if (groupBy !== "phase") return [];
      return await getProfilePhaseOutcomes({ profileId, filters });
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !!profileId && statsSig.games > 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const isAnyLoading = isLoading || isLoadingBuckets || isFetchingBuckets;
  const hasDataContext = !!info;
  const hasPanelData = buckets.some((b) => (b.won ?? 0) + (b.drawn ?? 0) + (b.lost ?? 0) > 0);

  const visiblePlatforms = platform === "all" ? (["Chess.com", "Lichess"] as const) : ([platform] as const);
  const groupByOptions = useMemo(() => {
    return [{ value: "phase", label: t("profiles.stats.groupBy.phase", { defaultValue: "Game phase" }) }];
  }, [t]);

  const phaseOrder: PhaseKey[] = ["opening", "middlegame", "endgame"];
  const byPhase = useMemo(() => {
    const map = new Map<PhaseKey, { won: number; drawn: number; lost: number }>();
    for (const phase of phaseOrder) {
      map.set(phase, { won: 0, drawn: 0, lost: 0 });
    }
    for (const b of buckets) {
      const p = (b.phase ?? "endgame") as PhaseKey;
      const cur = map.get(p) ?? { won: 0, drawn: 0, lost: 0 };
      map.set(p, {
        won: cur.won + (b.won ?? 0),
        drawn: cur.drawn + (b.drawn ?? 0),
        lost: cur.lost + (b.lost ?? 0),
      });
    }
    return map;
  }, [buckets]);

  const totals = useMemo(() => {
    let won = 0;
    let drawn = 0;
    let lost = 0;
    for (const v of byPhase.values()) {
      won += v.won;
      drawn += v.drawn;
      lost += v.lost;
    }
    return { won, drawn, lost, total: won + drawn + lost };
  }, [byPhase]);

  const detailsLimit = 50;
  const detailsOffset = (detailsPage - 1) * detailsLimit;

  const {
    data: detailGames = [],
    isFetching: isFetchingDetails,
    isLoading: isLoadingDetails,
    error: detailsError,
  } = useQuery<PhaseGameRow[]>({
    queryKey: [
      "profilePhaseGames",
      profileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
      detailsPhase ?? null,
      detailsPage,
    ],
    queryFn: async () => {
      if (!profileId || !detailsPhase) return [];
      return await getProfilePhaseGames({
        profileId,
        filters,
        phase: detailsPhase,
        limit: detailsLimit,
        offset: detailsOffset,
      });
    },
    enabled: !!profileId && !!detailsPhase && statsSig.games > 0,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const hasNextPage = detailGames.length === detailsLimit;

  const openGame = async (gameId: number) => {
    if (!profileId) return;

    try {
      const currentActiveTab = activeTab;
      const dbPath = await getProfileDbPath(profileId);
      const game = unwrap(await commands.getGame(dbPath, gameId));
      const pgn = createPgnFromNormalizedGame(game);
      const tree = await parsePGN(pgn);

      await createTab({
        tab: {
          name: `${tree.headers?.white || "White"} - ${tree.headers?.black || "Black"}`,
          type: "analysis",
        },
        setTabs,
        setActiveTab,
        pgn,
        headers: tree.headers,
        autoActivate: false,
      });

      if (currentActiveTab) {
        requestAnimationFrame(() => setActiveTab(currentActiveTab));
      } else {
        const profilesTab = tabs.find((tab) => tab.type === "profiles");
        if (profilesTab) setActiveTab(profilesTab.value);
      }

      notifications.show({
        title: t("features.dashboard.gameOpened", { defaultValue: "Game opened" }),
        message: t("features.dashboard.gameOpenedMessage", { defaultValue: "Opened in a new tab." }),
        color: "green",
      });
    } catch (error) {
      console.error("Error opening game:", error);
      notifications.show({
        title: t("features.dashboard.error", { defaultValue: "Error" }),
        message: t("features.dashboard.errorOpeningGame", { defaultValue: "Error opening game." }),
        color: "red",
      });
    }
  };

  return (
    <Flex
      h="100%"
      align="stretch"
      direction={isStackedLayout ? "column" : "row"}
      gap="md"
      style={{ minHeight: 0, minWidth: 0, width: "100%" }}
      data-testid="stats-panel"
    >
      {/* LEFT */}
      <Box
        style={{
          flex: isStackedLayout ? "0 0 auto" : "0 0 25%",
          width: isStackedLayout ? "100%" : undefined,
          minWidth: isStackedLayout ? 0 : 280,
          minHeight: 0,
        }}
      >
        <PlayerSidebarCard
          playerName={playerName}
          model={sidebarModel ?? null}
          visiblePlatforms={[...visiblePlatforms]}
          platform={platform}
          onPlatformChange={setPlatform}
          timeControl={timeControl}
          onTimeControlChange={setTimeControl}
          opponentEloOptions={opponentEloOptions}
          opponentEloBucket={opponentEloBucket}
          onOpponentEloChange={setOpponentEloBucket}
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          isLoading={isAnyLoading}
          extraFilters={
            <Select
              label={t("profiles.stats.groupBy.label", { defaultValue: "Group by" })}
              data={groupByOptions}
              value={groupBy}
              onChange={(v) => setGroupBy((v as StatGroupBy) || "phase")}
              clearable={false}
              size="xs"
            />
          }
        />
      </Box>

      {/* RIGHT */}
      <Box
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          width: "100%",
        }}
      >
        <Box style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", width: "100%" }}>
          <PanelLoadGate
            isLoading={isAnyLoading}
            isFetching={isFetchingBuckets}
            hasData={hasDataContext && hasPanelData}
            message={t("profiles.stats.loading", { defaultValue: "Loading stats..." })}
          >
            <Stack p="md" gap="md">
              <Stack gap={4}>
                <Text fw={700}>{t("profiles.stats.title", { defaultValue: "Wins / losses by game phase" })}</Text>
                <Text size="sm" c="dimmed">
                  {t("profiles.stats.subtitle", {
                    defaultValue: "Shows where games became decisively won or lost, based on analyzed games only.",
                  })}
                </Text>
              </Stack>

              {totals.total > 0 ? (
                <Group gap="md" wrap="wrap">
                  <Text size="sm">
                    {t("profiles.stats.summary", {
                      defaultValue: "{{total}} analyzed games ({{won}}W {{drawn}}D {{lost}}L)",
                      total: totals.total,
                      won: totals.won,
                      drawn: totals.drawn,
                      lost: totals.lost,
                    })}
                  </Text>
                </Group>
              ) : (
                <Text size="sm" c="dimmed">
                  {t("profiles.stats.noData", {
                    defaultValue: "No analyzed games found for the selected filters.",
                  })}
                </Text>
              )}

              <Divider />

              <Stack gap="sm">
                {phaseOrder.map((phase) => {
                  const v = byPhase.get(phase)!;
                  const total = v.won + v.drawn + v.lost;
                  return (
                    <UnstyledButton
                      key={phase}
                      onClick={() => {
                        setDetailsPhase(phase);
                        setDetailsPage(1);
                      }}
                      style={{ display: "block", textAlign: "left" }}
                    >
                      <Stack gap={6}>
                        <Group justify="space-between" wrap="nowrap">
                          <Text fw={600}>{phaseLabel(t, phase)}</Text>
                          <Text size="sm" c="dimmed">
                            {total > 0
                              ? t("profiles.stats.phaseCount", {
                                  defaultValue: "{{total}} games",
                                  total,
                                })
                              : t("profiles.stats.phaseCount", { defaultValue: "0 games", total: 0 })}
                          </Text>
                        </Group>
                        <PhaseBar won={v.won} drawn={v.drawn} lost={v.lost} />
                        <Text size="xs" c="dimmed">
                          {t("profiles.stats.phaseBreakdown", {
                            defaultValue: "{{won}}W · {{drawn}}D · {{lost}}L",
                            won: v.won,
                            drawn: v.drawn,
                            lost: v.lost,
                          })}
                        </Text>
                      </Stack>
                    </UnstyledButton>
                  );
                })}
              </Stack>
            </Stack>
          </PanelLoadGate>
        </Box>
      </Box>

      <Modal
        opened={detailsPhase != null}
        onClose={() => setDetailsPhase(null)}
        title={t("profiles.stats.details.title", { defaultValue: "Games" })}
        size="xl"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t("profiles.stats.details.subtitle", {
              defaultValue: "Showing games for {{phase}}.",
              phase: detailsPhase ? phaseLabel(t, detailsPhase) : "",
            })}
          </Text>

          {detailsError ? (
            <Text size="sm" c="red">
              {t("profiles.stats.details.error", { defaultValue: "Failed to load games." })}
            </Text>
          ) : null}

          <PanelLoadGate
            isLoading={isLoadingDetails}
            isFetching={isFetchingDetails}
            hasData={detailsPhase != null}
            message={t("profiles.stats.details.loading", { defaultValue: "Loading games..." })}
          >
            {detailGames.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t("profiles.stats.details.noData", { defaultValue: "No games found." })}
              </Text>
            ) : (
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("profiles.stats.details.columns.date", { defaultValue: "Date" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.white", { defaultValue: "White" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.black", { defaultValue: "Black" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.result", { defaultValue: "Result" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.site", { defaultValue: "Site" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.action", { defaultValue: "Action" })}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {detailGames.map((g) => (
                    <Table.Tr key={g.gameId}>
                      <Table.Td>{g.date ?? "-"}</Table.Td>
                      <Table.Td>{g.white}</Table.Td>
                      <Table.Td>{g.black}</Table.Td>
                      <Table.Td>{g.result ?? "-"}</Table.Td>
                      <Table.Td>{g.site}</Table.Td>
                      <Table.Td>
                        <Button size="xs" variant="light" onClick={() => openGame(g.gameId)}>
                          {t("features.dashboard.openGame", { defaultValue: "Open Game" })}
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </PanelLoadGate>

          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {t("profiles.stats.details.page", { defaultValue: "Page {{page}}", page: detailsPage })}
            </Text>
            <Group>
              <Button
                size="xs"
                variant="default"
                disabled={detailsPage <= 1}
                onClick={() => setDetailsPage((p) => Math.max(1, p - 1))}
              >
                {t("common.previous", { defaultValue: "Previous" })}
              </Button>
              <Button size="xs" variant="default" disabled={!hasNextPage} onClick={() => setDetailsPage((p) => p + 1)}>
                {t("common.next", { defaultValue: "Next" })}
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>
    </Flex>
  );
}
