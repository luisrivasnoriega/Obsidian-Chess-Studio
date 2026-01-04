import { Box, Group, Stack, Text } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PlayerGameInfo } from "@/bindings";
import { ChartSizeGuard } from "@/components/ChartSizeGuard";
import { getTimeControl } from "@/utils/timeControl";
import { DateRange } from "./DateRangeTabs";
import PlayerSidebarCard, { normalizePlatform, type PlatformFilter, type TimeControlFilter } from "./PlayerSidebarCard";
import { gradientStops, linearGradientProps, tooltipContentStyle, tooltipCursorStyle } from "./RatingsPanel.css";
import ResultsChart from "./ResultsChart";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function calculateEarliestDate(dateRange: DateRange, ratingDates: number[]): number {
  const lastDate = ratingDates[ratingDates.length - 1];
  switch (dateRange) {
    case DateRange.SevenDays:
      return lastDate - 7 * MILLISECONDS_PER_DAY;
    case DateRange.ThirtyDays:
      return lastDate - 30 * MILLISECONDS_PER_DAY;
    case DateRange.NinetyDays:
      return lastDate - 90 * MILLISECONDS_PER_DAY;
    case DateRange.OneYear:
      return lastDate - 365 * MILLISECONDS_PER_DAY;
    default:
      return Math.min(...ratingDates);
  }
}

function RatingsPanel({ playerName, info }: { playerName: string; info: PlayerGameInfo }) {
  const { t } = useTranslation();
  const [dateRange, setDateRange] = useState<DateRange | null>(DateRange.NinetyDays);
  const [timeControl, setTimeControl] = useState<TimeControlFilter>("any");
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [opponentEloBucket, setOpponentEloBucket] = useState<string>("all");
  const [timeRange, setTimeRange] = useState({ start: 0, end: 0 });

  const dates = useMemo(() => {
    const timezoneOffset = new Date().getTimezoneOffset() * 60 * 1000; // milliseconds
    const localDate = new Date(Date.now() - timezoneOffset);
    const todayString = localDate.toISOString().slice(0, 10);
    const today = new Date(todayString).getTime();

    const gameDates =
      info.site_stats_data
        ?.filter((games) => platform === "all" || normalizePlatform(games.site) === platform)
        .flatMap((games) =>
          games.data
            .filter((game) => timeControl === "any" || getTimeControl(games.site, game.time_control) === timeControl)
            .map((game) => new Date(game?.date?.replaceAll(".", "-")).getTime()),
        ) ?? [];

    return Array.from(new Set([today, ...gameDates])).sort((a, b) => a - b);
  }, [info.site_stats_data, platform, timeControl]);

  useEffect(() => {
    if (dateRange) {
      const earliestDate = calculateEarliestDate(dateRange as DateRange, dates);
      const earliestIndex = dates.findIndex((date) => date >= earliestDate);
      setTimeRange({ start: earliestIndex, end: dates.length - 1 });
    } else {
      setTimeRange({ start: 0, end: dates.length > 0 ? dates.length - 1 : 0 });
    }
  }, [dateRange, dates]);

  const [summary, ratingSeries] = useMemo(() => {
    let filteredGames =
      info.site_stats_data
        ?.filter((games) => platform === "all" || normalizePlatform(games.site) === platform)
        .flatMap((games) =>
          games.data
            .filter((game) => timeControl === "any" || getTimeControl(games.site, game.time_control) === timeControl)
            .filter((game) => {
              const gameDate = new Date(game?.date?.replaceAll(".", "-")).getTime();
              const startDate = dates[timeRange.start];
              const endDate = dates[timeRange.end];
              return gameDate >= (startDate ?? 0) && gameDate <= (endDate ?? 0);
            })
            .map((game) => ({ ...game, site: games.site })),
        ) ?? [];

    if (opponentEloBucket !== "all") {
      const start = Number.parseInt(opponentEloBucket, 10);
      if (Number.isFinite(start)) {
        const end = start + 199;
        filteredGames = filteredGames.filter(
          (game) => typeof game.opponent_elo === "number" && game.opponent_elo >= start && game.opponent_elo <= end,
        );
      }
    }

    const wonCount = filteredGames.filter((game) => game.result === "Won").length;
    const drawCount = filteredGames.filter((game) => game.result === "Drawn").length;
    const lostCount = filteredGames.filter((game) => game.result === "Lost").length;

    const ratingData = (() => {
      const perPlatform = new Map<string, Map<number, number>>();
      for (const game of filteredGames) {
        const date = new Date(game?.date?.replaceAll(".", "-")).getTime();
        const normalized = normalizePlatform(game.site);
        if (!Number.isFinite(date)) continue;
        const platformKey = normalized === "Chess.com" ? "chesscom" : normalized === "Lichess" ? "lichess" : "unknown";
        const platformMap = perPlatform.get(platformKey) ?? new Map<number, number>();
        const existing = platformMap.get(date);
        if (existing == null || existing < game.player_elo) {
          platformMap.set(date, game.player_elo);
        }
        perPlatform.set(platformKey, platformMap);
      }
      const allDates = Array.from(
        new Set(Array.from(perPlatform.values()).flatMap((map) => Array.from(map.keys()))),
      ).sort((a, b) => a - b);

      const data = allDates.map((date) => {
        const entry: { date: number; [key: string]: number | undefined } = { date };
        for (const [key, map] of perPlatform.entries()) {
          const value = map.get(date);
          if (value != null) entry[key] = value;
        }
        return entry;
      });

      const platforms = Array.from(perPlatform.keys()).map((key) => {
        const isChessCom = key === "chesscom";
        const isLichess = key === "lichess";
        return {
          key,
          label: isChessCom ? "Chess.com" : isLichess ? "Lichess" : "Unknown",
          stroke: isChessCom
            ? "var(--mantine-color-blue-filled)"
            : isLichess
              ? "var(--mantine-color-red-filled)"
              : "var(--mantine-color-gray-5)",
        };
      });

      return { data, dates: allDates, platforms };
    })();

    return [
      {
        games: filteredGames.length,
        won: wonCount,
        draw: drawCount,
        lost: lostCount,
      },
      ratingData,
      ratingData.dates,
    ];
  }, [info.site_stats_data, platform, timeControl, dates, timeRange, opponentEloBucket]);

  const playerEloDomain = useMemo(() => {
    if (ratingSeries.data.length === 0) return null;

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const entry of ratingSeries.data) {
      for (const platformInfo of ratingSeries.platforms) {
        const value = entry[platformInfo.key];
        if (typeof value !== "number") continue;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    return [Math.floor(min / 50) * 50, Math.ceil(max / 50) * 50] as [number, number];
  }, [ratingSeries.data, ratingSeries.platforms]);

  const opponentEloOptions = useMemo(() => {
    const buckets = new Set<number>();
    for (const site of info.site_stats_data ?? []) {
      for (const game of site.data) {
        if (typeof game.opponent_elo !== "number") continue;
        buckets.add(Math.floor(game.opponent_elo / 200) * 200);
      }
    }
    const sorted = Array.from(buckets).sort((a, b) => a - b);
    return [
      { value: "all", label: t("common.all", { defaultValue: "All" }) },
      ...sorted.map((start) => ({ value: String(start), label: `${start}-${start + 199}` })),
    ];
  }, [info.site_stats_data, t]);

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
        />
      </Box>

      <Box style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex" }}>
        <Box style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
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
        </Box>
      </Box>
    </Group>
  );
}

export default RatingsPanel;
