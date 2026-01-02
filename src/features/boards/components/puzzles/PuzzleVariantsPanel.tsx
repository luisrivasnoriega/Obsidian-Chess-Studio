import { Badge, Divider, Group, Loader, Stack, Text } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import {
  getSolvedPgnPuzzleCount,
  getSolvedPgnPuzzleIndexes,
  PGN_PUZZLE_PROGRESS_UPDATED_EVENT,
} from "@/utils/pgnPuzzleProgress";
import { unwrap } from "@/utils/unwrap";

type PuzzleVariantsInfo = {
  variantName: string | null;
  depth: number | null;
  mainline: string | null;
  puzzleCount: number;
};

const PUZZLE_VARIANTS_UPDATED_EVENT = "puzzle-variants:updated";
const solutionCache = new Map<string, string[]>();

function parsePuzzleVariantTags(tags: string[]): { variantName: string | null; depth: number | null; mainline: string | null } {
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

function extractSolutionHeader(pgn: string): string | null {
  const match = pgn.match(/\[Solution\s+\"([^\"]*)\"\]/i);
  return match?.[1]?.trim() || null;
}

export function PuzzleVariantsPanel({ selectedDb }: { selectedDb: string | null }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<PuzzleVariantsInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [progressVersion, setProgressVersion] = useState(0);
  const [solvedLines, setSolvedLines] = useState<string[]>([]);

  const isPgn = selectedDb?.toLowerCase().endsWith(".pgn") ?? false;

  useEffect(() => {
    const handleProgress = () => setProgressVersion((v) => v + 1);
    const handleSources = () => setProgressVersion((v) => v + 1);

    window.addEventListener(PGN_PUZZLE_PROGRESS_UPDATED_EVENT, handleProgress);
    window.addEventListener(PUZZLE_VARIANTS_UPDATED_EVENT, handleSources);
    return () => {
      window.removeEventListener(PGN_PUZZLE_PROGRESS_UPDATED_EVENT, handleProgress);
      window.removeEventListener(PUZZLE_VARIANTS_UPDATED_EVENT, handleSources);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadInfo = async () => {
      if (!selectedDb || !isPgn) {
        setInfo(null);
        setSolvedLines([]);
        return;
      }

      setLoading(true);
      try {
        const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
        const metadataPath = selectedDb.replace(/\.pgn$/i, ".info");
        if (!(await exists(metadataPath))) {
          setInfo(null);
          setSolvedLines([]);
          return;
        }

        const raw = await readTextFile(metadataPath);
        const metadata = JSON.parse(raw) as { type?: string; tags?: unknown };
        if (metadata.type !== "puzzle") {
          setInfo(null);
          setSolvedLines([]);
          return;
        }

        const tags = Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string") : [];
        if (!tags.includes("puzzle-variants")) {
          setInfo(null);
          setSolvedLines([]);
          return;
        }

        const { variantName, depth, mainline } = parsePuzzleVariantTags(tags);
        const puzzleCount = unwrap(await commands.countPgnGames(selectedDb));

        if (cancelled) return;
        setInfo({ variantName, depth, mainline, puzzleCount });
      } catch {
        if (!cancelled) {
          setInfo(null);
          setSolvedLines([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadInfo();
    return () => {
      cancelled = true;
    };
  }, [isPgn, selectedDb]);

  useEffect(() => {
    let cancelled = false;

    const loadSolvedLines = async () => {
      if (!selectedDb || !info) {
        setSolvedLines([]);
        return;
      }

      const solvedIndexes = getSolvedPgnPuzzleIndexes(selectedDb);
      if (solvedIndexes.length === 0) {
        setSolvedLines([]);
        return;
      }

      const cached = solutionCache.get(selectedDb);
      if (cached) {
        const lines = solvedIndexes.map((idx) => cached[idx]).filter((line): line is string => typeof line === "string" && line.length > 0);
        setSolvedLines(lines);
        return;
      }

      try {
        const games = unwrap(await commands.readGames(selectedDb, 0, Math.max(0, info.puzzleCount - 1)));
        const solutions = games.map((game) => extractSolutionHeader(game) ?? "");
        solutionCache.set(selectedDb, solutions);

        if (cancelled) return;
        const lines = solvedIndexes
          .map((idx) => solutions[idx])
          .filter((line): line is string => typeof line === "string" && line.length > 0);
        setSolvedLines(lines);
      } catch {
        if (!cancelled) setSolvedLines([]);
      }
    };

    void loadSolvedLines();
    return () => {
      cancelled = true;
    };
  }, [info, progressVersion, selectedDb]);

  const solvedCount = useMemo(
    () => (selectedDb && info ? getSolvedPgnPuzzleCount(selectedDb) : 0),
    [info, progressVersion, selectedDb],
  );
  const clampedSolvedCount = useMemo(() => {
    if (!info) return 0;
    return Math.min(solvedCount, Math.max(0, info.puzzleCount));
  }, [info, solvedCount]);
  const coverage = useMemo(() => {
    if (!info) return 0;
    const total = Math.max(0, info.puzzleCount);
    const solved = clampedSolvedCount;
    return total > 0 ? Math.round((solved / total) * 100) : 0;
  }, [clampedSolvedCount, info]);

  return (
    <Stack gap={6}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text fw={600}>{t("features.puzzle.puzzleVariants", { defaultValue: "Puzzle variants" })}</Text>
        {info ? (
          <Badge size="sm" variant="light">
            {coverage}%
          </Badge>
        ) : null}
      </Group>

      {loading ? (
        <Group justify="center" py={4}>
          <Loader size="xs" />
        </Group>
      ) : info ? (
        <>
          <Stack gap={2}>
            <Group gap="xs" wrap="wrap">
              {info.variantName ? (
                <Badge size="sm" variant="light">
                  {info.variantName}
                </Badge>
              ) : null}
              {info.depth != null ? (
                <Badge size="sm" variant="light">
                  d{info.depth}
                </Badge>
              ) : null}
              <Badge size="sm" variant="light">
                {clampedSolvedCount}/{info.puzzleCount}
              </Badge>
            </Group>
            {info.mainline ? (
              <Text size="sm" c="dimmed" lineClamp={2}>
                {info.mainline}
              </Text>
            ) : null}
          </Stack>

          <Divider my={4} />

          <Stack gap={4}>
            <Text size="sm" fw={600}>
              {t("features.puzzle.coveredSubvariants", { defaultValue: "Covered sub-variants" })}
            </Text>
            {solvedLines.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t("features.puzzle.coveredSubvariantsEmpty", { defaultValue: "No solved sub-variants yet." })}
              </Text>
            ) : (
              <Stack gap={2}>
                {solvedLines.slice(0, 10).map((line, index) => (
                  <Text key={`${index}:${line}`} size="xs" c="dimmed" lineClamp={1}>
                    {line}
                  </Text>
                ))}
                {solvedLines.length > 10 ? (
                  <Text size="xs" c="dimmed">
                    {t("features.puzzle.coveredSubvariantsMore", {
                      defaultValue: "+{{count}} more",
                      count: solvedLines.length - 10,
                    })}
                  </Text>
                ) : null}
              </Stack>
            )}
          </Stack>
        </>
      ) : (
        <Text size="sm" c="dimmed">
          {t("features.puzzle.puzzleVariantsDesc", {
            defaultValue: "Build and solve puzzle variants to track your coverage here.",
          })}
        </Text>
      )}
    </Stack>
  );
}
