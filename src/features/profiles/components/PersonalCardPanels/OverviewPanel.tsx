import { Box, DEFAULT_THEME, Flex, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";

import type { PlayerGameInfo } from "@/bindings";
import { ChartSizeGuard } from "@/components/ChartSizeGuard";
import type { EloBucket, GameStats, PlayerSidebarModel } from "@/bindings/playerStats";
import { playerStatsCommands } from "@/bindings/playerStats";
import { createPlayerStatsFilters } from "@/utils/playerStats";
import { unwrap } from "@/utils/unwrap";

import PlayerSidebarCard, { type PlatformFilter, type TimeControlFilter } from "./PlayerSidebarCard";
import ResultsChart from "./ResultsChart";
import { PanelLoadGate } from "./PanelLoadGate";

/**
 * React 18 StrictMode (dev) can mount/unmount/mount and run `queryFn` twice.
 * In Tauri, invokes are not truly cancelable, so we could end up calculating twice.
 *
 * This cache dedupes by key and reuses the same Promise (even across remounts).
 */
const promiseCache = {
  eloBuckets: new Map<string, Promise<EloBucket[]>>(),
  gameStats: new Map<string, Promise<GameStats>>(),
  sidebarModel: new Map<string, Promise<PlayerSidebarModel>>(),
};

function makeCacheKey(parts: Array<string | number | null | undefined>) {
  return parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("|");
}

function OverviewPanel({ playerName, info, profileId, isLoading }: { playerName: string; info: PlayerGameInfo; profileId?: string; isLoading?: boolean }) {
  const { t } = useTranslation();
  const isStackedLayout = useMediaQuery(`(width < ${DEFAULT_THEME.breakpoints.md})`);
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [timeControl, setTimeControl] = useState<TimeControlFilter>("any");
  const [opponentEloBucket, setOpponentEloBucket] = useState<string>("all");


  const statsSignature = useMemo(() => {
    const ssd = info?.site_stats_data ?? [];
    if (ssd.length === 0) {
      return { sites: 0, games: 0, firstSite: "", lastSite: "" };
    }

    const sites = ssd.length;
    const games = ssd.reduce((acc, s) => acc + (s.data?.length ?? 0), 0);
    const firstSite = ssd[0]?.site ?? "";
    const lastSite = ssd[ssd.length - 1]?.site ?? "";
    return { sites, games, firstSite, lastSite };
  }, [info?.site_stats_data]);

  const statsEnabled = statsSignature.games > 0;

  // --- Sidebar model (style + ELO summary) ---
  const { data: sidebarModel } = useQuery({
    queryKey: ["playerSidebarModel", statsSignature.sites, statsSignature.games, statsSignature.firstSite, statsSignature.lastSite],
    queryFn: async () => {
      const key = makeCacheKey(["sidebar", statsSignature.sites, statsSignature.games, statsSignature.firstSite, statsSignature.lastSite]);
      const existing = promiseCache.sidebarModel.get(key);
      if (existing) return existing;

      const p = (async () => {
        const res = unwrap(await playerStatsCommands.calculatePlayerSidebarModel(info?.site_stats_data ?? []));
        return res;
      })();
      promiseCache.sidebarModel.set(key, p);
      return p;
    },
    staleTime: Infinity,
    retry: false,
    enabled: statsEnabled,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: true,
  });

  // --- ELO buckets ---
  const { data: eloBuckets = [] } = useQuery<EloBucket[]>({
    queryKey: ["playerEloBuckets", statsSignature.sites, statsSignature.games, statsSignature.firstSite, statsSignature.lastSite],
    queryFn: async () => {
      const key = makeCacheKey(["elo", statsSignature.sites, statsSignature.games, statsSignature.firstSite, statsSignature.lastSite]);

      const existing = promiseCache.eloBuckets.get(key);
      if (existing) return existing;

      const p = (async () => {
        const res = unwrap(await playerStatsCommands.calculatePlayerEloBuckets(info?.site_stats_data ?? []));
        return res;
      })();

      promiseCache.eloBuckets.set(key, p);
      return p;
    },
    staleTime: Infinity,
    retry: false,
    enabled: statsEnabled,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: true,
  });

  const opponentEloOptions = useMemo(() => {
    return [
      { value: "all", label: t("common.all", { defaultValue: "All" }) },
      ...eloBuckets.map((bucket) => ({ value: bucket.value, label: bucket.label })),
    ];
  }, [eloBuckets, t]);

  // --- Game stats ---
  const filters = useMemo(() => createPlayerStatsFilters(platform, timeControl, opponentEloBucket, null), [
    platform,
    timeControl,
    opponentEloBucket,
  ]);

  const { data: gameStats, isLoading: isLoadingGameStats, error: gameStatsError, isFetching: isFetchingGameStats } =
    useQuery<GameStats>({
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
        const key = makeCacheKey([
          "stats",
          statsSignature.sites,
          statsSignature.games,
          statsSignature.firstSite,
          statsSignature.lastSite,
          filters.platform,
          filters.time_control,
          filters.opponent_elo_bucket,
          String(filters.date_range ?? ""),
        ]);

        const existing = promiseCache.gameStats.get(key);
        if (existing) return existing;

        const p = (async () => {
          const res = unwrap(await playerStatsCommands.calculatePlayerGameStats(info?.site_stats_data ?? [], filters));
          return res;
        })();

        promiseCache.gameStats.set(key, p);
        return p;
      },
      staleTime: Infinity,
      retry: false,
      enabled: statsEnabled,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: true,
    });

  const { total = 0, won = 0, draw = 0, lost = 0, data_per_month = [], unknown_count = 0 } = gameStats ?? {};

  // Keep a stable reference for DateChart.
  const dataPerMonth = useMemo(() => data_per_month.map((m) => ({ name: m.name, count: m.count })), [data_per_month]);
  const unknownCount = unknown_count;

  // Calculate loading state: prop from parent OR internal queries loading/fetching
  const isAnyLoading = isLoading || isLoadingGameStats || isFetchingGameStats;
  const hasPanelData = total > 0;
  // Consider that we have "data context" if info exists (even if empty), so we don't show blocking loader
  const hasDataContext = !!info;
  const visiblePlatforms = platform === "all" ? (["Chess.com", "Lichess"] as const) : ([platform] as const);

  return (
    <Flex
      h="100%"
      align="stretch"
      direction={isStackedLayout ? "column" : "row"}
      gap="md"
      style={{ minHeight: 0, minWidth: 0 }}
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
          isLoading={isAnyLoading}
        />
      </Box>

      <Box
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: isStackedLayout ? "visible" : "hidden",
          display: "flex",
        }}
      >
        <Box
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: isStackedLayout ? "visible" : "auto",
            overflowX: "hidden",
          }}
        >
          <PanelLoadGate
            isLoading={isLoadingGameStats || !!isLoading}
            isFetching={isFetchingGameStats}
            hasData={hasPanelData || hasDataContext}
          >
            <>
              {gameStatsError ? (
                <Text size="sm" c="red" p="md">
                  {t("common.error", { defaultValue: "Error loading data" })}: {String(gameStatsError)}
                </Text>
              ) : total > 0 ? (
                <Stack gap="md" p="md">
                  <ResultsChart won={won} draw={draw} lost={lost} size="2rem" />
                  <DateChart dataPerMonth={dataPerMonth} unknownCount={unknownCount} unknownLabel="Unknown" />
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
    </Flex>
  );
}

