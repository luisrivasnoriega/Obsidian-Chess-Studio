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

function edgeColor(link: HierarchyPointLink<CoverageGraphNode>): string {
  if (link.target.data.unmappedResponse) return COVERAGE_UNMAPPED_COLOR;
  return COVERAGE_TIER_COLORS[link.target.data.tier] ?? "#64748b";
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

    const linkGenerator = linkHorizontal<HierarchyPointLink<CoverageGraphNode>, HierarchyPointNode<CoverageGraphNode>>()
      .x((d) => d.y)
      .y((d) => d.x);

    g.append("g")
      .selectAll("path")
      .data(treeRoot.links())
      .join("path")
      .attr("fill", "none")
      .attr("stroke", (d) => edgeColor(d))
      .attr("stroke-width", DIMS.strokeWidth.link)
      .attr("opacity", 0.9)
      .attr("d", linkGenerator as any);

    const nodes = g
      .append("g")
      .selectAll("g")
      .data(treeRoot.descendants() as NodeWithMeta[])
      .join("g")
      .attr("transform", (d) => `translate(${d.y},${d.x})`)
      .attr("data-node", "true")
      .style("cursor", (d) => (d.data.tier === "root" || !onNodeClick ? "default" : "pointer"));

    const collapsibleNodes = nodes.filter((d) => {
      if (d.data.tier === "root") return false;
      const visibleChildren = d.data.children.length;
      const hiddenChildren = d.data.hiddenChildrenCount ?? 0;
      return visibleChildren > 0 || hiddenChildren > 0 || d.data.collapsed === true;
    });

    nodes
      .append("rect")
      .attr("width", DIMS.nodeWidth)
      .attr("height", DIMS.nodeHeight)
      .attr("x", -DIMS.nodeWidth / 2)
      .attr("y", -DIMS.nodeHeight / 2)
      .attr("rx", DIMS.borderRadius)
      .attr("fill", (d) => (d.data.unmappedResponse ? COVERAGE_UNMAPPED_COLOR : COVERAGE_TIER_COLORS[d.data.tier]));

    nodes
      .filter((d) => d.data.lowSample === true && d.data.unmappedResponse !== true)
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
      .attr("fill", (d) => getNodeTextColor(d.data.tier, d.data.lowSample, d.data.unmappedResponse))
      .style("font-size", "11px")
      .style("font-weight", 700)
      .style("pointer-events", "none");

    textGroup
      .append("tspan")
      .attr("x", 0)
      .attr("dy", (d) => (d.data.openingName || d.data.lowSample || d.data.unmappedResponse ? "-0.1em" : "0.31em"))
      .text((d) => d.data.label);

    textGroup
      .filter((d) => Boolean(d.data.openingName))
      .append("tspan")
      .attr("x", 0)
      .attr("dy", "1.15em")
      .style("font-size", "9.5px")
      .style("font-weight", 600)
      .text((d) => formatOpeningSubtitle(d.data.openingName));

    textGroup
      .filter((d) => d.data.tier !== "root" && d.data.collapsed === true)
      .append("tspan")
      .attr("x", 0)
      .attr("dy", (d) => (d.data.openingName ? "1.0em" : "1.15em"))
      .style("font-size", "10px")
      .style("font-weight", 700)
      .text(() => t("features.board.variants.coverageCollapsedBadge", { defaultValue: "Collapsed" }));

    textGroup
      .filter(
        (d) =>
          d.data.tier !== "root" &&
          d.data.lowSample === true &&
          d.data.unmappedResponse !== true &&
          !d.data.responseRarity &&
          d.data.collapsed !== true,
      )
      .append("tspan")
      .attr("x", 0)
      .attr("dy", (d) => (d.data.openingName ? "1.0em" : "1.15em"))
      .style("font-size", "10px")
      .style("font-weight", 600)
      .text(() => t("features.board.variants.lowSampleBadge", { defaultValue: "Low Sample" }));

    textGroup
      .filter(
        (d) =>
          d.data.tier !== "root" &&
          Boolean(d.data.responseRarity) &&
          d.data.unmappedResponse !== true &&
          d.data.collapsed !== true,
      )
      .append("tspan")
      .attr("x", 0)
      .attr("dy", (d) => (d.data.openingName ? "1.0em" : "1.15em"))
      .style("font-size", "10px")
      .style("font-weight", 700)
      .text((d) =>
        d.data.responseRarity === "novelty"
          ? t("features.board.variants.coverageResponseNovelty", {
              defaultValue: "Novelty",
            })
          : t("features.board.variants.coverageResponseLowFrequency", {
              defaultValue: "Rare Line",
            }),
      );

    textGroup
      .filter((d) => d.data.tier !== "root" && d.data.unmappedResponse === true && d.data.collapsed !== true)
      .append("tspan")
      .attr("x", 0)
      .attr("dy", (d) => (d.data.openingName ? "1.0em" : "1.15em"))
      .style("font-size", "10px")
      .style("font-weight", 700)
      .text(() => t("features.board.variants.unmappedResponseBadge", { defaultValue: "No response mapped" }));

    if (onNodeClick) {
      nodes.on("click", (_event, d) => {
        if (d.data.tier === "root") return;
        if (clickTimeoutRef.current) {
          clearTimeout(clickTimeoutRef.current);
        }
        clickTimeoutRef.current = setTimeout(() => {
          onNodeClick(d.data);
        }, 180);
      });
    }

    if (onNodeToggleCollapse) {
      nodes.on("dblclick", (event, d) => {
        if (d.data.tier === "root") return;
        event.preventDefault();
        event.stopPropagation();
        if (clickTimeoutRef.current) {
          clearTimeout(clickTimeoutRef.current);
          clickTimeoutRef.current = null;
        }
        onNodeToggleCollapse(d.data);
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
        .text((d) => (d.data.collapsed ? "+" : "âˆ’"));

      toggleButton.on("click", (event, d) => {
        event.preventDefault();
        event.stopPropagation();
        if (clickTimeoutRef.current) {
          clearTimeout(clickTimeoutRef.current);
          clickTimeoutRef.current = null;
        }
        onNodeToggleCollapse(d.data);
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
