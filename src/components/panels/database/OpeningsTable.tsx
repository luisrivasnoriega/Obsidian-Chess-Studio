import { Box, Group, Progress, ScrollArea, Table, Text } from "@mantine/core";
import { useForceUpdate } from "@mantine/hooks";
import { useAtomValue } from "jotai";
import { memo, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Score } from "@/bindings";
import { TreeStateContext } from "@/components/TreeStateContext";
import { useLanguageChangeListener } from "@/hooks/useLanguageChangeListener";
import { activeEngineAnalysisAtom } from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import type { Opening } from "@/utils/db";
import { buildEngineVariationCacheKey } from "@/utils/engineCacheKey";

type OpeningRow = Opening & {
  isTotal?: boolean;
};

function safePercent(value: number, total: number) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return (value / total) * 100;
}

function normalizeMoveKey(move: string) {
  return move.replace(/\s+/g, "").replace(/[+#?!]+$/g, "");
}

const resultBarColors = {
  white: "#2792b5",
  draw: "#475562",
  black: "#d19a35",
} as const;

const resultLabelStyle = {
  fontVariantNumeric: "tabular-nums",
  textShadow: "0 1px 2px rgb(0 0 0 / 0.55)",
} as const;

function EngineScore({ score }: { score: Score | null }) {
  const { t } = useTranslation();

  return (
    <Text size="md" ta="right" c={score ? undefined : "dimmed"} style={{ fontVariantNumeric: "tabular-nums" }}>
      {score ? t("units.score", { score: score.value, formatParams: { score: { precision: 2 } } }) : "--"}
    </Text>
  );
}

function ResultBar({ white, draw, black }: { white: number; draw: number; black: number }) {
  const total = white + draw + black;
  const whitePercent = safePercent(white, total);
  const drawPercent = safePercent(draw, total);
  const blackPercent = safePercent(black, total);

  return (
    <Progress.Root size={25} radius="sm" bg="var(--mantine-color-dark-7)">
      <Progress.Section value={whitePercent} color={resultBarColors.white}>
        <Progress.Label c="white" fz={13} fw={700} style={resultLabelStyle}>
          {whitePercent > 8 ? `${whitePercent.toFixed(1)}%` : ""}
        </Progress.Label>
      </Progress.Section>
      <Progress.Section value={drawPercent} color={resultBarColors.draw}>
        <Progress.Label c="white" fz={13} fw={700} style={resultLabelStyle}>
          {drawPercent > 8 ? `${drawPercent.toFixed(1)}%` : ""}
        </Progress.Label>
      </Progress.Section>
      <Progress.Section value={blackPercent} color={resultBarColors.black}>
        <Progress.Label c="white" fz={13} fw={700} style={resultLabelStyle}>
          {blackPercent > 8 ? `${blackPercent.toFixed(1)}%` : ""}
        </Progress.Label>
      </Progress.Section>
    </Progress.Root>
  );
}

function OpeningsTable({ openings, loading }: { openings: Opening[]; loading: boolean }) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("OpeningsTable must be used within a TreeStateProvider");
  }
  const makeMove = useStore(store, (s) => s.makeMove);
  const currentNodeScore = useStore(store, (s) => s.currentNode().score);
  const rootFen = useStore(store, (s) => s.root.fen);
  const moves = useStore(
    store,
    useShallow((s) => getVariationLine(s.root, s.position, s.headers.variant === "Chess960")),
  );
  const activeEngineAnalysis = useAtomValue(activeEngineAnalysisAtom);
  const forceUpdate = useForceUpdate();
  useLanguageChangeListener(forceUpdate);

  const whiteTotal = openings.reduce((acc, curr) => acc + curr.white, 0);
  const blackTotal = openings.reduce((acc, curr) => acc + curr.black, 0);
  const drawTotal = openings.reduce((acc, curr) => acc + curr.draw, 0);
  const grandTotal = whiteTotal + blackTotal + drawTotal;

  const rows = useMemo<OpeningRow[]>(() => {
    if (openings.length === 0) return [];
    return [
      ...openings,
      {
        move: "Total",
        white: whiteTotal,
        black: blackTotal,
        draw: drawTotal,
        isTotal: true,
      },
    ];
  }, [blackTotal, drawTotal, openings, whiteTotal]);

  const engineScoresByMove = useMemo(() => {
    const scores = new Map<string, Score>();
    if (activeEngineAnalysis.state !== "hasData" || !activeEngineAnalysis.data) {
      return scores;
    }

    const cacheKey = buildEngineVariationCacheKey(rootFen, moves);
    const engineLines = activeEngineAnalysis.data.moves.get(cacheKey) ?? [];
    for (const line of engineLines) {
      const firstMove = line.sanMoves[0];
      if (firstMove) {
        scores.set(normalizeMoveKey(firstMove), line.score);
      }
    }
    return scores;
  }, [activeEngineAnalysis, moves, rootFen]);

  const showScore = activeEngineAnalysis.state === "hasData" && activeEngineAnalysis.data != null;

  if (!loading && rows.length === 0) {
    return (
      <Box h="100%" style={{ display: "grid", placeItems: "center" }}>
        <Text size="sm" c="dimmed">
          {t("features.board.database.noGamesFound")}
        </Text>
      </Box>
    );
  }

  return (
    <Box style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}>
      <ScrollArea h="100%" offsetScrollbars>
        <Table stickyHeader highlightOnHover verticalSpacing={7} style={{ fontSize: "var(--mantine-font-size-md)" }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={96}>{t("features.board.database.move")}</Table.Th>
              <Table.Th w={190}>{t("features.board.database.popularity")}</Table.Th>
              <Table.Th miw={210}>{t("features.board.database.results")}</Table.Th>
              {showScore && (
                <Table.Th w={112} ta="right">
                  {t("features.board.database.score")}
                </Table.Th>
              )}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => {
              const total = row.white + row.draw + row.black;
              const popularity = safePercent(total, grandTotal);
              const score = row.isTotal
                ? currentNodeScore
                : (engineScoresByMove.get(normalizeMoveKey(row.move)) ?? null);
              const canPlayMove = !row.isTotal && row.move !== "*";

              return (
                <Table.Tr
                  key={row.isTotal ? "total" : row.move}
                  onClick={() => {
                    if (canPlayMove) {
                      makeMove({ payload: row.move });
                    }
                  }}
                  style={{
                    cursor: canPlayMove ? "pointer" : "default",
                    background: row.isTotal ? "var(--mantine-color-dark-8)" : undefined,
                    position: row.isTotal ? "sticky" : undefined,
                    bottom: row.isTotal ? 0 : undefined,
                    zIndex: row.isTotal ? 2 : undefined,
                    boxShadow: row.isTotal ? "0 -1px 0 var(--mantine-color-dark-4)" : undefined,
                  }}
                >
                  <Table.Td>
                    <Text size="md" fw={row.isTotal ? 700 : 500}>
                      {row.move === "*"
                        ? t("features.board.database.gameEnd")
                        : row.isTotal
                          ? row.move
                          : t("formatters.moveNotation", { move: row.move })}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <Text
                        size="sm"
                        w={84}
                        fw={row.isTotal ? 700 : 500}
                        style={{ fontVariantNumeric: "tabular-nums" }}
                      >
                        {row.isTotal ? "100%" : `${popularity.toFixed(0)}%`} ({t("units.count", { count: total })})
                      </Text>
                      <Progress
                        value={row.isTotal ? 100 : popularity}
                        size={6}
                        radius="xl"
                        color="blue.5"
                        bg="var(--mantine-color-dark-7)"
                        style={{ flex: 1 }}
                      />
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <ResultBar white={row.white} draw={row.draw} black={row.black} />
                  </Table.Td>
                  {showScore && (
                    <Table.Td>
                      <EngineScore score={score} />
                    </Table.Td>
                  )}
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </Box>
  );
}

export default memo(OpeningsTable);
