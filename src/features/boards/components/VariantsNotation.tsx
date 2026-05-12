import {
  ActionIcon,
  Badge,
  Box,
  Divider,
  Group,
  Overlay,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  useMantineColorScheme,
} from "@mantine/core";
import { useColorScheme, useHotkeys, useToggle } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconArticle,
  IconArticleOff,
  IconChevronDown,
  IconChevronsDown,
  IconChevronsUp,
  IconChevronUp,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconPointFilled,
  IconTarget,
  IconWindowMaximize,
} from "@tabler/icons-react";
import { join } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  type CSSProperties,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Comment } from "@/components/Comment";
import OpeningName from "@/components/OpeningName";
import { TreeStateContext } from "@/components/TreeStateContext";
import type { VariantLinkRef } from "@/features/variants/types";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { activeTabAtom, currentInvisibleAtom, currentTabAtom, tabsAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybindings";
import { openFile, readInfoMetadata } from "@/utils/files";
import type { TreeNode } from "@/utils/treeReducer";
import { VariantsNotationTree } from "./VariantsNotationTree";

function isPrefixPath(prefix: number[], path: number[]): boolean {
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

function collectCollapsiblePaths(node: TreeNode, path: number[] = [], out: number[][] = []) {
  if (path.length > 0 && node.children.length > 0) {
    out.push(path);
  }
  for (let i = 0; i < node.children.length; i++) {
    collectCollapsiblePaths(node.children[i], [...path, i], out);
  }
  return out;
}

function isAbsolutePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path);
}

type VariantLinksState = {
  parent: VariantLinkRef | null;
  children: VariantLinkRef[];
};

const notationPanelSurface: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 10%, var(--mantine-color-dark-4))",
  borderRadius: 8,
  background:
    "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-8) 92%, var(--mantine-color-dark-6) 8%), var(--mantine-color-dark-8))",
  boxShadow: "0 18px 40px rgba(0, 0, 0, 0.18)",
};

