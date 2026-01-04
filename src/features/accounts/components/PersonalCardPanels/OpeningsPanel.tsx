import { Box, Divider, Group, Select, Stack, Text } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import type { Color } from "chessops";
import { useAtom } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlayerGameInfo } from "@/bindings";
import { commands, type GameOutcome } from "@/bindings";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { createTab } from "@/utils/tabs";
import { getTimeControl } from "@/utils/timeControl";
import { countMainPly, defaultTree } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";
import { DateRange } from "./DateRangeTabs";
import * as classes from "./OpeningsPanel.css";
import PlayerSidebarCard, { normalizePlatform, type PlatformFilter, type TimeControlFilter } from "./PlayerSidebarCard";
import ResultsChart from "./ResultsChart";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function extractOpponentEloValues(value: unknown): number[] {
  if (typeof value === "number" && Number.isFinite(value)) return [value];
  if (typeof value === "string") {
    const matches = value.replaceAll(",", "").match(/-?\d+(?:\.\d+)?/g);
    if (!matches) return [];
    return matches.map((match) => Number.parseFloat(match)).filter((num) => Number.isFinite(num));
  }
  return [];
}

function parseOpponentEloRange(value: unknown): { min: number; max: number } | null {
  const values = extractOpponentEloValues(value);
  if (values.length === 0) return null;
  if (values.length === 1) return { min: values[0], max: values[0] };
  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

type OpeningStats = {
  name: string;
  games: number;
  won: number;
  draw: number;
  lost: number;
};

type OpeningSort = "games_desc" | "score_desc" | "score_asc";

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

function aggregateOpenings(
  data: { opening: string; result: GameOutcome; is_player_white: boolean }[],
  color: Color,
): OpeningStats[] {
  return Array.from(
    data
      .filter((d) => d.is_player_white === (color === "white"))
      .reduce((acc, d) => {
        const prev = acc.get(d.opening) ?? { won: 0, draw: 0, lost: 0, total: 0 };
        acc.set(d.opening, {
          won: prev.won + (d.result === "Won" ? 1 : 0),
          draw: prev.draw + (d.result === "Drawn" ? 1 : 0),
          lost: prev.lost + (d.result === "Lost" ? 1 : 0),
          total: prev.total + 1,
        });
        return acc;
      }, new Map()),
  ).map(([name, { won, draw, lost, total }]) => ({ name, games: total, won, draw, lost }));
}

function getScoreRate(opening: OpeningStats): number {
  if (opening.games <= 0) return 0;
  return (opening.won + opening.draw * 0.5) / opening.games;
}

function sortOpenings(openings: OpeningStats[], sortBy: OpeningSort): OpeningStats[] {
  const sorted = [...openings];
  switch (sortBy) {
    case "score_asc":
      return sorted.sort((a, b) => getScoreRate(a) - getScoreRate(b));
    case "score_desc":
      return sorted.sort((a, b) => getScoreRate(b) - getScoreRate(a));
    default:
      return sorted.sort((a, b) => b.games - a.games);
  }
}

function OpeningsPanel({ playerName, info }: { playerName: string; info: PlayerGameInfo }) {
  const { t } = useTranslation();

  const openingData = useMemo(
    () =>
      info?.site_stats_data.flatMap((d) =>
        d.data.map((g) => ({
          opening: g.opening,
          result: g.result,
          is_player_white: g.is_player_white,
          opponent_elo: g.opponent_elo,
          site: d.site,
          time_control: g.time_control,
          date: g.date,
        })),
      ) ?? [],
    [info?.site_stats_data],
  );

  const opponentEloOptions = useMemo(() => {
    const buckets = new Set<number>();
    for (const g of openingData) {
      const values = extractOpponentEloValues(g.opponent_elo);
      for (const elo of values) {
        buckets.add(Math.floor(elo / 200) * 200);
      }
    }
    const sorted = Array.from(buckets).sort((a, b) => a - b);
    return [
      { value: "all", label: t("common.all", { defaultValue: "All" }) },
      ...sorted.map((start) => ({ value: String(start), label: `${start}-${start + 199}` })),
    ];
  }, [openingData, t]);

  const [opponentEloBucket, setOpponentEloBucket] = useState<string>("all");
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [timeControl, setTimeControl] = useState<TimeControlFilter>("any");
  const [dateRange, setDateRange] = useState<DateRange | null>(DateRange.NinetyDays);
  const [sortBy, setSortBy] = useState<OpeningSort>("games_desc");

  const dates = useMemo(() => {
    const gameDates = openingData
      .map((game) => {
        if (!game.date) return null;
        return new Date(game.date.replaceAll(".", "-")).getTime();
      })
      .filter((date): date is number => Number.isFinite(date));

    return Array.from(new Set(gameDates)).sort((a, b) => a - b);
  }, [openingData]);

  const filteredOpeningData = useMemo(() => {
    let data = openingData;

    if (platform !== "all") {
      data = data.filter((g) => normalizePlatform(g.site) === platform);
    }
    if (timeControl !== "any") {
      data = data.filter((g) => getTimeControl(g.site, g.time_control) === timeControl);
    }
    if (opponentEloBucket !== "all") {
      const start = Number.parseInt(opponentEloBucket, 10);
      if (Number.isFinite(start)) {
        const end = start + 199;
        data = data.filter((g) => {
          const range = parseOpponentEloRange(g.opponent_elo);
          return range != null && range.max >= start && range.min <= end;
        });
      }
    }

    if (dateRange && dates.length > 0) {
      const earliestDate = calculateEarliestDate(dateRange, dates);
      data = data.filter((g) => {
        if (!g.date) return false;
        const gameDate = new Date(g.date.replaceAll(".", "-")).getTime();
        return gameDate >= earliestDate;
      });
    }

    return data;
  }, [openingData, opponentEloBucket, platform, timeControl, dateRange, dates]);

  const whiteGames = filteredOpeningData.filter((g) => g.is_player_white).length;
  const blackGames = filteredOpeningData.filter((g) => !g.is_player_white).length;

  const whiteOpenings = aggregateOpenings(filteredOpeningData, "white");
  const blackOpenings = aggregateOpenings(filteredOpeningData, "black");
  const sortedWhiteOpenings = useMemo(() => sortOpenings(whiteOpenings, sortBy), [whiteOpenings, sortBy]);
  const sortedBlackOpenings = useMemo(() => sortOpenings(blackOpenings, sortBy), [blackOpenings, sortBy]);
  const rowCount = Math.max(sortedWhiteOpenings.length, sortedBlackOpenings.length);

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
        </Box>
      </Box>
    </Group>
  );
}

function OpeningDetail({ opening, totalGames, color }: { opening: OpeningStats; totalGames: number; color: Color }) {
  const [, setTabs] = useAtom(tabsAtom);
  const [, setActiveTab] = useAtom(activeTabAtom);
  const navigate = useNavigate();

  const openingRate = opening.games / Math.max(totalGames, 1);

  return (
    <Stack py="sm" justify="space-between" style={{ minWidth: 0, height: "100%" }}>
      <Group justify="space-between" wrap="nowrap" gap="xs" style={{ minWidth: 0 }}>
        <Text
          lineClamp={2}
          style={{ flex: 1, minWidth: 0 }} // <- critical: allow shrink + clamp
          className={classes.link}
          onClick={async () => {
            const pgn = unwrap(await commands.getOpeningFromName(opening.name));
            const headers = defaultTree().headers;
            const tree = await parsePGN(pgn);
            headers.orientation = color;

            createTab({
              tab: { name: opening.name, type: "analysis" },
              pgn,
              headers,
              setTabs,
              setActiveTab,
              position: Array(countMainPly(tree.root)).fill(0),
            });

            navigate({ to: "/analysis" });
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
