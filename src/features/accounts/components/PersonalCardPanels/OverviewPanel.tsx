import { Box, Group, Stack, Text } from "@mantine/core";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, type TooltipProps, XAxis, YAxis } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import type { PlayerGameInfo, StatsData } from "@/bindings";
import { ChartSizeGuard } from "@/components/ChartSizeGuard";
import { getTimeControl } from "@/utils/timeControl";
import PlayerSidebarCard, { type PlatformFilter, type TimeControlFilter, normalizePlatform } from "./PlayerSidebarCard";
import ResultsChart from "./ResultsChart";

function fillMissingMonths(data: { name: string; count: number }[]): { name: string; count: number }[] {
  if (data.length === 0) return data;

  data.sort((a, b) => a.name.localeCompare(b.name));

  const monthStrings: string[] = [];
  const startDate = new Date(`${data[0].name}-01`);
  const endDate = new Date(`${data[data.length - 1].name}-01`);

  const timezoneOffset = new Date().getTimezoneOffset() * 60 * 1000; // milliseconds
  const currDate = new Date(startDate);
  while (currDate <= endDate) {
    const localCurrDate = new Date(currDate.getTime() - timezoneOffset);
    const monthString = localCurrDate.toISOString().slice(0, 7);
    monthStrings.push(monthString);
    currDate.setMonth(currDate.getMonth() + 1);
  }

  const dataMap = new Map(data.map((item) => [item.name, item.count]));
  const filledData = monthStrings.map((month) => ({
    name: month,
    count: dataMap.get(month) || 0,
  }));

  return filledData;
}

function mergeYears(data: { name: string; count: number }[]): { name: string; count: number }[] {
  const yearCounts: { [year: string]: number } = {};

  data.forEach(({ name, count }) => {
    const year = name.slice(0, 4);
    yearCounts[year] = (yearCounts[year] || 0) + count;
  });

  return Object.entries(yearCounts).map(([year, count]) => ({
    name: year,
    count,
  }));
}

function extractGameStats(games: StatsData[]) {
  const total = games.length;
  const won = games.filter((d) => d.result === "Won").length;
  const draw = games.filter((d) => d.result === "Drawn").length;
  const lost = games.filter((d) => d.result === "Lost").length;

  const monthCounts: { [key: string]: number } = {};
  games.forEach((game) => {
    const monthString = game.date.slice(0, 7).replace(".", "-");
    monthCounts[monthString] = (monthCounts[monthString] || 0) + 1;
  });

  const dataPerMonth = Object.entries(monthCounts).map(([month, count]) => ({
    name: month,
    count,
  }));

  return { total, won, draw, lost, dataPerMonth };
}

function OverviewPanel({ playerName, info }: { playerName: string; info: PlayerGameInfo }) {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [timeControl, setTimeControl] = useState<TimeControlFilter>("any");
  const [opponentEloBucket, setOpponentEloBucket] = useState<string>("all");

  const opponentEloOptions = useMemo(() => {
    const buckets = new Set<number>();
    for (const site of info?.site_stats_data ?? []) {
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
  }, [info?.site_stats_data, t]);

  const games = useMemo(() => {
    let data =
      info?.site_stats_data
        ?.filter((d) => platform === "all" || normalizePlatform(d.site) === platform)
        .flatMap((d) => d.data.map((game) => ({ ...game, site: d.site }))) ?? [];

    if (timeControl !== "any") {
      data = data.filter((game) => getTimeControl(game.site, game.time_control) === timeControl);
    }

    if (opponentEloBucket !== "all") {
      const start = Number.parseInt(opponentEloBucket, 10);
      if (Number.isFinite(start)) {
        const end = start + 199;
        data = data.filter(
          (game) => typeof game.opponent_elo === "number" && game.opponent_elo >= start && game.opponent_elo <= end,
        );
      }
    }

    return data;
  }, [info?.site_stats_data, opponentEloBucket, platform, timeControl]);
  const { total, won, draw, lost, dataPerMonth } = extractGameStats(games);

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
        />
      </Box>

      <Box style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex" }}>
        <Box style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
          {total > 0 ? (
            <Stack gap="md" p="md">
              <ResultsChart won={won} draw={draw} lost={lost} size="2rem" />
              <DateChart dataPerMonth={dataPerMonth} />
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

const DateChartTooltip = ({
  active,
  payload,
  label,
  isYearSelected,
}: TooltipProps<ValueType, NameType> & { payload?: any[]; label?: string; isYearSelected?: boolean }) => {
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
        <p
          style={{ color: "var(--mantine-color-blue-filled)", marginTop: "8px" }}
        >{`${payload?.[0].name} : ${payload?.[0].value}`}</p>
        <p style={{ fontSize: "0.75rem", margin: "0", color: "grey" }}>
          Click to {isYearSelected ? "see the month details" : "return to the years view"}.
        </p>
      </div>
    );
  }

  return null;
};

function DateChart({ dataPerMonth }: { dataPerMonth: { name: string; count: number }[] }) {
  const [selectedYear, setSelectedYear] = useState<number | null>(null);

  let data = fillMissingMonths(dataPerMonth);

  if (selectedYear) {
    data = data.filter((obj) => obj.name.startsWith(selectedYear.toString()));
  } else if (data.length > 36) {
    data = mergeYears(data);
  }

  return (
    <ChartSizeGuard height={300}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          onClick={(e) => {
            const year = Number.parseInt(`${e?.activeLabel || ""}`, 10);
            if (year) {
              setSelectedYear((prev) => (prev === year ? null : year));
            }
          }}
        >
          <CartesianGrid strokeDasharray="3" vertical={false} />
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip
            content={<DateChartTooltip isYearSelected={selectedYear === null} />}
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