function VariantsNotation({
  topBar,
  forceDesktopLayout = false,
  onDetach,
}: {
  topBar?: boolean;
  editingMode?: boolean;
  forceDesktopLayout?: boolean;
  onDetach?: () => void;
}) {
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("VariantsNotation must be used within a TreeStateProvider");
  }

  const root = useStore(store, (s) => s.root);
  const headers = useStore(store, (s) => s.headers);
  const goToMove = useStore(store, (s) => s.goToMove);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [invisibleValue, setInvisible] = useAtom(currentInvisibleAtom);
  const currentTab = useAtomValue(currentTabAtom);
  const [, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const [showComments, toggleComments] = useToggle([false, true]);
  const [expandedDepths, setExpandedDepths] = useState<Map<string, number>>(() => new Map());
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
  const [maxVariationDepth, setMaxVariationDepth] = useState(5);
  const [variantLinks, setVariantLinks] = useState<VariantLinksState>({ parent: null, children: [] });
  const invisible = topBar && invisibleValue;
  const { colorScheme } = useMantineColorScheme();
  const osColorScheme = useColorScheme();
  const keyMap = useAtomValue(keyMapAtom);
  const { t } = useTranslation();
  const position = useStore(store, (s) => s.position);
  const variantsFilePath =
    currentTab?.source?.type === "file" && currentTab.source.metadata?.type === "variants"
      ? currentTab.source.path
      : null;

  const deferredRoot = useDeferredValue(root);
  const [expansionVersion, setExpansionVersion] = useState(0);

  const toggleExpandedPath = useCallback((pathKey: string) => {
    setExpandedDepths((prev) => {
      const next = new Map(prev);
      const current = next.get(pathKey) ?? 0;
      if (current > 0) {
        next.delete(pathKey);
      } else {
        next.set(pathKey, Number.POSITIVE_INFINITY);
      }
      return next;
    });
    setExpansionVersion((prev) => prev + 1);
  }, []);
  const getExtraDepth = useCallback((pathKey: string) => expandedDepths.get(pathKey) ?? 0, [expandedDepths]);
  const toggleCollapsedPath = useCallback((pathKey: string) => {
    if (!pathKey) {
      return;
    }
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(pathKey)) {
        next.delete(pathKey);
      } else {
        next.add(pathKey);
      }
      return next;
    });
    setExpansionVersion((prev) => prev + 1);
  }, []);

  const currentMoveRef = useRef<HTMLSpanElement | null>(null);
  const { layout } = useResponsiveLayout();
  const isMobileLayout = !forceDesktopLayout && layout.chessBoard.layoutType === "mobile";
  const _currentPathKey = position.join(".");

  const focusCurrentMove = useCallback((behavior: ScrollBehavior = "smooth") => {
    const node = currentMoveRef.current;
    if (!node) {
      return;
    }
    node.scrollIntoView({ behavior, block: "center", inline: "nearest" });
    node.animate?.(
      [
        { boxShadow: "0 0 0 0 rgba(255, 193, 7, 0)" },
        { boxShadow: "0 0 0 8px rgba(255, 193, 7, 0.25)" },
        { boxShadow: "0 0 0 0 rgba(255, 193, 7, 0)" },
      ],
      { duration: 700, easing: "ease-out" },
    );
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadLinks = async () => {
      if (!variantsFilePath) {
        if (!cancelled) {
          setVariantLinks({ parent: null, children: [] });
        }
        return;
      }

      try {
        const metadata = await readInfoMetadata(variantsFilePath, "variants");
        if (cancelled) {
          return;
        }
        setVariantLinks({
          parent: metadata.type === "variants" ? (metadata.links?.parent ?? null) : null,
          children:
            metadata.type === "variants" && Array.isArray(metadata.links?.children) ? metadata.links.children : [],
        });
      } catch {
        if (!cancelled) {
          setVariantLinks({ parent: null, children: [] });
        }
      }
    };

    const onLinksUpdated = () => {
      void loadLinks();
    };

    void loadLinks();
    window.addEventListener("variants:links-updated", onLinksUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener("variants:links-updated", onLinksUpdated);
    };
  }, [variantsFilePath]);

  const sortedChildLinks = useMemo(() => {
    return [...variantLinks.children].sort((a, b) => {
      if (a.anchorPly !== b.anchorPly) {
        return a.anchorPly - b.anchorPly;
      }
      const aLabel = (a.label || a.name || "").toLowerCase();
      const bLabel = (b.label || b.name || "").toLowerCase();
      return aLabel.localeCompare(bLabel);
    });
  }, [variantLinks.children]);

  const resolveLinkedPath = useCallback(
    async (linkPath: string): Promise<string | null> => {
      if (!variantsFilePath) {
        return null;
      }
      if (isAbsolutePath(linkPath)) {
        return linkPath;
      }
      const parentDir = variantsFilePath.replace(/[\\/][^\\/]+$/, "");
      return join(parentDir, linkPath);
    },
    [variantsFilePath],
  );

  const openLinkedVariant = useCallback(
    async (link: VariantLinkRef, targetPath?: number[]) => {
      try {
        const resolvedPath = await resolveLinkedPath(link.path);
        if (!resolvedPath || !(await exists(resolvedPath))) {
          notifications.show({
            title: t("common.error"),
            message: t("features.gameNotation.linkedVariantMissing", { name: link.name }),
            color: "red",
          });
          return;
        }
        await openFile(resolvedPath, setTabs, setActiveTab, {
          position: targetPath ? [...targetPath] : [],
          initialNotationView: "variations",
        });
      } catch {
        notifications.show({
          title: t("common.error"),
          message: t("features.gameNotation.linkedVariantOpenFailed"),
          color: "red",
        });
      }
    },
    [resolveLinkedPath, setActiveTab, setTabs, t],
  );

  const jumpToAnchor = useCallback(
    (link: VariantLinkRef) => {
      if (!Array.isArray(link.anchorPath)) {
        return;
      }
      goToMove([...link.anchorPath]);
    },
    [goToMove],
  );

  useEffect(() => {
    if (position.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => focusCurrentMove("smooth"), 50);
    return () => window.clearTimeout(timer);
  }, [focusCurrentMove, position.length]);

  const collapseOneLevel = useCallback(() => {
    setExpandedDepths(new Map());
    setExpansionVersion((prev) => prev + 1);
    setMaxVariationDepth((prev) => Math.max(1, prev - 1));
  }, []);

  const expandOneLevel = useCallback(() => {
    setMaxVariationDepth((prev) => Math.min(24, prev + 1));
  }, []);

  const collapseAllBranches = useCallback(() => {
    const collapsiblePaths = collectCollapsiblePaths(deferredRoot);
    const next = new Set<string>();
    for (const path of collapsiblePaths) {
      if (isPrefixPath(path, position)) {
        continue;
      }
      next.add(path.join("."));
    }
    setCollapsedPaths(next);
    setExpandedDepths(new Map());
    setExpansionVersion((prev) => prev + 1);
    setMaxVariationDepth(1);
  }, [deferredRoot, position]);

  const expandAllBranches = useCallback(() => {
    setCollapsedPaths(new Set());
    setExpandedDepths(new Map());
    setExpansionVersion((prev) => prev + 1);
    setMaxVariationDepth(24);
  }, []);

  useHotkeys([
    [keyMap.TOGGLE_BLUR.keys, () => setInvisible((prev: boolean) => !prev)],
    [
      keyMap.COLLAPSE_VARIATIONS.keys,
      () => {
        if (collapsedPaths.size > 0 || maxVariationDepth <= 1) {
          expandAllBranches();
        } else {
          collapseAllBranches();
        }
      },
    ],
  ]);

  const notationBody = (
    <Box style={{ minWidth: 0, position: "relative" }}>
      {invisible && (
        <Overlay
          backgroundOpacity={0.6}
          color={colorScheme === "dark" || (osColorScheme === "dark" && colorScheme === "auto") ? "#1a1b1e" : undefined}
          blur={8}
          zIndex={2}
        />
      )}
      <Box
        style={{
          width: "100%",
          position: "relative",
        }}
      >
        {deferredRoot.children.length === 0 ? (
          <Text c="dimmed" size="sm">
            {t("features.gameNotation.noMoves")}
          </Text>
        ) : (
          <>
            {showComments && deferredRoot.comment && <Comment comment={deferredRoot.comment} />}
            <VariantsNotationTree
              root={deferredRoot}
              start={headers.start}
              showComments={showComments}
              targetRef={currentMoveRef}
              maxVariationDepth={maxVariationDepth}
              getExtraDepth={getExtraDepth}
              onToggleExpanded={toggleExpandedPath}
              collapsedPaths={collapsedPaths}
              onToggleCollapsedPath={toggleCollapsedPath}
              currentPath={position}
              expansionVersion={expansionVersion}
            />
          </>
        )}
      </Box>
    </Box>
  );

  return (
    <Paper
      p="md"
      flex={isMobileLayout ? undefined : 1}
      style={{
        ...(!isMobileLayout ? notationPanelSurface : {}),
        display: isMobileLayout ? undefined : "flex",
        flexDirection: isMobileLayout ? undefined : "column",
        height: isMobileLayout ? undefined : "100%",
        minHeight: 0,
        minWidth: 0,
        position: "relative",
        overflow: isMobileLayout ? "visible" : "hidden",
        touchAction: isMobileLayout ? "pan-y" : undefined,
      }}
    >
      <Stack
        h={isMobileLayout ? "auto" : "100%"}
        gap={0}
        style={{
          flex: isMobileLayout ? undefined : "1 1 0",
          minHeight: 0,
          minWidth: 0,
          overflow: isMobileLayout ? undefined : "hidden",
        }}
      >
        {topBar && (
          <NotationHeader
            showComments={showComments}
            toggleComments={toggleComments}
            invisible={invisible ?? false}
            setInvisible={setInvisible}
            focusCurrentMove={() => focusCurrentMove("smooth")}
            collapseOneLevel={collapseOneLevel}
            expandOneLevel={expandOneLevel}
            collapseAllBranches={collapseAllBranches}
            expandAllBranches={expandAllBranches}
            maxVariationDepth={maxVariationDepth}
            onDetach={onDetach}
          />
        )}
        {(variantLinks.parent || sortedChildLinks.length > 0) && (
          <LinkedVariantsBar
            parentLink={variantLinks.parent}
            childLinks={sortedChildLinks}
            onOpenParent={(link) => void openLinkedVariant(link, link.anchorPath)}
            onOpenChild={(link) => void openLinkedVariant(link)}
            onJumpToAnchor={jumpToAnchor}
          />
        )}
        {isMobileLayout ? (
          <Box style={{ touchAction: "pan-y" }}>{notationBody}</Box>
        ) : (
          <Box style={{ flex: "1 1 0", minHeight: 0, minWidth: 0, overflow: "hidden" }}>
            <ScrollArea h="100%" type="auto" offsetScrollbars viewportRef={viewportRef}>
              {notationBody}
            </ScrollArea>
          </Box>
        )}
      </Stack>
    </Paper>
  );
}

