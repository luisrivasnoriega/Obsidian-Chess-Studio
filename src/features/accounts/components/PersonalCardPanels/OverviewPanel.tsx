import { Badge, Card, Divider, Grid, Group, Stack, Text } from "@mantine/core";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, type TooltipProps, XAxis, YAxis } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import type { PlayerGameInfo, StatsData } from "@/bindings";
import { ChartSizeGuard } from "@/components/ChartSizeGuard";
import { getTimeControl } from "@/utils/timeControl";
import { analyzePlayerStyle } from "@/utils/playerStyle";
import ResultsChart from "./ResultsChart";
import TimeControlSelector from "./TimeControlSelector";
import WebsiteAccountSelector from "./WebsiteAccountSelector";

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
  const [website, setWebsite] = useState<string | null>("All websites");
  const [account, setAccount] = useState<string | null>("All accounts");
  const [timeControl, setTimeControl] = useState<string | null>(null);
  const playerStyle = useMemo(() => analyzePlayerStyle(info), [info]);

  const siteElo = useMemo(() => {
    const map = new Map<string, { games: number; elo: number }>();
    for (const site of info.site_stats_data ?? []) {
      const games = site.data.length;
      const maxElo = site.data.reduce((max, g) => (typeof g.player_elo === "number" ? Math.max(max, g.player_elo) : max), 0);
      map.set(site.site, {
        games: (map.get(site.site)?.games ?? 0) + games,
        elo: Math.max(map.get(site.site)?.elo ?? 0, maxElo),
      });
    }
    return Array.from(map.entries()).sort((a, b) => b[1].games - a[1].games || a[0].localeCompare(b[0]));
  }, [info.site_stats_data]);

  const games =
    info?.site_stats_data
      .filter((d) => website === "All websites" || d.site === website)
      .filter((d) => account === "All accounts" || d.player === account)
      .flatMap((d) => d.data)
      .filter(
        (game) => !timeControl || timeControl === "any" || getTimeControl(website!, game.time_control) === timeControl,
      ) ?? [];
  const { total, won, draw, lost, dataPerMonth } = extractGameStats(games);

  return (
    <Grid gutter="md" h="100%" style={{ minHeight: 0 }}>
      <Grid.Col span={{ base: 12, md: 3 }}>
        <Card withBorder radius="md" shadow="sm" bg="var(--mantine-color-dark-6)">
          <Stack gap="xs">
            <Text fz="lg" fw={700} ta="center">
              {playerName}
            </Text>
            <Badge color={playerStyle.color} variant="light" size="lg" mx="auto">
              {t(playerStyle.label)}
            </Badge>
            <Text c="dimmed" fz="xs" ta="center">
              {t(playerStyle.description)}
            </Text>
            <Divider />
            <Stack gap={4}>
              <Text fw={600} fz="sm">
                {t("common.filters", { defaultValue: "Filters" })}
              </Text>
              <WebsiteAccountSelector
                playerName={playerName}
                onWebsiteChange={(website) => {
                  setWebsite(website);
                  if (website === "All websites") {
                    setTimeControl(null);
                  } else if (timeControl === null) {
                    setTimeControl("any");
                  }
                }}
                onAccountChange={setAccount}
                allowAll={true}
              />
              {website !== "All websites" && (
                <TimeControlSelector website={website} onTimeControlChange={setTimeControl} allowAll={true} />
              )}
            </Stack>
            <Divider />
            <Stack gap={4}>
              <Text fw={600} fz="sm">
                {t("common.elo", { defaultValue: "Elo" })} / {t("common.games.other", { defaultValue: "Games", count: 0 })}
              </Text>
              {siteElo.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No data
                </Text>
              ) : (
                siteElo.map(([site, { games, elo }]) => (
                  <Group key={site} justify="space-between">
                    <Text>{site}</Text>
                    <Text fw={700}>
                      {elo > 0 ? elo : "—"} · {games} games
                    </Text>
                  </Group>
                ))
              )}
            </Stack>
          </Stack>
        </Card>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 9 }} style={{ minHeight: 0 }}>
        <Stack gap="md" h="100%" style={{ minHeight: 0 }}>
          <Text pt="md" fw="bold" fz="lg" ta="center">
            {total} Games
          </Text>
          {total > 0 && (
            <>
              <ResultsChart won={won} draw={draw} lost={lost} size="2rem" />
              <DateChart dataPerMonth={dataPerMonth} />
            </>
          )}
        </Stack>
      </Grid.Col>
    </Grid>
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
