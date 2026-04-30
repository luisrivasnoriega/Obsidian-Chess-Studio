import { ActionIcon, Box, Menu, Portal, Tooltip } from "@mantine/core";
import { useClickOutside } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconArrowsJoin,
  IconChevronsUp,
  IconChevronUp,
  IconCopy,
  IconFlag,
  IconGitBranch,
  IconX,
} from "@tabler/icons-react";
import equal from "fast-deep-equal";
import { useAtomValue } from "jotai";
import { memo, useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Comment } from "@/components/Comment";
import { currentTabAtom } from "@/state/atoms";
import type { Annotation } from "@/utils/annotation";
import { getPGN, hasMorePriority, makeClk, stripClock } from "@/utils/chess";
import { createFile, getFileNameWithoutExtension, readInfoMetadata, writeInfoMetadata } from "@/utils/files";
import { type GameHeaders, getNodeAtPath, type TreeNode, treeIterator } from "@/utils/treeReducer";
import MoveCell from "./MoveCell";
import { TreeStateContext } from "./TreeStateContext";

const transpositionIndexCache = new WeakMap<TreeNode, Map<string, number[][]>>();

function getTranspositionIndex(root: TreeNode): Map<string, number[][]> {
  const cached = transpositionIndexCache.get(root);
  if (cached) return cached;

  const index = new Map<string, number[][]>();
  const iterator = treeIterator(root);
  for (const item of iterator) {
    const key = stripClock(item.node.fen);
    const positions = index.get(key);
    if (positions) {
      positions.push(item.position);
    } else {
      index.set(key, [item.position]);
    }
  }

  transpositionIndexCache.set(root, index);
  return index;
}

function getTranspositions(fen: string, position: number[], root: TreeNode) {
  if (position.length === 0 || position.every((v) => v === 0)) return [];

  const index = getTranspositionIndex(root);
  const strippedFen = stripClock(fen);
  const sameFenPositions = index.get(strippedFen);
  if (!sameFenPositions || sameFenPositions.length === 0) return [];

  const transpositions: number[][] = [];
  for (const candidatePosition of sameFenPositions) {
    if (hasMorePriority(position, candidatePosition)) {
      continue;
    }
    transpositions.push(candidatePosition);
  }
  return transpositions;
}

function cloneTreeNode(node: TreeNode): TreeNode {
  return {
    ...node,
    move: node.move ? { ...node.move } : null,
    shapes: node.shapes.map((shape) => ({ ...shape })),
    annotations: [...node.annotations],
    children: node.children.map(cloneTreeNode),
  };
}

function sanitizeFileStem(input: string): string {
  const withoutControlChars = Array.from(input)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");
  const cleaned = withoutControlChars
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "subvariant";
}

