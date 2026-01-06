import { Box, Divider, Group, Select, Stack, Text } from "@mantine/core";
import type { Color } from "chessops";
import { useAtom } from "jotai";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlayerGameInfo } from "@/bindings";
import { commands } from "@/bindings";
import type { EloBucket, OpeningStats } from "@/bindings/playerStats";
import { playerStatsCommands } from "@/bindings/playerStats";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { createPlayerStatsFilters } from "@/utils/playerStats";
import { createTab } from "@/utils/tabs";
import { countMainPly, defaultTree } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";
import { DateRange } from "./DateRangeTabs";
import * as classes from "./OpeningsPanel.css";
import PlayerSidebarCard, { normalizePlatform, type PlatformFilter, type TimeControlFilter } from "./PlayerSidebarCard";
import ResultsChart from "./ResultsChart";
import { PanelLoadGate } from "./PanelLoadGate";

type OpeningSort = "games_desc" | "score_desc" | "score_asc";

function OpeningsPanel({ playerName, info, profileId, isLoading }: { playerName: string; info: PlayerGameInfo; profileId?: string; isLoading?: boolean }) {
  const { t } = useTranslation();

  // IMPORTANT: Never put `info.site_stats_data` directly into a react-query key.
  // It's a large nested structure and hashing it is extremely expensive.
  // Create a stable signature that only changes when the actual data changes.
  const statsSignature = useMemo(() => {
    if (!info?.site_stats_data || info.site_stats_data.length === 0) {
      return { sites: 0, games: 0, firstSite: "", lastSite: "" };
    }
    const sites = info.site_stats_data.length;
    const games = info.site_stats_data.reduce((acc, s) => acc + (s.data?.length ?? 0), 0);
    const firstSite = info.site_stats_data[0]?.site ?? "";
    const lastSite = info.site_stats_data[info.site_stats_data.length - 1]?.site ?? "";
    return { sites, games, firstSite, lastSite };
  }, [info?.site_stats_data]);

  // Get ELO buckets from backend
  const { data: eloBuckets = [] } = useQuery<EloBucket[]>({
    queryKey: ["playerEloBuckets", statsSignature.sites, statsSignature.games, statsSignature.firstSite, statsSignature.lastSite],
    queryFn: async () => {
      return unwrap(await playerStatsCommands.calculatePlayerEloBuckets(info?.site_stats_data ?? []));
    },
    staleTime: Infinity,
    retry: false,
    enabled: statsSignature.games > 0,
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
  const [dateRange, setDateRange] = useState<DateRange | null>(DateRange.NinetyDays);
  const [sortBy, setSortBy] = useState<OpeningSort>("games_desc");

  // Create filters for backend
  const filters = useMemo(
    () => createPlayerStatsFilters(platform, timeControl, opponentEloBucket, dateRange),
    [platform, timeControl, opponentEloBucket, dateRange],
  );

  // Get openings stats from backend
  const {
    data: whiteOpeningsData = [],
    isLoading: isLoadingWhiteOpenings,
    isFetching: isFetchingWhiteOpenings,
  } = useQuery<OpeningStats[]>({
    queryKey: [
      "playerOpeningsWhite",
      statsSignature.sites,
      statsSignature.games,
      statsSignature.firstSite,
      statsSignature.lastSite,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
    ],
    queryFn: async () => {
      return unwrap(await playerStatsCommands.calculatePlayerOpeningsStats(info?.site_stats_data ?? [], filters, true));
    },
    staleTime: Infinity,
    retry: false,
    enabled: statsSignature.games > 0,
  });

  const {
    data: blackOpeningsData = [],
    isLoading: isLoadingBlackOpenings,
    isFetching: isFetchingBlackOpenings,
  } = useQuery<OpeningStats[]>({
    queryKey: [
      "playerOpeningsBlack",
      statsSignature.sites,
      statsSignature.games,
      statsSignature.firstSite,
      statsSignature.lastSite,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
    ],
    queryFn: async () => {
      return unwrap(await playerStatsCommands.calculatePlayerOpeningsStats(info?.site_stats_data ?? [], filters, false));
    },
    staleTime: Infinity,
    retry: false,
    enabled: statsSignature.games > 0,
  });

  // Sort openings (backend doesn't sort, so we do it here for now)
  // TODO: Add sorting to backend
  const sortedWhiteOpenings = useMemo(() => {
    const sorted = [...whiteOpeningsData];
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
  }, [whiteOpeningsData, sortBy]);

  const sortedBlackOpenings = useMemo(() => {
    const sorted = [...blackOpeningsData];
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
  }, [blackOpeningsData, sortBy]);

  const whiteGames = whiteOpeningsData.reduce((sum, o) => sum + o.games, 0);
  const blackGames = blackOpeningsData.reduce((sum, o) => sum + o.games, 0);
  const rowCount = Math.max(sortedWhiteOpenings.length, sortedBlackOpenings.length);

  // Calculate loading state: prop from parent OR internal queries loading/fetching
  const isAnyLoading = isLoading || isLoadingWhiteOpenings || isFetchingWhiteOpenings || isLoadingBlackOpenings || isFetchingBlackOpenings;
  const hasPanelData = rowCount > 0;
  // Consider that we have "data context" if info exists (even if empty), so we don't show blocking loader
  const hasDataContext = !!info;

  return (
    <Group h="100%" align="stretch" wrap="nowrap" gap="md" style={{ minHeight: 0, minWidth: 0, width: "100%" }}>
      <Box style={{ flex: "0 0 25%", minWidth: 280, minHeight: 0 }}>
        <PlayerSidebarCard
          playerName={playerName}
          info={info}
          platform={platform}
          onPlatformChange={setPlatform}
          timeControl={timeControl}
          onTimeControlChange={setTimeControl}
          opponentEloOptions={opponentEloOptions}
          opponentEloBucket={opponentEloBucket}
          onOpponentEloChange={setOpponentEloBucket}
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          profileId={profileId}
          isLoading={isAnyLoading}
        />
      </Box>

      {/* RIGHT */}
      <Box style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", width: "100%" }}>
        <Box style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", width: "100%" }}>
          <Group justify="flex-end" p="md" pb={0}>
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
          <PanelLoadGate
            isLoading={isLoadingWhiteOpenings || isLoadingBlackOpenings || !!isLoading}
            isFetching={isFetchingWhiteOpenings || isFetchingBlackOpenings}
            hasData={hasPanelData || hasDataContext}
          >
            <>
              {rowCount === 0 ? (
                <Text size="sm" c="dimmed" p="md">
                  {t("common.noData", { defaultValue: "No data" })}
                </Text>
              ) : (
            <Stack gap="md" p="md" style={{ minWidth: 0, minHeight: 0, width: "100%" }}>
              {Array.from({ length: rowCount }, (_, index) => {
                const white = sortedWhiteOpenings[index];
                const black = sortedBlackOpenings[index];
                const key = `${white?.name ?? "-"}:${white?.games ?? 0}|${black?.name ?? "-"}:${black?.games ?? 0}`;

                return (
                  <Box key={key} style={{ minWidth: 0 }}>
                    {/* Two fixed columns that can shrink properly */}
                    <Group wrap="nowrap" align="stretch" gap="md" style={{ minWidth: 0 }}>
                      <Box style={{ flex: 1, minWidth: 0 }}>
                        {white ? <OpeningDetail opening={white} totalGames={whiteGames} color="white" /> : <div />}
                      </Box>
                      <Box style={{ flex: 1, minWidth: 0 }}>
                        {black ? <OpeningDetail opening={black} totalGames={blackGames} color="black" /> : <div />}
                      </Box>
                    </Group>
                    <Divider />
                  </Box>
                );
              })}
            </Stack>
              )}
            </>
          </PanelLoadGate>
        </Box>
      </Box>
    </Group>
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

        <Text style={{ flex: "0 0 auto" }}>{(openingRate * 100).toFixed(2)}%</Text>
      </Group>

      <ResultsChart won={opening.won} draw={opening.draw} lost={opening.lost} size="1.5rem" />
    </Stack>
  );
}

export default OpeningsPanel;
