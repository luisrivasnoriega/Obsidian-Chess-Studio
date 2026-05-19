import { Badge, Divider, Group, Loader, Stack, Text } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import {
  getFirstAttemptPgnPuzzleStats,
  getPgnPuzzleSolveTimeStats,
  getSolvedPgnPuzzleCount,
  PGN_PUZZLE_PROGRESS_UPDATED_EVENT,
} from "@/utils/pgnPuzzleProgress";
import type { Puzzle } from "@/utils/puzzles";
import { PUZZLE_VARIANTS_TAG, parsePuzzleVariantTags } from "@/utils/puzzleVariantMetadata";
import { unwrap } from "@/utils/unwrap";

type PuzzleVariantsInfo = {
  displayName: string;
  profileId: string | null;
  variantPath: string | null;
  variantName: string | null;
  depth: number | null;
  mainline: string | null;
  coverageNode: string | null;
  coverageTier: "mainline" | "secondary" | "alternative" | null;
  ecoVariant: string | null;
  puzzleCount: number;
};

const PUZZLE_VARIANTS_UPDATED_EVENT = "puzzle-variants:updated";
const solutionCache = new Map<string, string[]>();
const openingCache = new Map<string, string[]>();
const PUZZLE_SOLUTION_CACHE_LIMIT = 12;

function getCachedSolutions(dbPath: string): string[] | null {
  const cached = solutionCache.get(dbPath) ?? null;
  if (!cached) return null;
  solutionCache.delete(dbPath);
  solutionCache.set(dbPath, cached);
  return cached;
}

function setCachedSolutions(dbPath: string, solutions: string[]) {
  if (solutionCache.has(dbPath)) {
    solutionCache.delete(dbPath);
  }
  solutionCache.set(dbPath, solutions);
  while (solutionCache.size > PUZZLE_SOLUTION_CACHE_LIMIT) {
    const oldest = solutionCache.keys().next().value;
    if (oldest === undefined) break;
    solutionCache.delete(oldest);
  }
}

function getCachedOpenings(dbPath: string): string[] | null {
  const cached = openingCache.get(dbPath) ?? null;
  if (!cached) return null;
  openingCache.delete(dbPath);
  openingCache.set(dbPath, cached);
  return cached;
}

function setCachedOpenings(dbPath: string, openings: string[]) {
  if (openingCache.has(dbPath)) {
    openingCache.delete(dbPath);
  }
  openingCache.set(dbPath, openings);
  while (openingCache.size > PUZZLE_SOLUTION_CACHE_LIMIT) {
    const oldest = openingCache.keys().next().value;
    if (oldest === undefined) break;
    openingCache.delete(oldest);
  }
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").toLowerCase();
}

function getFileStem(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const filename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  return filename.replace(/\.pgn$/i, "");
}

function humanizePuzzleTitle(title: string): string {
  const withoutGeneratedSuffix = title.replace(
    /-(mainline|secondary|alternative)-d\d+-\d{4}\.\d{2}\.\d{2}(?:-\d{6})?$/i,
    "",
  );
  return withoutGeneratedSuffix.replace(/[-_]+/g, " ").trim();
}

function getPuzzleDisplayName(stem: string, parsed: ReturnType<typeof parsePuzzleVariantTags>): string {
  const humanizedStem = humanizePuzzleTitle(stem);
  if (humanizedStem.length > 0 && humanizedStem.toLowerCase() !== (parsed.variantName ?? "").toLowerCase()) {
    return humanizedStem;
  }
  if (parsed.coverageNode && parsed.coverageNode.trim().length > 0) {
    return parsed.coverageNode;
  }
  if (parsed.variantName && parsed.variantName.trim().length > 0) {
    return parsed.variantName;
  }
  return stem;
}

function extractSolutionHeader(pgn: string): string | null {
  const match = pgn.match(/\[Solution\s+"([^"]*)"\]/i);
  return match?.[1]?.trim() || null;
}

