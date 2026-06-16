import { Box, DEFAULT_THEME, Divider, Flex, Group, Select, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import type { Color } from "chessops";
import { useAtom } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlayerGameInfo } from "@/bindings";
import { commands } from "@/bindings";
import type { EloBucket, OpeningFamilyStats, OpeningStats, ProfileSidebarStats } from "@/bindings/playerStats";
import { playerStatsCommands } from "@/bindings/playerStats";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { createPlayerStatsFilters, createSiteStatsSignature } from "@/utils/playerStats";
import { createTab } from "@/utils/tabs";
import { countMainPly, defaultTree } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";
import { DateRange } from "./DateRangeTabs";
import * as classes from "./OpeningsPanel.css";
import { PanelLoadGate } from "./PanelLoadGate";
import PlayerSidebarCard, { type PlatformFilter, type TimeControlFilter } from "./PlayerSidebarCard";
import ResultsChart from "./ResultsChart";

type OpeningSort = "games_desc" | "score_desc" | "score_asc";

function sortOpeningStats(items: OpeningStats[], sortBy: OpeningSort) {
  const sorted = [...items];
  switch (sortBy) {
    case "score_asc":
      return sorted.sort((a, b) => {
        const rateA = a.games > 0 ? (a.won + a.draw * 0.5) / a.games : 0;
        const rateB = b.games > 0 ? (b.won + b.draw * 0.5) / b.games : 0;
        return rateA - rateB;
      });
    case "score_desc":
      return sorted.sort((a, b) => {
        const rateA = a.games > 0 ? (a.won + a.draw * 0.5) / a.games : 0;
        const rateB = b.games > 0 ? (b.won + b.draw * 0.5) / b.games : 0;
        return rateB - rateA;
      });
    default:
      return sorted.sort((a, b) => b.games - a.games);
  }
}

function sortOpeningFamilies(items: OpeningFamilyStats[], sortBy: OpeningSort) {
  const sorted = [...items].map((family) => ({
    ...family,
    openings: sortOpeningStats(family.openings, sortBy),
  }));
  switch (sortBy) {
    case "score_asc":
      return sorted.sort((a, b) => {
        const rateA = a.games > 0 ? (a.won + a.draw * 0.5) / a.games : 0;
        const rateB = b.games > 0 ? (b.won + b.draw * 0.5) / b.games : 0;
        return rateA - rateB;
      });
    case "score_desc":
      return sorted.sort((a, b) => {
        const rateA = a.games > 0 ? (a.won + a.draw * 0.5) / a.games : 0;
        const rateB = b.games > 0 ? (b.won + b.draw * 0.5) / b.games : 0;
        return rateB - rateA;
      });
    default:
      return sorted.sort((a, b) => b.games - a.games);
  }
}

