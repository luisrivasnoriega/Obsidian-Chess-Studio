import { ActionIcon, Paper, Tooltip } from "@mantine/core";
import { IconFocus } from "@tabler/icons-react";
import { type HierarchyNode, type HierarchyPointLink, type HierarchyPointNode, hierarchy, tree } from "d3-hierarchy";
import { select } from "d3-selection";
import { linkHorizontal } from "d3-shape";
import "d3-transition";
import { type ZoomBehavior, zoom, zoomIdentity } from "d3-zoom";
import { t } from "i18next";
import { useContext, useEffect, useRef } from "react";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/TreeStateContext";
import type { TreeNode } from "@/utils/treeReducer";

const COLORS = {
  link: "#555",
  highlight: "orange",
  root: "#f9a825",
  white: "#ffffff",
  black: "#2c2c2c",
  text: "#333",
};

const DIMS = {
  nodeWidth: 80,
  nodeHeight: 30,
  nodeSpacing: [40, 150] as [number, number],
  borderRadius: 10,
  strokeWidth: { link: 1.5, node: 2 },
  scale: 0.8,
  transitionDuration: 750,
};

type NodeWithPath = HierarchyPointNode<TreeNode> & { movePath?: number[] };

const getNodeColor = (d: HierarchyNode<TreeNode>) =>
  d.depth === 0 ? COLORS.root : d.data.halfMoves % 2 === 1 ? COLORS.white : COLORS.black;

const getTextColor = (d: HierarchyNode<TreeNode>) =>
  d.depth === 0 ? COLORS.text : d.data.halfMoves % 2 === 1 ? COLORS.text : COLORS.white;

