import { Badge, Box, Button, Card, Group, Loader, Progress, ScrollArea, Stack, Text, ThemeIcon } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPuzzle } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadDirectories } from "@/App";
import { type FileMetadata, processEntriesRecursively } from "@/features/files/utils/file";
import { activeTabAtom, puzzleUnsolvedOnlyDbAtom, selectedPuzzleDbAtom, tabsAtom } from "@/state/atoms";
import {
  getSolvedPgnPuzzleCount,
  PGN_PUZZLE_PROGRESS_UPDATED_EVENT,
  resetPgnPuzzleProgressForPaths,
} from "@/utils/pgnPuzzleProgress";
import { createTab } from "@/utils/tabs";

type PuzzleVariantFile = {
  title: string;
  path: string;
  puzzleCount: number;
  variantName: string | null;
  depth: number | null;
  mainline: string | null;
  coverageNode: string | null;
  coverageTier: "mainline" | "secondary" | "alternative" | null;
};

function parsePuzzleVariantTags(tags: string[]): {
  variantName: string | null;
  depth: number | null;
  mainline: string | null;
  coverageNode: string | null;
  coverageTier: "mainline" | "secondary" | "alternative" | null;
} {
  const variantName =
    tags
      .find((tag) => tag.startsWith("variant:"))
      ?.slice("variant:".length)
      .trim() || null;
  const depthRaw =
    tags
      .find((tag) => tag.startsWith("depth:"))
      ?.slice("depth:".length)
      .trim() || null;
  const depth = depthRaw ? Number.parseInt(depthRaw, 10) : null;
  const mainline =
    tags
      .find((tag) => tag.startsWith("mainline:"))
      ?.slice("mainline:".length)
      .trim() || null;
  const coverageNode =
    tags
      .find((tag) => tag.startsWith("coverageNode:"))
      ?.slice("coverageNode:".length)
      .trim() || null;
  const coverageTierRaw =
    tags
      .find((tag) => tag.startsWith("coverageTier:"))
      ?.slice("coverageTier:".length)
      .trim()
      .toLowerCase() || null;
  const coverageTier =
    coverageTierRaw === "mainline" || coverageTierRaw === "secondary" || coverageTierRaw === "alternative"
      ? coverageTierRaw
      : null;

  return {
    variantName,
    depth: depthRaw && Number.isFinite(depth) ? depth : null,
    mainline,
    coverageNode,
    coverageTier,
  };
}

function humanizePuzzleTitle(title: string): string {
  const withoutGeneratedSuffix = title.replace(/-(mainline|secondary|alternative)-d\d+-\d{4}\.\d{2}\.\d{2}$/i, "");
  return withoutGeneratedSuffix.replace(/[-_]+/g, " ").trim();
}

function getTierPriority(tier: PuzzleVariantFile["coverageTier"]): number {
  switch (tier) {
    case "mainline":
      return 1;
    case "secondary":
      return 2;
    case "alternative":
      return 3;
    default:
      return 9;
  }
}

function getPuzzleDisplayName(file: PuzzleVariantFile): string {
  const title = humanizePuzzleTitle(file.title);
  if (title.length > 0 && title.toLowerCase() !== (file.variantName ?? "").toLowerCase()) {
    return title;
  }
  if (file.coverageNode && file.coverageNode.trim().length > 0) {
    return file.coverageNode;
  }
  if (file.variantName && file.variantName.trim().length > 0) {
    return file.variantName;
  }
  if (title.length > 0) {
    return title;
  }
  return file.title;
}

const PUZZLE_VARIANTS_UPDATED_EVENT = "puzzle-variants:updated";

