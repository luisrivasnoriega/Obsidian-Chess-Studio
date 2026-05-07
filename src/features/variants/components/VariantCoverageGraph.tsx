import { ActionIcon, Paper, Tooltip } from "@mantine/core";
import { IconFocus } from "@tabler/icons-react";
import { type HierarchyPointLink, type HierarchyPointNode, hierarchy, tree } from "d3-hierarchy";
import { select } from "d3-selection";
import { linkHorizontal } from "d3-shape";
import "d3-transition";
import { type ZoomBehavior, zoom, zoomIdentity } from "d3-zoom";
import { useEffect, useId, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { premiumPanelStyle } from "@/styles/premiumSurface";

export type CoverageTier = "root" | "mainline" | "secondary" | "alternative";

export type CoverageGraphNode = {
  id: string;
  label: string;
  openingName?: string | null;
  transpositionLabels?: string[];
  tier: CoverageTier;
  percent?: number;
  responsePercent?: number;
  responseRarity?: "low_frequency" | "novelty";
  fen?: string | null;
  overrideKey?: string;
  activeMovesUsed?: number;
  lowSample?: boolean;
  unmappedResponse?: boolean;
  collapsed?: boolean;
  hiddenChildrenCount?: number;
  activeWinRate?: number | null;
  activeLossRate?: number | null;
  profileWinRate?: number | null;
  profileLossRate?: number | null;
  engineAdvantage?: string | null;
  engineMs?: number | null;
  engineName?: string | null;
  children: CoverageGraphNode[];
};

export const COVERAGE_TIER_COLORS: Record<CoverageTier, string> = {
  root: "#3b82f6",
  mainline: "#3b82f6",
  secondary: "#15803d",
  alternative: "#dc2626",
};
export const COVERAGE_UNMAPPED_COLOR = "#facc15";

const DIMS = {
  nodeWidth: 760,
  nodeHeight: 440,
  nodeSpacing: [525, 940] as [number, number],
  borderRadius: 20,
  strokeWidth: { link: 2.2, node: 1.2 },
  scale: 0.5,
  transitionDuration: 550,
};

type CoverageVisualKey = CoverageTier | "unmapped";

const NODE_VISUALS: Record<
  CoverageVisualKey,
  {
    start: string;
    end: string;
    badgeStart: string;
    badgeEnd: string;
    accent: string;
    border: string;
    shadow: string;
  }
> = {
  root: {
    start: "#0f2f6f",
    end: "#020817",
    badgeStart: "#2563eb",
    badgeEnd: "#0891b2",
    accent: "#60a5fa",
    border: "rgba(147, 197, 253, 0.56)",
    shadow: "rgba(37, 99, 235, 0.14)",
  },
  mainline: {
    start: "#0f2f6f",
    end: "#020817",
    badgeStart: "#2563eb",
    badgeEnd: "#0891b2",
    accent: "#60a5fa",
    border: "rgba(147, 197, 253, 0.56)",
    shadow: "rgba(37, 99, 235, 0.14)",
  },
  secondary: {
    start: "#075f45",
    end: "#03251d",
    badgeStart: "#10b981",
    badgeEnd: "#047857",
    accent: "#34d399",
    border: "rgba(110, 231, 183, 0.62)",
    shadow: "rgba(16, 185, 129, 0.16)",
  },
  alternative: {
    start: "#7f1d1d",
    end: "#2a0707",
    badgeStart: "#ef4444",
    badgeEnd: "#991b1b",
    accent: "#f87171",
    border: "rgba(252, 165, 165, 0.66)",
    shadow: "rgba(239, 68, 68, 0.17)",
  },
  unmapped: {
    start: "#5a4610",
    end: "#020817",
    badgeStart: "#facc15",
    badgeEnd: "#ca8a04",
    accent: "#fde047",
    border: "rgba(254, 249, 195, 0.72)",
    shadow: "rgba(202, 138, 4, 0.12)",
  },
};

type NodeWithMeta = HierarchyPointNode<CoverageGraphNode> & { nodeId: string };
type RenderedNode = {
  mergeKey: string;
  hierarchyNode: NodeWithMeta;
  transpositionLabels: string[];
  x: number;
  y: number;
};
type RenderedLink = {
  source: RenderedNode;
  target: RenderedNode;
};

type VariantCoverageGraphProps = {
  root: CoverageGraphNode | null;
  onNodeClick?: (node: CoverageGraphNode) => void;
  onNodeToggleCollapse?: (node: CoverageGraphNode) => void;
  onNodeExpandAllChildren?: (node: CoverageGraphNode) => void;
};

function edgeColor(target: CoverageGraphNode): string {
  if (target.unmappedResponse) return COVERAGE_UNMAPPED_COLOR;
  return COVERAGE_TIER_COLORS[target.tier] ?? "#64748b";
}

function getNodeVisualKey(node: CoverageGraphNode): CoverageVisualKey {
  return node.unmappedResponse ? "unmapped" : node.tier;
}

function truncateSvgText(value: string, maxLength: number): string {
  const text = `${value ?? ""}`.trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function parseCoverageLabel(node: CoverageGraphNode): {
  headline: string;
  coverage: string;
} {
  const rawLabel = `${node.label ?? ""}`.trim();
  const [rawMain = rawLabel, rawRight = ""] = rawLabel.split("|").map((part) => part.trim());
  const embeddedPercent = rawRight.match(/[0-9]+(?:\.[0-9]+)?%/)?.[0];
  const trailingPercent = rawMain.match(/\b([0-9]+(?:\.[0-9]+)?%)\b/)?.[1];
  const coverage = hasFiniteNumber(node.percent)
    ? formatPercent(node.percent)
    : embeddedPercent || trailingPercent || "--";
  const headline =
    rawMain
      .replace(/\b[0-9]+(?:\.[0-9]+)?%\b/g, "")
      .replace(/\s+-\s+$/g, "")
      .trim() ||
    rawLabel ||
    "--";

  return {
    headline: truncateSvgText(headline, 12),
    coverage,
  };
}

function splitOpeningName(openingName?: string | null): { eco: string; name: string } {
  const text = `${openingName ?? ""}`.trim();
  if (!text) return { eco: "--", name: "" };
  const match = text.match(/^([A-E][0-9]{2}[A-Z]?)\s+(.+)$/);
  if (!match) return { eco: "--", name: text };
  return { eco: match[1], name: match[2] };
}

function formatRateValue(value: number | null | undefined): string {
  if (!hasFiniteNumber(value)) return "--";
  return formatPercent(value);
}

function formatWinLossRates(winRate: number | null | undefined, lossRate: number | null | undefined): string {
  if (!hasFiniteNumber(winRate) || !hasFiniteNumber(lossRate)) return "W -- / L --";
  return `W ${formatRateValue(winRate)} / L ${formatRateValue(lossRate)}`;
}

function getTierLabelKey(node: CoverageGraphNode): string {
  if (node.unmappedResponse) return "features.board.variants.coverageTierUnmappedCard";
  if (node.tier === "root") return "features.board.variants.coverageTierRootCard";
  if (node.tier === "mainline") return "features.board.variants.coverageTierMainLineCard";
  if (node.tier === "secondary") return "features.board.variants.coverageTierSecondaryCard";
  return "features.board.variants.coverageTierAlternativeCard";
}

function getTierLabelDefault(node: CoverageGraphNode): string {
  if (node.unmappedResponse) return "NO RESPONSE";
  if (node.tier === "root") return "ROOT";
  if (node.tier === "mainline") return "MAIN LINE";
  if (node.tier === "secondary") return "SECONDARY";
  return "ALTERNATIVE";
}

function estimateBadgeWidth(label: string): number {
  return Math.max(76, Math.min(136, label.length * 7 + 30));
}

function buildCoverageCardSubtitle(
  node: CoverageGraphNode,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (node.unmappedResponse) {
    return t("features.board.variants.coverageCardSubtitleNoResponse", {
      defaultValue: "No prepared response is mapped for this branch.",
    });
  }

  const hiddenCount = node.hiddenChildrenCount ?? 0;
  if (node.collapsed && hiddenCount > 0) {
    return t("features.board.variants.coverageCardSubtitleHiddenReplies", {
      defaultValue: "{{count}} hidden replies in this branch.",
      count: hiddenCount,
    });
  }

  if (node.responseRarity === "novelty") {
    return t("features.board.variants.coverageCardSubtitleNovelty", {
      defaultValue: "Novelty-level reply in the selected time controls.",
    });
  }

  if (node.responseRarity === "low_frequency") {
    return t("features.board.variants.coverageCardSubtitleRare", {
      defaultValue: "Rare reply in the selected time controls.",
    });
  }

  if (node.lowSample) {
    return t("features.board.variants.coverageCardSubtitleLowSample", {
      defaultValue: "Low sample size for this position.",
    });
  }

  if (hasFiniteNumber(node.percent)) {
    const coverage = formatPercent(node.percent);
    if (node.tier === "root") {
      return t("features.board.variants.coverageCardSubtitleRootCoverage", {
        defaultValue: "Root position for {{coverage}} of selected time controls.",
        coverage,
      });
    }

    if (node.tier === "mainline") {
      return t("features.board.variants.coverageCardSubtitleMainLineCoverage", {
        defaultValue: "Main-line branch with {{coverage}} time-control coverage.",
        coverage,
      });
    }

    if (node.tier === "secondary") {
      return t("features.board.variants.coverageCardSubtitleSecondaryCoverage", {
        defaultValue: "Secondary response covering {{coverage}} of time-control games.",
        coverage,
      });
    }

    return t("features.board.variants.coverageCardSubtitleAlternativeCoverage", {
      defaultValue: "Alternative response found in {{coverage}} of time-control games.",
      coverage,
    });
  }

  if (hasFiniteNumber(node.activeMovesUsed)) {
    return t("features.board.variants.coverageCardSubtitleDepth", {
      defaultValue: "Depth {{depth}} in the active repertoire.",
      depth: node.activeMovesUsed,
    });
  }

  return t("features.board.variants.coverageCardSubtitlePosition", {
    defaultValue: "Position summary from selected time controls.",
  });
}

function mergeCoverageAndForcedLabel(coverageLabel: string, forcedLabel: string): string {
  const forcedPrimary = forcedLabel.split("|")[0]?.split("->")[0]?.split(" - ")[0]?.trim();
  const match = coverageLabel.match(/^(.*?)\s+([0-9]+(?:\.[0-9]+)?%)\s*(?:-\s*(.+))?$/);
  if (!match) {
    return forcedPrimary ? `${coverageLabel}, ${forcedPrimary}` : coverageLabel;
  }

  const [, moveSan, percent] = match;
  if (!forcedPrimary) {
    return `${moveSan} | ${percent}`;
  }
  return `${moveSan}, ${forcedPrimary} | ${percent}`;
}

function computeResponseRarity(percent: number | undefined): "low_frequency" | "novelty" | undefined {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  if (percent < 5) return "novelty";
  if (percent < 20) return "low_frequency";
  return undefined;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "--";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
}

function hasFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeFenForMergeKey(fen?: string | null): string | null {
  const text = `${fen ?? ""}`.trim();
  if (!text) return null;
  const parts = text.split(/\s+/);
  const board = (parts[0] ?? "").trim().toLowerCase();
  if (!board) return null;
  const turn = (parts[1] ?? "w").trim().toLowerCase();
  const castling = (parts[2] ?? "-").trim().toLowerCase();
  const ep = (parts[3] ?? "-").trim().toLowerCase();
  return `${board} ${turn} ${castling} ${ep}`;
}

function buildMergeKey(node: CoverageGraphNode): string {
  const fenKey = normalizeFenForMergeKey(node.fen);
  if (fenKey) return `fen:${fenKey}`;
  const override = `${node.overrideKey ?? ""}`.trim();
  if (override) return `override:${override.toLowerCase()}`;
  return `id:${node.id}`;
}

function extractTranspositionLabel(label: string): string | null {
  const text = `${label ?? ""}`.trim();
  if (!text) return null;
  const left = (text.split("|")[0] ?? text).trim();
  if (!left) return null;
  const withoutVariantSuffix = (left.split(" - ")[0] ?? left).trim();
  return withoutVariantSuffix || null;
}

function buildRenderedDag(root: HierarchyPointNode<CoverageGraphNode>): {
  nodes: RenderedNode[];
  links: RenderedLink[];
  outgoingCount: Map<string, number>;
} {
  const descendants = root.descendants() as NodeWithMeta[];
  const treeLinks = root.links() as Array<HierarchyPointLink<CoverageGraphNode>>;
  const canonicalByKey = new Map<string, NodeWithMeta>();
  const keyByNodeId = new Map<string, string>();
  const transpositionSetsByKey = new Map<string, Set<string>>();

  for (const node of descendants) {
    const mergeKey = buildMergeKey(node.data);
    keyByNodeId.set(node.data.id, mergeKey);
    if (!canonicalByKey.has(mergeKey)) {
      canonicalByKey.set(mergeKey, node);
    }

    const transition = extractTranspositionLabel(node.data.label);
    if (transition && node.data.tier !== "root") {
      const set = transpositionSetsByKey.get(mergeKey) ?? new Set<string>();
      set.add(transition);
      transpositionSetsByKey.set(mergeKey, set);
    }
  }

  const renderedByKey = new Map<string, RenderedNode>();
  for (const [mergeKey, hierarchyNode] of canonicalByKey.entries()) {
    const transpositionLabels = Array.from(transpositionSetsByKey.get(mergeKey) ?? []);
    hierarchyNode.data.transpositionLabels = transpositionLabels;
    renderedByKey.set(mergeKey, {
      mergeKey,
      hierarchyNode,
      transpositionLabels,
      x: hierarchyNode.x,
      y: hierarchyNode.y,
    });
  }

  const links: RenderedLink[] = [];
  const linkKeySet = new Set<string>();
  const outgoingCount = new Map<string, number>();
  for (const link of treeLinks) {
    const sourceKey = keyByNodeId.get(link.source.data.id);
    const targetKey = keyByNodeId.get(link.target.data.id);
    if (!sourceKey || !targetKey || sourceKey === targetKey) continue;
    const dedupeKey = `${sourceKey}->${targetKey}`;
    if (linkKeySet.has(dedupeKey)) continue;
    linkKeySet.add(dedupeKey);

    const source = renderedByKey.get(sourceKey);
    const target = renderedByKey.get(targetKey);
    if (!source || !target) continue;
    links.push({ source, target });
    outgoingCount.set(sourceKey, (outgoingCount.get(sourceKey) ?? 0) + 1);
  }

  return {
    nodes: Array.from(renderedByKey.values()),
    links,
    outgoingCount,
  };
}

function normalizeCoverageNode(node: CoverageGraphNode): CoverageGraphNode | null {
  const normalizedChildren = node.children
    .map(normalizeCoverageNode)
    .filter((child): child is CoverageGraphNode => child !== null);

  const normalizedNode: CoverageGraphNode = {
    ...node,
    children: normalizedChildren,
  };

  if (normalizedNode.tier !== "root") {
    const forcedReply =
      normalizedChildren.length === 1 && normalizedChildren[0].tier === "root" ? normalizedChildren[0] : null;

    if (normalizedNode.collapsed === true) {
      if (forcedReply) {
        const responseRarity = computeResponseRarity(forcedReply.percent);
        return {
          ...normalizedNode,
          label: mergeCoverageAndForcedLabel(normalizedNode.label, forcedReply.label),
          responsePercent: forcedReply.percent,
          responseRarity,
          fen: forcedReply.fen ?? normalizedNode.fen,
          openingName: forcedReply.openingName ?? normalizedNode.openingName,
          activeWinRate: forcedReply.activeWinRate,
          activeLossRate: forcedReply.activeLossRate,
          profileWinRate: forcedReply.profileWinRate,
          profileLossRate: forcedReply.profileLossRate,
          engineAdvantage: forcedReply.engineAdvantage,
          engineName: forcedReply.engineName,
          engineMs: forcedReply.engineMs,
          unmappedResponse: false,
          hiddenChildrenCount: forcedReply.children.length,
          children: [],
        };
      }

      return {
        ...normalizedNode,
        unmappedResponse: false,
        children: [],
      };
    }

    // Keep previous visibility rule: hide unmapped ALTERNATIVE nodes.
    if (normalizedNode.tier === "alternative" && !forcedReply) {
      return null;
    }

    if (forcedReply) {
      const responseRarity = computeResponseRarity(forcedReply.percent);
      return {
        ...normalizedNode,
        label: mergeCoverageAndForcedLabel(normalizedNode.label, forcedReply.label),
        responsePercent: forcedReply.percent,
        responseRarity,
        fen: forcedReply.fen ?? normalizedNode.fen,
        openingName: forcedReply.openingName ?? normalizedNode.openingName,
        activeWinRate: forcedReply.activeWinRate,
        activeLossRate: forcedReply.activeLossRate,
        profileWinRate: forcedReply.profileWinRate,
        profileLossRate: forcedReply.profileLossRate,
        engineAdvantage: forcedReply.engineAdvantage,
        engineName: forcedReply.engineName,
        engineMs: forcedReply.engineMs,
        unmappedResponse: false,
        children: forcedReply.children,
      };
    }

    return {
      ...normalizedNode,
      unmappedResponse: true,
      children: normalizedChildren,
    };
  }

  return normalizedNode;
}

export function VariantCoverageGraph({
  root,
  onNodeClick,
  onNodeToggleCollapse,
  onNodeExpandAllChildren,
}: VariantCoverageGraphProps) {
  const { t } = useTranslation();
  const svgIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const hierarchyRef = useRef<HierarchyPointNode<CoverageGraphNode> | null>(null);
  const lastTransformRef = useRef<any>(null);
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visualRoot = useMemo(() => {
    const normalized = root ? normalizeCoverageNode(root) : null;
    if (!normalized) return null;

    // Drop synthetic variant-title root when it only wraps the first move/prelude node.
    if (normalized.tier === "root" && normalized.children.length === 1 && normalized.children[0].tier === "root") {
      return normalized.children[0];
    }

    return normalized;
  }, [root]);

  const centerGraph = () => {
    if (!svgRef.current || !zoomRef.current || !hierarchyRef.current) return;
    const svg = select(svgRef.current);
    const node = svg.node();
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    const transform = zoomIdentity
      .translate(width / 2 - hierarchyRef.current.y * DIMS.scale, height / 2 - hierarchyRef.current.x * DIMS.scale)
      .scale(DIMS.scale);
    svg.transition().duration(DIMS.transitionDuration).call(zoomRef.current.transform, transform);
  };

  useEffect(() => {
    if (!svgRef.current || !visualRoot) return;

    const svg = select(svgRef.current);
    svg.selectAll("*").remove();
    svg.style("background", "transparent");

    const node = svg.node();
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();

    const gridPatternId = `${svgIdPrefix}-coverage-grid`;
    const nodeGlowFilterId = `${svgIdPrefix}-coverage-node-glow`;
    const nodeShadowFilterId = `${svgIdPrefix}-coverage-node-shadow`;
    const linkGlowFilterId = `${svgIdPrefix}-coverage-link-glow`;
    const nodeSheenGradientId = `${svgIdPrefix}-coverage-node-sheen`;
    const nodeRightGlowGradientId = `${svgIdPrefix}-coverage-node-right-glow`;
    const gradientIds: Record<CoverageVisualKey, string> = {
      root: `${svgIdPrefix}-coverage-node-root`,
      mainline: `${svgIdPrefix}-coverage-node-mainline`,
      secondary: `${svgIdPrefix}-coverage-node-secondary`,
      alternative: `${svgIdPrefix}-coverage-node-alternative`,
      unmapped: `${svgIdPrefix}-coverage-node-unmapped`,
    };
    const badgeGradientIds: Record<CoverageVisualKey, string> = {
      root: `${svgIdPrefix}-coverage-badge-root`,
      mainline: `${svgIdPrefix}-coverage-badge-mainline`,
      secondary: `${svgIdPrefix}-coverage-badge-secondary`,
      alternative: `${svgIdPrefix}-coverage-badge-alternative`,
      unmapped: `${svgIdPrefix}-coverage-badge-unmapped`,
    };

    const defs = svg.append("defs");
    const gridPattern = defs
      .append("pattern")
      .attr("id", gridPatternId)
      .attr("width", 44)
      .attr("height", 44)
      .attr("patternUnits", "userSpaceOnUse");
    gridPattern
      .append("path")
      .attr("d", "M 44 0 L 0 0 0 44")
      .attr("fill", "none")
      .attr("stroke", "rgba(148, 163, 184, 0.1)")
      .attr("stroke-width", 1);
    gridPattern
      .append("path")
      .attr("d", "M 22 0 L 22 44 M 0 22 L 44 22")
      .attr("fill", "none")
      .attr("stroke", "rgba(148, 163, 184, 0.05)")
      .attr("stroke-width", 1);

    defs
      .append("filter")
      .attr("id", nodeGlowFilterId)
      .attr("x", "-30%")
      .attr("y", "-45%")
      .attr("width", "160%")
      .attr("height", "190%")
      .append("feGaussianBlur")
      .attr("stdDeviation", 5);

    defs
      .append("filter")
      .attr("id", nodeShadowFilterId)
      .attr("x", "-25%")
      .attr("y", "-35%")
      .attr("width", "150%")
      .attr("height", "170%")
      .append("feDropShadow")
      .attr("dx", 0)
      .attr("dy", 8)
      .attr("stdDeviation", 5)
      .attr("flood-color", "#020617")
      .attr("flood-opacity", 0.2);

    defs
      .append("filter")
      .attr("id", linkGlowFilterId)
      .attr("x", "-15%")
      .attr("y", "-30%")
      .attr("width", "130%")
      .attr("height", "160%")
      .append("feGaussianBlur")
      .attr("stdDeviation", 1.6);

    for (const [visualKey, visual] of Object.entries(NODE_VISUALS) as Array<
      [CoverageVisualKey, (typeof NODE_VISUALS)[CoverageVisualKey]]
    >) {
      const gradient = defs
        .append("linearGradient")
        .attr("id", gradientIds[visualKey])
        .attr("x1", "0%")
        .attr("y1", "0%")
        .attr("x2", "0%")
        .attr("y2", "100%");
      gradient.append("stop").attr("offset", "0%").attr("stop-color", visual.start);
      gradient.append("stop").attr("offset", "72%").attr("stop-color", visual.end);
      gradient.append("stop").attr("offset", "100%").attr("stop-color", visual.end);

      const badgeGradient = defs
        .append("linearGradient")
        .attr("id", badgeGradientIds[visualKey])
        .attr("x1", "0%")
        .attr("y1", "0%")
        .attr("x2", "100%")
        .attr("y2", "100%");
      badgeGradient.append("stop").attr("offset", "0%").attr("stop-color", visual.badgeStart);
      badgeGradient.append("stop").attr("offset", "100%").attr("stop-color", visual.badgeEnd);
    }

    const nodeSheen = defs
      .append("linearGradient")
      .attr("id", nodeSheenGradientId)
      .attr("x1", "0%")
      .attr("y1", "0%")
      .attr("x2", "0%")
      .attr("y2", "100%");
    nodeSheen.append("stop").attr("offset", "0%").attr("stop-color", "#ffffff").attr("stop-opacity", 0.08);
    nodeSheen.append("stop").attr("offset", "36%").attr("stop-color", "#ffffff").attr("stop-opacity", 0.02);
    nodeSheen.append("stop").attr("offset", "100%").attr("stop-color", "#ffffff").attr("stop-opacity", 0);

    const nodeRightGlow = defs
      .append("radialGradient")
      .attr("id", nodeRightGlowGradientId)
      .attr("cx", "82%")
      .attr("cy", "22%")
      .attr("r", "74%");
    nodeRightGlow.append("stop").attr("offset", "0%").attr("stop-color", "#2563eb").attr("stop-opacity", 0.12);
    nodeRightGlow.append("stop").attr("offset", "52%").attr("stop-color", "#2563eb").attr("stop-opacity", 0.04);
    nodeRightGlow.append("stop").attr("offset", "100%").attr("stop-color", "#020617").attr("stop-opacity", 0);

    svg
      .append("rect")
      .attr("width", "100%")
      .attr("height", "100%")
      .attr("fill", `url(#${gridPatternId})`)
      .attr("opacity", 0.32)
      .style("pointer-events", "none");

    const g = svg.append("g");
    const hierarchyRoot = hierarchy(visualRoot, (d) => d.children);
    const treeRoot = tree<CoverageGraphNode>().nodeSize(DIMS.nodeSpacing)(hierarchyRoot);
    hierarchyRef.current = treeRoot;
    const renderedDag = buildRenderedDag(treeRoot);

    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .filter((event) => {
        if (event.type === "wheel") return true;
        const target = event.target as Element | null;
        return !target?.closest("g[data-node]");
      })
      .on("zoom", (event) => {
        lastTransformRef.current = event.transform;
        g.attr("transform", event.transform);
      });
    zoomRef.current = zoomBehavior;
    svg.call(zoomBehavior);

    if (lastTransformRef.current) {
      svg.call(zoomBehavior.transform, lastTransformRef.current);
    } else {
      const initialTransform = zoomIdentity
        .translate(width / 2 - treeRoot.y * DIMS.scale, height / 2 - treeRoot.x * DIMS.scale)
        .scale(DIMS.scale);
      svg.transition().duration(DIMS.transitionDuration).call(zoomBehavior.transform, initialTransform);
    }

    const linkGenerator = linkHorizontal<RenderedLink, RenderedNode>()
      .x((d) => d.y)
      .y((d) => d.x);

    const renderedLinks = renderedDag.links.map((link) => ({
      ...link,
      source: {
        ...link.source,
        x: link.source.hierarchyNode.x,
        y: link.source.hierarchyNode.y,
      },
      target: {
        ...link.target,
        x: link.target.hierarchyNode.x,
        y: link.target.hierarchyNode.y,
      },
    }));

    const linksLayer = g.append("g").attr("data-layer", "links").style("pointer-events", "none");

    linksLayer
      .append("g")
      .selectAll("path")
      .data(renderedLinks)
      .join("path")
      .attr("fill", "none")
      .attr("stroke", (d) => edgeColor(d.target.hierarchyNode.data))
      .attr("stroke-width", DIMS.strokeWidth.link + 4)
      .attr("stroke-linecap", "round")
      .attr("stroke-linejoin", "round")
      .attr("opacity", 0.12)
      .attr("filter", `url(#${linkGlowFilterId})`)
      .attr("d", linkGenerator as any);

    linksLayer
      .append("g")
      .selectAll("path")
      .data(renderedLinks)
      .join("path")
      .attr("fill", "none")
      .attr("stroke", (d) => edgeColor(d.target.hierarchyNode.data))
      .attr("stroke-width", DIMS.strokeWidth.link)
      .attr("stroke-linecap", "round")
      .attr("stroke-linejoin", "round")
      .attr("opacity", 0.7)
      .attr("d", linkGenerator as any);

    const nodes = g
      .append("g")
      .selectAll("g")
      .data(renderedDag.nodes)
      .join("g")
      .attr("transform", (d) => `translate(${d.hierarchyNode.y},${d.hierarchyNode.x})`)
      .attr("data-node", "true")
      .style("cursor", () => (onNodeClick ? "pointer" : "default"));

    const collapsibleNodes = nodes.filter((d) => {
      const nodeData = d.hierarchyNode.data;
      if (nodeData.tier === "root") return false;
      if (nodeData.children.length === 0 && (nodeData.hiddenChildrenCount ?? 0) <= 0) return false;
      const visibleChildren = renderedDag.outgoingCount.get(d.mergeKey) ?? 0;
      const hiddenChildren = nodeData.hiddenChildrenCount ?? 0;
      return visibleChildren > 0 || hiddenChildren > 0 || nodeData.collapsed === true;
    });

    nodes.each(function (d) {
      if (!(this instanceof SVGGElement)) return;
      const nodeData = d.hierarchyNode.data;
      const visualKey = getNodeVisualKey(nodeData);
      const visual = NODE_VISUALS[visualKey];
      const nodeGroup = select(this);
      const x = -DIMS.nodeWidth / 2;
      const y = -DIMS.nodeHeight / 2;
      const cardWidth = DIMS.nodeWidth;
      const cardHeight = DIMS.nodeHeight;
      const parsedLabel = parseCoverageLabel(nodeData);
      const opening = splitOpeningName(nodeData.openingName);
      const openingTitle = opening.name
        ? `${opening.eco !== "--" ? `${opening.eco} · ` : ""}${opening.name}`
        : t("features.board.variants.coverageCardUnknownOpening", { defaultValue: "Unknown opening" });
      const statusLabel =
        nodeData.unmappedResponse === true
          ? t("features.board.variants.unmappedResponseBadge", { defaultValue: "No response mapped" })
          : nodeData.collapsed === true
            ? t("features.board.variants.coverageCollapsedBadge", { defaultValue: "Collapsed" })
            : t("features.board.variants.coverageCardExpanded", { defaultValue: "Expanded" });
      const conditionBadges: Array<{
        label: string;
        fill: string;
        stroke: string;
        text: string;
      }> = [];
      if (nodeData.responseRarity === "novelty") {
        conditionBadges.push({
          label: t("features.board.variants.coverageResponseNovelty", { defaultValue: "Novelty" }),
          fill: "rgba(168, 85, 247, 0.24)",
          stroke: "rgba(216, 180, 254, 0.72)",
          text: "#f3e8ff",
        });
      } else if (nodeData.responseRarity === "low_frequency") {
        conditionBadges.push({
          label: t("features.board.variants.coverageResponseLowFrequency", { defaultValue: "Rare Line" }),
          fill: "rgba(249, 115, 22, 0.24)",
          stroke: "rgba(253, 186, 116, 0.76)",
          text: "#ffedd5",
        });
      }
      if (nodeData.lowSample === true) {
        conditionBadges.push({
          label: t("features.board.variants.lowSampleBadge", { defaultValue: "Low Sample" }),
          fill: "rgba(250, 204, 21, 0.2)",
          stroke: "rgba(254, 240, 138, 0.78)",
          text: "#fef9c3",
        });
      }
      const sourceRates = formatWinLossRates(nodeData.activeWinRate, nodeData.activeLossRate);
      const profileRates = formatWinLossRates(nodeData.profileWinRate, nodeData.profileLossRate);
      const evalText =
        typeof nodeData.engineAdvantage === "string" && nodeData.engineAdvantage.trim().length > 0
          ? truncateSvgText(nodeData.engineAdvantage.trim(), 8)
          : t("features.board.variants.coverageCardNoEval", { defaultValue: "--" });
      const nodeSubtitle =
        d.transpositionLabels.length > 1
          ? truncateSvgText(d.transpositionLabels.slice(0, 3).join(" · "), 48)
          : truncateSvgText(buildCoverageCardSubtitle(nodeData, t), 52);

      nodeGroup
        .append("rect")
        .attr("width", cardWidth + 22)
        .attr("height", cardHeight + 18)
        .attr("x", x - 11)
        .attr("y", y - 9)
        .attr("rx", DIMS.borderRadius + 8)
        .attr("fill", visual.shadow)
        .attr("opacity", nodeData.unmappedResponse ? 0.24 : 0.3)
        .attr("filter", `url(#${nodeGlowFilterId})`);

      nodeGroup
        .append("path")
        .attr(
          "d",
          `M ${x - 17} ${y + 24} C ${x - 27} ${y + 42}, ${x - 27} ${y + 84}, ${x - 27} ${y + 122} L ${x - 27} ${y + cardHeight - 122} C ${x - 27} ${y + cardHeight - 84}, ${x - 27} ${y + cardHeight - 42}, ${x - 17} ${y + cardHeight - 24} L ${x + 5} ${y + cardHeight - 4} L ${x + 5} ${y + 4} Z`,
        )
        .attr("fill", visual.accent)
        .attr("opacity", 0.26)
        .style("pointer-events", "none");

      nodeGroup
        .append("path")
        .attr(
          "d",
          `M ${x - 13} ${y + 34} C ${x - 20} ${y + 52}, ${x - 20} ${y + 90}, ${x - 20} ${y + 128} L ${x - 20} ${y + cardHeight - 128} C ${x - 20} ${y + cardHeight - 90}, ${x - 20} ${y + cardHeight - 52}, ${x - 13} ${y + cardHeight - 34}`,
        )
        .attr("fill", "none")
        .attr("stroke", visual.accent)
        .attr("stroke-width", 5)
        .attr("stroke-linecap", "round")
        .attr("opacity", 0.82)
        .style("pointer-events", "none");

      nodeGroup
        .append("path")
        .attr(
          "d",
          `M ${x - 4} ${y + 40} C ${x - 9} ${y + 58}, ${x - 9} ${y + 94}, ${x - 9} ${y + 132} L ${x - 9} ${y + cardHeight - 132} C ${x - 9} ${y + cardHeight - 94}, ${x - 9} ${y + cardHeight - 58}, ${x - 4} ${y + cardHeight - 40}`,
        )
        .attr("fill", "none")
        .attr("stroke", "#ffffff")
        .attr("stroke-width", 1.4)
        .attr("stroke-linecap", "round")
        .attr("opacity", 0.18)
        .style("pointer-events", "none");

      nodeGroup
        .append("rect")
        .attr("width", cardWidth)
        .attr("height", cardHeight)
        .attr("x", x)
        .attr("y", y)
        .attr("rx", DIMS.borderRadius)
        .attr("fill", `url(#${gradientIds[visualKey]})`)
        .attr("stroke", visual.border)
        .attr("stroke-width", 1.4)
        .attr("filter", `url(#${nodeShadowFilterId})`);

      nodeGroup
        .append("rect")
        .attr("width", cardWidth - 2)
        .attr("height", cardHeight - 2)
        .attr("x", x + 1)
        .attr("y", y + 1)
        .attr("rx", DIMS.borderRadius - 1)
        .attr("fill", `url(#${nodeRightGlowGradientId})`)
        .attr("opacity", nodeData.unmappedResponse ? 0.08 : 0.16)
        .style("pointer-events", "none");

      nodeGroup
        .append("rect")
        .attr("width", cardWidth - 2)
        .attr("height", cardHeight - 2)
        .attr("x", x + 1)
        .attr("y", y + 1)
        .attr("rx", DIMS.borderRadius - 1)
        .attr("fill", `url(#${nodeSheenGradientId})`)
        .attr("opacity", 0.12)
        .style("pointer-events", "none");

      nodeGroup
        .append("rect")
        .attr("width", cardWidth - 20)
        .attr("height", 3)
        .attr("x", x + 10)
        .attr("y", y + 1)
        .attr("rx", 2)
        .attr("fill", visual.accent)
        .attr("opacity", 0.38)
        .style("pointer-events", "none");

      nodeGroup
        .filter(() => nodeData.lowSample === true && nodeData.unmappedResponse !== true)
        .append("rect")
        .attr("width", cardWidth)
        .attr("height", cardHeight)
        .attr("x", x)
        .attr("y", y)
        .attr("rx", DIMS.borderRadius)
        .attr("fill", "rgba(2, 6, 23, 0.22)")
        .attr("stroke", "none");

      nodeGroup
        .append("path")
        .attr(
          "d",
          `M ${x + cardWidth - 190} ${y + 162} L ${x + cardWidth} ${y + 96} L ${x + cardWidth} ${y + 230} L ${x + cardWidth - 104} ${y + 270} Z`,
        )
        .attr("fill", visual.accent)
        .attr("opacity", 0.03)
        .style("pointer-events", "none");

      nodeGroup
        .append("path")
        .attr(
          "d",
          `M ${x + cardWidth - 154} ${y + 228} L ${x + cardWidth} ${y + 174} L ${x + cardWidth} ${y + 260} L ${x + cardWidth - 100} ${y + 302} Z`,
        )
        .attr("fill", "#ffffff")
        .attr("opacity", 0.015)
        .style("pointer-events", "none");

      nodeGroup
        .append("rect")
        .attr("width", 248)
        .attr("height", 48)
        .attr("x", x + 30)
        .attr("y", y + 28)
        .attr("rx", 12)
        .attr("fill", `url(#${badgeGradientIds[visualKey]})`)
        .attr("stroke", "rgba(191, 219, 254, 0.42)")
        .attr("stroke-width", 1);

      nodeGroup
        .append("path")
        .attr(
          "d",
          `M ${x + 62} ${y + 60} L ${x + 62} ${y + 47} L ${x + 72} ${y + 52} L ${x + 82} ${y + 40} L ${x + 92} ${y + 52} L ${x + 102} ${y + 47} L ${x + 102} ${y + 60} Z`,
        )
        .attr("fill", "#ffffff")
        .attr("opacity", 0.94)
        .style("pointer-events", "none");

      nodeGroup
        .append("text")
        .attr("x", x + 126)
        .attr("y", y + 59)
        .attr("fill", "#f8fafc")
        .style("font-family", "var(--mantine-font-family)")
        .style("font-size", "22px")
        .style("font-weight", 900)
        .style("letter-spacing", "0")
        .style("pointer-events", "none")
        .text(t(getTierLabelKey(nodeData), { defaultValue: getTierLabelDefault(nodeData) }));

      let conditionBadgeRight = x + cardWidth - 118;
      for (const badge of conditionBadges) {
        const badgeWidth = estimateBadgeWidth(badge.label) + 12;
        const badgeX = conditionBadgeRight - badgeWidth;

        nodeGroup
          .append("rect")
          .attr("width", badgeWidth)
          .attr("height", 30)
          .attr("x", badgeX)
          .attr("y", y + 36)
          .attr("rx", 10)
          .attr("fill", badge.fill)
          .attr("stroke", badge.stroke)
          .attr("stroke-width", 1)
          .style("pointer-events", "none");

        nodeGroup
          .append("circle")
          .attr("cx", badgeX + 17)
          .attr("cy", y + 51)
          .attr("r", 5)
          .attr("fill", badge.stroke)
          .style("pointer-events", "none");

        nodeGroup
          .append("text")
          .attr("x", badgeX + 31)
          .attr("y", y + 57)
          .attr("fill", badge.text)
          .style("font-family", "var(--mantine-font-family)")
          .style("font-size", "12px")
          .style("font-weight", 900)
          .style("letter-spacing", "0")
          .style("pointer-events", "none")
          .text(badge.label.toUpperCase());

        conditionBadgeRight = badgeX - 8;
      }

      nodeGroup
        .append("text")
        .attr("x", x + 34)
        .attr("y", y + 164)
        .attr("fill", "#f8fafc")
        .attr("stroke", "rgba(2, 6, 23, 0.42)")
        .attr("stroke-width", 2.6)
        .attr("paint-order", "stroke")
        .style("font-family", "var(--mantine-font-family)")
        .style("font-size", parsedLabel.headline.length > 10 ? "56px" : "64px")
        .style("font-weight", 900)
        .style("letter-spacing", "0")
        .style("pointer-events", "none")
        .text(parsedLabel.headline);

      nodeGroup
        .append("line")
        .attr("x1", x + 390)
        .attr("x2", x + 390)
        .attr("y1", y + 118)
        .attr("y2", y + 178)
        .attr("stroke", "rgba(148, 163, 184, 0.5)")
        .attr("stroke-width", 1.1);

      nodeGroup
        .append("rect")
        .attr("width", cardWidth - 448)
        .attr("height", 102)
        .attr("x", x + 430)
        .attr("y", y + 92)
        .attr("rx", 12)
        .attr("fill", "rgba(2, 6, 23, 0.28)")
        .attr("stroke", visual.border)
        .attr("stroke-width", 1.1)
        .style("pointer-events", "none");

      nodeGroup
        .append("text")
        .attr("x", x + 462)
        .attr("y", y + 132)
        .attr("fill", "rgba(203, 213, 225, 0.74)")
        .style("font-family", "var(--mantine-font-family)")
        .style("font-size", "18px")
        .style("font-weight", 800)
        .style("letter-spacing", "0")
        .style("pointer-events", "none")
        .text(t("features.board.variants.coverageCardCoverage", { defaultValue: "COVERAGE" }));

      nodeGroup
        .append("text")
        .attr("x", x + 462)
        .attr("y", y + 176)
        .attr("fill", visual.accent)
        .attr("stroke", "rgba(2, 6, 23, 0.34)")
        .attr("stroke-width", 1.8)
        .attr("paint-order", "stroke")
        .style("font-family", "var(--mantine-font-family)")
        .style("font-size", "52px")
        .style("font-weight", 900)
        .style("letter-spacing", "0")
        .style("pointer-events", "none")
        .text(parsedLabel.coverage);

      nodeGroup
        .append("rect")
        .attr("width", cardWidth - 40)
        .attr("height", 88)
        .attr("x", x + 20)
        .attr("y", y + 214)
        .attr("rx", 12)
        .attr("fill", "rgba(2, 6, 23, 0.18)")
        .attr("stroke", visual.border)
        .attr("stroke-width", 1)
        .style("pointer-events", "none");

      nodeGroup
        .append("path")
        .attr(
          "d",
          `M ${x + 54} ${y + 246} L ${x + 76} ${y + 235} L ${x + 98} ${y + 246} L ${x + 93} ${y + 276} L ${x + 76} ${y + 292} L ${x + 59} ${y + 276} Z`,
        )
        .attr("fill", "none")
        .attr("stroke", visual.accent)
        .attr("stroke-width", 3.2)
        .attr("opacity", 0.9);

      nodeGroup
        .append("text")
        .attr("x", x + 128)
        .attr("y", y + 256)
        .attr("fill", "#f8fafc")
        .style("font-family", "var(--mantine-font-family)")
        .style("font-size", "27px")
        .style("font-weight", 850)
        .style("letter-spacing", "0")
        .style("pointer-events", "none")
        .text(truncateSvgText(openingTitle, 38));

      nodeGroup
        .append("text")
        .attr("x", x + 128)
        .attr("y", y + 282)
        .attr("fill", "rgba(203, 213, 225, 0.68)")
        .style("font-family", "var(--mantine-font-family)")
        .style("font-size", "17px")
        .style("font-weight", 650)
        .style("letter-spacing", "0")
        .style("pointer-events", "none")
        .text(nodeSubtitle);

      nodeGroup
        .append("rect")
        .attr("width", cardWidth - 40)
        .attr("height", 64)
        .attr("x", x + 20)
        .attr("y", y + 312)
        .attr("rx", 12)
        .attr("fill", "rgba(2, 6, 23, 0.18)")
        .attr("stroke", visual.border)
        .attr("stroke-width", 1)
        .style("pointer-events", "none");

      nodeGroup
        .append("line")
        .attr("x1", x + 260)
        .attr("x2", x + 260)
        .attr("y1", y + 322)
        .attr("y2", y + 364)
        .attr("stroke", "rgba(148, 163, 184, 0.28)")
        .attr("stroke-width", 1);

      nodeGroup
        .append("line")
        .attr("x1", x + 502)
        .attr("x2", x + 502)
        .attr("y1", y + 322)
        .attr("y2", y + 364)
        .attr("stroke", "rgba(148, 163, 184, 0.28)")
        .attr("stroke-width", 1);

      const metricColumns = [
        {
          label: t("features.board.variants.coverageCardSource", { defaultValue: "SOURCE" }),
          value: sourceRates,
          x: x + 145,
          labelX: x + 130,
          iconX: x + 56,
          icon: "source",
          isEval: false,
        },
        {
          label: t("features.board.variants.coverageCardProfile", { defaultValue: "PROFILE" }),
          value: profileRates,
          x: x + 383,
          labelX: x + 372,
          iconX: x + 300,
          icon: "profile",
          isEval: false,
        },
        {
          label: t("features.board.variants.coverageCardEval", { defaultValue: "EVAL" }),
          value: evalText,
          x: x + 616,
          labelX: x + 604,
          iconX: x + 540,
          icon: "eval",
          isEval: true,
        },
      ];

      for (const metric of metricColumns) {
        const iconGroup = nodeGroup
          .append("g")
          .attr("transform", `translate(${metric.iconX},${y + 315}) scale(0.86)`)
          .attr("opacity", 0.9)
          .style("pointer-events", "none");

        if (metric.icon === "source") {
          iconGroup
            .append("path")
            .attr("d", "M4 6 H22 V30 H4 Z")
            .attr("fill", "none")
            .attr("stroke", visual.accent)
            .attr("stroke-width", 3)
            .attr("stroke-linejoin", "round");
          iconGroup
            .append("path")
            .attr("d", "M2 18 H17 M11 11 L18 18 L11 25")
            .attr("fill", "none")
            .attr("stroke", visual.accent)
            .attr("stroke-width", 3.4)
            .attr("stroke-linecap", "round")
            .attr("stroke-linejoin", "round");
        } else if (metric.icon === "profile") {
          iconGroup
            .append("circle")
            .attr("cx", 14)
            .attr("cy", 9)
            .attr("r", 6)
            .attr("fill", "none")
            .attr("stroke", visual.accent)
            .attr("stroke-width", 3);
          iconGroup
            .append("path")
            .attr("d", "M3 31 V25 C3 19 8 16 14 16 C20 16 25 19 25 25 V31")
            .attr("fill", "none")
            .attr("stroke", visual.accent)
            .attr("stroke-width", 3)
            .attr("stroke-linecap", "round")
            .attr("stroke-linejoin", "round");
        } else {
          [8, 14, 20, 26].forEach((barX, index) => {
            iconGroup
              .append("line")
              .attr("x1", barX)
              .attr("x2", barX)
              .attr("y1", 30)
              .attr("y2", 30 - (index + 1) * 5)
              .attr("stroke", visual.accent)
              .attr("stroke-width", 3.4)
              .attr("stroke-linecap", "round");
          });
        }

        nodeGroup
          .append("text")
          .attr("x", metric.labelX)
          .attr("y", y + 340)
          .attr("text-anchor", "start")
          .attr("fill", "rgba(203, 213, 225, 0.66)")
          .style("font-family", "var(--mantine-font-family)")
          .style("font-size", "18px")
          .style("font-weight", 800)
          .style("letter-spacing", "0")
          .style("pointer-events", "none")
          .text(metric.label);

        nodeGroup
          .append("text")
          .attr("x", metric.x)
          .attr("y", y + 371)
          .attr("text-anchor", "middle")
          .attr("fill", metric.isEval ? "#f8fafc" : visual.accent)
          .attr("stroke", "rgba(2, 6, 23, 0.34)")
          .attr("stroke-width", 1.4)
          .attr("paint-order", "stroke")
          .style("font-family", "var(--mantine-font-family)")
          .style("font-size", metric.value.length > 16 ? "18px" : metric.value.length > 10 ? "22px" : "29px")
          .style("font-weight", 900)
          .style("letter-spacing", "0")
          .style("pointer-events", "none")
          .text(metric.value);
      }

      nodeGroup
        .append("rect")
        .attr("width", cardWidth)
        .attr("height", 58)
        .attr("x", x)
        .attr("y", y + cardHeight - 58)
        .attr("rx", DIMS.borderRadius)
        .attr("fill", visual.accent)
        .attr("opacity", 0.16);

      nodeGroup
        .append("rect")
        .attr("width", cardWidth)
        .attr("height", 20)
        .attr("x", x)
        .attr("y", y + cardHeight - 58)
        .attr("fill", visual.accent)
        .attr("opacity", 0.16);

      nodeGroup
        .append("line")
        .attr("x1", x)
        .attr("x2", x + cardWidth)
        .attr("y1", y + cardHeight - 58)
        .attr("y2", y + cardHeight - 58)
        .attr("stroke", visual.accent)
        .attr("stroke-width", 1)
        .attr("opacity", 0.48);

      nodeGroup
        .append("circle")
        .attr("cx", x + 38)
        .attr("cy", y + cardHeight - 29)
        .attr("r", 17)
        .attr("fill", `url(#${badgeGradientIds[visualKey]})`)
        .attr("stroke", "rgba(191, 219, 254, 0.42)")
        .attr("stroke-width", 1);

      nodeGroup
        .append("path")
        .attr(
          "d",
          `M ${x + 29} ${y + cardHeight - 29} L ${x + 36} ${y + cardHeight - 22} L ${x + 48} ${y + cardHeight - 37}`,
        )
        .attr("fill", "none")
        .attr("stroke", "#f8fafc")
        .attr("stroke-width", 4)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round");

      nodeGroup
        .append("text")
        .attr("x", x + 68)
        .attr("y", y + cardHeight - 20)
        .attr("fill", "#bfdbfe")
        .style("font-family", "var(--mantine-font-family)")
        .style("font-size", "23px")
        .style("font-weight", 850)
        .style("letter-spacing", "0")
        .style("pointer-events", "none")
        .text(statusLabel);
    });

    if (onNodeClick) {
      nodes.on("click", (_event, d) => {
        if (clickTimeoutRef.current) {
          clearTimeout(clickTimeoutRef.current);
        }
        clickTimeoutRef.current = setTimeout(() => {
          onNodeClick(d.hierarchyNode.data);
        }, 180);
      });
    }

    if (onNodeToggleCollapse) {
      nodes.on("dblclick", (event, d) => {
        if (d.hierarchyNode.data.tier === "root") return;
        event.preventDefault();
        event.stopPropagation();
        if (clickTimeoutRef.current) {
          clearTimeout(clickTimeoutRef.current);
          clickTimeoutRef.current = null;
        }
        onNodeToggleCollapse(d.hierarchyNode.data);
      });

      const toggleButton = collapsibleNodes
        .append("g")
        .attr("transform", () => `translate(${DIMS.nodeWidth / 2 - 34},${-DIMS.nodeHeight / 2 + 34})`)
        .style("cursor", "pointer");

      toggleButton
        .append("circle")
        .attr("r", 17)
        .attr("fill", "rgba(15, 23, 42, 0.86)")
        .attr("stroke", "rgba(226, 232, 240, 0.72)")
        .attr("stroke-width", 1.2)
        .attr("filter", `url(#${nodeShadowFilterId})`);

      toggleButton
        .append("text")
        .attr("text-anchor", "middle")
        .attr("dy", "0.35em")
        .style("font-size", "18px")
        .style("font-weight", 900)
        .style("fill", "#f8fafc")
        .style("pointer-events", "none")
        .text((d) => (d.hierarchyNode.data.collapsed ? "+" : "-"));

      toggleButton
        .append("title")
        .text((d) =>
          d.hierarchyNode.data.collapsed
            ? t("features.board.variants.coverageExpandNode", { defaultValue: "Expand subtree" })
            : t("features.board.variants.coverageCollapseNode", { defaultValue: "Collapse subtree" }),
        );

      toggleButton.on("click", (event, d) => {
        event.preventDefault();
        event.stopPropagation();
        if (clickTimeoutRef.current) {
          clearTimeout(clickTimeoutRef.current);
          clickTimeoutRef.current = null;
        }
        onNodeToggleCollapse(d.hierarchyNode.data);
      });

      if (onNodeExpandAllChildren) {
        const expandAllButton = collapsibleNodes
          .append("g")
          .attr("transform", () => `translate(${DIMS.nodeWidth / 2 - 82},${-DIMS.nodeHeight / 2 + 34})`)
          .style("cursor", "pointer");

        expandAllButton
          .append("circle")
          .attr("r", 17)
          .attr("fill", "rgba(37, 99, 235, 0.88)")
          .attr("stroke", "rgba(219, 234, 254, 0.78)")
          .attr("stroke-width", 1.2)
          .attr("filter", `url(#${nodeShadowFilterId})`);

        expandAllButton
          .append("text")
          .attr("text-anchor", "middle")
          .attr("dy", "0.35em")
          .style("font-size", "12px")
          .style("font-weight", 900)
          .style("fill", "#f8fafc")
          .style("pointer-events", "none")
          .text("++");

        expandAllButton.append("title").text(() =>
          t("features.board.variants.coverageExpandAllChildren", {
            defaultValue: "Expand all children",
          }),
        );

        expandAllButton.on("click", (event, d) => {
          event.preventDefault();
          event.stopPropagation();
          if (clickTimeoutRef.current) {
            clearTimeout(clickTimeoutRef.current);
            clickTimeoutRef.current = null;
          }
          onNodeExpandAllChildren(d.hierarchyNode.data);
        });
      }
    }
  }, [onNodeClick, onNodeExpandAllChildren, onNodeToggleCollapse, svgIdPrefix, t, visualRoot]);

  return (
    <Paper
      withBorder
      h="100%"
      radius="lg"
      shadow="sm"
      style={{
        ...premiumPanelStyle,
        background:
          "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-8) 92%, var(--mantine-color-blue-9) 8%), var(--mantine-color-dark-8))",
        overflow: "hidden",
        position: "relative",
        boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.035), 0 18px 56px rgba(2, 6, 23, 0.18)",
      }}
    >
      <svg ref={svgRef} width="100%" height="100%" style={{ display: "block" }} />
      <Tooltip label={t("common.centerGraph")} position="top">
        <ActionIcon
          aria-label={t("common.centerGraph")}
          variant="subtle"
          size="lg"
          radius="md"
          style={{
            position: "absolute",
            bottom: 16,
            right: 16,
            zIndex: 10,
            background:
              "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-blue-6) 34%, transparent), rgba(15, 23, 42, 0.86))",
            border: "1px solid color-mix(in srgb, var(--mantine-color-blue-5) 34%, var(--mantine-color-dark-4))",
            boxShadow: "0 12px 28px rgba(2, 6, 23, 0.35)",
            color: "var(--mantine-color-blue-1)",
          }}
          onClick={centerGraph}
        >
          <IconFocus size={18} />
        </ActionIcon>
      </Tooltip>
    </Paper>
  );
}