function NotationHeader({
  showComments,
  toggleComments,
  invisible,
  setInvisible,
  focusCurrentMove,
  collapseOneLevel,
  expandOneLevel,
  collapseAllBranches,
  expandAllBranches,
  maxVariationDepth,
  onDetach,
}: {
  showComments: boolean;
  toggleComments: () => void;
  invisible: boolean;
  setInvisible: (value: boolean | ((prev: boolean) => boolean)) => void;
  focusCurrentMove: () => void;
  collapseOneLevel: () => void;
  expandOneLevel: () => void;
  collapseAllBranches: () => void;
  expandAllBranches: () => void;
  maxVariationDepth: number;
  onDetach?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Stack gap="xs" style={{ flex: "0 0 auto", minWidth: 0 }}>
      <Group justify="space-between" align="flex-start" gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
        <Box style={{ flex: "1 1 auto", minWidth: 0 }}>
          <OpeningName />
        </Box>
        <Group gap="sm">
          <Tooltip label={invisible ? t("features.gameNotation.showMoves") : t("features.gameNotation.hideMoves")}>
            <ActionIcon onClick={() => setInvisible((prev: boolean) => !prev)}>
              {invisible ? <IconEyeOff size="1rem" /> : <IconEye size="1rem" />}
            </ActionIcon>
          </Tooltip>
          <Tooltip
            label={showComments ? t("features.gameNotation.hideComments") : t("features.gameNotation.showComments")}
          >
            <ActionIcon onClick={toggleComments}>
              {showComments ? <IconArticle size="1rem" /> : <IconArticleOff size="1rem" />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("features.gameNotation.focusCurrentMove")}>
            <ActionIcon onClick={focusCurrentMove}>
              <IconPointFilled size="1rem" />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("features.gameNotation.collapseTreeLevel")}>
            <ActionIcon onClick={collapseOneLevel}>
              <IconChevronUp size="1rem" />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("features.gameNotation.collapseAllVariations")}>
            <ActionIcon onClick={collapseAllBranches}>
              <IconChevronsUp size="1rem" />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("features.gameNotation.expandTreeLevel")}>
            <ActionIcon onClick={expandOneLevel}>
              <IconChevronDown size="1rem" />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("features.gameNotation.expandAllVariations")}>
            <ActionIcon onClick={expandAllBranches}>
              <IconChevronsDown size="1rem" />
            </ActionIcon>
          </Tooltip>
          {onDetach && (
            <Tooltip label={t("features.gameNotation.openNotationWindow")}>
              <ActionIcon onClick={onDetach}>
                <IconWindowMaximize size="1rem" />
              </ActionIcon>
            </Tooltip>
          )}
          <Text size="xs" c="dimmed">
            D{maxVariationDepth}
          </Text>
        </Group>
      </Group>
      <Divider />
    </Stack>
  );
}

