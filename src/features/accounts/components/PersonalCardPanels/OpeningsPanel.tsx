import { Badge, Box, Card, Divider, Group, ScrollArea, Select, Stack, Text } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import type { Color } from "chessops";
import { useAtom } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlayerGameInfo } from "@/bindings";
import { commands, type GameOutcome } from "@/bindings";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { analyzePlayerStyle } from "@/utils/playerStyle";
import { createTab } from "@/utils/tabs";
import { countMainPly, defaultTree } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";
import * as classes from "./OpeningsPanel.css";
import ResultsChart from "./ResultsChart";

type OpeningStats = {
  name: string;
  games: number;
  won: number;
  draw: number;
  lost: number;
};

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
  )
    .map(([name, { won, draw, lost, total }]) => ({ name, games: total, won, draw, lost }))
    .sort((a, b) => b.games - a.games);
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
          player_elo: g.player_elo,
          opponent_elo: g.opponent_elo,
          site: d.site,
          time_control: g.time_control,
          account: d.player,
        })),
      ) ?? [],
    [info?.site_stats_data],
  );

  const playerStyle = useMemo(() => analyzePlayerStyle(info), [info]);

  const opponentEloOptions = useMemo(() => {
    const buckets = new Set<number>();
    for (const g of openingData) {
      const elo = g.opponent_elo;
      if (typeof elo !== "number") continue;
      buckets.add(Math.floor(elo / 200) * 200);
    }
    const sorted = Array.from(buckets).sort((a, b) => a - b);
    return [
      { value: "all", label: t("common.all", { defaultValue: "All" }) },
      ...sorted.map((start) => ({ value: String(start), label: `${start}-${start + 199}` })),
    ];
  }, [openingData, t]);

  const [opponentEloBucket, setOpponentEloBucket] = useState<string>("all");

  const filteredOpeningData = useMemo(() => {
    if (opponentEloBucket === "all") return openingData;
    const start = Number.parseInt(opponentEloBucket, 10);
    if (!Number.isFinite(start)) return openingData;
    const end = start + 199;
    return openingData.filter(
      (g) => typeof g.opponent_elo === "number" && g.opponent_elo >= start && g.opponent_elo <= end,
    );
  }, [openingData, opponentEloBucket]);

  const accountStats = useMemo(() => {
    const map = new Map<string, { games: number; elo: number; site: string; account: string }>();
    for (const g of filteredOpeningData) {
      const accountName = g.account || "Unknown";
      const key = `${g.site}:${accountName}`;
      const prev = map.get(key) ?? { games: 0, elo: 0, site: g.site, account: accountName };
      map.set(key, {
        account: accountName,
        games: prev.games + 1,
        elo: typeof g.player_elo === "number" ? Math.max(prev.elo, g.player_elo) : prev.elo,
        site: g.site,
      });
    }
    return Array.from(map.entries())
      .map(([key, val]) => ({ key, ...val }))
      .sort((a, b) => b.games - a.games || a.site.localeCompare(b.site));
  }, [filteredOpeningData]);

  const whiteGames = filteredOpeningData.filter((g) => g.is_player_white).length;
  const blackGames = filteredOpeningData.filter((g) => !g.is_player_white).length;

  const whiteOpenings = aggregateOpenings(filteredOpeningData, "white");
  const blackOpenings = aggregateOpenings(filteredOpeningData, "black");
  const rowCount = Math.max(whiteOpenings.length, blackOpenings.length);

  return (
    <Group h="100%" align="stretch" wrap="nowrap" gap="md" style={{ minHeight: 0, minWidth: 0 }}>
      <Box style={{ flex: "0 0 25%", minWidth: 280, minHeight: 0 }}>
        <Card
          withBorder
          radius="md"
          shadow="sm"
          bg="var(--mantine-color-dark-6)"
          h="100%"
          style={{ overflow: "hidden" }}
        >
          <ScrollArea h="100%" offsetScrollbars>
            <Stack gap="sm">
              <Text fz="lg" fw={700} ta="center">
                {playerName}
              </Text>
              <Badge color={playerStyle.color} variant="light" size="lg" mx="auto">
                {t(playerStyle.label)}
              </Badge>
              <Text fz="xs" c="dimmed" ta="center">
                {t(playerStyle.description)}
              </Text>
              <Divider />
              <Select
                label={t("accounts.opponentElo", { defaultValue: "Opponent Elo" })}
                data={opponentEloOptions}
                value={opponentEloBucket}
                onChange={(v) => setOpponentEloBucket(v || "all")}
                clearable={false}
                searchable
                size="xs"
              />
              <Divider />
              <Stack gap="xs">
                <Text fw={600}>{t("common.elo", { defaultValue: "Elo" })}</Text>
                {accountStats.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t("common.noData", { defaultValue: "No data" })}
                  </Text>
                ) : (
                  accountStats.map(({ key, games, elo, site, account }) => (
                    <Group key={key} justify="space-between" align="flex-start" wrap="nowrap">
                      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                        <Text fw={600} style={{ wordBreak: "break-all" }}>
                          {account}
                        </Text>
                        <Text size="xs" c="dimmed" style={{ wordBreak: "break-word" }}>
                          {site}
                        </Text>
                      </Stack>
                      <Text fw={700} style={{ whiteSpace: "nowrap" }}>
                        {elo > 0 ? elo : "-"} - {games} {t("common.games.other", { count: games })}
                      </Text>
                    </Group>
                  ))
                )}
              </Stack>
            </Stack>
          </ScrollArea>
        </Card>
      </Box>

      <Box style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex" }}>
        <Box style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
          {rowCount === 0 ? (
            <Text size="sm" c="dimmed" p="md">
              {t("common.noData", { defaultValue: "No data" })}
            </Text>
          ) : (
            <Stack gap={0} style={{ minWidth: 0 }}>
              {Array.from({ length: rowCount }, (_, index) => {
                const white = whiteOpenings[index];
                const black = blackOpenings[index];
                const key = `${white?.name ?? "-"}:${white?.games ?? 0}|${black?.name ?? "-"}:${black?.games ?? 0}`;
                return (
                  <Box key={key}>
                    <Group grow>
                      {white ? <OpeningDetail opening={white} totalGames={whiteGames} color="white" /> : <div />}
                      {black ? <OpeningDetail opening={black} totalGames={blackGames} color="black" /> : <div />}
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
    <Stack py="sm" justify="space-between">
      <Group justify="space-between" wrap="nowrap">
        <Text
          lineClamp={2}
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
        <Text>{(openingRate * 100).toFixed(2)}%</Text>
      </Group>
      <ResultsChart won={opening.won} draw={opening.draw} lost={opening.lost} size="1.5rem" />
    </Stack>
  );
}

export default OpeningsPanel;
