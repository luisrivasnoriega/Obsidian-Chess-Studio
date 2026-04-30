import { DragDropContext } from "@hello-pangea/dnd";
import { Box, Tabs } from "@mantine/core";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { lazy, Suspense, useCallback, useEffect, useMemo } from "react";
import { isSplitNode, isTabsNode, Mosaic, type MosaicNode } from "react-mosaic-component";
import { match } from "ts-pattern";
import { debugNavLog } from "@/utils/debugNav";
import type { Tab } from "@/utils/tabs";

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

const ProfilesPage = lazy(() => import("@/features/profiles/ProfilesPage"));

export default function BoardsPage() {
  const { layout } = useResponsiveLayout();
  const isMobileLayout = layout.chessBoard.layoutType === "mobile";
  const { tabs, activeTab, setActiveTab } = useTabManagement({ enableHotkeys: false });

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
        keepMounted
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
          {tabs.map((tab) => {
            const panelPadding = isMobileLayout ? 0 : tab.type === "play" ? 0 : "md";
            const panelPaddingTop = isMobileLayout ? 0 : tab.type === "play" ? 0 : undefined;

            return (
              <Tabs.Panel
                key={tab.value}
                value={tab.value}
                h="100%"
                w="100%"
                px={panelPadding}
                pb={panelPadding}
                pt={panelPaddingTop}
                style={{
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                }}
              >
                <TabSwitch tab={tab} isActive={tab.value === resolvedActiveTab} />
              </Tabs.Panel>
            );
          })}
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
  if (isSplitNode(node)) {
    node.children.forEach((child) => {
      collectLeafIds(child, acc);
    });
    return;
  }
  if (isTabsNode(node)) {
    node.tabs.forEach((tab) => {
      acc.add(tab);
    });
  }
}

function isValidMosaicLayout(node: MosaicNode<ViewId> | null): node is MosaicNode<ViewId> {
  if (!node) return false;
  const leaves = new Set<string>();
  collectLeafIds(node, leaves);
  return leaves.has("left") && leaves.has("topRight") && leaves.has("bottomRight");
}

function sanitizeMosaicLayout(node: MosaicNode<ViewId>): MosaicNode<ViewId> {
  if (typeof node === "string") {
    return node;
  }

  if (isTabsNode(node)) {
    return {
      ...node,
      tabs: [...node.tabs],
    };
  }

  if (isSplitNode(node)) {
    const left = sanitizeMosaicLayout(node.children[0]);
    const right = sanitizeMosaicLayout(node.children[1]);
    const constrained = constrainSplitPercentage(node.splitPercentages?.[0]);
    return {
      ...node,
      children: [left, right],
      splitPercentages: [constrained, 100 - constrained],
    };
  }

  return node;
}

const TabSwitch = function TabSwitch({ tab, isActive }: { tab: Tab; isActive: boolean }) {
  const [windowsState, setWindowsState] = useAtom(windowsStateAtom);
  const portalDomIds = useMemo(() => {
    const safeTabId = tab.value.replace(/[^a-zA-Z0-9_-]/g, "");
    const prefix = `mosaic-${safeTabId}`;
    return {
      left: `${prefix}-left`,
      topRight: `${prefix}-topRight`,
      bottomRight: `${prefix}-bottomRight`,
    };
  }, [tab.value]);
  const fullLayout = useMemo(() => createFullLayout(portalDomIds), [portalDomIds]);
  const portalTargets = useMemo(
    () => ({
      left: `#${portalDomIds.left}`,
      topRight: `#${portalDomIds.topRight}`,
      bottomRight: `#${portalDomIds.bottomRight}`,
    }),
    [portalDomIds],
  );

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
      const nextNode = currentNode ? sanitizeMosaicLayout(currentNode) : DEFAULT_MOSAIC_LAYOUT;
      setWindowsState({ currentNode: nextNode });
    },
    [setWindowsState],
  );

  useEffect(() => {
    if (isMobileLayout) return;
    if (isValidMosaicLayout(windowsState.currentNode)) return;
    debugNavLog("tab-switch: resetting invalid mosaic layout", { currentNode: windowsState.currentNode });
    setWindowsState({ currentNode: DEFAULT_MOSAIC_LAYOUT });
  }, [isMobileLayout, setWindowsState, windowsState.currentNode]);

  const mosaicValue = useMemo(() => {
    if (!isValidMosaicLayout(windowsState.currentNode)) {
      return DEFAULT_MOSAIC_LAYOUT;
    }
    return sanitizeMosaicLayout(windowsState.currentNode);
  }, [windowsState.currentNode]);

  const keepMountedWhenInactive = tab.type === "profiles";
  if (!isActive && !keepMountedWhenInactive) {
    return null;
  }

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
          {!isMobileLayout && !isVariantsFile && (
            <Box style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative" }}>
              <Mosaic<ViewId>
                renderTile={(id) => fullLayout[id]}
                value={mosaicValue}
                onChange={handleMosaicChange}
                resize={resizeOptions}
              />
            </Box>
          )}
          {!isVariantsFile && <ReportProgressSubscriber id={`${REPORT_ID_PREFIX}${tab.value}`} />}
          {isVariantsFile ? <BoardVariants /> : <BoardAnalysis portalTargets={portalTargets} />}
        </TreeStateProvider>
      </Box>
    );
  }

  if (tab.type === "profiles") {
    return (
      <Box style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Suspense fallback={<div>Loading...</div>}>
          <ProfilesPage />
        </Suspense>
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
    .with("database", () => <Box />)
    .with("route", () => <Box />)
    .exhaustive();
};
