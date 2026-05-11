import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useRef, useState } from "react";
import type { VariantsDesktopPanel } from "./types";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function useVariantsDesktopLayoutState() {
  const [collapsedDesktopPanels, setCollapsedDesktopPanels] = useState({
    pgn: false,
    analysis: false,
    database: false,
  });
  const [mainLeftSplit, setMainLeftSplit] = useState(44);
  const [mainCenterSplit, setMainCenterSplit] = useState(22);
  const [rightColumnSplit, setRightColumnSplit] = useState(50);
  const desktopRootRef = useRef<HTMLDivElement | null>(null);
  const rightColumnRef = useRef<HTMLDivElement | null>(null);

  const toggleDesktopPanel = useCallback((panel: VariantsDesktopPanel) => {
    setCollapsedDesktopPanels((prev) => ({ ...prev, [panel]: !prev[panel] }));
  }, []);

  const setDesktopPanelCollapsed = useCallback((panel: VariantsDesktopPanel, collapsed: boolean) => {
    setCollapsedDesktopPanels((prev) => ({ ...prev, [panel]: collapsed }));
  }, []);

  const startResizeDrag = useCallback(
    (
      event: ReactMouseEvent<HTMLElement>,
      axis: "x" | "y",
      container: HTMLElement | null,
      onDeltaPercent: (deltaPercent: number) => void,
    ) => {
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const size = axis === "x" ? rect.width : rect.height;
      if (!Number.isFinite(size) || size <= 0) return;

      event.preventDefault();
      const startPos = axis === "x" ? event.clientX : event.clientY;
      const startCursor = document.body.style.cursor;
      const startUserSelect = document.body.style.userSelect;

      document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";

      const handleMove = (moveEvent: MouseEvent) => {
        const currentPos = axis === "x" ? moveEvent.clientX : moveEvent.clientY;
        const deltaPercent = ((currentPos - startPos) / size) * 100;
        onDeltaPercent(deltaPercent);
      };

      const handleUp = () => {
        document.removeEventListener("mousemove", handleMove);
        document.body.style.cursor = startCursor;
        document.body.style.userSelect = startUserSelect;
      };

      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp, { once: true });
    },
    [],
  );

  const handleMainLeftResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const rightColumnCollapsed = collapsedDesktopPanels.analysis && collapsedDesktopPanels.database;

      if (collapsedDesktopPanels.pgn) {
        if (rightColumnCollapsed) return;

        const startLeft = mainLeftSplit;
        const startRight = 100 - mainLeftSplit - mainCenterSplit;
        const minLeft = 24;
        const minRight = 22;

        startResizeDrag(event, "x", desktopRootRef.current, (deltaPercent) => {
          const minDelta = minLeft - startLeft;
          const maxDelta = startRight - minRight;
          const safeDelta = clamp(deltaPercent, minDelta, maxDelta);
          setMainLeftSplit(startLeft + safeDelta);
        });
        return;
      }

      const startLeft = mainLeftSplit;
      const startCenter = mainCenterSplit;
      const minLeft = 24;
      const minCenter = 14;

      startResizeDrag(event, "x", desktopRootRef.current, (deltaPercent) => {
        const minDelta = minLeft - startLeft;
        const maxDelta = startCenter - minCenter;
        const safeDelta = clamp(deltaPercent, minDelta, maxDelta);
        setMainLeftSplit(startLeft + safeDelta);
        setMainCenterSplit(startCenter - safeDelta);
      });
    },
    [
      collapsedDesktopPanels.analysis,
      collapsedDesktopPanels.database,
      collapsedDesktopPanels.pgn,
      mainCenterSplit,
      mainLeftSplit,
      startResizeDrag,
    ],
  );

  const handleMainRightResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const rightColumnCollapsed = collapsedDesktopPanels.analysis && collapsedDesktopPanels.database;
      if (collapsedDesktopPanels.pgn || rightColumnCollapsed) return;

      const startCenter = mainCenterSplit;
      const startRight = 100 - mainLeftSplit - mainCenterSplit;
      const minCenter = 14;
      const minRight = 22;

      startResizeDrag(event, "x", desktopRootRef.current, (deltaPercent) => {
        const minDelta = minCenter - startCenter;
        const maxDelta = startRight - minRight;
        const safeDelta = clamp(deltaPercent, minDelta, maxDelta);
        setMainCenterSplit(startCenter + safeDelta);
      });
    },
    [
      collapsedDesktopPanels.analysis,
      collapsedDesktopPanels.database,
      collapsedDesktopPanels.pgn,
      mainCenterSplit,
      mainLeftSplit,
      startResizeDrag,
    ],
  );

  const handleRightVerticalResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (collapsedDesktopPanels.analysis || collapsedDesktopPanels.database) return;

      const startTop = rightColumnSplit;
      const startBottom = 100 - startTop;
      const minTop = 26;
      const minBottom = 20;

      startResizeDrag(event, "y", rightColumnRef.current, (deltaPercent) => {
        const minDelta = minTop - startTop;
        const maxDelta = startBottom - minBottom;
        const safeDelta = clamp(deltaPercent, minDelta, maxDelta);
        setRightColumnSplit(startTop + safeDelta);
      });
    },
    [collapsedDesktopPanels.analysis, collapsedDesktopPanels.database, rightColumnSplit, startResizeDrag],
  );

  const rightColumnCollapsed = collapsedDesktopPanels.analysis && collapsedDesktopPanels.database;
  const showCenterColumn = !collapsedDesktopPanels.pgn;
  const showRightColumn = !rightColumnCollapsed;

  const baseLeftSplit = mainLeftSplit;
  const baseCenterSplit = mainCenterSplit;
  const baseRightSplit = 100 - mainLeftSplit - mainCenterSplit;
  const totalVisibleMainSplit =
    baseLeftSplit + (showCenterColumn ? baseCenterSplit : 0) + (showRightColumn ? baseRightSplit : 0);

  const effectiveLeftSplit = totalVisibleMainSplit > 0 ? (baseLeftSplit / totalVisibleMainSplit) * 100 : 100;
  const effectiveCenterSplit =
    showCenterColumn && totalVisibleMainSplit > 0 ? (baseCenterSplit / totalVisibleMainSplit) * 100 : 0;
  const effectiveRightSplit =
    showRightColumn && totalVisibleMainSplit > 0 ? (baseRightSplit / totalVisibleMainSplit) * 100 : 0;

  const verticalHandleStyle: CSSProperties = {
    flex: "0 0 8px",
    minHeight: 0,
    minWidth: 8,
    borderRadius: 999,
    background: "transparent",
    cursor: "col-resize",
  };
  const horizontalHandleStyle: CSSProperties = {
    minWidth: 0,
    height: 8,
    borderRadius: 999,
    background: "transparent",
    cursor: "row-resize",
  };

  return {
    collapsedDesktopPanels,
    desktopRootRef,
    rightColumnRef,
    toggleDesktopPanel,
    setDesktopPanelCollapsed,
    handleMainLeftResize,
    handleMainRightResize,
    handleRightVerticalResize,
    showCenterColumn,
    showRightColumn,
    effectiveLeftSplit,
    effectiveCenterSplit,
    effectiveRightSplit,
    rightTopSplit: rightColumnSplit,
    verticalHandleStyle,
    horizontalHandleStyle,
  };
}

export type VariantsDesktopLayoutState = ReturnType<typeof useVariantsDesktopLayoutState>;
