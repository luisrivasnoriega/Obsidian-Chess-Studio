import { ActionIcon, Box, Text } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import equal from "fast-deep-equal";
import type React from "react";
import { memo } from "react";
import CompleteMoveCell from "@/components/CompleteMoveCell";
import type { TreeNode } from "@/utils/treeReducer";

function isPathPrefix(prefix: number[], path: number[]): boolean {
  if (prefix.length > path.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== path[i]) {
      return false;
    }
  }
  return true;
}

type RenderVariationLineProps = {
  tree: TreeNode;
  path: number[];
  depth: number;
  first: boolean;
  showComments: boolean;
  start?: number[];
  targetRef: React.RefObject<HTMLSpanElement | null>;
  maxDepth?: number;
  maxVariationDepth?: number;
  variationDepth: number;
  getExtraDepth: (pathKey: string) => number;
  onToggleExpanded: (pathKey: string) => void;
  collapsedPaths: Set<string>;
  onToggleCollapsedPath: (pathKey: string) => void;
  currentPath: number[];
  extraDepth: number;
  expansionVersion: number;
};

type VariationBranchProps = {
  variation: TreeNode;
  path: number[];
  depth: number;
  showComments: boolean;
  start?: number[];
  targetRef: React.RefObject<HTMLSpanElement | null>;
  maxDepth?: number;
  maxVariationDepth?: number;
  variationDepth: number;
  getExtraDepth: (pathKey: string) => number;
  onToggleExpanded: (pathKey: string) => void;
  collapsedPaths: Set<string>;
  onToggleCollapsedPath: (pathKey: string) => void;
  currentPath: number[];
  extraDepth: number;
  expansionVersion: number;
};