function GraphPanel() {
  const store = useContext(TreeStateContext)!;
  const rootData = useStore(store, (s) => s.root);
  const currentPosition = useStore(store, (s) => s.position);
  const goToMove = useStore(store, (s) => s.goToMove);

  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const hierarchyRef = useRef<HierarchyPointNode<TreeNode> | null>(null);

  const addMovePaths = (root: HierarchyPointNode<TreeNode>) => {
    root.each((d: NodeWithPath) => {
      const path: number[] = [];
      let current = d;
      while (current.parent) {
        const index = current.parent.children?.indexOf(current);
        if (index !== undefined && index >= 0) {
          path.unshift(index);
        }
        current = current.parent;
      }
      d.movePath = path;
    });
  };

  const createCenterTransform = (node: HierarchyPointNode<TreeNode>, width: number, height: number) =>
    zoomIdentity.translate(width / 2 - node.y * DIMS.scale, height / 2 - node.x * DIMS.scale).scale(DIMS.scale);

  const findCurrentNode = (root: HierarchyPointNode<TreeNode>) => {
    if (!currentPosition.length) return root;
    return (
      root.descendants().find((d) => {
        const path = (d as NodeWithPath).movePath || [];
        return path.length === currentPosition.length && path.every((val, idx) => val === currentPosition[idx]);
      }) || root
    );
  };

  const updateSelection = (root: HierarchyPointNode<TreeNode>) => {
    if (!svgRef.current) return;
    const svg = select(svgRef.current);
    const ancestors = findCurrentNode(root).ancestors();

    // Reset all styles
    svg
      .selectAll<SVGPathElement, HierarchyPointLink<TreeNode>>("path.link")
      .attr("stroke", COLORS.link)
      .attr("stroke-width", DIMS.strokeWidth.link);

    svg
      .selectAll<SVGRectElement, HierarchyNode<TreeNode>>("g[data-node] > rect")
      .attr("stroke", COLORS.link)
      .attr("stroke-width", DIMS.strokeWidth.node);

    // Highlight active path
    svg
      .selectAll<SVGPathElement, HierarchyPointLink<TreeNode>>("path.link")
      .filter((l) => ancestors.includes(l.target))
      .attr("stroke", COLORS.highlight)
      .attr("stroke-width", DIMS.strokeWidth.node);

    svg
      .selectAll<SVGGElement, HierarchyPointNode<TreeNode>>("g[data-node]")
      .filter((n) => ancestors.includes(n))
      .select("rect")
      .attr("stroke", COLORS.highlight)
      .attr("stroke-width", DIMS.strokeWidth.node);
  };

  const centerOnCurrentMove = () => {
    if (!svgRef.current || !hierarchyRef.current || !zoomRef.current) return;

    const svg = select(svgRef.current);
    const node = svg.node();
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();

    svg
      .transition()
      .duration(DIMS.transitionDuration)
      .call(zoomRef.current.transform, createCenterTransform(findCurrentNode(hierarchyRef.current), width, height));
  };

  useEffect(() => {
    if (!svgRef.current || !rootData) return;

    const svg = select(svgRef.current);
    svg.selectAll("*").remove();

    const node = svg.node();
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    const g = svg.append("g");
    const root = hierarchy(rootData, (d) => d.children);
    const treeRoot = tree<TreeNode>().nodeSize(DIMS.nodeSpacing)(root);

    hierarchyRef.current = treeRoot;
    addMovePaths(treeRoot);

    // Setup zoom
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .filter((event) => {
        if (event.type === "wheel") return true;
        const target = event.target as Element | null;
        return !target?.closest("g[data-node]");
      })
      .on("zoom", (event) => g.attr("transform", event.transform));

    zoomRef.current = zoomBehavior;
    svg.call(zoomBehavior);

    // Center on current move
    svg
      .transition()
      .duration(DIMS.transitionDuration)
      .call(zoomBehavior.transform, createCenterTransform(findCurrentNode(treeRoot), width, height));

    // Draw links
    const linkGenerator = linkHorizontal<HierarchyPointLink<TreeNode>, HierarchyPointNode<TreeNode>>()
      .x((d) => d.y)
      .y((d) => d.x);

    g.append("g")
      .selectAll("path")
      .data(treeRoot.links())
      .join("path")
      .attr("class", "link")
      .attr("fill", "none")
      .attr("stroke", COLORS.link)
      .attr("stroke-width", DIMS.strokeWidth.link)
      .attr("d", linkGenerator as any);

    // Draw nodes
    const nodes = g
      .append("g")
      .selectAll("g")
      .data(treeRoot.descendants())
      .join("g")
      .attr("transform", (d) => `translate(${d.y},${d.x})`)
      .attr("data-node", "true")
      .style("cursor", "pointer")
      .on("click", (event, d: NodeWithPath) => {
        event.stopPropagation();
        goToMove(d.depth === 0 ? [] : d.movePath || []);
      });

    // Node rectangles
    nodes
      .append("rect")
      .attr("width", DIMS.nodeWidth)
      .attr("height", DIMS.nodeHeight)
      .attr("x", -DIMS.nodeWidth / 2)
      .attr("y", -DIMS.nodeHeight / 2)
      .attr("rx", DIMS.borderRadius)
      .attr("fill", getNodeColor)
      .attr("stroke", COLORS.link)
      .attr("stroke-width", DIMS.strokeWidth.node);

    // Node text
    nodes
      .append("text")
      .attr("dy", "0.31em")
      .attr("text-anchor", "middle")
      .text((d) => d.data.san || "")
      .attr("fill", getTextColor)
      .style("pointer-events", "none");

    updateSelection(treeRoot);
  }, [rootData, goToMove, addMovePaths, createCenterTransform, findCurrentNode, updateSelection]);

  return (
    <Paper flex={1} h="100%" style={{ overflow: "hidden", position: "relative" }}>
      <svg ref={svgRef} width="100%" height="100%" />
      <Tooltip label={t("common.centerGraph")} position="top">
        <ActionIcon
          variant="filled"
          size="lg"
          style={{
            position: "absolute",
            bottom: 16,
            right: 16,
            zIndex: 10,
          }}
          onClick={centerOnCurrentMove}
        >
          <IconFocus size={18} />
        </ActionIcon>
      </Tooltip>
    </Paper>
  );
}

export default GraphPanel;