export function PuzzleVariantsCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const setSelectedPuzzleDb = useSetAtom(selectedPuzzleDbAtom);
  const setPuzzleUnsolvedOnlyDb = useSetAtom(puzzleUnsolvedOnlyDbAtom);

  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<PuzzleVariantFile[]>([]);
  const [_progressVersion, setProgressVersion] = useState(0);

  const openPuzzles = useCallback(
    (dbPath?: string, unsolvedOnly = false) => {
      if (dbPath) {
        setSelectedPuzzleDb(dbPath);
      }
      setPuzzleUnsolvedOnlyDb(unsolvedOnly && dbPath ? dbPath : null);
      void createTab({
        tab: { name: t("features.tabs.puzzle.title"), type: "puzzles" },
        setTabs,
        setActiveTab,
      });
      navigate({ to: "/puzzles" });
    },
    [navigate, setActiveTab, setPuzzleUnsolvedOnlyDb, setSelectedPuzzleDb, setTabs, t],
  );

  const reloadFiles = useCallback(async () => {
    setLoading(true);
    try {
      const { exists, readDir } = await import("@tauri-apps/plugin-fs");
      const dirs = await loadDirectories();
      const documentsDir = dirs.documentDir;
      if (!(await exists(documentsDir))) {
        setFiles([]);
        return;
      }

      const entries = await readDir(documentsDir);
      const allEntries = await processEntriesRecursively(documentsDir, entries);

      const variantFiles = allEntries
        .filter((entry): entry is FileMetadata => entry.type === "file")
        .filter((file) => file.metadata.type === "puzzle")
        .filter((file) => file.metadata.tags.includes("puzzle-variants"))
        .map((file) => {
          const { variantName, depth, mainline, coverageNode, coverageTier } = parsePuzzleVariantTags(
            file.metadata.tags,
          );
          return {
            title: file.name,
            path: file.path,
            puzzleCount: file.numGames,
            variantName,
            depth,
            mainline,
            coverageNode,
            coverageTier,
          };
        });

      setFiles(variantFiles);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadFiles();
  }, [reloadFiles]);

  useEffect(() => {
    const handleSourcesUpdate = () => {
      void reloadFiles();
    };
    const handleProgressUpdate = () => {
      setProgressVersion((v) => v + 1);
    };

    window.addEventListener(PUZZLE_VARIANTS_UPDATED_EVENT, handleSourcesUpdate);
    window.addEventListener(PGN_PUZZLE_PROGRESS_UPDATED_EVENT, handleProgressUpdate);
    return () => {
      window.removeEventListener(PUZZLE_VARIANTS_UPDATED_EVENT, handleSourcesUpdate);
      window.removeEventListener(PGN_PUZZLE_PROGRESS_UPDATED_EVENT, handleProgressUpdate);
    };
  }, [reloadFiles]);

  const rows = useMemo(() => {
    return files
      .map((file) => {
        const solvedCount = getSolvedPgnPuzzleCount(file.path);
        const safeTotal = Math.max(0, file.puzzleCount);
        const clampedSolved = Math.min(solvedCount, safeTotal);
        const coverage = safeTotal > 0 ? Math.round((clampedSolved / safeTotal) * 100) : 0;
        const displayName = getPuzzleDisplayName(file);
        return { ...file, solvedCount: clampedSolved, coverage, displayName };
      })
      .sort((a, b) => {
        const tierPriorityDiff = getTierPriority(a.coverageTier) - getTierPriority(b.coverageTier);
        if (tierPriorityDiff !== 0) {
          return tierPriorityDiff;
        }
        return a.displayName.localeCompare(b.displayName);
      });
  }, [files]);

  const resetProgress = useCallback(() => {
    try {
      const changed = resetPgnPuzzleProgressForPaths(files.map((file) => file.path));
      notifications.show({
        title: t("common.success", { defaultValue: "Success" }),
        message: t("features.dashboard.puzzleVariants.resetDone", {
          defaultValue: "Progress reset for {{count}} puzzle files.",
          count: changed,
        }),
        color: "green",
      });
    } catch {
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message: t("features.dashboard.puzzleVariants.resetFailed", {
          defaultValue: "Failed to reset puzzle progress.",
        }),
        color: "red",
      });
    }
  }, [files, t]);

  const resetSingleProgress = useCallback(
    (row: { path: string; variantName: string | null; title: string; displayName?: string }) => {
      try {
        const changed = resetPgnPuzzleProgressForPaths([row.path]);
        if (changed === 0) {
          notifications.show({
            title: t("common.success", { defaultValue: "Success" }),
            message: t("features.dashboard.puzzleVariants.resetOneNoChanges", {
              defaultValue: "This puzzle variant had no saved progress.",
            }),
            color: "blue",
          });
          return;
        }
        notifications.show({
          title: t("common.success", { defaultValue: "Success" }),
          message: t("features.dashboard.puzzleVariants.resetOneDone", {
            defaultValue: "Progress reset for {{name}}.",
            name: row.displayName ?? row.variantName ?? row.title,
          }),
          color: "green",
        });
      } catch {
        notifications.show({
          title: t("common.error", { defaultValue: "Error" }),
          message: t("features.dashboard.puzzleVariants.resetFailed", {
            defaultValue: "Failed to reset puzzle progress.",
          }),
          color: "red",
        });
      }
    },
    [t],
  );

  return (
    <Card
      withBorder
      p="lg"
      radius="lg"
      h="100%"
      style={{
        background:
          "radial-gradient(120% 180% at 100% 0%, color-mix(in srgb, var(--mantine-color-cyan-9) 9%, transparent) 0%, transparent 52%), linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-7) 90%, var(--mantine-color-dark-5) 10%), var(--mantine-color-dark-7))",
        borderColor: "color-mix(in srgb, var(--mantine-color-cyan-8) 18%, var(--mantine-color-dark-4))",
      }}
    >
      <Group justify="space-between" mb="md">
        <Group gap="xs">
          <ThemeIcon
            radius="md"
            variant="light"
            color="cyan"
            style={{ border: "1px solid color-mix(in srgb, var(--mantine-color-cyan-7) 30%, transparent)" }}
          >
            <IconPuzzle size={16} />
          </ThemeIcon>
          <Text fw={700}>{t("features.dashboard.puzzleVariants.title", { defaultValue: "Puzzle variants" })}</Text>
        </Group>
        <Group gap="xs">
          <Button
            size="xs"
            radius="md"
            variant="default"
            disabled={rows.length === 0}
            onClick={resetProgress}
            style={{
              borderColor: "color-mix(in srgb, var(--mantine-color-cyan-8) 20%, var(--mantine-color-dark-4))",
              backgroundColor: "color-mix(in srgb, var(--mantine-color-dark-6) 90%, var(--mantine-color-cyan-9) 10%)",
            }}
          >
            {t("features.dashboard.puzzleVariants.resetProgress", { defaultValue: "Reset progress" })}
          </Button>
          <Button
            size="xs"
            radius="md"
            variant="light"
            onClick={() => openPuzzles()}
            leftSection={<IconPuzzle size={16} />}
            style={{
              border: "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 20%, transparent)",
              background:
                "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-blue-8) 84%, var(--mantine-color-blue-7) 16%), color-mix(in srgb, var(--mantine-color-blue-7) 90%, var(--mantine-color-blue-6) 10%))",
            }}
          >
            {t("features.tabs.puzzle.button")}
          </Button>
        </Group>
      </Group>
      {loading ? (
        <Group justify="center" py="md">
          <Loader size="sm" />
        </Group>
      ) : rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("features.dashboard.puzzleVariants.empty", {
            defaultValue: "Generate puzzle variants from Build Variants to see them here.",
          })}
        </Text>
      ) : (
        <ScrollArea
          h={260}
          offsetScrollbars
          style={{
            borderRadius: 12,
            border: "1px solid color-mix(in srgb, var(--mantine-color-cyan-8) 14%, var(--mantine-color-dark-4))",
            background:
              "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-6) 94%, var(--mantine-color-cyan-9) 6%), var(--mantine-color-dark-6))",
            padding: 8,
          }}
        >
          <Stack gap="sm">
            {rows.map((row) => (
              <Box
                key={row.path}
                onClick={() => openPuzzles(row.path)}
                style={{
                  cursor: "pointer",
                  borderRadius: 11,
                  border: "1px solid color-mix(in srgb, var(--mantine-color-cyan-8) 14%, var(--mantine-color-dark-4))",
                  background:
                    "linear-gradient(150deg, color-mix(in srgb, var(--mantine-color-dark-7) 84%, var(--mantine-color-dark-5) 16%), color-mix(in srgb, var(--mantine-color-dark-7) 92%, var(--mantine-color-dark-6) 8%))",
                  padding: "10px 12px",
                }}
              >
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={5} style={{ flex: 1, minWidth: 0 }}>
                    <Group gap="xs" wrap="nowrap">
                      <Text size="sm" fw={600} truncate>
                        {row.displayName}
                      </Text>
                      {row.coverageTier === "mainline" ? (
                        <Badge size="xs" variant="filled" radius="md" color="blue">
                          {t("features.board.variants.mainlineShort", { defaultValue: "ML" })}
                        </Badge>
                      ) : row.coverageTier === "secondary" ? (
                        <Badge size="xs" variant="filled" radius="md" color="green">
                          {t("features.board.variants.secondaryShort", { defaultValue: "Secondary" })}
                        </Badge>
                      ) : row.coverageTier === "alternative" ? (
                        <Badge size="xs" variant="filled" radius="md" color="red">
                          {t("features.board.variants.alternativeShort", { defaultValue: "Alternative" })}
                        </Badge>
                      ) : null}
                    </Group>
                    {row.mainline ? (
                      <Text size="xs" c="dimmed" truncate>
                        {row.mainline}
                      </Text>
                    ) : null}
                    <Progress
                      value={row.coverage}
                      size="xs"
                      radius="xl"
                      color="cyan"
                      style={{
                        backgroundColor:
                          "color-mix(in srgb, var(--mantine-color-dark-5) 86%, var(--mantine-color-dark-4) 14%)",
                      }}
                    />
                  </Stack>

                  <Stack gap={3} align="flex-end" style={{ flexShrink: 0 }}>
                    <Text size="sm" fw={700}>
                      {row.coverage}%
                    </Text>
                    <Text size="xs" c="dimmed">
                      {row.solvedCount}/{row.puzzleCount}
                    </Text>
                    <Button
                      size="compact-xs"
                      radius="md"
                      variant="subtle"
                      onClick={(event) => {
                        event.stopPropagation();
                        resetSingleProgress(row);
                      }}
                    >
                      {t("features.dashboard.puzzleVariants.resetOne", { defaultValue: "Reset" })}
                    </Button>
                    <Button
                      size="compact-xs"
                      radius="md"
                      variant="light"
                      onClick={(event) => {
                        event.stopPropagation();
                        openPuzzles(row.path, true);
                      }}
                      style={{
                        border: "1px solid color-mix(in srgb, var(--mantine-color-cyan-8) 20%, transparent)",
                        backgroundColor:
                          "color-mix(in srgb, var(--mantine-color-cyan-9) 28%, var(--mantine-color-dark-6) 72%)",
                      }}
                    >
                      {t("features.dashboard.puzzleVariants.solveUnsolved", { defaultValue: "Solve Unsolved" })}
                    </Button>
                  </Stack>
                </Group>
              </Box>
            ))}
          </Stack>
        </ScrollArea>
      )}
    </Card>
  );
}
