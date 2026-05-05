import { ActionIcon, Paper, Tooltip } from "@mantine/core";
import { IconFocus } from "@tabler/icons-react";
import { type HierarchyPointLink, type HierarchyPointNode, hierarchy, tree } from "d3-hierarchy";
import { select } from "d3-selection";
import { linkHorizontal } from "d3-shape";
import "d3-transition";
import { type ZoomBehavior, zoom, zoomIdentity } from "d3-zoom";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

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
  children: CoverageGraphNode[];
};

export const COVERAGE_TIER_COLORS: Record<CoverageTier, string> = {
  root: "#3b82f6",
  mainline: "#3b82f6",
  secondary: "#15803d",
  alternative: "#dc2626",
};
export const COVERAGE_UNMAPPED_COLOR = "#ffea00";

const DIMS = {
  nodeWidth: 240,
  nodeHeight: 58,
  nodeSpacing: [62, 300] as [number, number],
  borderRadius: 8,
  strokeWidth: { link: 2, node: 1.5 },
  scale: 0.75,
  transitionDuration: 550,
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
};

function getNodeTextColor(tier: CoverageTier, lowSample?: boolean, unmappedResponse?: boolean) {
  if (unmappedResponse) return "#111827";
  if (tier === "root") return "#f8fafc";
  if (lowSample) return "#f8fafc";
  return "#0f172a";
}