function RenderVariationLineBase({
  tree,
  path,
  depth,
  first,
  showComments,
  start,
  targetRef,
  maxDepth,
  maxVariationDepth,
  variationDepth,
  getExtraDepth,
  onToggleExpanded,
  collapsedPaths,
  onToggleCollapsedPath,
  currentPath,
  extraDepth,
  expansionVersion,
}: RenderVariationLineProps) {
  if (tree.san) {
    const pathKey = path.join(".");
    const localExtraDepth = getExtraDepth(pathKey);
    const activeExtraDepth = localExtraDepth > 0 ? localExtraDepth : extraDepth;
    const variations = tree.children;
    const hasChildren = variations.length > 0;
    const userCollapsed = collapsedPaths.has(pathKey) && !isPathPrefix(path, currentPath);
    const reachedDepthLimit = maxDepth != null && depth >= maxDepth;
    const reachedVariationLimit =
      maxVariationDepth != null && variationDepth >= maxVariationDepth && activeExtraDepth <= 0;
    const showChildren = hasChildren && !userCollapsed && !(reachedDepthLimit || reachedVariationLimit);

    const collapseControl = hasChildren ? (
      <ActionIcon
        variant="subtle"
        size="sm"
        color="gray"
        onClick={() => {
          if (userCollapsed) {
            onToggleCollapsedPath(pathKey);
            return;
          }
          if (reachedDepthLimit || reachedVariationLimit) {
            onToggleExpanded(pathKey);
            return;
          }
          onToggleCollapsedPath(pathKey);
        }}
        aria-label={userCollapsed ? "Expand variation" : "Collapse variation"}
        style={{ marginLeft: "0.25rem" }}
      >
        {userCollapsed || reachedDepthLimit || reachedVariationLimit ? (
          <IconChevronRight size={14} />
        ) : (
          <IconChevronDown size={14} />
        )}
      </ActionIcon>
    ) : null;

    return (
      <>
        <CompleteMoveCell
          targetRef={targetRef}
          annotations={tree.annotations}
          comment={tree.comment}
          halfMoves={tree.halfMoves}
          move={tree.san}
          fen={tree.fen}
          movePath={path}
          showComments={showComments}
          isStart={equal(path, start)}
          first={first}
          enableTranspositions
        />
        {collapseControl}
        {showChildren && variations.length > 1 ? (
          variations.map((childVariation, index) => (
            <VariationBranch
              key={`${childVariation.fen}-${index}`}
              variation={childVariation}
              path={[...path, index]}
              depth={depth + 1}
              start={start}
              showComments={showComments}
              targetRef={targetRef}
              maxDepth={maxDepth}
              maxVariationDepth={maxVariationDepth}
              variationDepth={variationDepth + 1}
              getExtraDepth={getExtraDepth}
              onToggleExpanded={onToggleExpanded}
              collapsedPaths={collapsedPaths}
              onToggleCollapsedPath={onToggleCollapsedPath}
              currentPath={currentPath}
              extraDepth={0}
              expansionVersion={expansionVersion}
            />
          ))
        ) : showChildren && variations.length === 1 ? (
          <RenderVariationLine
            tree={variations[0]}
            path={[...path, 0]}
            depth={depth + 1}
            first={false}
            start={start}
            showComments={showComments}
            targetRef={targetRef}
            maxDepth={maxDepth}
            maxVariationDepth={maxVariationDepth}
            variationDepth={variationDepth}
            getExtraDepth={getExtraDepth}
            onToggleExpanded={onToggleExpanded}
            collapsedPaths={collapsedPaths}
            onToggleCollapsedPath={onToggleCollapsedPath}
            currentPath={currentPath}
            extraDepth={activeExtraDepth}
            expansionVersion={expansionVersion}
          />
        ) : null}
      </>
    );
  }

  const variations = tree.children;
  if (!variations?.length) return null;

  const newPath = [...path, 0];
  const pathKey = path.join(".");
  const localExtraDepth = getExtraDepth(pathKey);
  const activeExtraDepth = localExtraDepth > 0 ? localExtraDepth : extraDepth;
  const reachedDepthLimit = maxDepth != null && depth >= maxDepth;
  const reachedVariationLimit =
    maxVariationDepth != null && variationDepth >= maxVariationDepth && activeExtraDepth <= 0;
  const hasChildren = variations.length > 0;
  const userCollapsed = collapsedPaths.has(pathKey) && !isPathPrefix(path, currentPath);
  const showChildren = hasChildren && !userCollapsed && !(reachedDepthLimit || reachedVariationLimit);
  return (
    <>
      <CompleteMoveCell
        targetRef={targetRef}
        annotations={variations[0].annotations}
        comment={variations[0].comment}
        halfMoves={variations[0].halfMoves}
        move={variations[0].san}
        fen={variations[0].fen}
        movePath={newPath}
        showComments={showComments}
        isStart={equal(newPath, start)}
        first={first}
        enableTranspositions
      />
      {hasChildren ? (
        <ActionIcon
          variant="subtle"
          size="sm"
          color="gray"
          onClick={() => {
            if (userCollapsed) {
              onToggleCollapsedPath(pathKey);
              return;
            }
            if (reachedDepthLimit || reachedVariationLimit) {
              onToggleExpanded(pathKey);
              return;
            }
            onToggleCollapsedPath(pathKey);
          }}
          aria-label={userCollapsed ? "Expand variation" : "Collapse variation"}
          style={{ marginLeft: "0.25rem" }}
        >
          {userCollapsed || reachedDepthLimit || reachedVariationLimit ? (
            <IconChevronRight size={14} />
          ) : (
            <IconChevronDown size={14} />
          )}
        </ActionIcon>
      ) : null}
      {showChildren && variations.length > 1 ? (
        variations.map((childVariation, index) => (
          <VariationBranch
            key={`${childVariation.fen}-${index}`}
            variation={childVariation}
            path={[...path, index]}
            depth={depth + 1}
            start={start}
            showComments={showComments}
            targetRef={targetRef}
            maxDepth={maxDepth}
            maxVariationDepth={maxVariationDepth}
            variationDepth={variationDepth + 1}
            getExtraDepth={getExtraDepth}
            onToggleExpanded={onToggleExpanded}
            collapsedPaths={collapsedPaths}
            onToggleCollapsedPath={onToggleCollapsedPath}
            currentPath={currentPath}
            extraDepth={0}
            expansionVersion={expansionVersion}
          />
        ))
      ) : showChildren ? (
        <RenderVariationLine
          tree={variations[0]}
          path={newPath}
          depth={depth + 1}
          first={false}
          start={start}
          showComments={showComments}
          targetRef={targetRef}
          maxDepth={maxDepth}
          maxVariationDepth={maxVariationDepth}
          variationDepth={variationDepth}
          getExtraDepth={getExtraDepth}
          onToggleExpanded={onToggleExpanded}
          collapsedPaths={collapsedPaths}
          onToggleCollapsedPath={onToggleCollapsedPath}
          currentPath={currentPath}
          extraDepth={activeExtraDepth}
          expansionVersion={expansionVersion}
        />
      ) : null}
    </>
  );
}