function LinkedVariantsBar({
  parentLink,
  childLinks,
  onOpenParent,
  onOpenChild,
  onJumpToAnchor,
}: {
  parentLink: VariantLinkRef | null;
  childLinks: VariantLinkRef[];
  onOpenParent: (link: VariantLinkRef) => void;
  onOpenChild: (link: VariantLinkRef) => void;
  onJumpToAnchor: (link: VariantLinkRef) => void;
}) {
  const { t } = useTranslation();

  return (
    <Stack gap="xs" py="xs">
      {parentLink ? (
        <Group gap="xs" wrap="wrap">
          <Badge color="teal" variant="light">
            {t("features.gameNotation.parentVariant")}
          </Badge>
          <Tooltip label={t("features.gameNotation.openLinkedVariant")}>
            <ActionIcon variant="light" color="teal" onClick={() => onOpenParent(parentLink)}>
              <IconExternalLink size="1rem" />
            </ActionIcon>
          </Tooltip>
          <Text size="sm">{parentLink.label || parentLink.name}</Text>
          <Tooltip label={t("features.gameNotation.goToAnchor")}>
            <ActionIcon variant="subtle" color="gray" onClick={() => onJumpToAnchor(parentLink)}>
              <IconTarget size="1rem" />
            </ActionIcon>
          </Tooltip>
        </Group>
      ) : null}

      {childLinks.length > 0 ? (
        <Stack gap={6}>
          <Group gap="xs" wrap="wrap">
            <Badge color="cyan" variant="light">
              {t("features.gameNotation.childVariants")} ({childLinks.length})
            </Badge>
          </Group>
          <Group gap="xs" wrap="wrap">
            {childLinks.map((child) => {
              const key = `${child.path}-${child.anchorPly}-${child.label ?? child.name}`;
              return (
                <Group key={key} gap={4} wrap="nowrap">
                  <Tooltip label={t("features.gameNotation.openLinkedVariant")}>
                    <ActionIcon variant="light" color="cyan" onClick={() => onOpenChild(child)}>
                      <IconExternalLink size="1rem" />
                    </ActionIcon>
                  </Tooltip>
                  <Text size="sm">{child.label || child.name}</Text>
                  <Tooltip label={t("features.gameNotation.goToAnchor")}>
                    <ActionIcon variant="subtle" color="gray" onClick={() => onJumpToAnchor(child)}>
                      <IconTarget size="1rem" />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              );
            })}
          </Group>
        </Stack>
      ) : null}

      <Divider />
    </Stack>
  );
}

export default VariantsNotation;