function edgeColor(target: CoverageGraphNode): string {
  if (target.unmappedResponse) return COVERAGE_UNMAPPED_COLOR;
  return COVERAGE_TIER_COLORS[target.tier] ?? "#64748b";
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

function formatOpeningSubtitle(openingName?: string | null): string {
  const text = `${openingName ?? ""}`.trim();
  if (!text) return "";
  const maxLen = 38;
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
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
    if (normalizedNode.collapsed === true) {
      return {
        ...normalizedNode,
        unmappedResponse: false,
        children: [],
      };
    }

    const forcedReply =
      normalizedChildren.length === 1 && normalizedChildren[0].tier === "root" ? normalizedChildren[0] : null;

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

export function VariantCoverageGraph({ root, onNodeClick, onNodeToggleCollapse }: VariantCoverageGraphProps) {
  const { t } = useTranslation();
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

    const node = svg.node();
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();

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

    g.append("g")
      .selectAll("path")
      .data(
        renderedDag.links.map((link) => ({
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
        })),
      )
      .join("path")
      .attr("fill", "none")
      .attr("stroke", (d) => edgeColor(d.target.hierarchyNode.data))
      .attr("stroke-width", DIMS.strokeWidth.link)
      .attr("opacity", 0.9)
      .attr("d", linkGenerator as any);

    const nodes = g
      .append("g")
      .selectAll("g")
      .data(renderedDag.nodes)
      .join("g")
      .attr("transform", (d) => `translate(${d.hierarchyNode.y},${d.hierarchyNode.x})`)
      .attr("data-node", "true")
      .style("cursor", (d) => (d.hierarchyNode.data.tier === "root" || !onNodeClick ? "default" : "pointer"));

    const collapsibleNodes = nodes.filter((d) => {
      const nodeData = d.hierarchyNode.data;
      if (nodeData.tier === "root") return false;
      const visibleChildren = renderedDag.outgoingCount.get(d.mergeKey) ?? 0;
      const hiddenChildren = nodeData.hiddenChildrenCount ?? 0;
      return visibleChildren > 0 || hiddenChildren > 0 || nodeData.collapsed === true;
    });

    nodes
      .append("rect")
      .attr("width", DIMS.nodeWidth)
      .attr("height", DIMS.nodeHeight)
      .attr("x", -DIMS.nodeWidth / 2)
      .attr("y", -DIMS.nodeHeight / 2)
      .attr("rx", DIMS.borderRadius)
      .attr("fill", (d) =>
        d.hierarchyNode.data.unmappedResponse
          ? COVERAGE_UNMAPPED_COLOR
          : COVERAGE_TIER_COLORS[d.hierarchyNode.data.tier],
      );

    nodes
      .filter((d) => d.hierarchyNode.data.lowSample === true && d.hierarchyNode.data.unmappedResponse !== true)
      .append("rect")
      .attr("width", DIMS.nodeWidth)
      .attr("height", DIMS.nodeHeight)
      .attr("x", -DIMS.nodeWidth / 2)
      .attr("y", -DIMS.nodeHeight / 2)
      .attr("rx", DIMS.borderRadius)
      .attr("fill", "rgba(0, 0, 0, 0.28)")
      .attr("stroke", "none");

    nodes
      .append("rect")
      .attr("width", DIMS.nodeWidth)
      .attr("height", DIMS.nodeHeight)
      .attr("x", -DIMS.nodeWidth / 2)
      .attr("y", -DIMS.nodeHeight / 2)
      .attr("rx", DIMS.borderRadius)
      .attr("fill", "none")
      .attr("stroke", "#0b1220")
      .attr("stroke-width", DIMS.strokeWidth.node);

    const textGroup = nodes
      .append("text")
      .attr("text-anchor", "middle")
      .attr("fill", (d) =>
        getNodeTextColor(
          d.hierarchyNode.data.tier,
          d.hierarchyNode.data.lowSample,
          d.hierarchyNode.data.unmappedResponse,
        ),
      )
      .style("font-size", "11px")
      .style("font-weight", 700)
      .style("pointer-events", "none");

    textGroup
      .append("tspan")
      .attr("x", 0)
      .attr("dy", (d) =>
        d.hierarchyNode.data.openingName || d.hierarchyNode.data.lowSample || d.hierarchyNode.data.unmappedResponse
          ? "-0.1em"
          : "0.31em",
      )
      .text((d) => d.hierarchyNode.data.label);

    textGroup
      .filter((d) => Boolean(d.hierarchyNode.data.openingName))
      .append("tspan")
      .attr("x", 0)
      .attr("dy", "1.15em")
      .style("font-size", "9.5px")
      .style("font-weight", 600)
      .text((d) => formatOpeningSubtitle(d.hierarchyNode.data.openingName));

    textGroup
      .filter((d) => (d.transpositionLabels?.length ?? 0) > 1)
      .append("tspan")
      .attr("x", 0)
      .attr("dy", (d) => (d.hierarchyNode.data.openingName ? "1.0em" : "1.15em"))
      .style("font-size", "9.5px")
      .style("font-weight", 600)
      .text((d) => {
        const labels = d.transpositionLabels.slice(0, 3);
        const remaining = Math.max(0, d.transpositionLabels.length - labels.length);
        const suffix = remaining > 0 ? ` +${remaining}` : "";
        return `${labels.join(" · ")}${suffix}`;
      });

    textGroup
      .filter((d) => d.hierarchyNode.data.tier !== "root" && d.hierarchyNode.data.collapsed === true)
      .append("tspan")
      .attr("x", 0)
      .attr("dy", (d) => (d.hierarchyNode.data.openingName ? "1.0em" : "1.15em"))
      .style("font-size", "10px")
      .style("font-weight", 700)
      .text(() => t("features.board.variants.coverageCollapsedBadge", { defaultValue: "Collapsed" }));

    textGroup
      .filter(
        (d) =>
          d.hierarchyNode.data.tier !== "root" &&
          d.hierarchyNode.data.lowSample === true &&
          d.hierarchyNode.data.unmappedResponse !== true &&
          !d.hierarchyNode.data.responseRarity &&
          d.hierarchyNode.data.collapsed !== true,
      )
      .append("tspan")
      .attr("x", 0)
      .attr("dy", (d) => (d.hierarchyNode.data.openingName ? "1.0em" : "1.15em"))
      .style("font-size", "10px")
      .style("font-weight", 600)
      .text(() => t("features.board.variants.lowSampleBadge", { defaultValue: "Low Sample" }));

    textGroup
      .filter(
        (d) =>
          d.hierarchyNode.data.tier !== "root" &&
          Boolean(d.hierarchyNode.data.responseRarity) &&
          d.hierarchyNode.data.unmappedResponse !== true &&
          d.hierarchyNode.data.collapsed !== true,
      )
      .append("tspan")
      .attr("x", 0)
      .attr("dy", (d) => (d.hierarchyNode.data.openingName ? "1.0em" : "1.15em"))
      .style("font-size", "10px")
      .style("font-weight", 700)
      .text((d) =>
        d.hierarchyNode.data.responseRarity === "novelty"
          ? t("features.board.variants.coverageResponseNovelty", {
              defaultValue: "Novelty",
            })
          : t("features.board.variants.coverageResponseLowFrequency", {
              defaultValue: "Rare Line",
            }),
      );

    textGroup
      .filter(
        (d) =>
          d.hierarchyNode.data.tier !== "root" &&
          d.hierarchyNode.data.unmappedResponse === true &&
          d.hierarchyNode.data.collapsed !== true,
      )
      .append("tspan")
      .attr("x", 0)
      .attr("dy", (d) => (d.hierarchyNode.data.openingName ? "1.0em" : "1.15em"))
      .style("font-size", "10px")
      .style("font-weight", 700)
      .text(() => t("features.board.variants.unmappedResponseBadge", { defaultValue: "No response mapped" }));

    if (onNodeClick) {
      nodes.on("click", (_event, d) => {
        if (d.hierarchyNode.data.tier === "root") return;
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
        .attr("transform", () => `translate(${DIMS.nodeWidth / 2 - 14},${-DIMS.nodeHeight / 2 + 14})`)
        .style("cursor", "pointer");

      toggleButton
        .append("circle")
        .attr("r", 9)
        .attr("fill", "rgba(15, 23, 42, 0.78)")
        .attr("stroke", "#cbd5e1")
        .attr("stroke-width", 1.2);

      toggleButton
        .append("text")
        .attr("text-anchor", "middle")
        .attr("dy", "0.35em")
        .style("font-size", "12px")
        .style("font-weight", 900)
        .style("fill", "#f8fafc")
        .style("pointer-events", "none")
        .text((d) => (d.hierarchyNode.data.collapsed ? "+" : "-"));

      toggleButton.on("click", (event, d) => {
        event.preventDefault();
        event.stopPropagation();
        if (clickTimeoutRef.current) {
          clearTimeout(clickTimeoutRef.current);
          clickTimeoutRef.current = null;
        }
        onNodeToggleCollapse(d.hierarchyNode.data);
      });
    }
  }, [onNodeClick, onNodeToggleCollapse, t, visualRoot]);

  return (
    <Paper withBorder h="100%" style={{ overflow: "hidden", position: "relative" }}>
      <svg ref={svgRef} width="100%" height="100%" />
      <Tooltip label={t("common.centerGraph")} position="top">
        <ActionIcon
          variant="filled"
          size="lg"
          style={{ position: "absolute", bottom: 16, right: 16, zIndex: 10 }}
          onClick={centerGraph}
        >
          <IconFocus size={18} />
        </ActionIcon>
      </Tooltip>
    </Paper>
  );
}