const RenderVariationLine = memo(RenderVariationLineBase, (prev, next) => {
  return (
    prev.tree === next.tree &&
    prev.depth === next.depth &&
    prev.first === next.first &&
    prev.showComments === next.showComments &&
    prev.targetRef === next.targetRef &&
    prev.variationDepth === next.variationDepth &&
    prev.maxVariationDepth === next.maxVariationDepth &&
    prev.expansionVersion === next.expansionVersion &&
    equal(prev.currentPath, next.currentPath) &&
    equal(prev.path, next.path) &&
    equal(prev.start, next.start)
  );
});

function VariationBranchBase({
  variation,
  path,
  depth,
  showComments,
  start,
  targetRef,
  maxDepth,
  maxVariationDepth,
  variationDepth,
  getExtraDepth,
  onToggleExpanded,
  collapsedPaths,
  onToggleCollapsedPath,
  currentPath,
  extraDepth,
  expansionVersion,
}: VariationBranchProps) {
  if (!variation.san && !variation.children?.length) return null;

  const pathKey = path.join(".");
  const localExtraDepth = getExtraDepth(pathKey);
  const activeExtraDepth = localExtraDepth > 0 ? localExtraDepth : extraDepth;
  const firstMoveHalfMoves = variation.halfMoves;
  const moveNumber = Math.floor((firstMoveHalfMoves - 1) / 2) + 1;
  const isBlackMove = (firstMoveHalfMoves - 1) % 2 === 1;
  const marginLeft = "3rem";
  const hasChildren = variation.children.length > 0;
  const userCollapsed = collapsedPaths.has(pathKey) && !isPathPrefix(path, currentPath);
  const reachedDepthLimit = maxDepth != null && depth >= maxDepth;
  const reachedVariationLimit =
    maxVariationDepth != null && variationDepth >= maxVariationDepth && activeExtraDepth <= 0;
  const showChildren = hasChildren && !userCollapsed && !(reachedDepthLimit || reachedVariationLimit);

  const renderVariationContent = () => (
    <>
      {isBlackMove && (
        <Text component="span" c="dimmed" style={{ marginRight: "0.25rem" }}>
          {moveNumber}...
        </Text>
      )}
      <CompleteMoveCell
        targetRef={targetRef}
        annotations={variation.annotations}
        comment={variation.comment}
        halfMoves={variation.halfMoves}
        move={variation.san}
        fen={variation.fen}
        movePath={path}
        showComments={showComments}
        isStart={equal(path, start)}
        first={false}
        enableTranspositions
      />
      {hasChildren ? (
        <ActionIcon
          variant="subtle"
          size="sm"
          color="gray"
          onClick={() => {
            if (userCollapsed) {
              onToggleCollapsedPath(pathKey);
              return;
            }
            if (reachedDepthLimit || reachedVariationLimit) {
              onToggleExpanded(pathKey);
              return;
            }
            onToggleCollapsedPath(pathKey);
          }}
          aria-label={userCollapsed ? "Expand variation" : "Collapse variation"}
          style={{ marginLeft: "0.25rem" }}
        >
          {userCollapsed || reachedDepthLimit || reachedVariationLimit ? (
            <IconChevronRight size={14} />
          ) : (
            <IconChevronDown size={14} />
          )}
        </ActionIcon>
      ) : null}
      {showChildren && variation.children.length > 1 ? (
        variation.children.map((childVariation, index) => (
          <VariationBranch
            key={`${childVariation.fen}-${index}`}
            variation={childVariation}
            path={[...path, index]}
            depth={depth + 1}
            start={start}
            showComments={showComments}
            targetRef={targetRef}
            maxDepth={maxDepth}
            maxVariationDepth={maxVariationDepth}
            variationDepth={variationDepth + 1}
            getExtraDepth={getExtraDepth}
            onToggleExpanded={onToggleExpanded}
            collapsedPaths={collapsedPaths}
            onToggleCollapsedPath={onToggleCollapsedPath}
            currentPath={currentPath}
            extraDepth={0}
            expansionVersion={expansionVersion}
          />
        ))
      ) : showChildren && variation.children.length === 1 ? (
        <RenderVariationLine
          tree={variation.children[0]}
          path={[...path, 0]}
          depth={depth + 1}
          first={false}
          start={start}
          showComments={showComments}
          targetRef={targetRef}
          maxDepth={maxDepth}
          maxVariationDepth={maxVariationDepth}
          variationDepth={variationDepth}
          getExtraDepth={getExtraDepth}
          onToggleExpanded={onToggleExpanded}
          collapsedPaths={collapsedPaths}
          onToggleCollapsedPath={onToggleCollapsedPath}
          currentPath={currentPath}
          extraDepth={activeExtraDepth}
          expansionVersion={expansionVersion}
        />
      ) : null}
    </>
  );

  return (
    <Box
      style={{
        marginLeft,
        marginTop: "0.125rem",
        marginBottom: "0.125rem",
        display: "block",
        lineHeight: "1.5",
      }}
    >
      <Text component="span" c="dimmed" style={{ marginRight: "0.25rem" }}>
        (
      </Text>
      <Box component="span" style={{ display: "inline" }}>
        {renderVariationContent()}
      </Box>
      <Text component="span" c="dimmed" style={{ marginLeft: "0.25rem" }}>
        )
      </Text>
    </Box>
  );
}

