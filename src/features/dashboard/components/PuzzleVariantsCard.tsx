import { Badge, Button, Card, Group, Loader, ScrollArea, Stack, Text } from "@mantine/core";
import { IconPuzzle } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadDirectories } from "@/App";
import { processEntriesRecursively, type FileMetadata } from "@/features/files/utils/file";
import { activeTabAtom, selectedPuzzleDbAtom, tabsAtom } from "@/state/atoms";
import { getSolvedPgnPuzzleCount, PGN_PUZZLE_PROGRESS_UPDATED_EVENT } from "@/utils/pgnPuzzleProgress";
import { createTab } from "@/utils/tabs";

type PuzzleVariantFile = {
  title: string;
  path: string;
  puzzleCount: number;
  variantName: string | null;
  depth: number | null;
  mainline: string | null;
};

function parsePuzzleVariantTags(tags: string[]): {
  variantName: string | null;
  depth: number | null;
  mainline: string | null;
} {
  const variantName = tags.find((tag) => tag.startsWith("variant:"))?.slice("variant:".length).trim() || null;
  const depthRaw = tags.find((tag) => tag.startsWith("depth:"))?.slice("depth:".length).trim() || null;
  const depth = depthRaw ? Number.parseInt(depthRaw, 10) : null;
  const mainline = tags.find((tag) => tag.startsWith("mainline:"))?.slice("mainline:".length).trim() || null;

  return {
    variantName,
    depth: depthRaw && Number.isFinite(depth) ? depth : null,
    mainline,
  };
}

const PUZZLE_VARIANTS_UPDATED_EVENT = "puzzle-variants:updated";

export function PuzzleVariantsCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const setSelectedPuzzleDb = useSetAtom(selectedPuzzleDbAtom);

  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<PuzzleVariantFile[]>([]);
  const [progressVersion, setProgressVersion] = useState(0);

  const openPuzzles = useCallback(
    (dbPath?: string) => {
      if (dbPath) {
        setSelectedPuzzleDb(dbPath);
      }
      void createTab({
        tab: { name: t("features.tabs.puzzle.title"), type: "puzzles" },
        setTabs,
        setActiveTab,
      });
      navigate({ to: "/puzzles" });
    },
    [navigate, setActiveTab, setSelectedPuzzleDb, setTabs, t],
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
          const { variantName, depth, mainline } = parsePuzzleVariantTags(file.metadata.tags);
          return {
            title: file.name,
            path: file.path,
            puzzleCount: file.numGames,
            variantName,
            depth,
            mainline,
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title));

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
    return files.map((file) => {
      const solvedCount = getSolvedPgnPuzzleCount(file.path);
      const safeTotal = Math.max(0, file.puzzleCount);
      const clampedSolved = Math.min(solvedCount, safeTotal);
      const coverage = safeTotal > 0 ? Math.round((clampedSolved / safeTotal) * 100) : 0;
      return { ...file, solvedCount: clampedSolved, coverage };
    });
  }, [files, progressVersion]);

  return (
    <Card withBorder p="lg" radius="md" h="100%">
      <Group justify="space-between" mb="sm">
        <Text fw={700}>{t("features.dashboard.puzzleVariants.title", { defaultValue: "Puzzle variants" })}</Text>
        <Button size="xs" variant="light" onClick={() => openPuzzles()} leftSection={<IconPuzzle size={16} />}>
          {t("features.tabs.puzzle.button")}
        </Button>
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
        <ScrollArea h={220} offsetScrollbars>
          <Stack gap="sm">
            {rows.map((row) => (
              <Group
                key={row.path}
                justify="space-between"
                wrap="nowrap"
                onClick={() => openPuzzles(row.path)}
                style={{ cursor: "pointer" }}
              >
                <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Group gap="xs" wrap="nowrap">
                    <Text size="sm" fw={600} truncate>
                      {row.variantName ?? row.title}
                    </Text>
                    {row.depth != null && (
                      <Badge size="xs" variant="light">
                        d{row.depth}
                      </Badge>
                    )}
                  </Group>
                  {row.mainline ? (
                    <Text size="xs" c="dimmed" truncate>
                      {row.mainline}
                    </Text>
                  ) : null}
                </Stack>

                <Stack gap={0} align="flex-end" style={{ flexShrink: 0 }}>
                  <Text size="sm" fw={700}>
                    {row.coverage}%
                  </Text>
                  <Text size="xs" c="dimmed">
                    {row.solvedCount}/{row.puzzleCount}
                  </Text>
                </Stack>
              </Group>
            ))}
          </Stack>
        </ScrollArea>
      )}
    </Card>
  );
}