function extractTagHeader(pgn: string, tag: string): string | null {
  const match = pgn.match(new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`, "i"));
  return match?.[1]?.trim() || null;
}

function extractOpeningHeader(pgn: string): string | null {
  const eco = extractTagHeader(pgn, "ECO");
  const opening = extractTagHeader(pgn, "Opening");
  if (eco && opening) return `${eco}: ${opening}`;
  return opening || eco || null;
}

export function PuzzleVariantsPanel({
  selectedDb,
  sessionPuzzles = [],
  currentPuzzle = null,
}: {
  selectedDb: string | null;
  sessionPuzzles?: Puzzle[];
  currentPuzzle?: Puzzle | null;
}) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<PuzzleVariantsInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [progressVersion, setProgressVersion] = useState(0);
  const [solutionHeaders, setSolutionHeaders] = useState<string[]>([]);
  const [openingHeaders, setOpeningHeaders] = useState<string[]>([]);

  const isPgn = selectedDb?.toLowerCase().endsWith(".pgn") ?? false;
  void progressVersion;

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
        setSolutionHeaders([]);
        setOpeningHeaders([]);
        return;
      }

      setLoading(true);
      try {
        const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
        const metadataPath = selectedDb.replace(/\.pgn$/i, ".info");
        if (!(await exists(metadataPath))) {
          setInfo(null);
          setSolutionHeaders([]);
          setOpeningHeaders([]);
          return;
        }

        const raw = await readTextFile(metadataPath);
        const metadata = JSON.parse(raw) as { type?: string; tags?: unknown };
        if (metadata.type !== "puzzle") {
          setInfo(null);
          setSolutionHeaders([]);
          setOpeningHeaders([]);
          return;
        }

        const tags = Array.isArray(metadata.tags)
          ? metadata.tags.filter((tag): tag is string => typeof tag === "string")
          : [];
        if (!tags.includes(PUZZLE_VARIANTS_TAG)) {
          setInfo(null);
          setSolutionHeaders([]);
          setOpeningHeaders([]);
          return;
        }

        const parsed = parsePuzzleVariantTags(tags);
        const puzzleCount = unwrap(await commands.countPgnGames(selectedDb));
        const stem = getFileStem(selectedDb);
        const displayName = getPuzzleDisplayName(stem, parsed);

        if (cancelled) return;
        setInfo({
          displayName,
          profileId: parsed.profileId,
          variantPath: parsed.variantPath,
          variantName: parsed.variantName,
          depth: parsed.depth,
          mainline: parsed.mainline,
          coverageNode: parsed.coverageNode,
          coverageTier: parsed.coverageTier,
          ecoVariant: parsed.ecoVariant,
          puzzleCount,
        });
      } catch {
        if (!cancelled) {
          setInfo(null);
          setSolutionHeaders([]);
          setOpeningHeaders([]);
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

    const loadSolutionHeaders = async () => {
      if (!selectedDb || !info) {
        setSolutionHeaders([]);
        setOpeningHeaders([]);
        return;
      }

      const cached = getCachedSolutions(selectedDb);
      const cachedOpenings = getCachedOpenings(selectedDb);
      if (cached && cachedOpenings) {
        setSolutionHeaders(cached);
        setOpeningHeaders(cachedOpenings);
        return;
      }

      try {
        const games = unwrap(await commands.readGames(selectedDb, 0, Math.max(0, info.puzzleCount - 1)));
        const solutions = games.map((game) => extractSolutionHeader(game) ?? "");
        const openings = games.map((game) => extractOpeningHeader(game) ?? "");
        setCachedSolutions(selectedDb, solutions);
        setCachedOpenings(selectedDb, openings);

        if (cancelled) return;
        setSolutionHeaders(solutions);
        setOpeningHeaders(openings);
      } catch {
        if (!cancelled) {
          setSolutionHeaders([]);
          setOpeningHeaders([]);
        }
      }
    };

    void loadSolutionHeaders();
    return () => {
      cancelled = true;
    };
  }, [info, selectedDb]);

  const solvedCount = selectedDb && info ? getSolvedPgnPuzzleCount(selectedDb) : 0;
  const firstAttemptStats =
    selectedDb && info ? getFirstAttemptPgnPuzzleStats(selectedDb) : { attempted: 0, correct: 0 };
  const solveTimeStats = selectedDb && info ? getPgnPuzzleSolveTimeStats(selectedDb) : { count: 0, averageMs: null };
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
  const accuracy = useMemo(() => {
    if (!info) return 0;
    if (firstAttemptStats.attempted <= 0) return 0;
    return Math.round((firstAttemptStats.correct / firstAttemptStats.attempted) * 100);
  }, [firstAttemptStats, info]);
  const averageSolveTime = useMemo(() => {
    if (!info || solveTimeStats.averageMs == null) return "--";
    return t("units.duration", { duration: solveTimeStats.averageMs });
  }, [info, solveTimeStats.averageMs, t]);
  const currentPuzzleOpening = useMemo(() => {
    if (!selectedDb || !currentPuzzle || currentPuzzle.source?.type !== "pgn") return null;
    if (normalizePath(currentPuzzle.source.path) !== normalizePath(selectedDb)) return null;
    const opening = openingHeaders[currentPuzzle.source.index];
    return opening && opening.trim().length > 0 ? opening : null;
  }, [currentPuzzle, openingHeaders, selectedDb]);
  const displayedEcoVariant = currentPuzzleOpening ?? info?.ecoVariant ?? null;
  const recentIncorrectSubvariants = useMemo(() => {
    if (!selectedDb || !info || solutionHeaders.length === 0) return [];
    const activePath = normalizePath(selectedDb);
    const seen = new Set<string>();
    const lines: string[] = [];
    for (let i = sessionPuzzles.length - 1; i >= 0; i -= 1) {
      const puzzle = sessionPuzzles[i];
      if (puzzle.completion !== "incorrect") continue;
      if (puzzle.source?.type !== "pgn") continue;
      if (normalizePath(puzzle.source.path) !== activePath) continue;
      const idx = puzzle.source.index;
      if (!Number.isFinite(idx) || idx < 0) continue;
      const line = solutionHeaders[idx];
      if (!line || line.trim().length === 0) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      if (lines.length >= 10) break;
    }
    return lines;
  }, [info, selectedDb, sessionPuzzles, solutionHeaders]);

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
              <Badge size="sm" variant="light">
                {info.displayName}
              </Badge>
              {info.coverageTier === "mainline" ? (
                <Badge size="sm" variant="filled" color="blue">
                  {t("features.board.variants.mainlineShort", { defaultValue: "ML" })}
                </Badge>
              ) : info.coverageTier === "secondary" ? (
                <Badge size="sm" variant="filled" color="green">
                  {t("features.board.variants.secondaryShort", { defaultValue: "Secondary" })}
                </Badge>
              ) : info.coverageTier === "alternative" ? (
                <Badge size="sm" variant="filled" color="red">
                  {t("features.board.variants.alternativeShort", { defaultValue: "Alternative" })}
                </Badge>
              ) : null}
              {displayedEcoVariant ? (
                <Badge size="sm" variant="light" color="cyan">
                  {t("features.puzzle.eco", { defaultValue: "ECO" })}: {displayedEcoVariant}
                </Badge>
              ) : null}
              <Badge size="sm" variant="light">
                {t("features.puzzle.variantsSolved", {
                  defaultValue: "Solved {{solved}}/{{total}}",
                  solved: clampedSolvedCount,
                  total: info.puzzleCount,
                })}
              </Badge>
              <Badge size="sm" variant="light">
                {t("features.puzzle.variantsAccuracy", {
                  defaultValue: "Accuracy {{accuracy}}%",
                  accuracy,
                })}
              </Badge>
              <Badge size="sm" variant="light">
                {t("features.puzzle.averageSolveTime", {
                  defaultValue: "Avg time {{time}}",
                  time: averageSolveTime,
                })}
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
            {recentIncorrectSubvariants.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t("features.puzzle.coveredSubvariantsEmpty", {
                  defaultValue: "No recent incorrect sub-variants.",
                })}
              </Text>
            ) : (
              <Stack gap={2}>
                {recentIncorrectSubvariants.map((line) => (
                  <Text key={line} size="xs" c="dimmed" lineClamp={1}>
                    {line}
                  </Text>
                ))}
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
