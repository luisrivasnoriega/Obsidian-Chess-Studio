import {
  Badge,
  Box,
  Button,
  Card,
  Group,
  Loader,
  Progress,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import {
  IconChevronRight,
  IconCrown,
  IconFilter,
  IconPuzzle,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { join } from "@tauri-apps/api/path";
import { exists, readDir, readTextFile, remove } from "@tauri-apps/plugin-fs";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { getPuzzleVariantsDirectory } from "@/features/variants/utils/profileDir";
import {
  activeProfileIdAtom,
  activeTabAtom,
  puzzleUnsolvedOnlyDbAtom,
  selectedPuzzleDbAtom,
  tabsAtom,
} from "@/state/atoms";
import {
  getFirstAttemptPgnPuzzleStats,
  getPgnPuzzleSolveTimeStats,
  getSolvedPgnPuzzleCount,
  PGN_PUZZLE_PROGRESS_UPDATED_EVENT,
  resetPgnPuzzleProgressForPaths,
} from "@/utils/pgnPuzzleProgress";
import {
  PUZZLE_VARIANTS_TAG,
  parsePuzzleVariantTags,
  puzzleVariantMatchesProfile,
} from "@/utils/puzzleVariantMetadata";
import { createTab } from "@/utils/tabs";
import { unwrap } from "@/utils/unwrap";

type PuzzleVariantFile = {
  title: string;
  path: string;
  puzzleCount: number;
  profileId: string | null;
  variantPath: string | null;
  variantName: string | null;
  depth: number | null;
  mainline: string | null;
  coverageNode: string | null;
  coverageTier: "mainline" | "secondary" | "alternative" | null;
  ecoVariant: string | null;
  orientation: "white" | "black" | null;
};

type PriorityFilter = "all" | "1" | "2" | "3";
type CompletionFilter = "all" | "incomplete" | "completed";
type PuzzleColorFilter = "all" | "white" | "black";

function humanizePuzzleTitle(title: string): string {
  const withoutGeneratedSuffix = title.replace(
    /-(mainline|secondary|alternative)-d\d+-\d{4}\.\d{2}\.\d{2}(?:-\d{6})?$/i,
    "",
  );
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

function getTierDisplayLabel(
  t: (key: string, options?: { defaultValue?: string }) => string,
  tier: PuzzleVariantFile["coverageTier"],
): string {
  switch (tier) {
    case "mainline":
      return t("features.dashboard.puzzleVariants.mainlineTier", { defaultValue: "Main line" });
    case "secondary":
      return t("features.dashboard.puzzleVariants.secondaryTier", { defaultValue: "Secondary" });
    case "alternative":
      return t("features.dashboard.puzzleVariants.alternativeTier", { defaultValue: "Alternative" });
    default:
      return t("features.dashboard.puzzleVariants.training", { defaultValue: "Training" });
  }
}

function getTierBadgeColor(tier: PuzzleVariantFile["coverageTier"]): string {
  switch (tier) {
    case "mainline":
      return "blue";
    case "secondary":
      return "green";
    case "alternative":
      return "red";
    default:
      return "gray";
  }
}

function getPuzzleColorLabel(
  t: (key: string, options?: { defaultValue?: string }) => string,
  orientation: PuzzleVariantFile["orientation"],
): string {
  if (orientation === "white") {
    return t("features.dashboard.puzzleVariants.whitePuzzles", { defaultValue: "White" });
  }
  if (orientation === "black") {
    return t("features.dashboard.puzzleVariants.blackPuzzles", { defaultValue: "Black" });
  }
  return t("features.dashboard.puzzleVariants.colorUnknown", { defaultValue: "Unknown" });
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

function normalizeSearchText(value: string | null | undefined): string {
  return `${value ?? ""}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const PUZZLE_VARIANTS_UPDATED_EVENT = "puzzle-variants:updated";
const puzzleVariantCountCache = new Map<string, number>();

function getInfoPath(pgnPath: string): string {
  return pgnPath.replace(/\.pgn$/i, ".info");
}

async function loadPuzzleVariantFilesFromDirectory(
  dir: string,
  activeProfileId: string | null,
): Promise<PuzzleVariantFile[]> {
  if (!(await exists(dir))) {
    return [];
  }

  const entries = await readDir(dir);
  const nested = await Promise.all(
    entries.map(async (entry): Promise<PuzzleVariantFile[]> => {
      const entryPath = await join(dir, entry.name);
      if (entry.isDirectory) {
        return loadPuzzleVariantFilesFromDirectory(entryPath, activeProfileId);
      }
      if (!entry.isFile || !entry.name.toLowerCase().endsWith(".pgn")) {
        return [];
      }

      try {
        const infoPath = getInfoPath(entryPath);
        if (!(await exists(infoPath))) {
          return [];
        }

        const metadata = JSON.parse(await readTextFile(infoPath)) as { type?: unknown; tags?: unknown };
        const tags = Array.isArray(metadata.tags)
          ? metadata.tags.filter((tag): tag is string => typeof tag === "string")
          : [];
        if (metadata.type !== "puzzle" || !tags.includes(PUZZLE_VARIANTS_TAG)) {
          return [];
        }
        if (!puzzleVariantMatchesProfile(tags, activeProfileId)) {
          return [];
        }

        const {
          profileId,
          variantPath,
          variantName,
          depth,
          mainline,
          coverageNode,
          coverageTier,
          ecoVariant,
          orientation,
        } = parsePuzzleVariantTags(tags);
        let puzzleCount = puzzleVariantCountCache.get(entryPath);
        if (puzzleCount === undefined) {
          puzzleCount = unwrap(await commands.countPgnGames(entryPath));
          puzzleVariantCountCache.set(entryPath, puzzleCount);
        }

        return [
          {
            title: entry.name.replace(/\.pgn$/i, ""),
            path: entryPath,
            puzzleCount,
            profileId,
            variantPath,
            variantName,
            depth,
            mainline,
            coverageNode,
            coverageTier,
            ecoVariant,
            orientation,
          },
        ];
      } catch {
        return [];
      }
    }),
  );

  return nested.flat();
}

async function removePuzzleVariantFiles(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (path) => {
      const infoPath = getInfoPath(path);
      puzzleVariantCountCache.delete(path);
      if (await exists(path)) {
        await remove(path);
      }
      if (await exists(infoPath)) {
        await remove(infoPath);
      }
    }),
  );
}

export function PuzzleVariantsCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const setSelectedPuzzleDb = useSetAtom(selectedPuzzleDbAtom);
  const setPuzzleUnsolvedOnlyDb = useSetAtom(puzzleUnsolvedOnlyDbAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const isMobile = useMediaQuery("(max-width: 48em)");

  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<PuzzleVariantFile[]>([]);
  const [progressVersion, setProgressVersion] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [completionFilter, setCompletionFilter] = useState<CompletionFilter>("all");
  const [colorFilter, setColorFilter] = useState<PuzzleColorFilter>("all");

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
      const puzzleVariantsDir = await getPuzzleVariantsDirectory(activeProfileId);
      setFiles(await loadPuzzleVariantFilesFromDirectory(puzzleVariantsDir, activeProfileId ?? null));
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [activeProfileId]);

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
    void progressVersion;
    return files
      .map((file) => {
        const solvedCount = getSolvedPgnPuzzleCount(file.path);
        const safeTotal = Math.max(0, file.puzzleCount);
        const clampedSolved = Math.min(solvedCount, safeTotal);
        const coverage = safeTotal > 0 ? Math.round((clampedSolved / safeTotal) * 100) : 0;
        const firstAttemptStats = getFirstAttemptPgnPuzzleStats(file.path);
        const accuracy =
          firstAttemptStats.attempted > 0
            ? Math.round((firstAttemptStats.correct / firstAttemptStats.attempted) * 100)
            : 0;
        const solveTimeStats = getPgnPuzzleSolveTimeStats(file.path);
        const averageSolveTime =
          solveTimeStats.averageMs == null ? "--" : t("units.duration", { duration: solveTimeStats.averageMs });
        const displayName = getPuzzleDisplayName(file);
        return {
          ...file,
          solvedCount: clampedSolved,
          coverage,
          accuracy,
          attemptedCount: firstAttemptStats.attempted,
          averageSolveTime,
          displayName,
          isCompleted: safeTotal > 0 && coverage >= 100 && accuracy > 95,
        };
      })
      .sort((a, b) => {
        const tierPriorityDiff = getTierPriority(a.coverageTier) - getTierPriority(b.coverageTier);
        if (tierPriorityDiff !== 0) {
          return tierPriorityDiff;
        }
        return a.displayName.localeCompare(b.displayName);
      });
  }, [files, progressVersion, t]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = normalizeSearchText(searchQuery);
    return rows.filter((row) => {
      const priority = getTierPriority(row.coverageTier);
      if (priorityFilter !== "all" && priority !== Number(priorityFilter)) {
        return false;
      }
      if (completionFilter === "completed" && !row.isCompleted) {
        return false;
      }
      if (completionFilter === "incomplete" && row.isCompleted) {
        return false;
      }
      if (colorFilter !== "all" && row.orientation !== colorFilter) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }

      const tierLabel = getTierDisplayLabel(t, row.coverageTier);
      const priorityTokens = [
        `${priority}`,
        `p${priority}`,
        `priority ${priority}`,
        `priority:${priority}`,
        row.coverageTier === "mainline" ? "ml" : "",
      ];
      const searchable = [
        row.displayName,
        row.title,
        row.variantName,
        row.coverageNode,
        row.ecoVariant,
        row.mainline,
        row.orientation,
        row.coverageTier,
        tierLabel,
        ...priorityTokens,
      ]
        .map(normalizeSearchText)
        .filter(Boolean)
        .join(" ");
      return searchable.includes(normalizedQuery);
    });
  }, [colorFilter, completionFilter, priorityFilter, rows, searchQuery, t]);

  const priorityFilterOptions = useMemo(
    () => [
      { value: "all", label: t("features.dashboard.puzzleVariants.priorityAll", { defaultValue: "All priorities" }) },
      { value: "1", label: t("features.dashboard.puzzleVariants.priorityOne", { defaultValue: "Priority 1 - ML" }) },
      {
        value: "2",
        label: t("features.dashboard.puzzleVariants.priorityTwo", { defaultValue: "Priority 2 - Secondary" }),
      },
      {
        value: "3",
        label: t("features.dashboard.puzzleVariants.priorityThree", { defaultValue: "Priority 3 - Alternative" }),
      },
    ],
    [t],
  );

  const completionFilterOptions = useMemo(
    () => [
      { value: "all", label: t("features.dashboard.puzzleVariants.completionAll", { defaultValue: "All progress" }) },
      {
        value: "incomplete",
        label: t("features.dashboard.puzzleVariants.completionIncomplete", { defaultValue: "Hide completed" }),
      },
      {
        value: "completed",
        label: t("features.dashboard.puzzleVariants.completionCompleted", { defaultValue: "Completed only" }),
      },
    ],
    [t],
  );

  const colorFilterOptions = useMemo(
    () => [
      { value: "all", label: t("features.dashboard.puzzleVariants.colorAll", { defaultValue: "All colors" }) },
      { value: "white", label: t("features.dashboard.puzzleVariants.whitePuzzles", { defaultValue: "White" }) },
      { value: "black", label: t("features.dashboard.puzzleVariants.blackPuzzles", { defaultValue: "Black" }) },
    ],
    [t],
  );

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

  const deletePuzzleVariants = useCallback(
    async (targets: Array<{ path: string }>) => {
      const paths = targets.map((target) => target.path);
      if (paths.length === 0) return;

      try {
        await removePuzzleVariantFiles(paths);
        resetPgnPuzzleProgressForPaths(paths);
        const pathSet = new Set(paths);
        setFiles((current) => current.filter((file) => !pathSet.has(file.path)));
        setSelectedPuzzleDb((current) => (current && pathSet.has(current) ? null : current));
        setPuzzleUnsolvedOnlyDb((current) => (current && pathSet.has(current) ? null : current));

        try {
          window.dispatchEvent(new Event("puzzles:updated"));
          window.dispatchEvent(new Event(PUZZLE_VARIANTS_UPDATED_EVENT));
        } catch {}

        notifications.show({
          title: t("common.success", { defaultValue: "Success" }),
          message: t("features.dashboard.puzzleVariants.deleteDone", {
            defaultValue: "Deleted {{count}} puzzle variant files.",
            count: paths.length,
          }),
          color: "green",
        });
      } catch {
        notifications.show({
          title: t("common.error", { defaultValue: "Error" }),
          message: t("features.dashboard.puzzleVariants.deleteFailed", {
            defaultValue: "Failed to delete puzzle variants.",
          }),
          color: "red",
        });
      }
    },
    [setPuzzleUnsolvedOnlyDb, setSelectedPuzzleDb, t],
  );

  const confirmDeletePuzzleVariant = useCallback(
    (row: { path: string; displayName: string }) => {
      modals.openConfirmModal({
        title: t("features.dashboard.puzzleVariants.deleteOneTitle", { defaultValue: "Delete puzzle variant" }),
        children: (
          <Text size="sm">
            {t("features.dashboard.puzzleVariants.deleteOneConfirm", {
              defaultValue: "Delete {{name}} and its saved progress?",
              name: row.displayName,
            })}
          </Text>
        ),
        labels: {
          confirm: t("features.dashboard.puzzleVariants.deleteOne", { defaultValue: "Delete" }),
          cancel: t("common.cancel", { defaultValue: "Cancel" }),
        },
        confirmProps: { color: "red" },
        onConfirm: () => void deletePuzzleVariants([row]),
      });
    },
    [deletePuzzleVariants, t],
  );

  const confirmDeleteAllPuzzleVariants = useCallback(() => {
    modals.openConfirmModal({
      title: t("features.dashboard.puzzleVariants.deleteAllTitle", { defaultValue: "Delete puzzle variants" }),
      children: (
        <Text size="sm">
          {t("features.dashboard.puzzleVariants.deleteAllConfirm", {
            defaultValue: "Delete {{count}} puzzle variant files and their saved progress?",
            count: rows.length,
          })}
        </Text>
      ),
      labels: {
        confirm: t("features.dashboard.puzzleVariants.deleteAll", { defaultValue: "Delete all" }),
        cancel: t("common.cancel", { defaultValue: "Cancel" }),
      },
      confirmProps: { color: "red" },
      onConfirm: () => void deletePuzzleVariants(rows),
    });
  }, [deletePuzzleVariants, rows, t]);

  return (
    <Card
      withBorder
      p="xl"
      radius="lg"
      h="100%"
      style={{
        background:
          "radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 22%, transparent) 0%, transparent 52%), radial-gradient(120% 90% at 100% 0%, color-mix(in srgb, var(--mantine-color-cyan-9) 14%, transparent) 0%, transparent 55%), linear-gradient(145deg, #030812, #07111f 52%, #050a13)",
        borderColor: "rgba(96, 165, 250, 0.22)",
        boxShadow: "0 20px 70px rgba(0, 0, 0, 0.28)",
      }}
    >
      <Stack gap="xl">
        <Group justify="space-between" align="flex-start" gap="lg" wrap="wrap">
          <Group gap="md" align="flex-start" style={{ flex: "1 1 260px" }}>
            <ThemeIcon
              radius="lg"
              variant="light"
              color="cyan"
              size={58}
              style={{
                border: "1px solid rgba(34, 211, 238, 0.42)",
                background: "linear-gradient(145deg, rgba(8, 47, 73, 0.72), rgba(2, 8, 23, 0.9))",
                boxShadow: "0 0 34px rgba(34, 211, 238, 0.16)",
              }}
            >
              <IconPuzzle size={28} />
            </ThemeIcon>
            <Stack gap={4} style={{ minWidth: 0 }}>
              <Text fw={800} fz={28} lh={1.1}>
                {t("features.dashboard.puzzleVariants.title", { defaultValue: "Puzzle variants" })}
              </Text>
              <Text size="sm" c="dimmed" lh={1.45}>
                {t("features.dashboard.puzzleVariants.subtitle", {
                  defaultValue: "Track progress and solve puzzles for each variant.",
                })}
              </Text>
            </Stack>
          </Group>

          <Group gap="sm" wrap="wrap" justify="flex-end">
            <Button
              size="md"
              radius="md"
              variant="default"
              disabled={rows.length === 0}
              onClick={resetProgress}
              leftSection={<IconRefresh size={18} />}
              style={{
                borderColor: "rgba(148, 163, 184, 0.32)",
                backgroundColor: "rgba(15, 23, 42, 0.72)",
              }}
            >
              {t("features.dashboard.puzzleVariants.resetProgress", { defaultValue: "Reset progress" })}
            </Button>
            <Button
              size="md"
              radius="md"
              variant="light"
              onClick={() => openPuzzles()}
              leftSection={<IconPuzzle size={18} />}
              style={{
                border: "1px solid rgba(14, 165, 233, 0.44)",
                background: "linear-gradient(145deg, #0b63f6, #0647b8)",
                color: "white",
              }}
            >
              {t("features.tabs.puzzle.button")}
            </Button>
            <Button
              size="md"
              radius="md"
              variant="default"
              color="red"
              disabled={rows.length === 0}
              onClick={confirmDeleteAllPuzzleVariants}
              leftSection={<IconTrash size={18} />}
              style={{
                borderColor: "rgba(248, 113, 113, 0.32)",
                backgroundColor: "rgba(15, 23, 42, 0.72)",
                color: "var(--mantine-color-red-3)",
              }}
            >
              {t("features.dashboard.puzzleVariants.deleteAll", { defaultValue: "Delete all" })}
            </Button>
          </Group>
        </Group>

        {rows.length > 0 ? (
          <Group gap="sm" align="flex-end" wrap="wrap">
            <TextInput
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder={t("features.dashboard.puzzleVariants.searchPlaceholder", {
                defaultValue: "Search by name, ECO, tier, or priority",
              })}
              leftSection={<IconSearch size={16} />}
              style={{ flex: "1 1 320px" }}
              styles={{
                input: {
                  backgroundColor: "rgba(15, 23, 42, 0.72)",
                  borderColor: "rgba(96, 165, 250, 0.22)",
                },
              }}
            />
            <Select
              value={priorityFilter}
              onChange={(value) => setPriorityFilter((value as PriorityFilter | null) ?? "all")}
              data={priorityFilterOptions}
              leftSection={<IconFilter size={16} />}
              allowDeselect={false}
              style={{ flex: "0 1 260px" }}
              styles={{
                input: {
                  backgroundColor: "rgba(15, 23, 42, 0.72)",
                  borderColor: "rgba(96, 165, 250, 0.22)",
                },
              }}
            />
            <Select
              value={completionFilter}
              onChange={(value) => setCompletionFilter((value as CompletionFilter | null) ?? "all")}
              data={completionFilterOptions}
              allowDeselect={false}
              style={{ flex: "0 1 220px" }}
              styles={{
                input: {
                  backgroundColor: "rgba(15, 23, 42, 0.72)",
                  borderColor: "rgba(96, 165, 250, 0.22)",
                },
              }}
            />
            <Select
              value={colorFilter}
              onChange={(value) => setColorFilter((value as PuzzleColorFilter | null) ?? "all")}
              data={colorFilterOptions}
              allowDeselect={false}
              style={{ flex: "0 1 180px" }}
              styles={{
                input: {
                  backgroundColor: "rgba(15, 23, 42, 0.72)",
                  borderColor: "rgba(96, 165, 250, 0.22)",
                },
              }}
            />
          </Group>
        ) : null}

        {loading ? (
          <Group justify="center" py="xl">
            <Loader size="sm" />
          </Group>
        ) : rows.length === 0 ? (
          <Box
            p="lg"
            style={{
              borderRadius: 16,
              border: "1px solid rgba(96, 165, 250, 0.18)",
              background: "rgba(15, 23, 42, 0.48)",
            }}
          >
            <Text size="sm" c="dimmed">
              {t("features.dashboard.puzzleVariants.empty", {
                defaultValue: "Generate puzzle variants from Build Variants to see them here.",
              })}
            </Text>
          </Box>
        ) : filteredRows.length === 0 ? (
          <Box
            p="lg"
            style={{
              borderRadius: 16,
              border: "1px solid rgba(96, 165, 250, 0.18)",
              background: "rgba(15, 23, 42, 0.48)",
            }}
          >
            <Text size="sm" c="dimmed">
              {t("features.dashboard.puzzleVariants.noMatches", {
                defaultValue: "No puzzle variants match the current filters.",
              })}
            </Text>
          </Box>
        ) : (
          <ScrollArea.Autosize mah={isMobile ? "calc(100dvh - 260px)" : 620} offsetScrollbars>
            {isMobile ? (
              <SimpleGrid cols={2} spacing="xs" verticalSpacing="xs">
                {filteredRows.map((row) => {
                  const tierLabel = getTierDisplayLabel(t, row.coverageTier);
                  return (
                    <Box
                      key={row.path}
                      onClick={() => openPuzzles(row.path)}
                      style={{
                        cursor: "pointer",
                        borderRadius: 10,
                        border: "1px solid rgba(96, 165, 250, 0.2)",
                        background: "rgba(15, 23, 42, 0.72)",
                        padding: 10,
                        minHeight: 168,
                      }}
                    >
                      <Stack gap={7} h="100%">
                        <Group gap={4} justify="space-between" wrap="nowrap">
                          <Badge
                            size="xs"
                            radius="xl"
                            variant="filled"
                            color={getTierBadgeColor(row.coverageTier)}
                            style={{ maxWidth: "58%" }}
                          >
                            {row.coverageTier === "mainline"
                              ? t("features.board.variants.mainlineShort", { defaultValue: "ML" })
                              : tierLabel}
                          </Badge>
                          <Badge size="xs" radius="xl" variant="outline" color="gray" style={{ flexShrink: 0 }}>
                            {getPuzzleColorLabel(t, row.orientation)}
                          </Badge>
                        </Group>

                        <Text fw={800} size="sm" lh={1.15} lineClamp={2}>
                          {row.displayName}
                        </Text>

                        {row.ecoVariant ? (
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {row.ecoVariant}
                          </Text>
                        ) : null}

                        <Group gap={4} justify="space-between" wrap="nowrap" mt="auto">
                          <Text size="xs" c="dimmed" truncate>
                            {row.solvedCount}/{row.puzzleCount}
                          </Text>
                          <Text size="xs" c={row.isCompleted ? "teal.3" : "blue.3"} fw={800}>
                            {row.accuracy}%
                          </Text>
                        </Group>

                        <Progress
                          value={row.coverage}
                          size={5}
                          radius="xl"
                          color={row.isCompleted ? "teal" : "cyan"}
                          style={{ backgroundColor: "rgba(148, 163, 184, 0.16)" }}
                        />

                        <Group gap={6} wrap="nowrap">
                          <Button
                            size="xs"
                            radius="md"
                            leftSection={<IconPuzzle size={14} />}
                            onClick={(event) => {
                              event.stopPropagation();
                              openPuzzles(row.path, true);
                            }}
                            style={{ flex: 1 }}
                          >
                            {t("features.dashboard.puzzleVariants.solveShort", { defaultValue: "Solve" })}
                          </Button>
                          <Button
                            size="xs"
                            radius="md"
                            variant="default"
                            aria-label={t("features.dashboard.puzzleVariants.resetOne", { defaultValue: "Reset" })}
                            onClick={(event) => {
                              event.stopPropagation();
                              resetSingleProgress(row);
                            }}
                            style={{
                              width: 34,
                              paddingInline: 0,
                              borderColor: "rgba(96, 165, 250, 0.22)",
                              backgroundColor: "rgba(15, 23, 42, 0.72)",
                            }}
                          >
                            <IconRefresh size={14} />
                          </Button>
                          <Button
                            size="xs"
                            radius="md"
                            variant="default"
                            color="red"
                            aria-label={t("features.dashboard.puzzleVariants.deleteOne", { defaultValue: "Delete" })}
                            onClick={(event) => {
                              event.stopPropagation();
                              confirmDeletePuzzleVariant(row);
                            }}
                            style={{
                              width: 34,
                              paddingInline: 0,
                              borderColor: "rgba(248, 113, 113, 0.26)",
                              backgroundColor: "rgba(15, 23, 42, 0.72)",
                              color: "var(--mantine-color-red-3)",
                            }}
                          >
                            <IconTrash size={14} />
                          </Button>
                        </Group>
                      </Stack>
                    </Box>
                  );
                })}
              </SimpleGrid>
            ) : (
              <Stack gap="md">
                {filteredRows.map((row) => {
                  const tierLabel = getTierDisplayLabel(t, row.coverageTier);
                  return (
                    <Box
                      key={row.path}
                      onClick={() => openPuzzles(row.path)}
                      style={{
                        cursor: "pointer",
                        borderRadius: 18,
                        border: "1px solid rgba(96, 165, 250, 0.18)",
                        background:
                          "radial-gradient(90% 120% at 0% 50%, rgba(14, 165, 233, 0.1), transparent 52%), linear-gradient(145deg, rgba(8, 19, 34, 0.94), rgba(6, 13, 25, 0.96))",
                        boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.04)",
                        padding: "18px",
                      }}
                    >
                      <Box style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
                        <Group gap="md" wrap="nowrap" style={{ flex: "1.25 1 360px", minWidth: 0 }}>
                          <ThemeIcon
                            radius="50%"
                            variant="light"
                            color="cyan"
                            size={64}
                            style={{
                              border: "2px solid rgba(34, 211, 238, 0.84)",
                              background: "radial-gradient(circle, rgba(14, 165, 233, 0.24), rgba(2, 8, 23, 0.92))",
                              boxShadow: "0 0 0 8px rgba(14, 165, 233, 0.08), 0 0 30px rgba(34, 211, 238, 0.24)",
                              flexShrink: 0,
                            }}
                          >
                            <IconCrown size={28} />
                          </ThemeIcon>

                          <Stack gap={6} style={{ minWidth: 0, flex: 1 }}>
                            <Group gap="xs" wrap="nowrap">
                              <Text fw={800} fz={22} lh={1.1} truncate>
                                {row.displayName}
                              </Text>
                              <Badge
                                size="md"
                                radius="xl"
                                variant="filled"
                                color={getTierBadgeColor(row.coverageTier)}
                                style={{ flexShrink: 0 }}
                              >
                                {row.coverageTier === "mainline"
                                  ? t("features.board.variants.mainlineShort", { defaultValue: "ML" })
                                  : tierLabel}
                              </Badge>
                              <Badge size="md" radius="xl" variant="outline" color="gray" style={{ flexShrink: 0 }}>
                                {getPuzzleColorLabel(t, row.orientation)}
                              </Badge>
                            </Group>

                            {row.ecoVariant ? (
                              <Text size="sm" c="dimmed" truncate>
                                {row.ecoVariant}
                              </Text>
                            ) : null}

                            <Text size="sm" c="dimmed" truncate>
                              {t("features.dashboard.puzzleVariants.trainingSet", {
                                defaultValue: "{{tier}} training set",
                                tier: tierLabel,
                              })}
                            </Text>

                            <Group gap="xs" wrap="nowrap">
                              <IconPuzzle size={18} color="var(--mantine-color-blue-3)" />
                              <Text size="sm" c="dimmed">
                                {t("features.dashboard.puzzleVariants.puzzleCount", {
                                  defaultValue: "{{count}} puzzles",
                                  count: row.puzzleCount,
                                })}
                              </Text>
                            </Group>
                          </Stack>
                        </Group>

                        <Box
                          style={{
                            flex: "1 1 390px",
                            minWidth: "min(320px, 100%)",
                            borderLeft: "1px solid rgba(148, 163, 184, 0.18)",
                            borderRight: "1px solid rgba(148, 163, 184, 0.18)",
                            padding: "4px 22px",
                          }}
                        >
                          <Group grow gap={0} wrap="nowrap">
                            <Stack gap={2} align="center">
                              <Text fw={800} fz={25}>
                                {row.coverage}%
                              </Text>
                              <Text size="xs" c="dimmed">
                                {t("features.dashboard.puzzleVariants.progress", { defaultValue: "Progress" })}
                              </Text>
                            </Stack>
                            <Stack gap={2} align="center">
                              <Text fw={800} fz={25}>
                                {row.solvedCount}
                                <Text span fz={16} c="dimmed" fw={500}>
                                  /{row.puzzleCount}
                                </Text>
                              </Text>
                              <Text size="xs" c="dimmed">
                                {t("features.dashboard.puzzleVariants.solved", { defaultValue: "Solved" })}
                              </Text>
                            </Stack>
                            <Stack gap={2} align="center">
                              <Text fw={800} fz={25}>
                                {row.accuracy}%
                              </Text>
                              <Text size="xs" c="dimmed" ta="center">
                                {t("features.dashboard.puzzleVariants.solvedAccuracy", {
                                  defaultValue: "Solved accuracy",
                                })}
                              </Text>
                            </Stack>
                            <Stack gap={2} align="center">
                              <Text fw={800} fz={22}>
                                {row.averageSolveTime}
                              </Text>
                              <Text size="xs" c="dimmed" ta="center">
                                {t("features.dashboard.puzzleVariants.averageSolveTime", {
                                  defaultValue: "Avg time",
                                })}
                              </Text>
                            </Stack>
                          </Group>

                          <Group gap="sm" mt="lg" wrap="nowrap">
                            <Progress
                              value={row.coverage}
                              size="sm"
                              radius="xl"
                              color="cyan"
                              style={{
                                flex: 1,
                                backgroundColor: "rgba(148, 163, 184, 0.16)",
                              }}
                            />
                            <Text size="sm" c="blue.4" fw={700} style={{ minWidth: 42, textAlign: "right" }}>
                              {row.coverage}%
                            </Text>
                          </Group>
                        </Box>

                        <Stack gap="sm" style={{ flex: "0 1 220px", minWidth: 190, marginLeft: "auto" }}>
                          <Button
                            size="sm"
                            radius="md"
                            fullWidth
                            rightSection={<IconChevronRight size={18} />}
                            leftSection={<IconPuzzle size={18} />}
                            onClick={(event) => {
                              event.stopPropagation();
                              openPuzzles(row.path, true);
                            }}
                            style={{
                              border: "1px solid rgba(14, 165, 233, 0.52)",
                              background: "linear-gradient(145deg, #0b63f6, #0647b8)",
                              color: "white",
                            }}
                          >
                            {t("features.dashboard.puzzleVariants.solveUnsolved", { defaultValue: "Solve Unsolved" })}
                          </Button>

                          <Group grow gap="sm" wrap="nowrap">
                            <Button
                              size="sm"
                              radius="md"
                              variant="default"
                              leftSection={<IconRefresh size={16} />}
                              onClick={(event) => {
                                event.stopPropagation();
                                resetSingleProgress(row);
                              }}
                              style={{
                                borderColor: "rgba(96, 165, 250, 0.22)",
                                backgroundColor: "rgba(15, 23, 42, 0.72)",
                              }}
                            >
                              {t("features.dashboard.puzzleVariants.resetOne", { defaultValue: "Reset" })}
                            </Button>
                            <Button
                              size="sm"
                              radius="md"
                              variant="default"
                              color="red"
                              leftSection={<IconTrash size={16} />}
                              onClick={(event) => {
                                event.stopPropagation();
                                confirmDeletePuzzleVariant(row);
                              }}
                              style={{
                                borderColor: "rgba(248, 113, 113, 0.26)",
                                backgroundColor: "rgba(15, 23, 42, 0.72)",
                                color: "var(--mantine-color-red-3)",
                              }}
                            >
                              {t("features.dashboard.puzzleVariants.deleteOne", { defaultValue: "Delete" })}
                            </Button>
                          </Group>
                        </Stack>
                      </Box>
                    </Box>
                  );
                })}
              </Stack>
            )}
          </ScrollArea.Autosize>
        )}
      </Stack>
    </Card>
  );
}
