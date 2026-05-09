import { Draggable, Droppable } from "@hello-pangea/dnd";
import {
  Accordion,
  ActionIcon,
  Box,
  Button,
  Card,
  Group,
  Paper,
  Popover,
  ScrollArea,
  Space,
  Stack,
  Tabs,
  Text,
} from "@mantine/core";
import { IconChevronsRight, IconPlayerPause, IconSelector, IconSettings } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import { memo, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { TreeStateContext } from "@/components/TreeStateContext";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import {
  activeTabAtom,
  allEnabledAtom,
  currentAnalysisTabAtom,
  currentExpandedEnginesAtom,
  currentTabAtom,
  enableAllAtom,
  engineMovesFamily,
  enginesAtom,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { getPiecesCount, hasCaptures, positionFromFen } from "@/utils/chessops";
import { buildEngineVariationCacheKey } from "@/utils/engineCacheKey";
import type { Engine } from "@/utils/engines";
import { getLegacyAnalysisInitialConfig, removeAnalysisInitialConfigField } from "@/utils/tabs";
import type { TreeNode } from "@/utils/treeReducer";
import BestMoves, { arrowColors } from "./BestMoves";
import EngineSelection from "./EngineSelection";
import LogsPanel from "./LogsPanel";
import ReportPanel from "./ReportPanel";
import ScoreBubble from "./ScoreBubble";
import TablebaseInfo from "./TablebaseInfo";

type AnalysisPanelProps = {
  hideTabsList?: boolean;
  forceTab?: "engines" | "report" | "logs";
};

type AnalysisPanelTab = "engines" | "report" | "logs";

function isAnalysisPanelTab(value: string | undefined): value is AnalysisPanelTab {
  return value === "engines" || value === "report" || value === "logs";
}

function hasAnalysisContent(root: TreeNode): boolean {
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.score) {
      return true;
    }
    if (node.annotations.length > 0) {
      return true;
    }
    if (node.comment.trim().length > 0) {
      return true;
    }
    stack.push(...node.children);
  }
  return false;
}

