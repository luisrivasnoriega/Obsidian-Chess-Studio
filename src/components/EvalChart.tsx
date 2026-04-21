import { AreaChart } from "@mantine/charts";
import { Alert, Box, LoadingOverlay, Paper, SegmentedControl, Stack, Text, useMantineTheme } from "@mantine/core";
import equal from "fast-deep-equal";
import { useAtom } from "jotai";
import { memo, type ReactNode, useCallback, useContext, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { CategoricalChartFunc } from "recharts/types/chart/types";
import { useStore } from "zustand";
import { ChartSizeGuard } from "@/components/ChartSizeGuard";
import { reportTypeAtom } from "@/state/atoms";
import { ANNOTATION_INFO } from "@/utils/annotation";
import { positionFromFen } from "@/utils/chessops";
import { skipWhile, takeWhile } from "@/utils/misc";
import { type ListNode, type TreeNode, treeIteratorMainLine } from "@/utils/treeReducer";
import * as classes from "./EvalChart.css";
import { TreeStateContext } from "./TreeStateContext";

interface EvalChartProps {
  isAnalysing: boolean;
  startAnalysis: () => void;
}

type DataPoint = {
  name: string;
  cpText: string;
  wdlText: string;
  yValue: number | "none";
  movePath: number[];
  color: string;
  White: number;
  Draw: number;
  Black: number;
};

const EvalChart = memo(
  function EvalChart(props: EvalChartProps) {
    const { t } = useTranslation();

    const store = useContext(TreeStateContext);
    if (!store) {
      throw new Error("EvalChart must be used within TreeStateProvider");
    }
    const root = useStore(store, (s) => s.root);
    const position = useStore(store, (s) => s.position);
    const goToMove = useStore(store, (s) => s.goToMove);
    const theme = useMantineTheme();

    // Use refs to track previous values to detect what's causing re-renders
    const prevRootRef = useRef(root);
    const prevPositionRef = useRef(position);

    prevRootRef.current = root;
    prevPositionRef.current = position;

    function getYValue(node: TreeNode): number | undefined {
      if (node.score) {
        let cp: number = node.score.value.value;
        if (node.score.value.type === "mate") {
          cp = node.score.value.value > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
        }
        return 2 / (1 + Math.exp(-0.004 * cp)) - 1;
      }
      if (node.children.length === 0) {
        const [pos] = positionFromFen(node.fen);
        if (pos) {
          if (pos.isCheckmate()) {
            return pos?.turn === "white" ? -1 : 1;
          }
          if (pos.isStalemate()) {
            return 0;
          }
        }
      }
    }

    function getEvalText(node: TreeNode, type: "cp" | "wdl"): string {
      if (node.score) {
        if (type === "cp") {
          return `${t("features.board.analysis.advantage")}: ${t("units.score", { score: node.score.value })}`;
        }
        if (type === "wdl" && node.score.wdl) {
          return `
         White: ${node.score.wdl[0] / 10}%
         Draw: ${node.score.wdl[1] / 10}%
         Black: ${node.score.wdl[2] / 10}%`;
        }
      }
      if (node.children.length === 0) {
        const [pos] = positionFromFen(node.fen);
        if (pos) {
          if (pos.isCheckmate()) return t("chess.checkmate");
          if (pos.isStalemate()) return t("chess.stalemate");
        }
      }
      return t("features.board.analysis.notAnalysed");
    }

    function getNodes(): ListNode[] {
      const allNodes = treeIteratorMainLine(root);
      const withoutRoot = skipWhile(allNodes, (node: ListNode) => node.position.length === 0);
      const withMoves = takeWhile(withoutRoot, (node: ListNode) => node.node.move !== undefined);
      return [...withMoves];
    }

    function* getData(): Iterable<DataPoint> {
      const nodes = getNodes();
      for (let i = 0; i < nodes.length; i++) {
        const currentNode = nodes[i];
        const yValue = getYValue(currentNode.node);
        const [pos] = positionFromFen(currentNode.node.fen);
        const wdl = currentNode.node.score?.wdl;

        yield {
          name: `${Math.ceil(currentNode.node.halfMoves / 2)}.${
            pos?.turn === "black" ? "" : ".."
          } ${currentNode.node.san}${currentNode.node.annotations}`,
          cpText: getEvalText(currentNode.node, "cp"),
          wdlText: getEvalText(currentNode.node, "wdl"),
          yValue: yValue ?? "none",
          movePath: currentNode.position,
          color: ANNOTATION_INFO[currentNode.node.annotations[0]]?.color || "gray",
          White: wdl ? wdl[0] : 0,
          Draw: wdl ? wdl[1] : 0,
          Black: wdl ? wdl[2] : 0,
        };
      }
    }

    function gradientOffset(data: DataPoint[]) {
      const dataMax = Math.max(...data.map((i) => (i.yValue !== "none" ? i.yValue : 0)));
      const dataMin = Math.min(...data.map((i) => (i.yValue !== "none" ? i.yValue : 0)));

      if (dataMax <= 0) return 0;
      if (dataMin >= 0) return 1;

      return dataMax / (dataMax - dataMin);
    }

    const [chartType, setChartType] = useAtom(reportTypeAtom);
    const reportType = chartType;

    // Track previous data to prevent unnecessary re-renders of AreaChart
    const prevDataRef = useRef<DataPoint[]>([]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: getData is a generator function that depends on root, position, reportType, and theme internally
    const data = useMemo(() => {
      const newData = [...getData()];
      // Only update if data actually changed (deep comparison)
      const dataChanged = !equal(newData, prevDataRef.current);
      if (dataChanged) {
        prevDataRef.current = newData;
        prevPositionRef.current = position;
      }
      return prevDataRef.current;
    }, [root, position, reportType, theme]);

    const onChartClick: CategoricalChartFunc = useCallback(
      // biome-ignore lint/suspicious/noExplicitAny: Recharts event type is complex and not fully typed
      (event: any) => {
        if (event?.activeLabel) {
          const match = data.find((d) => d.name === event.activeLabel);
          if (match) goToMove(match.movePath);
        }
      },
      [data, goToMove],
    );

    const currentPositionName = useMemo(() => {
      return data.find((point) => equal(point.movePath, position))?.name;
    }, [data, position]);
    const colouroffset = useMemo(() => gradientOffset(data), [data, gradientOffset]);

    const isWDLDisabled = useMemo(() => {
      return !data.some((point) => point.White !== 0 || point.Black !== 0 || point.Draw !== 0);
    }, [data]);

    // Memoize referenceLines to prevent AreaChart from re-rendering unnecessarily
    const referenceLines = useMemo(() => {
      if (!currentPositionName) return [];
      return [
        {
          x: currentPositionName,
          color: theme.colors[theme.primaryColor][7],
        },
      ];
    }, [currentPositionName, theme.colors, theme.primaryColor]);

    // Memoize series to prevent AreaChart from re-rendering unnecessarily
    const cpSeries = useMemo(
      () => [{ name: "yValue", color: theme.colors[theme.primaryColor][7] }],
      [theme.colors, theme.primaryColor],
    );

    const wdlSeries = useMemo(
      () => [
        { name: "White", color: "white" },
        { name: "Draw", color: "gray" },
        { name: "Black", color: "black" },
      ],
      [],
    );

    // Memoize tooltip content functions to prevent AreaChart from re-rendering
    const cpTooltipContent = useCallback(
      ({ payload, active }: { payload: any; active?: boolean }) => (
        <CustomTooltip active={active} payload={payload} type="cp" />
      ),
      [],
    );

    const wdlTooltipContent = useCallback(
      ({ payload, active }: { payload: any; active?: boolean }) => (
        <CustomTooltip active={active} payload={payload} type="wdl" />
      ),
      [],
    );

    // Memoize areaChartProps to prevent AreaChart from re-rendering
    // Store onChartClick in a ref to prevent areaChartProps from changing
    const onChartClickRef = useRef(onChartClick);
    onChartClickRef.current = onChartClick;
    const areaChartProps = useMemo(
      () => ({
        onClick: (...args: Parameters<CategoricalChartFunc>) => onChartClickRef.current(...args),
        style: { cursor: "pointer" },
      }),
      [], // Empty deps - use ref instead
    );

    return (
      <Stack>
        <Box
          pos="relative"
          onFocusCapture={(e) => {
            (e.target as HTMLElement).blur?.();
          }}
        >
          <LoadingOverlay visible={props.isAnalysing === true} />
          <SegmentedControl
            data={["CP", "WDL"]}
            size="xs"
            value={chartType}
            onChange={(v) => setChartType(v as "CP" | "WDL")}
          />
          {chartType === "CP" && (
            <StableChartContainer
              data={data}
              cpSeries={cpSeries}
              colouroffset={colouroffset}
              referenceLines={referenceLines}
              areaChartProps={areaChartProps}
              cpTooltipContent={cpTooltipContent}
            />
          )}
          {chartType === "WDL" &&
            (isWDLDisabled ? (
              <Alert variant="outline" title="Enable WDL" mt="sm">
                {t("features.board.analysis.enableWDL")}
              </Alert>
            ) : (
              <StableChartContainer
                data={data}
                wdlSeries={wdlSeries}
                referenceLines={referenceLines}
                areaChartProps={areaChartProps}
                wdlTooltipContent={wdlTooltipContent}
              />
            ))}
        </Box>
      </Stack>
    );
  },
  (prevProps, nextProps) => {
    // Custom comparison function for memo
    // Only re-render if isAnalysing or startAnalysis actually changed
    return prevProps.isAnalysing === nextProps.isAnalysing && prevProps.startAnalysis === nextProps.startAnalysis;
  },
);

// Memoized wrapper for AreaChart to prevent re-renders when parent updates
const MemoizedAreaChart = memo(AreaChart, (prevProps, nextProps) => {
  // Deep comparison of all props to prevent unnecessary re-renders
  // This is critical to prevent the assignRef infinite loop
  const propsEqual =
    prevProps.h === nextProps.h &&
    prevProps.curveType === nextProps.curveType &&
    prevProps.dataKey === nextProps.dataKey &&
    prevProps.connectNulls === nextProps.connectNulls &&
    prevProps.withXAxis === nextProps.withXAxis &&
    prevProps.withYAxis === nextProps.withYAxis &&
    prevProps.type === nextProps.type &&
    prevProps.fillOpacity === nextProps.fillOpacity &&
    prevProps.gridAxis === nextProps.gridAxis &&
    equal(prevProps.data, nextProps.data) &&
    equal(prevProps.series, nextProps.series) &&
    equal(prevProps.yAxisProps, nextProps.yAxisProps) &&
    equal(prevProps.splitColors, nextProps.splitColors) &&
    prevProps.splitOffset === nextProps.splitOffset &&
    equal(prevProps.activeDotProps, nextProps.activeDotProps) &&
    equal(prevProps.dotProps, nextProps.dotProps) &&
    equal(prevProps.referenceLines, nextProps.referenceLines) &&
    equal(prevProps.areaChartProps, nextProps.areaChartProps) &&
    prevProps.tooltipProps?.content === nextProps.tooltipProps?.content;

  return propsEqual;
});

// Stable container component that prevents ChartSizeGuard from remounting
// This is critical to prevent the assignRef infinite loop
const StableChartContainer = memo(
  function StableChartContainer({
    data,
    cpSeries,
    wdlSeries,
    colouroffset,
    referenceLines,
    areaChartProps,
    cpTooltipContent,
    wdlTooltipContent,
  }: {
    data: DataPoint[];
    cpSeries?: Array<{ name: string; color: string }>;
    wdlSeries?: Array<{ name: string; color: string }>;
    colouroffset?: number;
    referenceLines: Array<{ x: string; color: string }>;
    areaChartProps: { onClick: CategoricalChartFunc; style: { cursor: string } };
    cpTooltipContent?: (props: { payload: any; active?: boolean }) => ReactNode;
    wdlTooltipContent?: (props: { payload: any; active?: boolean }) => ReactNode;
  }) {
    const chartContent = useMemo(() => {
      if (cpSeries) {
        return (
          <MemoizedAreaChart
            h={150}
            curveType="monotone"
            data={data}
            dataKey={"name"}
            series={cpSeries}
            connectNulls={false}
            withXAxis={false}
            withYAxis={false}
            yAxisProps={{ domain: [-1, 1] }}
            type="split"
            fillOpacity={1}
            splitColors={["gray.1", "black"]}
            splitOffset={colouroffset!}
            activeDotProps={{ r: 3, strokeWidth: 1 }}
            dotProps={{ r: 0 }}
            referenceLines={referenceLines}
            areaChartProps={areaChartProps}
            gridAxis="none"
            tooltipProps={{
              content: cpTooltipContent!,
            }}
          />
        );
      } else {
        return (
          <MemoizedAreaChart
            h={150}
            curveType="monotone"
            data={data}
            dataKey={"name"}
            series={wdlSeries!}
            connectNulls={false}
            withXAxis={false}
            withYAxis={false}
            type="percent"
            fillOpacity={1}
            activeDotProps={{ r: 3, strokeWidth: 1 }}
            dotProps={{ r: 0 }}
            referenceLines={referenceLines}
            areaChartProps={areaChartProps}
            gridAxis="none"
            tooltipProps={{
              content: wdlTooltipContent!,
            }}
          />
        );
      }
    }, [data, cpSeries, wdlSeries, colouroffset, referenceLines, areaChartProps, cpTooltipContent, wdlTooltipContent]);

    // Use a stable component to prevent ChartSizeGuard from remounting
    // This is critical to prevent the assignRef infinite loop
    return <ChartSizeGuard height={150}>{chartContent}</ChartSizeGuard>;
  },
  (prevProps, nextProps) => {
    // Deep comparison to prevent unnecessary re-renders
    const dataEqual = equal(prevProps.data, nextProps.data);
    const cpSeriesEqual = equal(prevProps.cpSeries, nextProps.cpSeries);
    const wdlSeriesEqual = equal(prevProps.wdlSeries, nextProps.wdlSeries);
    const colouroffsetEqual = prevProps.colouroffset === nextProps.colouroffset;
    const referenceLinesEqual = equal(prevProps.referenceLines, nextProps.referenceLines);
    const areaChartPropsEqual = equal(prevProps.areaChartProps, nextProps.areaChartProps);
    const cpTooltipContentEqual = prevProps.cpTooltipContent === nextProps.cpTooltipContent;
    const wdlTooltipContentEqual = prevProps.wdlTooltipContent === nextProps.wdlTooltipContent;

    const propsEqual =
      dataEqual &&
      cpSeriesEqual &&
      wdlSeriesEqual &&
      colouroffsetEqual &&
      referenceLinesEqual &&
      areaChartPropsEqual &&
      cpTooltipContentEqual &&
      wdlTooltipContentEqual;

    return propsEqual;
  },
);

function CustomTooltip({
  active,
  payload,
  type,
}: {
  active?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: Recharts payload type is complex and not fully typed
  payload: any;
  type: "cp" | "wdl";
}) {
  if (active && payload?.length && payload[0].payload) {
    const dataPoint: DataPoint = payload[0].payload;
    return (
      <Paper px="md" py="sm" withBorder shadow="md" radius="md">
        <Text className={classes.tooltipTitle} c={dataPoint.color === "gray" ? undefined : dataPoint.color}>
          {dataPoint.name}
        </Text>
        <Text>{type === "cp" ? dataPoint.cpText : dataPoint.wdlText}</Text>
      </Paper>
    );
  }
  return null;
}

export default EvalChart;
