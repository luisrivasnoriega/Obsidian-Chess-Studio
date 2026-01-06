import { Box, Group, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PlayerGameInfo } from "@/bindings";
import { ChartSizeGuard } from "@/components/ChartSizeGuard";
import type { EloBucket, EloDomain, GameStats, RatingTimeline } from "@/bindings/playerStats";
import { playerStatsCommands } from "@/bindings/playerStats";
import { createPlayerStatsFilters } from "@/utils/playerStats";
import { unwrap } from "@/utils/unwrap";
import { DateRange } from "./DateRangeTabs";
import PlayerSidebarCard, { normalizePlatform, type PlatformFilter, type TimeControlFilter } from "./PlayerSidebarCard";
import { gradientStops, linearGradientProps, tooltipContentStyle, tooltipCursorStyle } from "./RatingsPanel.css";
import ResultsChart from "./ResultsChart";
import { PanelLoadGate } from "./PanelLoadGate";

function RatingsPanel({ playerName, info, profileId, isLoading }: { playerName: string; info: PlayerGameInfo; profileId?: string; isLoading?: boolean }) {
  const { t } = useTranslation();
  const [dateRange, setDateRange] = useState<DateRange | null>(DateRange.NinetyDays);
  const [timeControl, setTimeControl] = useState<TimeControlFilter>("any");
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [opponentEloBucket, setOpponentEloBucket] = useState<string>("all");
  const [timeRange, setTimeRange] = useState({ start: 0, end: 0 });

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

  // Create filters for backend
  const filters = useMemo(
    () => createPlayerStatsFilters(platform, timeControl, opponentEloBucket, dateRange),
    [platform, timeControl, opponentEloBucket, dateRange],
  );

  // Get rating timeline from backend
  const {
    data: ratingTimeline,
    isLoading: isLoadingRatingTimeline,
    isFetching: isFetchingRatingTimeline,
  } = useQuery<RatingTimeline>({
    queryKey: [
      "playerRatingTimeline",
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
      return unwrap(await playerStatsCommands.calculatePlayerRatingTimeline(info.site_stats_data ?? [], filters));
    },
    staleTime: Infinity,
    retry: false,
    enabled: statsSignature.games > 0,
  });

  // Get game stats summary from backend
  const { data: gameStats, isLoading: isLoadingGameStats, isFetching: isFetchingGameStats } = useQuery<GameStats>({
    queryKey: [
      "playerGameStats",
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
      return unwrap(await playerStatsCommands.calculatePlayerGameStats(info.site_stats_data ?? [], filters));
    },
    staleTime: Infinity,
    retry: false,
    enabled: statsSignature.games > 0,
  });

  const dates = ratingTimeline?.dates ?? [];
  const summary = gameStats
    ? {
        games: gameStats.total,
        won: gameStats.won,
        draw: gameStats.draw,
        lost: gameStats.lost,
      }
    : { games: 0, won: 0, draw: 0, lost: 0 };

  const ratingSeries = ratingTimeline
    ? {
        data: ratingTimeline.data.map((point) => ({
          date: point.date,
          chesscom: point.chesscom,
          lichess: point.lichess,
        })),
        dates: ratingTimeline.dates,
        platforms: ratingTimeline.platforms,
      }
    : { data: [], dates: [], platforms: [] };

  useEffect(() => {
    if (dates.length > 0) {
      setTimeRange({ start: 0, end: dates.length - 1 });
    }
  }, [dates]);

  // Get ELO domain from backend
  const { data: eloDomain } = useQuery<EloDomain | null>({
    queryKey: ["playerEloDomain", statsSignature.sites, statsSignature.games, statsSignature.firstSite, statsSignature.lastSite, filters.platform, filters.time_control, filters.opponent_elo_bucket, filters.date_range],
    queryFn: async () => {
      if (!ratingTimeline) return null;
      return unwrap(await playerStatsCommands.calculatePlayerEloDomain(ratingTimeline));
    },
    enabled: !!ratingTimeline,
    staleTime: Infinity,
    retry: false,
  });

  const playerEloDomain = eloDomain ? ([eloDomain.min, eloDomain.max] as [number, number]) : null;

  // Get ELO buckets from backend
  const { data: eloBuckets = [] } = useQuery<EloBucket[]>({
    queryKey: ["playerEloBuckets", statsSignature.sites, statsSignature.games, statsSignature.firstSite, statsSignature.lastSite],
    queryFn: async () => {
      return unwrap(await playerStatsCommands.calculatePlayerEloBuckets(info.site_stats_data ?? []));
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

  // Calculate loading state: prop from parent OR internal queries loading/fetching
  const isAnyLoading =
    isLoading ||
    isLoadingRatingTimeline ||
    isFetchingRatingTimeline ||
    isLoadingGameStats ||
    isFetchingGameStats;
  const hasPanelData = dates.length > 1;

  return (
    <Group h="100%" align="stretch" wrap="nowrap" gap="md" style={{ minHeight: 0, minWidth: 0 }}>
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

      <Box style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex" }}>
        <Box style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
          <PanelLoadGate
            isLoading={isLoadingRatingTimeline || isLoadingGameStats || !!isLoading}
            isFetching={isFetchingRatingTimeline || isFetchingGameStats}
            hasData={hasPanelData}
          >
            <>
              {dates.length > 1 ? (
            <Stack style={{ minHeight: 0 }} p="md">
              {summary.games > 0 && (
                <ResultsChart won={summary.won} draw={summary.draw} lost={summary.lost} size="2rem" />
              )}
              <ChartSizeGuard height={300}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={ratingSeries.data}>
                    <defs>
                      <linearGradient {...linearGradientProps}>
                        {gradientStops.map((stopProps) => (
                          <stop key={stopProps.offset} {...stopProps} />
                        ))}
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3" vertical={false} />
                    <XAxis
                      dataKey="date"
                      domain={[dates[timeRange.start], dates[timeRange.end]]}
                      tickFormatter={(date) => new Date(date).toLocaleDateString()}
                      type="number"
                    />
                    {playerEloDomain == null && <YAxis />}
                    {playerEloDomain != null && <YAxis domain={playerEloDomain} />}
                    <Tooltip
                      contentStyle={tooltipContentStyle}
                      cursor={tooltipCursorStyle}
                      labelFormatter={(label) => new Date(label).toLocaleDateString()}
                    />
                    {ratingSeries.platforms.map((platformInfo) => {
                      return (
                        <Area
                          key={platformInfo.key}
                          name={platformInfo.label}
                          dataKey={platformInfo.key}
                          type="monotone"
                          stroke={platformInfo.stroke}
                          strokeWidth={2}
                          strokeOpacity={1}
                          fillOpacity={0.15}
                          fill="transparent"
                          connectNulls
                          dot={{ r: 2 }}
                          activeDot={{ r: 3 }}
                        />
                      );
                    })}
                  </AreaChart>
                </ResponsiveContainer>
              </ChartSizeGuard>
            </Stack>
              ) : (
                <Text size="sm" c="dimmed" p="md">
                  {t("common.noData", { defaultValue: "No data" })}
                </Text>
              )}
            </>
          </PanelLoadGate>
        </Box>
      </Box>
    </Group>
  );
}

export default RatingsPanel;