const VariationBranch = memo(VariationBranchBase, (prev, next) => {
  return (
    prev.variation === next.variation &&
    prev.depth === next.depth &&
    prev.showComments === next.showComments &&
    prev.targetRef === next.targetRef &&
    prev.variationDepth === next.variationDepth &&
    prev.maxVariationDepth === next.maxVariationDepth &&
    prev.expansionVersion === next.expansionVersion &&
    equal(prev.currentPath, next.currentPath) &&
    equal(prev.path, next.path) &&
    equal(prev.start, next.start)
  );
});

export function VariantsNotationTree({
  root,
  start,
  showComments,
  targetRef,
  maxDepth,
  maxVariationDepth,
  getExtraDepth,
  onToggleExpanded,
  collapsedPaths,
  onToggleCollapsedPath,
  currentPath,
  expansionVersion,
}: {
  root: TreeNode;
  start?: number[];
  showComments: boolean;
  targetRef: React.RefObject<HTMLSpanElement | null>;
  maxDepth?: number;
  maxVariationDepth?: number;
  getExtraDepth: (pathKey: string) => number;
  onToggleExpanded: (pathKey: string) => void;
  collapsedPaths: Set<string>;
  onToggleCollapsedPath: (pathKey: string) => void;
  currentPath: number[];
  expansionVersion: number;
}) {
  return (
    <>
      {root.children.map((variation, index) => (
        <VariationBranch
          key={`${variation.fen}-${index}`}
          variation={variation}
          path={[index]}
          depth={0}
          start={start}
          showComments={showComments}
          targetRef={targetRef}
          maxDepth={maxDepth}
          maxVariationDepth={maxVariationDepth}
          variationDepth={0}
          getExtraDepth={getExtraDepth}
          onToggleExpanded={onToggleExpanded}
          collapsedPaths={collapsedPaths}
          onToggleCollapsedPath={onToggleCollapsedPath}
          currentPath={currentPath}
          extraDepth={0}
          expansionVersion={expansionVersion}
        />
      ))}
    </>
  );
}