const DateChartTooltip = ({
  active,
  payload,
  label,
  isYearsView,
}: TooltipProps<ValueType, NameType> & {
  payload?: Array<{ name?: string; value?: number | string }>;
  label?: string;
  isYearsView?: boolean;
}) => {
  if (active && payload && payload.length) {
    return (
      <div
        style={{
          backgroundColor: "var(--mantine-color-body)",
          boxShadow: "var(--mantine-shadow-md)",
          borderRadius: "var(--mantine-radius-default)",
          border: "calc(0.0625rem* var(--mantine-scale)) solid var(--mantine-color-default-border)",
          padding: "10px",
        }}
      >
        <p style={{ margin: "0" }}>{`${label}`}</p>
        <p style={{ color: "var(--mantine-color-blue-filled)", marginTop: "8px" }}>{`${payload?.[0].name} : ${payload?.[0].value}`}</p>
        <p style={{ fontSize: "0.75rem", margin: "0", color: "grey" }}>
          Click to {isYearsView ? "see the month details" : "return to the years view"}.
        </p>
      </div>
    );
  }

  return null;
};

function parseYearMonth(name: string): { year: number; month: number } | null {
  // Accepts "YYYY-MM", "YYYY/MM", or "YYYY.MM".
  const m = /^(\d{4})[-/.](\d{2})$/.exec(name.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function formatYearMonth(year: number, month: number) {
  const mm = String(month).padStart(2, "0");
  return `${year}-${mm}`;
}

function monthToIndex(year: number, month: number) {
  return year * 12 + (month - 1);
}

function indexToYearMonth(idx: number) {
  const year = Math.floor(idx / 12);
  const month = (idx % 12) + 1;
  return { year, month };
}

function fillMissingMonthsLocal(data: { name: string; count: number }[]) {
  const parsed = data
    .map((d) => ({ d, ym: parseYearMonth(d.name) }))
    .filter((x): x is { d: { name: string; count: number }; ym: { year: number; month: number } } => Boolean(x.ym));

  if (parsed.length === 0) return data;

  const byName = new Map<string, number>();
  for (const p of parsed) byName.set(p.d.name, p.d.count);

  const indices = parsed.map((p) => monthToIndex(p.ym.year, p.ym.month));
  let minIdx = indices[0]!;
  let maxIdx = indices[0]!;
  for (const idx of indices) {
    if (idx < minIdx) minIdx = idx;
    if (idx > maxIdx) maxIdx = idx;
  }

  const result: { name: string; count: number }[] = [];
  for (let idx = minIdx; idx <= maxIdx; idx++) {
    const { year, month } = indexToYearMonth(idx);
    const name = formatYearMonth(year, month);
    result.push({ name, count: byName.get(name) ?? 0 });
  }

  return result;
}

function mergeYearsLocal(data: { name: string; count: number }[]) {
  const map = new Map<number, number>();
  for (const item of data) {
    const ym = parseYearMonth(item.name);
    if (!ym) continue;
    map.set(ym.year, (map.get(ym.year) ?? 0) + item.count);
  }

  const years = Array.from(map.keys()).sort((a, b) => a - b);
  return years.map((y) => ({ name: String(y), count: map.get(y) ?? 0 }));
}

function DateChart({
  dataPerMonth,
  unknownCount = 0,
  unknownLabel = "Unknown",
}: {
  dataPerMonth: { name: string; count: number }[];
  unknownCount?: number;
  unknownLabel?: string;
}) {
  const { t } = useTranslation();
  const [selectedYear, setSelectedYear] = useState<number | null>(null);

  const filledMonths = useMemo(() => fillMissingMonthsLocal(dataPerMonth), [dataPerMonth]);

  // Si hay mucha historia, conviene mostrar años primero
  const shouldShowYearsByDefault = useMemo(() => (filledMonths?.length ?? 0) > 36, [filledMonths]);

  const yearsData = useMemo(() => mergeYearsLocal(filledMonths), [filledMonths]);

  const isYearsView = selectedYear === null && shouldShowYearsByDefault;

  const chartData = useMemo(() => {
    let base: { name: string; count: number }[];

    if (isYearsView) {
      base = yearsData;
    } else if (selectedYear !== null) {
      base = filledMonths.filter((obj) => obj.name.startsWith(String(selectedYear)));
    } else {
      base = filledMonths;
    }

    if (unknownCount > 0) {
      return [...base, { name: unknownLabel, count: unknownCount }];
    }
    return base;
  }, [isYearsView, yearsData, selectedYear, filledMonths, unknownCount, unknownLabel]);

  if (dataPerMonth.length > 0 && chartData.length === 0) {
    return (
      <ChartSizeGuard height={300}>
        <Text size="sm" c="dimmed" p="md" style={{ textAlign: "center" }}>
          {t("common.loading", { defaultValue: "Loading chart..." })}
        </Text>
      </ChartSizeGuard>
    );
  }

  return (
    <ChartSizeGuard height={300}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={chartData}
          onClick={(e) => {
            const raw = `${e?.activeLabel || ""}`;
            const year = Number.parseInt(raw, 10);

            if (!year) return;

            setSelectedYear((prev) => (prev === year ? null : year));
          }}
        >
          <CartesianGrid strokeDasharray="3" vertical={false} />
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip
            content={<DateChartTooltip isYearsView={isYearsView} />}
            cursor={{
              fill: "var(--mantine-color-default-border)",
              stroke: "1px solid var(--chart-grid-color)",
            }}
          />
          <Bar dataKey="count" fill="var(--mantine-color-blue-filled)" name="Games" />
        </BarChart>
      </ResponsiveContainer>
    </ChartSizeGuard>
  );
}

export default OverviewPanel;
