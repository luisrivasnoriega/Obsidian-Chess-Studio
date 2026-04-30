import type { CSSProperties, JSX } from "react";
import type { MosaicNode } from "react-mosaic-component";

export const MOSAIC_PORTAL_IDS = {
  LEFT: "left",
  TOP_RIGHT: "topRight",
  BOTTOM_RIGHT: "bottomRight",
} as const;

export type ViewId = "left" | "topRight" | "bottomRight";

export const MOSAIC_PANE_CONSTRAINTS = {
  MINIMUM_PERCENTAGE: 10,
  MAXIMUM_PERCENTAGE: 80,
  DEFAULT_SPLIT_PERCENTAGE: 52.5,
} as const;

export const MOSAIC_RIGHT_COLUMN_SPLIT = 55;

export const MAX_TABS = 10;

export const DROPPABLE_IDS = {
  TABS: "droppable",
  ENGINES: "engines-droppable",
} as const;

export const SCROLL_AREA_CONFIG = {
  SCROLLBAR_SIZE: 8,
} as const;

export const STORAGE_KEYS = {
  WINDOWS_STATE: "windowsState",
} as const;

export const DEFAULT_MOSAIC_LAYOUT: MosaicNode<ViewId> = {
  type: "split",
  direction: "row",
  children: [
    MOSAIC_PORTAL_IDS.LEFT as ViewId,
    {
      type: "split",
      direction: "column",
      children: [MOSAIC_PORTAL_IDS.TOP_RIGHT as ViewId, MOSAIC_PORTAL_IDS.BOTTOM_RIGHT as ViewId],
      splitPercentages: [MOSAIC_RIGHT_COLUMN_SPLIT, 100 - MOSAIC_RIGHT_COLUMN_SPLIT],
    },
  ],
  splitPercentages: [
    MOSAIC_PANE_CONSTRAINTS.DEFAULT_SPLIT_PERCENTAGE,
    100 - MOSAIC_PANE_CONSTRAINTS.DEFAULT_SPLIT_PERCENTAGE,
  ],
};

export const CUSTOM_EVENTS = {
  ENGINE_REORDER: "engineReorder",
} as const;

export const REPORT_ID_PREFIX = "report_";

export function createFullLayout(portalDomIds?: { left?: string; topRight?: string; bottomRight?: string }): {
  [viewId: string]: JSX.Element;
} {
  const portalTargetStyle: CSSProperties = {
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  };

  const leftId = portalDomIds?.left ?? MOSAIC_PORTAL_IDS.LEFT;
  const topRightId = portalDomIds?.topRight ?? MOSAIC_PORTAL_IDS.TOP_RIGHT;
  const bottomRightId = portalDomIds?.bottomRight ?? MOSAIC_PORTAL_IDS.BOTTOM_RIGHT;

  return {
    [MOSAIC_PORTAL_IDS.LEFT]: <div id={leftId} style={portalTargetStyle} />,
    [MOSAIC_PORTAL_IDS.TOP_RIGHT]: <div id={topRightId} style={portalTargetStyle} />,
    [MOSAIC_PORTAL_IDS.BOTTOM_RIGHT]: <div id={bottomRightId} style={portalTargetStyle} />,
  };
}

export function constrainSplitPercentage(splitPercentage?: number): number {
  const value = splitPercentage ?? MOSAIC_PANE_CONSTRAINTS.DEFAULT_SPLIT_PERCENTAGE;

  return Math.max(
    MOSAIC_PANE_CONSTRAINTS.MINIMUM_PERCENTAGE,
    Math.min(MOSAIC_PANE_CONSTRAINTS.MAXIMUM_PERCENTAGE, value),
  );
}