function CompleteMoveCell({
  movePath,
  halfMoves,
  move,
  fen,
  comment,
  clockSeconds,
  annotations,
  showComments,
  first,
  isStart,
  targetRef,
  enableTranspositions = true,
}: {
  halfMoves: number;
  comment: string;
  clockSeconds?: number;
  annotations: Annotation[];
  showComments: boolean;
  move?: string | null;
  fen?: string;
  first?: boolean;
  isStart: boolean;
  movePath: number[];
  targetRef: React.RefObject<HTMLSpanElement | null>;
  enableTranspositions?: boolean;
}) {
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("CompleteMoveCell must be used within TreeStateProvider");
  }
  const isCurrentVariation = useStore(store, (s) => equal(s.position, movePath));
  const root = useStore(store, (s) => (enableTranspositions ? s.root : null));
  const goToMove = useStore(store, (s) => s.goToMove);
  const deleteMove = useStore(store, (s) => s.deleteMove);
  const promoteVariation = useStore(store, (s) => s.promoteVariation);
  const promoteToMainline = useStore(store, (s) => s.promoteToMainline);
  const copyVariationPgn = useStore(store, (s) => s.copyVariationPgn);
  const setStart = useStore(store, (s) => s.setStart);

  const moveNumber = Math.ceil(halfMoves / 2);
  const isWhite = halfMoves % 2 === 1;
  const hasNumber = halfMoves > 0 && (first || isWhite);
  const ref = useClickOutside(() => {
    setOpen(false);
  });
  const [open, setOpen] = useState(false);
  const currentTab = useAtomValue(currentTabAtom);

  const transpositions = enableTranspositions && fen && root ? getTranspositions(fen, movePath, root) : [];
  const { t } = useTranslation();
  const currentFileSource = currentTab?.source?.type === "file" ? currentTab.source : null;
  const variantsFileSource = currentFileSource?.metadata.type === "variants" ? currentFileSource : null;
  const isVariantsFile = variantsFileSource != null;

  const extractSubvariant = useCallback(async () => {
    setOpen(false);

    if (!variantsFileSource || !move) {
      return;
    }

    if (movePath.length === 0) {
      notifications.show({
        title: t("common.error"),
        message: t("errors.missingPosition"),
        color: "red",
      });
      return;
    }

    try {
      const state = store.getState();
      const branchIndex = movePath[movePath.length - 1];
      const parentPath = movePath.slice(0, -1);
      const parentNode = getNodeAtPath(state.root, parentPath);
      const selectedNode = getNodeAtPath(state.root, movePath);
      if (!parentNode || !selectedNode) {
        throw new Error("Invalid variation path");
      }

      const canExtractDescendants = selectedNode.children.length > 0;
      const canExtractSideVariation = branchIndex !== 0;

      if (!canExtractDescendants && !canExtractSideVariation) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.extractSubvariantSideOnly"),
          color: "red",
        });
        return;
      }

      const extractionMode = canExtractDescendants ? "subtree" : "side-variation";

      const extractedRoot: TreeNode =
        extractionMode === "subtree"
          ? {
              fen: selectedNode.fen,
              move: null,
              san: null,
              children: selectedNode.children.map(cloneTreeNode),
              score: null,
              depth: null,
              halfMoves: selectedNode.halfMoves,
              shapes: [],
              annotations: [],
              comment: "",
            }
          : {
              fen: parentNode.fen,
              move: null,
              san: null,
              children: [cloneTreeNode(selectedNode)],
              score: null,
              depth: null,
              halfMoves: parentNode.halfMoves,
              shapes: [],
              annotations: [],
              comment: "",
            };

      const childHeaders: GameHeaders = {
        ...state.headers,
        event: state.headers.event?.trim() ? `${state.headers.event} (Subvariant)` : "Subvariant",
        fen: extractedRoot.fen,
        result: "*",
      };

      const parentFilePath = variantsFileSource.path;
      const parentDir = parentFilePath.replace(/[\\/][^\\/]+$/, "");
      const parentBaseName = await getFileNameWithoutExtension(parentFilePath);
      const sideSuffix = halfMoves % 2 === 1 ? "w" : "b";
      const moveStem = sanitizeFileStem(move);
      const defaultStem = sanitizeFileStem(
        extractionMode === "subtree"
          ? `${parentBaseName}-split-${moveNumber}${sideSuffix}-${moveStem}`
          : `${parentBaseName}-sub-${moveNumber}${sideSuffix}-${moveStem}`,
      );
      const requestedNameRaw = window.prompt(t("common.enterFileName"), defaultStem);
      if (requestedNameRaw == null) {
        return;
      }
      const requestedName = requestedNameRaw.trim();
      if (!requestedName) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.nameRequired"),
          color: "red",
        });
        return;
      }
      const candidateStem = sanitizeFileStem(requestedName);
      if (!candidateStem) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.nameRequired"),
          color: "red",
        });
        return;
      }

      childHeaders.event = requestedName;

      const childPgn = `${getPGN(extractedRoot, {
        headers: childHeaders,
        glyphs: true,
        comments: true,
        variations: true,
        extraMarkups: true,
      })}\n\n`;

      let createdPath: string | null = null;
      let createdName: string | null = null;
      let createError: unknown = null;
      for (let attempt = 0; attempt < 100 && !createdPath; attempt++) {
        const attemptName = attempt === 0 ? candidateStem : `${candidateStem}-${attempt + 1}`;
        const created = await createFile({
          filename: attemptName,
          filetype: "variants",
          pgn: childPgn,
          dir: parentDir,
        });
        if (created.isOk) {
          createdPath = created.value.path;
          createdName = created.value.name;
          break;
        }
        const errMessage = created.error instanceof Error ? created.error.message : String(created.error ?? "");
        if (!/already exists/i.test(errMessage)) {
          createError = created.error;
          break;
        }
      }

      if (!createdPath || !createdName) {
        throw createError instanceof Error ? createError : new Error("Failed to create subvariant file");
      }

      const parentName = await getFileNameWithoutExtension(parentFilePath);
      const childName = createdName;
      const childRelativePath = createdPath.split(/[/\\]/).pop() ?? createdPath;
      const parentRelativePath = parentFilePath.split(/[/\\]/).pop() ?? parentFilePath;
      const linkLabel = `${moveNumber}${halfMoves % 2 === 1 ? "." : "..."} ${move}`;
      const splitCreatedAt = new Date().toISOString();

      const parentMetadata = await readInfoMetadata(parentFilePath, "variants");
      const childMetadata = await readInfoMetadata(createdPath, "variants");

      const childLink = {
        path: childRelativePath,
        name: childName,
        anchorFen: selectedNode.fen,
        anchorPath: [...movePath],
        anchorPly: selectedNode.halfMoves,
        label: linkLabel,
      };

      const existingChildren = Array.isArray(parentMetadata.links?.children) ? parentMetadata.links.children : [];
      const dedupedChildren = existingChildren.filter(
        (link) => !(link.path === childLink.path && link.anchorPly === childLink.anchorPly),
      );
      parentMetadata.links = {
        ...(parentMetadata.links ?? {}),
        children: [...dedupedChildren, childLink],
      };

      childMetadata.links = {
        ...(childMetadata.links ?? {}),
        parent: {
          path: parentRelativePath,
          name: parentName,
          anchorFen: selectedNode.fen,
          anchorPath: [...movePath],
          anchorPly: selectedNode.halfMoves,
          label: linkLabel,
        },
      };
      childMetadata.split = {
        mode: "manual",
        createdAt: splitCreatedAt,
      };
      parentMetadata.split = {
        mode: "manual",
        createdAt: splitCreatedAt,
      };

      await writeInfoMetadata(parentFilePath, parentMetadata);
      await writeInfoMetadata(createdPath, childMetadata);
      try {
        window.dispatchEvent(new Event("variants:links-updated"));
      } catch {}

      if (extractionMode === "subtree") {
        const freshSelected = getNodeAtPath(store.getState().root, movePath);
        const descendantsToDelete = freshSelected?.children?.length ?? 0;
        for (let i = descendantsToDelete - 1; i >= 0; i--) {
          deleteMove([...movePath, i]);
        }
        goToMove(movePath);
      } else {
        deleteMove(movePath);
      }

      notifications.show({
        title: t("common.success"),
        message: t("features.board.variants.extractSubvariantCreated", { name: childName }),
        color: "green",
      });
    } catch (_error) {
      notifications.show({
        title: t("common.error"),
        message: t("features.board.variants.extractSubvariantFailed"),
        color: "red",
      });
    }
  }, [deleteMove, goToMove, halfMoves, move, moveNumber, movePath, store, t, variantsFileSource]);

  const clockLabel = useMemo(() => {
    if (clockSeconds === undefined) return null;
    const full = makeClk(clockSeconds);
    return full.startsWith("0:") ? full.slice(2) : full;
  }, [clockSeconds]);

  return (
    <>
      <Box
        ref={isCurrentVariation ? targetRef : undefined}
        component="span"
        style={{
          display: "inline-block",
          marginLeft: hasNumber ? 6 : 0,
          fontSize: "80%",
        }}
      >
        {hasNumber && `${moveNumber.toString()}${isWhite ? "." : "..."}`}
        {move && (
          <Menu opened={open} width={200}>
            <Menu.Target>
              <MoveCell
                ref={ref}
                move={move}
                annotations={annotations}
                isStart={isStart}
                isCurrentVariation={isCurrentVariation}
                onClick={() => goToMove(movePath)}
                onContextMenu={(e: React.MouseEvent) => {
                  setOpen((v) => !v);
                  e.preventDefault();
                }}
              />
            </Menu.Target>

            <Portal>
              <Menu.Dropdown>
                {currentTab?.source?.type === "file" && currentTab.source.metadata.type === "repertoire" && (
                  <Menu.Item leftSection={<IconFlag size="0.875rem" />} onClick={() => setStart(movePath)}>
                    {t("features.menu.markAsStart")}
                  </Menu.Item>
                )}
                <Menu.Item leftSection={<IconChevronsUp size="0.875rem" />} onClick={() => promoteToMainline(movePath)}>
                  {t("features.menu.promoteToMainLine")}
                </Menu.Item>

                <Menu.Item leftSection={<IconChevronUp size="0.875rem" />} onClick={() => promoteVariation(movePath)}>
                  {t("features.menu.promoteVariation")}
                </Menu.Item>

                <Menu.Item leftSection={<IconCopy size="0.875rem" />} onClick={() => copyVariationPgn(movePath)}>
                  {t("features.menu.copyVariationPGN")}
                </Menu.Item>

                {isVariantsFile && (
                  <Menu.Item leftSection={<IconGitBranch size="0.875rem" />} onClick={() => void extractSubvariant()}>
                    {t("features.menu.extractSubvariant")}
                  </Menu.Item>
                )}

                <Menu.Item color="red" leftSection={<IconX size="0.875rem" />} onClick={() => deleteMove(movePath)}>
                  {t("features.menu.deleteMove")}
                </Menu.Item>
              </Menu.Dropdown>
            </Portal>
          </Menu>
        )}
        {clockLabel && (
          <Box
            component="span"
            style={{
              marginLeft: 6,
              fontSize: "0.9em",
              color: "var(--mantine-color-dimmed)",
              fontVariantNumeric: "tabular-nums",
              userSelect: "none",
            }}
          >
            {clockLabel}
          </Box>
        )}
        {transpositions.length > 0 && (
          <Tooltip label={t("moves.transposition")}>
            <ActionIcon size="xs" onClick={() => goToMove(transpositions[0])}>
              <IconArrowsJoin size="0.875rem" />
            </ActionIcon>
          </Tooltip>
        )}
      </Box>
      {showComments && comment && <Comment comment={comment} />}
    </>
  );
}

export default memo(CompleteMoveCell, (prev, next) => {
  return (
    prev.move === next.move &&
    prev.fen === next.fen &&
    prev.comment === next.comment &&
    prev.clockSeconds === next.clockSeconds &&
    equal(prev.annotations, next.annotations) &&
    prev.showComments === next.showComments &&
    prev.first === next.first &&
    prev.isStart === next.isStart &&
    equal(prev.movePath, next.movePath) &&
    prev.halfMoves === next.halfMoves &&
    (prev.enableTranspositions ?? true) === (next.enableTranspositions ?? true)
  );
});
