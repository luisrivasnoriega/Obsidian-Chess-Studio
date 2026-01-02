import { DragDropContext } from "@hello-pangea/dnd";
import { Box, Tabs } from "@mantine/core";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useCallback, useEffect, useMemo } from "react";
import { Mosaic, type MosaicNode } from "react-mosaic-component";
import { match } from "ts-pattern";
import type { Tab } from "@/utils/tabs";
import { debugNavLog } from "@/utils/debugNav";

import "react-mosaic-component/react-mosaic-component.css";
import "@/styles/react-mosaic.css";
import { TreeStateProvider } from "@/components/TreeStateContext";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import BoardAnalysis from "./components/BoardAnalysis";
import BoardVariants from "./components/BoardVariants";
import PlayVsEngineBoard from "./components/PlayVsEngineBoard";
import Puzzles from "./components/puzzles/Puzzles";
import ReportProgressSubscriber from "./components/ReportProgressSubscriber";
import {
  CUSTOM_EVENTS,
  constrainSplitPercentage,
  createFullLayout,
  DEFAULT_MOSAIC_LAYOUT,
  DROPPABLE_IDS,
  MOSAIC_PANE_CONSTRAINTS,
  REPORT_ID_PREFIX,
  STORAGE_KEYS,
  type ViewId,
} from "./constants";
import { useTabManagement } from "./hooks/useTabManagement";

const fullLayout = createFullLayout();

export default function BoardsPage() {
  const {
    tabs,
    activeTab,
    setActiveTab,
  } = useTabManagement({ enableHotkeys: false });

  const resolvedActiveTab = useMemo(() => {
    if (activeTab && tabs.some((tab) => tab.value === activeTab)) {
      return activeTab;
    }
    return tabs[0]?.value ?? null;
  }, [activeTab, tabs]);

  useEffect(() => {
    debugNavLog("boards-page", {
      tabs: tabs.length,
      activeTab,
      resolvedActiveTab,
      resolvedType: tabs.find((t) => t.value === resolvedActiveTab)?.type ?? null,
    });
  }, [activeTab, resolvedActiveTab, tabs]);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <DragDropContext
      onDragEnd={({ destination, source }) => {
        if (!destination) return;

        if (source.droppableId === DROPPABLE_IDS.ENGINES && destination.droppableId === DROPPABLE_IDS.ENGINES) {
          const event = new CustomEvent(CUSTOM_EVENTS.ENGINE_REORDER, {
            detail: { source, destination },
          });
          window.dispatchEvent(event);
        }
      }}
    >
      <Tabs
        value={resolvedActiveTab}
        onChange={(v) => setActiveTab(v)}
        keepMounted={false}
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          width: "100%",
          minHeight: 0,
          minWidth: 0,
        }}
      >
        <Box style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex" }}>
          {tabs.map((tab) => (
            <Tabs.Panel
              key={tab.value}
              value={tab.value}
              h="100%"
              w="100%"
              px={tab.type === "play" ? 0 : "md"}
              pb={tab.type === "play" ? 0 : "md"}
              pt={tab.type === "play" ? 0 : undefined}
              style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <TabSwitch tab={tab} />
            </Tabs.Panel>
          ))}
        </Box>
      </Tabs>
    </DragDropContext>
  );
}

interface WindowsState {
  currentNode: MosaicNode<ViewId> | null;
}

const windowsStateAtom = atomWithStorage<WindowsState>(STORAGE_KEYS.WINDOWS_STATE, {
  currentNode: DEFAULT_MOSAIC_LAYOUT,
});

function collectLeafIds(node: MosaicNode<ViewId>, acc: Set<string>): void {
  if (node == null) return;
  if (typeof node === "string") {
    acc.add(node);
    return;
  }
  collectLeafIds(node.first, acc);
  collectLeafIds(node.second, acc);
}

function isValidMosaicLayout(node: MosaicNode<ViewId> | null): node is MosaicNode<ViewId> {
  if (!node) return false;
  const leaves = new Set<string>();
  collectLeafIds(node, leaves);
  return leaves.has("left") && leaves.has("topRight") && leaves.has("bottomRight");
}

const TabSwitch = function TabSwitch({ tab }: { tab: Tab }) {
  const [windowsState, setWindowsState] = useAtom(windowsStateAtom);

  const { layout } = useResponsiveLayout();
  const isMobileLayout = layout.chessBoard.layoutType === "mobile";

  useEffect(() => {
    debugNavLog("tab-switch:mount", { tab: tab.value, type: tab.type, name: tab.name });
    return () => debugNavLog("tab-switch:unmount", { tab: tab.value, type: tab.type });
  }, [tab.name, tab.type, tab.value]);

  const resizeOptions = useMemo(
    () => ({
      minimumPaneSizePercentage: MOSAIC_PANE_CONSTRAINTS.MINIMUM_PERCENTAGE,
      maximumPaneSizePercentage: MOSAIC_PANE_CONSTRAINTS.MAXIMUM_PERCENTAGE,
    }),
    [],
  );

  const handleMosaicChange = useCallback(
    (currentNode: MosaicNode<ViewId> | null) => {
      if (currentNode && typeof currentNode === "object" && "direction" in currentNode) {
        if (currentNode.direction === "row") {
          const constrainedPercentage = constrainSplitPercentage(currentNode.splitPercentage);

          if (currentNode.splitPercentage !== constrainedPercentage) {
            currentNode = {
              ...currentNode,
              splitPercentage: constrainedPercentage,
            };
          }
        }
      }

      setWindowsState({ currentNode: currentNode ?? DEFAULT_MOSAIC_LAYOUT });
    },
    [setWindowsState],
  );

  useEffect(() => {
    if (isMobileLayout) return;
    if (isValidMosaicLayout(windowsState.currentNode)) return;
    debugNavLog("tab-switch: resetting invalid mosaic layout", { currentNode: windowsState.currentNode });
    setWindowsState({ currentNode: DEFAULT_MOSAIC_LAYOUT });
  }, [isMobileLayout, setWindowsState, windowsState.currentNode]);

  if (tab.type === "play") {
    return (
      <Box style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <TreeStateProvider id={tab.value}>
          <PlayVsEngineBoard />
        </TreeStateProvider>
      </Box>
    );
  }

  if (tab.type === "analysis" || tab.type === "new") {
    // Check if this is a variants file type
    const isVariantsFile = tab.source?.type === "file" && tab.source.metadata?.type === "variants";

    return (
      <Box style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <TreeStateProvider id={tab.value}>
          {!isMobileLayout && (
            <Box style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative" }}>
              <Mosaic<ViewId>
                renderTile={(id) => fullLayout[id]}
                value={isValidMosaicLayout(windowsState.currentNode) ? windowsState.currentNode : DEFAULT_MOSAIC_LAYOUT}
                onChange={handleMosaicChange}
                resize={resizeOptions}
              />
            </Box>
          )}
          {!isVariantsFile && <ReportProgressSubscriber id={`${REPORT_ID_PREFIX}${tab.value}`} />}
          {isVariantsFile ? <BoardVariants /> : <BoardAnalysis />}
        </TreeStateProvider>
      </Box>
    );
  }

  return match(tab.type)
    .with("puzzles", () => (
      <Box style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <TreeStateProvider id={tab.value}>
          <Puzzles id={tab.value} />
        </TreeStateProvider>
      </Box>
    ))
    .exhaustive();
};