function OpeningsPanel({
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

  // IMPORTANT: Never put `info.site_stats_data` directly into a react-query key.
  // It's a large nested structure and hashing it is extremely expensive.
  // Create a stable signature that only changes when the actual data changes.
  const statsSig = useMemo(() => createSiteStatsSignature(info?.site_stats_data), [info?.site_stats_data]);

  const {
    data: profileSidebarStats,
    isLoading: isLoadingProfileSidebarStats,
    isFetching: isFetchingProfileSidebarStats,
  } = useQuery<ProfileSidebarStats | null>({
    queryKey: ["profileSidebarStats", profileId ?? null],
    queryFn: async () => {
      if (!profileId) return null;
      return unwrap(await playerStatsCommands.getProfileSidebarStats(profileId));
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !!profileId,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Get ELO buckets from backend
  const { data: localEloBuckets = [] } = useQuery<EloBucket[]>({
    queryKey: ["playerEloBuckets", statsSig.key],
    queryFn: async () => {
      return unwrap(await playerStatsCommands.calculatePlayerEloBuckets(info?.site_stats_data ?? []));
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !profileId && statsSig.games > 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const eloBuckets = profileSidebarStats?.elo_buckets ?? localEloBuckets;

  const opponentEloOptions = useMemo(() => {
    return [
      { value: "all", label: t("common.all", { defaultValue: "All" }) },
      ...eloBuckets.map((bucket) => ({ value: bucket.value, label: bucket.label })),
    ];
  }, [eloBuckets, t]);

  const [opponentEloBucket, setOpponentEloBucket] = useState<string>("all");
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [timeControl, setTimeControl] = useState<TimeControlFilter>("any");
  const [dateRange, setDateRange] = useState<DateRange | null>(DateRange.NinetyDays);
  const [sortBy, setSortBy] = useState<OpeningSort>("games_desc");
  const [activeColor, setActiveColor] = useState<"white" | "black">("white");
  const [expandedFamilyByColor, setExpandedFamilyByColor] = useState<{ white: string | null; black: string | null }>({
    white: null,
    black: null,
  });

  const { data: localSidebarModel } = useQuery({
    queryKey: ["playerSidebarModel", statsSig.key],
    queryFn: async () => {
      return unwrap(await playerStatsCommands.calculatePlayerSidebarModel(info?.site_stats_data ?? []));
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !profileId && statsSig.games > 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const sidebarModel = profileSidebarStats?.sidebar_model ?? localSidebarModel;

  // Create filters for backend
  const filters = useMemo(
    () => createPlayerStatsFilters(platform, timeControl, opponentEloBucket, dateRange),
    [platform, timeControl, opponentEloBucket, dateRange],
  );

  // Get openings stats from backend
  const {
    data: whiteFamiliesData = [],
    isLoading: isLoadingWhiteOpenings,
    isFetching: isFetchingWhiteOpenings,
  } = useQuery<OpeningFamilyStats[]>({
    queryKey: [
      "playerOpeningsWhite",
      profileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
    ],
    queryFn: async () => {
      if (profileId) {
        return unwrap(await playerStatsCommands.getProfileOpeningFamiliesStats(profileId, filters, true));
      }
      return unwrap(
        await playerStatsCommands.calculatePlayerOpeningFamiliesStats(info?.site_stats_data ?? [], filters, true),
      );
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !!profileId || statsSig.games > 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const {
    data: blackFamiliesData = [],
    isLoading: isLoadingBlackOpenings,
    isFetching: isFetchingBlackOpenings,
  } = useQuery<OpeningFamilyStats[]>({
    queryKey: [
      "playerOpeningsBlack",
      profileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
    ],
    queryFn: async () => {
      if (profileId) {
        return unwrap(await playerStatsCommands.getProfileOpeningFamiliesStats(profileId, filters, false));
      }
      return unwrap(
        await playerStatsCommands.calculatePlayerOpeningFamiliesStats(info?.site_stats_data ?? [], filters, false),
      );
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !!profileId || statsSig.games > 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Sort openings (backend doesn't sort, so we do it here for now)
  // TODO: Add sorting to backend
  const sortedWhiteFamilies = useMemo(
    () => sortOpeningFamilies(whiteFamiliesData, sortBy),
    [whiteFamiliesData, sortBy],
  );

  const sortedBlackFamilies = useMemo(
    () => sortOpeningFamilies(blackFamiliesData, sortBy),
    [blackFamiliesData, sortBy],
  );

  const whiteGames = whiteFamiliesData.reduce((sum, o) => sum + o.games, 0);
  const blackGames = blackFamiliesData.reduce((sum, o) => sum + o.games, 0);
  const rowCount = Math.max(sortedWhiteFamilies.length, sortedBlackFamilies.length);
  const activeFamilies = activeColor === "white" ? sortedWhiteFamilies : sortedBlackFamilies;
  const activeTotalGames = activeColor === "white" ? whiteGames : blackGames;

  // Calculate loading state: prop from parent OR internal queries loading/fetching
  const isAnyLoading =
    isLoading ||
    isLoadingWhiteOpenings ||
    isFetchingWhiteOpenings ||
    isLoadingBlackOpenings ||
    isFetchingBlackOpenings ||
    isLoadingProfileSidebarStats ||
    isFetchingProfileSidebarStats;
  const hasPanelData = (isStackedLayout ? activeFamilies.length : rowCount) > 0;
  // Consider that we have "data context" if info exists (even if empty), so we don't show blocking loader
  const hasDataContext = !!info;
  const visiblePlatforms = platform === "all" ? (["Chess.com", "Lichess"] as const) : ([platform] as const);

  return (
    <Flex
      h="100%"
      align="stretch"
      direction={isStackedLayout ? "column" : "row"}
      gap="md"
      style={{ minHeight: 0, minWidth: 0, width: "100%" }}
    >
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
        <Box
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            overflowX: "hidden",
            width: "100%",
          }}
        >
          <Group justify="flex-end" p="md" pb={0}>
            <Group justify="center" wrap="nowrap" gap="md" w="100%">
              {isStackedLayout && (
                <Select
                  label={t("features.dashboard.playerColor", { defaultValue: "Player color" })}
                  size="xs"
                  value={activeColor}
                  data={[
                    {
                      value: "white",
                      label: t("accounts.openings.playingAsWhite", { defaultValue: "Playing as White" }),
                    },
                    {
                      value: "black",
                      label: t("accounts.openings.playingAsBlack", { defaultValue: "Playing as Black" }),
                    },
                  ]}
                  onChange={(value) => setActiveColor((value as "white" | "black") || "white")}
                  clearable={false}
                />
              )}
              <Select
                label={t("common.sort", { defaultValue: "Sort" })}
                size="xs"
                value={sortBy}
                data={[
                  { value: "games_desc", label: t("accounts.openings.sort.gamesDesc", { defaultValue: "Most games" }) },
                  {
                    value: "score_desc",
                    label: t("accounts.openings.sort.scoreDesc", { defaultValue: "Score (high to low)" }),
                  },
                  {
                    value: "score_asc",
                    label: t("accounts.openings.sort.scoreAsc", { defaultValue: "Score (low to high)" }),
                  },
                ]}
                onChange={(value) => setSortBy((value as OpeningSort) || "games_desc")}
                clearable={false}
              />
            </Group>
          </Group>
          <PanelLoadGate
            isLoading={isLoadingWhiteOpenings || isLoadingBlackOpenings || !!isLoading}
            isFetching={isFetchingWhiteOpenings || isFetchingBlackOpenings}
            hasData={hasPanelData || hasDataContext}
          >
            {(isStackedLayout ? activeFamilies.length : rowCount) === 0 ? (
              <Text size="sm" c="dimmed" p="md">
                {t("common.noData", { defaultValue: "No data" })}
              </Text>
            ) : (
              <Stack gap="md" p="md" style={{ minWidth: 0, minHeight: 0, width: "100%" }}>
                {!isStackedLayout && (
                  <Group wrap="nowrap" gap="md" style={{ minWidth: 0 }}>
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <Text size="xs" fw={700} c="dimmed">
                        {t("accounts.openings.playingAsWhite", { defaultValue: "Playing as White" })}
                      </Text>
                    </Box>
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <Text size="xs" fw={700} c="dimmed">
                        {t("accounts.openings.playingAsBlack", { defaultValue: "Playing as Black" })}
                      </Text>
                    </Box>
                  </Group>
                )}
                {(isStackedLayout ? activeFamilies : Array.from({ length: rowCount }, (_, i) => i)).map(
                  (item, index) => {
                    const white = isStackedLayout ? null : sortedWhiteFamilies[index];
                    const black = isStackedLayout ? null : sortedBlackFamilies[index];
                    const active = isStackedLayout ? (item as OpeningFamilyStats) : null;
                    const key = isStackedLayout
                      ? `${activeColor}:${active?.family ?? "-"}:${active?.games ?? 0}`
                      : `${white?.family ?? "-"}:${white?.games ?? 0}|${black?.family ?? "-"}:${black?.games ?? 0}`;

                    return (
                      <Box key={key} style={{ minWidth: 0 }}>
                        {isStackedLayout ? (
                          <Stack gap="sm" style={{ minWidth: 0 }}>
                            <Box style={{ minWidth: 0 }}>
                              {active ? (
                                <OpeningFamilyDetail
                                  family={active}
                                  totalGames={activeTotalGames}
                                  color={activeColor}
                                  expanded={expandedFamilyByColor[activeColor] === active.family}
                                  onToggle={() =>
                                    setExpandedFamilyByColor((prev) => ({
                                      ...prev,
                                      [activeColor]: prev[activeColor] === active.family ? null : active.family,
                                    }))
                                  }
                                />
                              ) : null}
                            </Box>
                          </Stack>
                        ) : (
                          // Two fixed columns that can shrink properly
                          <Group wrap="nowrap" align="stretch" gap="md" style={{ minWidth: 0 }}>
                            <Box style={{ flex: 1, minWidth: 0 }}>
                              {white ? (
                                <OpeningFamilyDetail
                                  family={white}
                                  totalGames={whiteGames}
                                  color="white"
                                  expanded={expandedFamilyByColor.white === white.family}
                                  onToggle={() =>
                                    setExpandedFamilyByColor((prev) => ({
                                      ...prev,
                                      white: prev.white === white.family ? null : white.family,
                                    }))
                                  }
                                />
                              ) : (
                                <div />
                              )}
                            </Box>
                            <Box style={{ flex: 1, minWidth: 0 }}>
                              {black ? (
                                <OpeningFamilyDetail
                                  family={black}
                                  totalGames={blackGames}
                                  color="black"
                                  expanded={expandedFamilyByColor.black === black.family}
                                  onToggle={() =>
                                    setExpandedFamilyByColor((prev) => ({
                                      ...prev,
                                      black: prev.black === black.family ? null : black.family,
                                    }))
                                  }
                                />
                              ) : (
                                <div />
                              )}
                            </Box>
                          </Group>
                        )}
                        <Divider />
                      </Box>
                    );
                  },
                )}
              </Stack>
            )}
          </PanelLoadGate>
        </Box>
      </Box>
    </Flex>
  );
}

function OpeningDetail({
  opening,
  totalGames,
  color,
}: {
  opening: { name: string; games: number; won: number; draw: number; lost: number };
  totalGames: number;
  color: Color;
}) {
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [, setActiveTab] = useAtom(activeTabAtom);
  const currentPath = typeof window !== "undefined" ? window.location.pathname : "";
  const isOnProfiles = currentPath === "/profiles";

  const openingRate = opening.games / Math.max(totalGames, 1);

  return (
    <Stack py="sm" justify="space-between" style={{ minWidth: 0, height: "100%" }}>
      <Group justify="space-between" wrap="nowrap" gap="xs" style={{ minWidth: 0 }}>
        <Text
          lineClamp={2}
          style={{ flex: 1, minWidth: 0 }} // <- critical: allow shrink + clamp
          className={classes.link}
          onClick={async (e) => {
            e.stopPropagation();
            const pgn = unwrap(await commands.getOpeningFromName(opening.name));
            const headers = defaultTree().headers;
            const tree = await parsePGN(pgn);
            headers.orientation = color;

            // Create the tab but manage activation manually to prevent navigation
            const tabId = await createTab({
              tab: { name: opening.name, type: "analysis" },
              pgn,
              headers,
              setTabs,
              setActiveTab,
              position: Array(countMainPly(tree.root)).fill(0),
              autoActivate: false,
            });

            // If we're on /profiles, activate the tab briefly for the blink effect,
            // then immediately reactivate the profiles tab to prevent navigation
            if (isOnProfiles && tabId) {
              const profilesTab = tabs.find((tab) => tab.type === "profiles");
              if (profilesTab) {
                // Activate the new tab for a brief moment to trigger the blink
                setActiveTab(tabId);
                // Then reactivate profiles tab immediately to prevent navigation
                setTimeout(() => {
                  setActiveTab(profilesTab.value);
                }, 50);
              } else {
                // If no profiles tab, just activate the new tab
                setActiveTab(tabId);
              }
            } else if (tabId) {
              // If not on profiles, activate normally
              setActiveTab(tabId);
            }
          }}
        >
          {opening.name}
        </Text>

        <Text style={{ flex: "0 0 auto" }}>
          {(openingRate * 100).toFixed(2)}% ({opening.games})
        </Text>
      </Group>

      <ResultsChart won={opening.won} draw={opening.draw} lost={opening.lost} size="1.5rem" />
    </Stack>
  );
}

function OpeningFamilyDetail({
  family,
  totalGames,
  color,
  expanded,
  onToggle,
}: {
  family: OpeningFamilyStats;
  totalGames: number;
  color: Color;
  expanded: boolean;
  onToggle: () => void;
}) {
  const familyRate = family.games / Math.max(totalGames, 1);

  return (
    <Stack py="sm" gap="sm" style={{ minWidth: 0, height: "100%" }}>
      <Box
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
        style={{ minWidth: 0, cursor: "pointer" }}
      >
        <Stack gap="sm" style={{ minWidth: 0 }}>
          <Group justify="space-between" wrap="nowrap" gap="xs" style={{ minWidth: 0 }}>
            <Text lineClamp={2} style={{ flex: 1, minWidth: 0 }} className={classes.link}>
              {family.family}
            </Text>
            <Text style={{ flex: "0 0 auto" }}>
              {(familyRate * 100).toFixed(2)}% ({family.games})
            </Text>
          </Group>

          <ResultsChart won={family.won} draw={family.draw} lost={family.lost} size="1.5rem" />
        </Stack>
      </Box>

      {expanded && family.openings.length > 0 && (
        <Stack gap={4} pl="md" style={{ minWidth: 0 }}>
          {family.openings.map((opening) => (
            <OpeningDetail
              key={`${family.family}:${opening.name}`}
              opening={opening}
              totalGames={totalGames}
              color={color}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

export default OpeningsPanel;