function AnalysisPanel({ hideTabsList = false, forceTab }: AnalysisPanelProps) {
  const { t } = useTranslation();
  const { layout } = useResponsiveLayout();
  const isCompact = layout.chessBoard.layoutType === "mobile";

  const store = useContext(TreeStateContext)!;
  const rootFen = useStore(store, (s) => s.root.fen);
  const root = useStore(store, (s) => s.root);
  const headers = useStore(store, (s) => s.headers);
  const currentNodeFen = useStore(
    store,
    useShallow((s) => s.currentNode().fen),
  );
  const is960 = useMemo(() => headers.variant === "Chess960", [headers]);
  const moves = useStore(
    store,
    useShallow((s) => getVariationLine(s.root, s.position, is960)),
  );
  const currentNodeHalfMoves = useStore(
    store,
    useShallow((s) => s.currentNode().halfMoves),
  );

  const [engines, setEngines] = useAtom(enginesAtom);
  const loadedEngines = useMemo(() => engines.filter((e) => e.loaded), [engines]);

  useEffect(() => {
    const handleEngineReorder = (event: CustomEvent) => {
      const { source, destination } = event.detail;
      setEngines(async (prev) => {
        const result = Array.from(await prev);
        const prevLoaded = result.filter((e) => e.loaded);
        const [removed] = prevLoaded.splice(source.index, 1);
        prevLoaded.splice(destination.index, 0, removed);

        result.forEach((e, i) => {
          if (e.loaded) {
            result[i] = prevLoaded.shift()!;
          }
        });
        return result;
      });
    };

    window.addEventListener("engineReorder", handleEngineReorder as EventListener);
    return () => {
      window.removeEventListener("engineReorder", handleEngineReorder as EventListener);
    };
  }, [setEngines]);

  const [, enable] = useAtom(enableAllAtom);
  const allEnabledLoader = useAtomValue(allEnabledAtom);
  const allEnabled = allEnabledLoader.state === "hasData" && allEnabledLoader.data;

  const [currentTab, setCurrentTab] = useAtom(currentTabAtom);
  const [configTabOverride, setConfigTabOverride] = useState<AnalysisPanelTab | null>(null);

  const [tab, setTab] = useAtom(currentAnalysisTabAtom);
  const [expanded, setExpanded] = useAtom(currentExpandedEnginesAtom);
  const defaultAppliedRef = useRef(false);

  // Use forced tab when provided (embedded contexts), otherwise configured/atom tab.
  const effectiveTab = (forceTab || configTabOverride || tab) as AnalysisPanelTab;

  const hadPreexistingAnalysisRef = useRef<boolean | null>(null);
  if (hadPreexistingAnalysisRef.current === null) {
    hadPreexistingAnalysisRef.current = hasAnalysisContent(root);
  }

  const desiredDefaultTab: "engines" | "report" = hadPreexistingAnalysisRef.current ? "report" : "engines";

  // Read initial configuration (per board tab) and apply it once.
  useEffect(() => {
    if (!currentTab?.value) {
      setConfigTabOverride(null);
      return;
    }

    const typedConfig = currentTab.meta?.initialConfig;
    const legacyConfig = typedConfig ? null : getLegacyAnalysisInitialConfig(currentTab.value);
    const next = typedConfig?.analysisSubTab ?? legacyConfig?.analysisSubTab;
    if (!isAnalysisPanelTab(next)) {
      setConfigTabOverride(null);
      return;
    }

    // IMPORTANT: decide based on analysis state at open time, not after engines start streaming scores.
    const hadPreexistingAnalysis = hadPreexistingAnalysisRef.current ?? false;
    if ((next === "report" && !hadPreexistingAnalysis) || (next === "engines" && hadPreexistingAnalysis)) {
      // Clear the one-shot config so it doesn't re-apply later (e.g. when analysis scores appear).
      if (typedConfig?.analysisSubTab) {
        setCurrentTab((prev) => {
          if (prev.value !== currentTab.value) return prev;
          return removeAnalysisInitialConfigField(prev, "analysisSubTab");
        });
      } else if (legacyConfig?.analysisSubTab && typeof window !== "undefined") {
        const configKey = `${currentTab.value}_initialConfig`;
        const updatedConfig = { ...legacyConfig };
        delete updatedConfig.analysisSubTab;
        if (Object.keys(updatedConfig).length === 0) {
          sessionStorage.removeItem(configKey);
        } else {
          try {
            sessionStorage.setItem(configKey, JSON.stringify(updatedConfig));
          } catch {
            // Ignore storage errors
          }
        }
      }
      setConfigTabOverride(null);
      return;
    }

    setConfigTabOverride(next);
  }, [currentTab?.value, currentTab?.meta?.initialConfig, setCurrentTab]);

  useEffect(() => {
    if (!currentTab?.value) return;
    if (!configTabOverride) return;

    if (tab !== configTabOverride) {
      setTab(configTabOverride);
    }

    if (currentTab.meta?.initialConfig?.analysisSubTab) {
      setCurrentTab((prev) => {
        if (prev.value !== currentTab.value) return prev;
        return removeAnalysisInitialConfigField(prev, "analysisSubTab");
      });
    } else {
      const legacyConfig = getLegacyAnalysisInitialConfig(currentTab.value);
      if (legacyConfig?.analysisSubTab && typeof window !== "undefined") {
        const configKey = `${currentTab.value}_initialConfig`;
        const updatedConfig = { ...legacyConfig };
        delete updatedConfig.analysisSubTab;
        if (Object.keys(updatedConfig).length === 0) {
          sessionStorage.removeItem(configKey);
        } else {
          try {
            sessionStorage.setItem(configKey, JSON.stringify(updatedConfig));
          } catch {
            // Ignore storage errors
          }
        }
      }
    }

    // Allow the user to change tabs after applying the config once.
    setConfigTabOverride(null);
  }, [configTabOverride, currentTab?.value, currentTab?.meta?.initialConfig, setCurrentTab, setTab, tab]);

  useEffect(() => {
    if (defaultAppliedRef.current) return;
    if (configTabOverride !== null) return;
    if (tab !== desiredDefaultTab) {
      setTab(desiredDefaultTab);
    }
    defaultAppliedRef.current = true;
  }, [configTabOverride, desiredDefaultTab, setTab, tab]);

  const [pos] = positionFromFen(currentNodeFen);
  const navigate = useNavigate();

  const panelStyle = isCompact
    ? { width: "100%", display: "flex", flexDirection: "column" as const, minHeight: 0, minWidth: 0 }
    : {
        display: "flex",
        overflow: "hidden",
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        flexDirection: "column" as const,
      };

  const enginesContent = (
    <Box style={isCompact ? { display: "flex", flexDirection: "column", alignItems: "center" } : undefined}>
      {pos && (getPiecesCount(pos) <= 7 || (getPiecesCount(pos) === 8 && hasCaptures(pos))) && (
        <>
          <TablebaseInfo fen={currentNodeFen} turn={pos.turn} />
          <Space h="sm" />
        </>
      )}
      {loadedEngines.length > 1 && (
        <Paper
          withBorder
          p="xs"
          flex={1}
          style={isCompact ? { width: "100%", display: "flex", justifyContent: "center" } : undefined}
        >
          <Group w="100%" justify={isCompact ? "center" : "flex-start"}>
            <Stack w="6rem" gap="xs">
              <Text ta="center" fw="bold">
                {t("features.board.analysis.summary")}
              </Text>
              <Button
                rightSection={allEnabled ? <IconPlayerPause size="1.2rem" /> : <IconChevronsRight size="1.2rem" />}
                variant={allEnabled ? "filled" : "default"}
                onClick={() => enable(!allEnabled)}
              >
                {allEnabled ? t("common.stop") : t("common.run")}
              </Button>
            </Stack>
            <Group grow flex={1}>
              {loadedEngines.map((engine, i) => (
                <EngineSummary key={engine.name} engine={engine} fen={rootFen} moves={moves} i={i} />
              ))}
            </Group>
          </Group>
        </Paper>
      )}
      <Stack mt="sm" style={isCompact ? { width: "100%", alignItems: "center" } : undefined}>
        <Accordion
          variant="separated"
          multiple
          chevronSize={0}
          defaultValue={loadedEngines.map((e) => e.name)}
          value={expanded}
          onChange={(v) => setExpanded(v)}
          styles={{
            label: {
              paddingTop: 0,
              paddingBottom: 0,
            },
            content: {
              padding: "0.3rem",
            },
          }}
          style={isCompact ? { width: "100%" } : undefined}
        >
          <Droppable droppableId="engines-droppable" direction="vertical">
            {(provided) => (
              <div ref={provided.innerRef} {...provided.droppableProps}>
                <Stack w="100%">
                  {loadedEngines.map((engine, i) => (
                    <Draggable key={engine.name + i.toString()} draggableId={`engine-${engine.name}`} index={i}>
                      {(provided) => (
                        <div ref={provided.innerRef} {...provided.draggableProps}>
                          <Accordion.Item value={engine.name}>
                            <BestMoves
                              id={i}
                              engine={engine}
                              fen={rootFen}
                              moves={moves}
                              halfMoves={currentNodeHalfMoves}
                              dragHandleProps={provided.dragHandleProps}
                              orientation={headers.orientation || "white"}
                            />
                          </Accordion.Item>
                        </div>
                      )}
                    </Draggable>
                  ))}
                </Stack>

                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </Accordion>
        <Group gap="xs" justify={isCompact ? "center" : "flex-start"}>
          <Button
            flex={isCompact ? undefined : 1}
            variant="default"
            onClick={() => {
              navigate({ to: "/engines" });
            }}
            leftSection={<IconSettings size="0.875rem" />}
          >
            Manage Engines
          </Button>
          <Popover width={250} position="top-end" shadow="md">
            <Popover.Target>
              <ActionIcon variant="default" size="lg">
                <IconSelector />
              </ActionIcon>
            </Popover.Target>

            <Popover.Dropdown>
              <EngineSelection />
            </Popover.Dropdown>
          </Popover>
        </Group>
      </Stack>
    </Box>
  );

  return (
    <Stack
      h={isCompact ? "auto" : "100%"}
      style={{ minHeight: isCompact ? undefined : 0, minWidth: 0, touchAction: isCompact ? "pan-y" : undefined }}
    >
      <Tabs
        h={isCompact ? undefined : "100%"}
        orientation={isCompact ? "horizontal" : "vertical"}
        placement={isCompact ? undefined : "right"}
        value={effectiveTab}
        onChange={(v) => setTab(v!)}
        style={
          isCompact
            ? { minWidth: 0, touchAction: "pan-y" }
            : {
                display: "flex",
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                overflow: "hidden",
              }
        }
        keepMounted={false}
      >
        {!hideTabsList && (
          <Tabs.List
            style={
              isCompact
                ? {
                    flexWrap: "nowrap",
                    overflowX: "auto",
                    gap: "0.5rem",
                    paddingBottom: "0.25rem",
                    justifyContent: "center",
                    touchAction: "pan-y",
                  }
                : undefined
            }
          >
            <Tabs.Tab value="engines">{t("features.board.analysis.engines")}</Tabs.Tab>
            <Tabs.Tab value="report">{t("features.board.analysis.report")}</Tabs.Tab>
            <Tabs.Tab value="logs" disabled={loadedEngines.length === 0}>
              {t("features.board.analysis.logs")}
            </Tabs.Tab>
          </Tabs.List>
        )}
        <Tabs.Panel value="engines" style={panelStyle}>
          {isCompact ? (
            <Box style={{ width: "100%", touchAction: "pan-y" }}>{enginesContent}</Box>
          ) : (
            <ScrollArea
              h="100%"
              offsetScrollbars
              onScrollPositionChange={() => document.dispatchEvent(new Event("analysis-panel-scroll"))}
              style={{ flex: 1, minHeight: 0 }}
            >
              {enginesContent}
            </ScrollArea>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="report" pt="xs" style={panelStyle}>
          <ReportPanel />
        </Tabs.Panel>
        <Tabs.Panel value="logs" pt="xs" style={panelStyle}>
          <LogsPanel />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

function EngineSummary({ engine, fen, moves, i }: { engine: Engine; fen: string; moves: string[]; i: number }) {
  const activeTab = useAtomValue(activeTabAtom);
  const [ev] = useAtom(engineMovesFamily({ engine: engine.name, tab: activeTab! }));
  const variationCacheKey = useMemo(() => buildEngineVariationCacheKey(fen, moves), [fen, moves]);

  const curEval = useDeferredValue(useMemo(() => ev.get(variationCacheKey), [ev, variationCacheKey]));
  const score = curEval && curEval.length > 0 ? curEval[0].score : null;

  return (
    <Card withBorder c={arrowColors[i]?.strong} p="xs">
      <Stack gap="xs" align="center">
        <Text fw="bold" fz="xs" style={{ textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {engine.name}
        </Text>
        {score ? (
          <ScoreBubble size="sm" score={score} />
        ) : (
          <Text fz="sm" c="dimmed">
            ???
          </Text>
        )}
      </Stack>
    </Card>
  );
}

export default memo(AnalysisPanel);
