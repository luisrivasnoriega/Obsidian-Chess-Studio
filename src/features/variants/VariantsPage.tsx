import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Loader,
  Menu,
  Modal,
  MultiSelect,
  NumberInput,
  Popover,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { MonthPickerInput } from "@mantine/dates";
import { useForm } from "@mantine/form";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconEdit,
  IconExclamationCircle,
  IconExternalLink,
  IconEye,
  IconFileExport,
  IconFileImport,
  IconGitBranch,
  IconPlus,
  IconPuzzle,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconShieldCheck,
  IconSitemap,
  IconTrash,
  IconVersions,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, readDir, readTextFile, rename, writeTextFile } from "@tauri-apps/plugin-fs";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { DataTable, type DataTableSortStatus } from "mantine-datatable";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Chessground } from "@/components/Chessground";
import GenericHeader from "@/components/GenericHeader";
import {
  createDefaultFileInfoMetadata,
  type FileMetadata,
  normalizeFileInfoMetadata,
  processEntriesRecursively,
} from "@/features/files/utils/file";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import {
  activeProfileIdAtom,
  activeTabAtom,
  coverageEngineAnalysisActiveAtom,
  enginesAtom,
  profilesAtom,
  sessionsAtom,
  tabsAtom,
} from "@/state/atoms";
import { premiumActionButtonStyles, premiumMutedPanelStyle } from "@/styles/premiumSurface";
import { getAccountKey, stripAccountKey } from "@/utils/accountKeys";
import { defaultPGN, getPGNFromReportView, parsePGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { getDatabases, query_players } from "@/utils/db";
import { createFile, openFile, readInfoMetadata, writeInfoMetadata } from "@/utils/files";
import { formatDateToPGN, parseDate } from "@/utils/format";
import type { LichessGameSpeed, LichessRating } from "@/utils/lichess/explorer";
import { getProfileDbPath } from "@/utils/profileDb";
import { buildPuzzleVariantSourceTags, PUZZLE_VARIANTS_TAG } from "@/utils/puzzleVariantMetadata";
import { generatePuzzleVariantsFromCoverageNode } from "@/utils/puzzleVariants";
import type { TreeNode } from "@/utils/treeReducer";
import {
  COVERAGE_TIER_COLORS,
  COVERAGE_UNMAPPED_COLOR,
  type CoverageGraphNode,
  type CoverageTier,
  VariantCoverageGraph,
} from "./components/VariantCoverageGraph";
import { VariantGridView } from "./components/VariantGridView";
import type { VariantInfo } from "./types";
import { cleanupVariantLinksAfterDelete, repairVariantLinks } from "./utils/links";
import { getPuzzleVariantsDirectory, getVariantsDirectory } from "./utils/profileDir";

type VariantTreeNode = {
  key: string;
  canonicalKey?: string;
  variant: VariantInfo;
  children: VariantTreeNode[];
  isTransposition?: boolean;
};

type VariantTableRow = VariantInfo & {
  key: string;
  canonicalKey?: string;
  variant: VariantInfo;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  isTransposition?: boolean;
};

type VariantSearchScope = "nameOpening" | "name" | "opening";

type PersistedVariantsTableState = {
  search?: string;
  searchScope?: VariantSearchScope;
  viewMode?: "grid" | "table";
  sortStatus?: {
    columnAccessor?: keyof VariantInfo | string;
    direction?: "asc" | "desc";
  };
  page?: number;
  pageSize?: number;
  expandedKeys?: string[];
};

type VariantValidationMoveOccurrence = {
  variantName: string;
  variantPath: string;
  line: string;
};

type VariantValidationConflict = {
  fen: string;
  moves: Array<{
    san: string;
    uci?: string | null;
    occurrences: VariantValidationMoveOccurrence[];
  }>;
};

type VariantValidationReport = {
  targetVariantName: string;
  targetVariantPath: string;
  activeColor: "white" | "black";
  checkedVariants: number;
  checkedVariantPaths: string[];
  checkedPositions: number;
  conflicts: VariantValidationConflict[];
  skippedVariants: string[];
  orientationMismatches: string[];
};

type VariantsPackageEntry = {
  relativePath: string;
  pgn: string;
  info: unknown;
};

type VariantsPackageFile = {
  schema: "ocs-variants-package";
  version: 1;
  exportedAt: string;
  variants: VariantsPackageEntry[];
};

type VariantBuildConfig = {
  dbType: "local" | "lch_all" | "lch_master";
  localDatabasePath: string | null;
  lichessSpeeds: LichessGameSpeed[];
  lichessRatings: LichessRating[];
  lichessSince: Date | null;
  lichessUntil: Date | null;
  lichessPlayer: string;
  lichessColor: "white" | "black";
  masterSince: Date | null;
  masterUntil: Date | null;
  includeChildren: boolean;
};

type VariantCoverageBuildConfigPatchDto = {
  dbType: VariantBuildConfig["dbType"] | null;
  localDatabasePath: string | null;
  lichessSpeeds: LichessGameSpeed[] | null;
  lichessRatings: LichessRating[] | null;
  lichessSince: string | null;
  lichessUntil: string | null;
  lichessPlayer: string;
  lichessColor: "white" | "black";
  masterSince: string | null;
  masterUntil: string | null;
};

type CoverageMoveEntry = {
  san: string;
  games: number;
  white: number;
  black: number;
  draw: number;
  percent: number;
  tier: CoverageTier;
  lowSample?: boolean;
  nextFen: string | null;
  activeWinRate?: number | null;
  activeLossRate?: number | null;
  activeDrawRate?: number | null;
};

type CoveragePositionCacheEntry = {
  fen: string;
  totalGames: number;
  white?: number;
  black?: number;
  draw?: number;
  moves: CoverageMoveEntry[];
};

type VariantCoverageCache = {
  version: 6;
  sourceSignature: string;
  maxMoves: number;
  positions: Record<string, CoveragePositionCacheEntry>;
  tierOverrides?: Record<string, Exclude<CoverageTier, "root">>;
  labelOverrides?: Record<string, string>;
  criticalLineDismissedFenKeys?: string[];
  graphRoot: CoverageGraphNode;
  repertoireColor: "white" | "black";
  generatedAt: string;
};

type CoverageBuildProgress = {
  phase: "preparing" | "building";
  variantsDone: number;
  variantsTotal: number;
  positionsProcessed: number;
  positionsPending: number;
};

type CoverageGraphBuildProgressPayload = {
  runId?: string | null;
  phase: CoverageBuildProgress["phase"];
  variantsDone: number;
  variantsTotal: number;
  positionsProcessed: number;
  positionsPending: number;
};

type CoverageGraphBackendBuildResult = {
  graphRoot: CoverageGraphNode;
  positions: Record<string, CoveragePositionCacheEntry>;
  repertoireColor: "white" | "black";
  sourceSignature: string;
  cachePath?: string | null;
  cacheWritten: boolean;
  loadedFromCache: boolean;
  priorityMetadataUpdated: boolean;
  criticalLineDismissedFenKeys: string[];
  maxMoves: number;
};

type CoverageProfileTimeControlCategory =
  | "ultra_bullet"
  | "bullet"
  | "blitz"
  | "rapid"
  | "classical"
  | "correspondence"
  | "daily";

type CoverageGamesHistoryFilterMetaResponse = {
  availableTimeControlCategories: string[];
  availableSources: string[];
};

type CoverageActionTab = "edit" | "puzzles" | "board" | "engine";
type CoveragePuzzleTierFilter = Exclude<CoverageTier, "root"> | "all";
type CoverageEngineProgress = {
  total: number;
  completed: number;
  saved: number;
  cached: number;
  failed: number;
  currentLabel: string;
};

type CoverageEngineSessionProgressPayload = {
  runId?: string | null;
  sessionId: string;
  index: number;
  total: number;
  completed: number;
  saved: number;
  cached: number;
  failed: number;
  fen: string;
  label: string;
  error?: string | null;
  hasScore: boolean;
};

type CoverageEngineBackendResultEntry = {
  fen: string;
  label: string;
  advantage?: string | null;
  engineName: string;
  engineMs: number;
  bestMove?: string | null;
  cached: boolean;
  error?: string | null;
};

type CoverageEngineBackendRunResult = {
  total: number;
  completed: number;
  saved: number;
  cached: number;
  failed: number;
  applied: number;
  failedDetails: string[];
  results: CoverageEngineBackendResultEntry[];
  updatedGraphRoot?: CoverageGraphNode | null;
  updatedActionNode?: CoverageGraphNode | null;
  graphCacheWritten?: boolean;
  resolvedGraphCachePath?: string | null;
};

const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;
const COVERAGE_GRAPH_CACHE_VERSION = 6;
const COVERAGE_GRAPH_INITIAL_EXPANDED_LEVELS = 3;
const COVERAGE_ENGINE_SESSION_PROGRESS_EVENT = "coverage_engine_session_progress";
const COVERAGE_GRAPH_BUILD_PROGRESS_EVENT = "variant_coverage_graph_build_progress";

function createCoverageEngineRunId() {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return randomId;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function _summarizeCoverageFen(fen: string | null | undefined) {
  return `${fen ?? ""}`.trim().split(/\s+/).slice(0, 4).join(" ");
}

function formatCoverageEngineUnknownError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function trackCoverageEngine(_runId: string, _phase: string, _details: Record<string, unknown> = {}) {}

const COVERAGE_CONTROL_INPUT_STYLE = {
  minHeight: 38,
  background:
    "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-8) 90%, var(--mantine-color-blue-9) 10%), color-mix(in srgb, var(--mantine-color-dark-7) 92%, var(--mantine-color-blue-9) 8%))",
  border: "1px solid color-mix(in srgb, var(--mantine-color-blue-7) 22%, var(--mantine-color-dark-4))",
  boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.035)",
  color: "var(--mantine-color-gray-0)",
};
const COVERAGE_CONTROL_LABEL_STYLE = {
  color: "var(--mantine-color-gray-3)",
  fontSize: 12,
  fontWeight: 700,
  marginBottom: 6,
};
const COVERAGE_NUMBER_INPUT_STYLES = {
  label: COVERAGE_CONTROL_LABEL_STYLE,
  input: COVERAGE_CONTROL_INPUT_STYLE,
  control: {
    borderColor: "color-mix(in srgb, var(--mantine-color-blue-7) 16%, var(--mantine-color-dark-4))",
    color: "var(--mantine-color-gray-3)",
  },
};
type CoverageGraphResumeSnapshot = {
  targetKey: string;
  depth: number;
  root: CoverageGraphNode;
  cachePath: string | null;
  sourceSignature: string | null;
  orientation: "white" | "black";
  collapsedNodeIds: string[];
  capturedAt: number;
};

type CriticalLineReportItem = {
  id: string;
  label: string;
  node: CoverageGraphNode;
  path: string[];
  openingName: string | null;
  fen: string | null;
  sourceWinRate: number | null;
  sourceLossRate: number | null;
  sourceDrawRate?: number | null;
  profileWinRate: number | null;
  profileLossRate: number | null;
  engineAdvantage: string | null;
  reasons: Array<"source" | "engine">;
};

type CriticalLineReport = {
  activeColor: "white" | "black";
  nodes: CriticalLineReportItem[];
};

let coverageGraphResumeSnapshot: CoverageGraphResumeSnapshot | null = null;

function coverageLegendBadgeStyles(color: string, textColor = "var(--mantine-color-gray-1)") {
  return {
    root: {
      background:
        "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-8) 88%, var(--mantine-color-dark-5) 12%), var(--mantine-color-dark-7))",
      border: `1px solid color-mix(in srgb, ${color} 38%, var(--mantine-color-dark-4))`,
      boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.035)",
      color: textColor,
      fontWeight: 800,
      textTransform: "uppercase" as const,
    },
  };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
}

function resolveLinkedPath(ownerPath: string, linkPath: string): string {
  if (ABSOLUTE_PATH_RE.test(linkPath)) return normalizePath(linkPath);
  const ownerDir = ownerPath.replace(/[\\/][^\\/]+$/, "");
  const candidate = `${ownerDir}/${linkPath}`;
  return normalizePath(candidate);
}

function relativePath(fromDir: string, toPath: string): string {
  const rootRaw = fromDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const targetRaw = toPath.replace(/\\/g, "/");
  const rootLower = rootRaw.toLowerCase();
  const targetLower = targetRaw.toLowerCase();
  if (targetLower.startsWith(`${rootLower}/`)) {
    return targetRaw.slice(rootRaw.length + 1);
  }
  return getFileName(toPath);
}

function parentDir(path: string): string {
  const match = path.match(/^(.*)[\\/][^\\/]+$/);
  return match?.[1] ?? path;
}

function sanitizePackageRelativePath(input: string): string | null {
  const normalized = input.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!normalized || ABSOLUTE_PATH_RE.test(normalized) || normalized.includes("\0")) {
    return null;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  const candidate = segments.join("/");
  if (!candidate.toLowerCase().endsWith(".pgn")) {
    return null;
  }
  return candidate;
}

function sanitizeFileStem(input: string, fallback = "puzzles"): string {
  const cleaned = input.replace(/[<>:"/\\|?*]/g, "").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function formatFileTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}.${month}.${day}-${hours}${minutes}${seconds}`;
}

async function resolveAvailablePgnFileStem(dir: string, desiredStem: string): Promise<string> {
  const baseStem = sanitizeFileStem(desiredStem);
  let candidate = baseStem;
  let suffix = 2;
  while (await exists(await join(dir, `${candidate}.pgn`))) {
    candidate = sanitizeFileStem(`${baseStem}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function normalizeFenKey(fen: string): string {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) {
    return fen.trim();
  }
  return `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]}`;
}

function _buildFenMatchKeys(fen: string | null | undefined): string[] {
  const trimmed = `${fen ?? ""}`.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/\s+/);
  const keys = new Set<string>();
  keys.add(`fen4:${normalizeFenKey(trimmed)}`);
  if (parts[0]) {
    if (parts[1]) {
      keys.add(`board-turn:${parts[0]} ${parts[1]}`);
    }
    keys.add(`board:${parts[0]}`);
  }
  return Array.from(keys);
}

function _buildCriticalLineCoverageCachePath(cacheFilePath: string): string {
  if (/\.json$/i.test(cacheFilePath)) {
    return cacheFilePath.replace(/\.json$/i, "-critical-lines.json");
  }
  return `${cacheFilePath}-critical-lines.json`;
}

function getCriticalLineDismissalKey(fen: string | null | undefined, fallbackId: string): string {
  const normalizedFen = `${fen ?? ""}`.trim();
  return normalizedFen ? normalizeFenKey(normalizedFen) : fallbackId;
}

function coverageTierPriority(tier: CoverageTier): number | null {
  if (tier === "mainline") return 1;
  if (tier === "secondary") return 2;
  if (tier === "alternative") return 3;
  return null;
}

function variantPriorityColor(priority: number): string {
  if (priority === 1) return "blue";
  if (priority === 2) return "green";
  if (priority === 3) return "red";
  return "gray";
}

function coverageTierFileSuffix(tier: Exclude<CoverageTier, "root">): string {
  if (tier === "mainline") return "Mainline";
  if (tier === "secondary") return "Secondary";
  return "Alternative";
}

function normalizeCoverageIdentityName(value: string | null | undefined): string {
  return stripAccountKey(`${value ?? ""}`)
    .trim()
    .toLowerCase();
}

function getCoverageTimeControlLabel(
  t: (key: string, options?: { defaultValue?: string }) => string,
  value: CoverageProfileTimeControlCategory,
): string {
  switch (value) {
    case "ultra_bullet":
      return t("chess.timeControl.ultraBullet", { defaultValue: "UltraBullet" });
    case "bullet":
      return t("chess.timeControl.bullet", { defaultValue: "Bullet" });
    case "blitz":
      return t("chess.timeControl.blitz", { defaultValue: "Blitz" });
    case "rapid":
      return t("chess.timeControl.rapid", { defaultValue: "Rapid" });
    case "classical":
      return t("chess.timeControl.classical", { defaultValue: "Classical" });
    case "correspondence":
      return t("chess.timeControl.correspondence", { defaultValue: "Correspondence" });
    case "daily":
      return t("chess.timeControl.daily", { defaultValue: "Daily" });
  }
}

function CoverageTimeControlSelector({
  value,
  options,
  onChange,
  disabled,
  t,
}: {
  value: CoverageProfileTimeControlCategory[];
  options: CoverageProfileTimeControlCategory[];
  onChange: (values: CoverageProfileTimeControlCategory[]) => void;
  disabled: boolean;
  t: (key: string, options?: { defaultValue?: string; count?: number }) => string;
}) {
  const selectedSet = new Set(value.length > 0 ? value : options);
  const selectedValues = options.filter((option) => selectedSet.has(option));
  const allSelected = options.length > 0 && selectedValues.length === options.length;
  const placeholder = t("features.board.variants.profileTimeControlsPlaceholder", {
    defaultValue: "All available time controls",
  });
  const visiblePills = allSelected
    ? [placeholder]
    : selectedValues.slice(0, 2).map((option) => getCoverageTimeControlLabel(t, option));
  const hiddenCount = allSelected ? 0 : Math.max(0, selectedValues.length - visiblePills.length);

  const updateSelection = (nextValues: CoverageProfileTimeControlCategory[]) => {
    onChange(nextValues.length > 0 ? nextValues : options);
  };

  const toggleOption = (option: CoverageProfileTimeControlCategory) => {
    const nextSet = new Set(selectedValues);
    if (nextSet.has(option)) {
      nextSet.delete(option);
    } else {
      nextSet.add(option);
    }
    updateSelection(options.filter((candidate) => nextSet.has(candidate)));
  };

  return (
    <Box w={300}>
      <Text style={COVERAGE_CONTROL_LABEL_STYLE}>
        {t("features.board.variants.profileTimeControls", {
          defaultValue: "Profile time controls",
        })}
      </Text>
      <Popover width={320} position="bottom-start" shadow="xl" withinPortal disabled={disabled}>
        <Popover.Target>
          <Box
            component="button"
            type="button"
            disabled={disabled}
            style={{
              ...COVERAGE_CONTROL_INPUT_STYLE,
              width: "100%",
              minHeight: 38,
              borderRadius: 10,
              padding: "6px 10px",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.55 : 1,
              textAlign: "left",
            }}
          >
            <Group justify="space-between" gap="xs" wrap="nowrap">
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                {visiblePills.map((label) => (
                  <Box
                    key={label}
                    style={{
                      maxWidth: allSelected ? 190 : 110,
                      padding: "3px 9px",
                      borderRadius: 999,
                      background:
                        "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-blue-8) 24%, var(--mantine-color-dark-6)), color-mix(in srgb, var(--mantine-color-cyan-8) 18%, var(--mantine-color-dark-6)))",
                      border: "1px solid color-mix(in srgb, var(--mantine-color-blue-4) 28%, transparent)",
                      color: "var(--mantine-color-blue-0)",
                      fontSize: 12,
                      fontWeight: 800,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {label}
                  </Box>
                ))}
                {hiddenCount > 0 && (
                  <Box
                    style={{
                      padding: "3px 8px",
                      borderRadius: 999,
                      background: "color-mix(in srgb, var(--mantine-color-dark-5) 86%, var(--mantine-color-blue-8))",
                      border: "1px solid color-mix(in srgb, var(--mantine-color-blue-6) 20%, transparent)",
                      color: "var(--mantine-color-gray-2)",
                      fontSize: 12,
                      fontWeight: 800,
                    }}
                  >
                    +{hiddenCount}
                  </Box>
                )}
                {visiblePills.length === 0 && (
                  <Text size="sm" c="dimmed" truncate>
                    {placeholder}
                  </Text>
                )}
              </Group>
              <IconChevronDown size={16} color="var(--mantine-color-gray-4)" />
            </Group>
          </Box>
        </Popover.Target>
        <Popover.Dropdown
          style={{
            padding: 8,
            background:
              "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-7) 92%, var(--mantine-color-blue-9) 8%), var(--mantine-color-dark-7))",
            border: "1px solid color-mix(in srgb, var(--mantine-color-blue-7) 24%, var(--mantine-color-dark-4))",
            boxShadow: "0 18px 40px rgba(2, 6, 23, 0.35)",
          }}
        >
          <Stack gap={6}>
            <Button
              variant="subtle"
              size="xs"
              radius="md"
              onClick={() => onChange(options)}
              styles={{
                root: {
                  justifyContent: "flex-start",
                  color: "var(--mantine-color-blue-1)",
                  background: allSelected
                    ? "color-mix(in srgb, var(--mantine-color-blue-8) 20%, var(--mantine-color-dark-6))"
                    : "transparent",
                },
              }}
            >
              {placeholder}
            </Button>
            {options.map((option) => (
              <Checkbox
                key={option}
                checked={selectedSet.has(option)}
                onChange={() => toggleOption(option)}
                label={getCoverageTimeControlLabel(t, option)}
                styles={{
                  root: {
                    padding: "6px 8px",
                    borderRadius: 8,
                    background: selectedSet.has(option)
                      ? "color-mix(in srgb, var(--mantine-color-blue-8) 14%, transparent)"
                      : "transparent",
                  },
                  label: {
                    color: "var(--mantine-color-gray-1)",
                    fontWeight: 650,
                  },
                  input: {
                    backgroundColor: "color-mix(in srgb, var(--mantine-color-dark-6) 86%, var(--mantine-color-dark-4))",
                    borderColor: "color-mix(in srgb, var(--mantine-color-blue-6) 34%, var(--mantine-color-dark-4))",
                  },
                }}
              />
            ))}
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </Box>
  );
}

function _formatOpeningNameForCoverageNode(
  info: { eco: string; opening: string; variation: string } | null,
): string | null {
  if (!info) return null;
  const eco = `${info.eco ?? ""}`.trim();
  const opening = `${info.opening ?? ""}`.trim();
  const variation = `${info.variation ?? ""}`.trim();
  const base = variation || opening;
  if (!base && !eco) return null;
  if (!base) return eco || null;
  return eco ? `${eco} ${base}` : base;
}

function _getTagValue(tags: string[], prefix: string): string | null {
  const value = tags
    .find((tag) => tag.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
  return value && value.length > 0 ? value : null;
}

function formatMonthTag(date: Date | null): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function parseCoverageMonthTag(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = parseDate(value);
  if (parsed) return parsed;
  const match = value.match(/^(\d{4})-(\d{1,2})/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return new Date(year, month - 1, 1);
}

async function parseVariantBuildConfigFromTags(tags: string[]): Promise<Partial<VariantBuildConfig>> {
  const parsed = await invoke<VariantCoverageBuildConfigPatchDto>("variant_coverage_parse_build_config_tags", {
    tags,
  });

  return {
    dbType: parsed.dbType ?? undefined,
    localDatabasePath: parsed.localDatabasePath ?? null,
    lichessSpeeds: parsed.lichessSpeeds && parsed.lichessSpeeds.length > 0 ? parsed.lichessSpeeds : undefined,
    lichessRatings: parsed.lichessRatings && parsed.lichessRatings.length > 0 ? parsed.lichessRatings : undefined,
    lichessSince: parseCoverageMonthTag(parsed.lichessSince),
    lichessUntil: parseCoverageMonthTag(parsed.lichessUntil),
    lichessPlayer: parsed.lichessPlayer ?? "",
    lichessColor: parsed.lichessColor === "black" ? "black" : "white",
    masterSince: parseCoverageMonthTag(parsed.masterSince),
    masterUntil: parseCoverageMonthTag(parsed.masterUntil),
  };
}

async function getCoverageGraphCacheFilePath(variantPath: string, sourceSignature: string): Promise<string> {
  return await invoke<string>("variant_coverage_graph_cache_path", {
    variantPath,
    sourceSignature,
  });
}

async function readCoverageGraphCache(filePath: string): Promise<VariantCoverageCache | null> {
  try {
    return await invoke<VariantCoverageCache | null>("variant_coverage_read_graph_cache", { filePath });
  } catch {
    return null;
  }
}

async function writeCoverageGraphCache(filePath: string, cache: VariantCoverageCache): Promise<void> {
  await invoke("variant_coverage_write_graph_cache", { filePath, cache });
}

async function applyProfileFlagsToCoverageGraph(
  root: CoverageGraphNode,
  positions: Record<string, CoveragePositionCacheEntry>,
  dbPath: string | null,
  playerIds: number[],
  repertoireColor: "white" | "black",
  timeControlCategories: CoverageProfileTimeControlCategory[],
): Promise<CoverageGraphNode> {
  return await invoke<CoverageGraphNode>("variant_coverage_apply_profile_position_flags", {
    root,
    positions,
    dbPath,
    playerIds,
    repertoireColor,
    timeControlCategories,
  });
}

async function applyCriticalLineFlagsToCoverageGraph(
  root: CoverageGraphNode,
  activeColor: "white" | "black",
): Promise<CoverageGraphNode> {
  return await invoke<CoverageGraphNode>("variant_coverage_apply_critical_line_flags", {
    root,
    activeColor,
  });
}

async function getCoverageCriticalLineReport(
  root: CoverageGraphNode,
  activeColor: "white" | "black",
  completeLinesOnly: boolean,
  dismissedKeys: Set<string>,
): Promise<CriticalLineReport> {
  return await invoke<CriticalLineReport>("variant_coverage_critical_line_report", {
    root,
    activeColor,
    completeLinesOnly,
    dismissedKeys: Array.from(dismissedKeys),
  });
}

function setCoverageTierByOverrideKey(
  node: CoverageGraphNode,
  overrideKey: string,
  tier: Exclude<CoverageTier, "root">,
): CoverageGraphNode {
  const nextChildren = node.children.map((child) => setCoverageTierByOverrideKey(child, overrideKey, tier));
  if (node.overrideKey === overrideKey && node.tier !== "root") {
    return {
      ...node,
      tier,
      children: nextChildren,
    };
  }
  return {
    ...node,
    children: nextChildren,
  };
}

function setCoverageLabelByOverrideKey(
  node: CoverageGraphNode,
  overrideKey: string,
  customLabel: string,
): CoverageGraphNode {
  const nextChildren = node.children.map((child) => setCoverageLabelByOverrideKey(child, overrideKey, customLabel));
  if (node.overrideKey === overrideKey && node.tier !== "root") {
    const match = node.label.match(/^(.*?)\s+([0-9]+(?:\.[0-9]+)?%)(\s*(?:-\s*.+)?)?$/);
    const nextLabel = match ? `${customLabel} ${match[2]}${match[3] ?? ""}` : customLabel;
    return {
      ...node,
      label: nextLabel,
      children: nextChildren,
    };
  }
  return {
    ...node,
    children: nextChildren,
  };
}

function extractCoverageEditableLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "";
  const combinedMatch = trimmed.match(/^(.*?)(?:,\s*.+)?\s*\|\s*[0-9]+(?:\.[0-9]+)?%/);
  if (combinedMatch?.[1]) return combinedMatch[1].trim();
  const rawMatch = trimmed.match(/^(.*?)\s+[0-9]+(?:\.[0-9]+)?%/);
  if (rawMatch?.[1]) return rawMatch[1].trim();
  const leftPipe = trimmed.split("|")[0]?.trim();
  return leftPipe || trimmed;
}

function findCoverageNodeById(node: CoverageGraphNode, id: string): CoverageGraphNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findCoverageNodeById(child, id);
    if (found) return found;
  }
  return null;
}

function mergeCoverageLabelWithForcedReply(coverageLabel: string, forcedLabel: string): string {
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

function mergeCoverageLabelWithForcedReplies(coverageLabel: string, forcedLabels: string[]): string {
  const normalizedForced = forcedLabels
    .map((label) => label.split("|")[0]?.split("->")[0]?.split(" - ")[0]?.trim() ?? "")
    .filter((label) => label.length > 0);
  if (normalizedForced.length === 0) return coverageLabel;
  const primary = normalizedForced[0];
  const extra = normalizedForced.length - 1;
  const renderedForced = extra > 0 ? `${primary} +${extra}` : primary;

  const match = coverageLabel.match(/^(.*?)\s+([0-9]+(?:\.[0-9]+)?%)\s*(?:-\s*(.+))?$/);
  if (!match) {
    return `${coverageLabel}, ${renderedForced}`;
  }

  const [, moveSan, percent] = match;
  return `${moveSan}, ${renderedForced} | ${percent}`;
}

type CoverageEngineAnnotation = {
  advantage: string;
  engineName?: string | null;
  engineMs?: number | null;
};

function _collectCoverageEngineAnnotationsByFen(
  root: CoverageGraphNode | null | undefined,
): Map<string, CoverageEngineAnnotation> {
  const byFen = new Map<string, CoverageEngineAnnotation>();
  if (!root) return byFen;
  const walk = (node: CoverageGraphNode) => {
    const fen = `${node.fen ?? ""}`.trim();
    const advantage = `${node.engineAdvantage ?? ""}`.trim();
    if (fen && advantage && !byFen.has(normalizeFenKey(fen))) {
      byFen.set(normalizeFenKey(fen), {
        advantage,
        engineName: node.engineName ?? null,
        engineMs: node.engineMs ?? null,
      });
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return byFen;
}

function _applyCoverageEngineAnnotationsByFen(
  node: CoverageGraphNode,
  annotationsByFen: Map<string, CoverageEngineAnnotation>,
): CoverageGraphNode {
  const nextChildren = node.children.map((child) => _applyCoverageEngineAnnotationsByFen(child, annotationsByFen));
  const fen = `${node.fen ?? ""}`.trim();
  if (!fen) {
    return {
      ...node,
      children: nextChildren,
    };
  }
  const annotation = annotationsByFen.get(normalizeFenKey(fen));
  if (!annotation) {
    return {
      ...node,
      children: nextChildren,
    };
  }
  return {
    ...node,
    engineAdvantage: annotation.advantage,
    engineName: annotation.engineName ?? null,
    engineMs: annotation.engineMs ?? null,
    children: nextChildren,
  };
}

function getCoverageResponseRarity(percent: number | undefined): "low_frequency" | "novelty" | undefined {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  if (percent < 5) return "novelty";
  if (percent < 20) return "low_frequency";
  return undefined;
}

function applyCollapsedCoverageNodes(
  root: CoverageGraphNode | null,
  collapsedIds: Set<string>,
): CoverageGraphNode | null {
  if (!root) return null;
  const visit = (node: CoverageGraphNode): CoverageGraphNode => {
    const hasChildren = node.children.length > 0;
    if (hasChildren && collapsedIds.has(node.id)) {
      const forcedReplies = node.children.filter((child) => child.tier === "root");
      const forcedReply = forcedReplies.length === 1 ? forcedReplies[0] : null;
      const mergedLabel = forcedReply
        ? mergeCoverageLabelWithForcedReply(node.label, forcedReply.label)
        : forcedReplies.length > 1
          ? mergeCoverageLabelWithForcedReplies(
              node.label,
              forcedReplies.map((child) => child.label),
            )
          : node.label;
      return {
        ...node,
        label: mergedLabel,
        responsePercent: forcedReply?.percent ?? node.responsePercent,
        responseRarity: forcedReply ? getCoverageResponseRarity(forcedReply.percent) : node.responseRarity,
        fen: forcedReply?.fen ?? node.fen,
        openingName: forcedReply?.openingName ?? node.openingName,
        activeMovesUsed: forcedReply?.activeMovesUsed ?? node.activeMovesUsed,
        activeWinRate: forcedReply ? forcedReply.activeWinRate : node.activeWinRate,
        activeLossRate: forcedReply ? forcedReply.activeLossRate : node.activeLossRate,
        activeDrawRate: forcedReply ? forcedReply.activeDrawRate : node.activeDrawRate,
        profileWinRate: forcedReply ? forcedReply.profileWinRate : node.profileWinRate,
        profileLossRate: forcedReply ? forcedReply.profileLossRate : node.profileLossRate,
        engineAdvantage: forcedReply ? forcedReply.engineAdvantage : node.engineAdvantage,
        engineName: forcedReply ? forcedReply.engineName : node.engineName,
        engineMs: forcedReply ? forcedReply.engineMs : node.engineMs,
        criticalLine: forcedReply ? forcedReply.criticalLine : node.criticalLine,
        criticalLineReasons: forcedReply ? forcedReply.criticalLineReasons : node.criticalLineReasons,
        unmappedResponse: forcedReplies.length > 0 ? false : node.unmappedResponse,
        collapsed: true,
        hiddenChildrenCount: forcedReply ? forcedReply.children.length : node.children.length,
        children: [],
      };
    }
    return {
      ...node,
      collapsed: false,
      hiddenChildrenCount: 0,
      children: node.children.map(visit),
    };
  };
  return visit(root);
}

function collectCollapsibleCoverageNodeIds(root: CoverageGraphNode | null): Set<string> {
  const ids = new Set<string>();
  if (!root) return ids;
  const walk = (node: CoverageGraphNode) => {
    if (node.tier !== "root" && node.children.length > 0) {
      ids.add(node.id);
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return ids;
}

function getCoverageGraphRenderRoot(root: CoverageGraphNode): CoverageGraphNode {
  if (root.tier === "root" && root.children.length === 1 && root.children[0].tier === "root") {
    return root.children[0];
  }
  return root;
}

function buildCoverageDefaultCollapsedIds(root: CoverageGraphNode | null, expandedLevels: number): Set<string> {
  const collapsedIds = new Set<string>();
  if (!root) return collapsedIds;

  const normalizedExpandedLevels = Math.max(1, Math.floor(expandedLevels));
  const traversalRoot = getCoverageGraphRenderRoot(root);

  const walk = (node: CoverageGraphNode, depth: number) => {
    if (depth >= normalizedExpandedLevels && node.tier !== "root" && node.children.length > 0) {
      collapsedIds.add(node.id);
      return;
    }
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  };

  walk(traversalRoot, 0);
  return collapsedIds;
}

function collectCoverageBranchCollapseIds(node: CoverageGraphNode, startDepth: number): Set<string> {
  const collapsed = new Set<string>();
  const walk = (current: CoverageGraphNode, depth: number) => {
    if (depth >= startDepth && current.tier !== "root" && current.children.length > 0) {
      collapsed.add(current.id);
    }
    for (const child of current.children) {
      walk(child, depth + 1);
    }
  };
  walk(node, 0);
  return collapsed;
}

function collectCoverageSubtreeNodeIds(node: CoverageGraphNode): Set<string> {
  const ids = new Set<string>();
  const walk = (current: CoverageGraphNode) => {
    ids.add(current.id);
    for (const child of current.children) {
      walk(child);
    }
  };
  walk(node);
  return ids;
}

function findCoverageNodePathById(
  node: CoverageGraphNode,
  id: string,
  path: CoverageGraphNode[] = [],
): CoverageGraphNode[] | null {
  const nextPath = [...path, node];
  if (node.id === id) return nextPath;
  for (const child of node.children) {
    const found = findCoverageNodePathById(child, id, nextPath);
    if (found) return found;
  }
  return null;
}

function extractSanFromCoverageLabel(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed) return null;
  const leftPart = trimmed.split("|")[0]?.trim() ?? trimmed;
  const firstToken = leftPart.split(/\s+/)[0]?.trim() ?? "";
  return firstToken.length > 0 ? firstToken : null;
}

function extractSanFromRootLabel(label: string): string[] {
  const trimmed = label.trim();
  if (!trimmed) return [];
  const beforeArrow = trimmed.split("->")[0]?.trim() ?? trimmed;
  const beforePipe = beforeArrow.split("|")[0]?.trim() ?? beforeArrow;
  const beforeVariantName = beforePipe.split(" - ")[0]?.trim() ?? beforePipe;
  if (!beforeVariantName) return [];
  return beforeVariantName
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && token !== "...");
}

function extractSanFromOverrideKey(overrideKey: string | undefined): string | null {
  if (!overrideKey) return null;
  const separator = overrideKey.lastIndexOf("|");
  if (separator <= 0 || separator + 1 >= overrideKey.length) return null;
  const san = overrideKey.slice(separator + 1).trim();
  return san.length > 0 ? san : null;
}

function extractSanFromCoverageNode(node: CoverageGraphNode): string | null {
  return extractSanFromOverrideKey(node.overrideKey) ?? extractSanFromCoverageLabel(node.label);
}

function buildSanSequenceFromCoveragePath(path: CoverageGraphNode[]): string[] {
  if (path.length <= 1) return [];
  const sequence: string[] = [];
  for (let i = 1; i < path.length; i += 1) {
    const node = path[i];
    if (node.tier === "root") {
      sequence.push(...extractSanFromRootLabel(node.label));
      continue;
    }

    const coverageSan = extractSanFromOverrideKey(node.overrideKey) ?? extractSanFromCoverageLabel(node.label);
    if (coverageSan) {
      sequence.push(coverageSan);
    }

    const forcedReplyNode = node.children.length === 1 && node.children[0].tier === "root" ? node.children[0] : null;
    if (forcedReplyNode) {
      const forcedSans = extractSanFromRootLabel(forcedReplyNode.label);
      if (forcedSans.length > 0) {
        sequence.push(forcedSans[0]);
      }
    }
  }
  return sequence;
}

function getCoverageNodeTerminalFen(node: CoverageGraphNode | null | undefined): string | null {
  if (!node) return null;
  const forcedReplyNode = node.children.length === 1 && node.children[0].tier === "root" ? node.children[0] : null;
  return forcedReplyNode?.fen ?? node.fen ?? null;
}

function findTreePathBySanSequence(root: TreeNode, sanSequence: string[]): number[] | null {
  const path: number[] = [];
  let currentNode: TreeNode | null = root;
  for (const san of sanSequence) {
    if (!currentNode) return null;
    const nextIndex = currentNode.children.findIndex((child) => (child.san ?? "").trim() === san);
    if (nextIndex < 0) {
      return null;
    }
    path.push(nextIndex);
    currentNode = currentNode.children[nextIndex] ?? null;
  }
  return path;
}

function collectTreePathsByFen(node: TreeNode, targetFenKey: string, currentPath: number[], out: number[][]): void {
  if (normalizeFenKey(node.fen) === targetFenKey) {
    out.push([...currentPath]);
  }
  for (let i = 0; i < node.children.length; i += 1) {
    collectTreePathsByFen(node.children[i], targetFenKey, [...currentPath, i], out);
  }
}

function getSanSequenceAtTreePath(root: TreeNode, path: number[]): string[] {
  const sequence: string[] = [];
  let node: TreeNode | null = root;
  for (const index of path) {
    const child: TreeNode | undefined = node ? node.children[index] : undefined;
    if (!child) break;
    if (child.san?.trim()) {
      sequence.push(child.san.trim());
    }
    node = child;
  }
  return sequence;
}

function getSuffixSanMatchScore(candidate: string[], reference: string[]): number {
  let score = 0;
  let i = candidate.length - 1;
  let j = reference.length - 1;
  while (i >= 0 && j >= 0) {
    if (candidate[i] !== reference[j]) break;
    score += 1;
    i -= 1;
    j -= 1;
  }
  return score;
}

function normalizeMonthPickerValue(value: string | Date | null): Date | null {
  return parseDate(value) ?? null;
}

function findBestTreePathByFen(root: TreeNode, fen: string, preferredSanSequence: string[]): number[] | null {
  const targetFenKey = normalizeFenKey(fen);
  const candidates: number[][] = [];
  collectTreePathsByFen(root, targetFenKey, [], candidates);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  let bestPath: number[] | null = null;
  let bestScore = -1;
  for (const candidatePath of candidates) {
    const candidateSans = getSanSequenceAtTreePath(root, candidatePath);
    const score = getSuffixSanMatchScore(candidateSans, preferredSanSequence);
    if (bestPath === null || score > bestScore || (score === bestScore && candidatePath.length > bestPath.length)) {
      bestPath = candidatePath;
      bestScore = score;
    }
  }
  return bestPath;
}

function _getTreeNodeAtPath(root: TreeNode, path: number[]): TreeNode | null {
  let node: TreeNode | null = root;
  for (const index of path) {
    if (!node || index < 0 || index >= node.children.length) return null;
    node = node.children[index] ?? null;
  }
  return node;
}

function findFirstTreePathByFen(root: TreeNode, fen: string): number[] | null {
  const targetFenKey = normalizeFenKey(fen);
  const stack: Array<{ node: TreeNode; path: number[] }> = [{ node: root, path: [] }];
  while (stack.length > 0) {
    const { node, path } = stack.shift()!;
    if (normalizeFenKey(node.fen) === targetFenKey) return path;
    for (let i = 0; i < node.children.length; i += 1) {
      stack.push({ node: node.children[i], path: [...path, i] });
    }
  }
  return null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // ignore serialization issues
  }
  return "Unknown error";
}

function formatCoverageRate(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

function formatCoverageWinLoss(winRate: number | null | undefined, lossRate: number | null | undefined): string {
  return `W ${formatCoverageRate(winRate)} / L ${formatCoverageRate(lossRate)}`;
}

function getCoveragePositionWinLossRates(
  entry: CoveragePositionCacheEntry | null | undefined,
  repertoireColor: "white" | "black",
): { winRate?: number; lossRate?: number; drawRate?: number } {
  if (!entry) return {};
  const hasPositionTotals =
    typeof entry.white === "number" &&
    typeof entry.black === "number" &&
    typeof entry.draw === "number" &&
    entry.white + entry.black + entry.draw > 0;
  const white = hasPositionTotals
    ? Math.max(0, entry.white ?? 0)
    : entry.moves.reduce((sum, move) => sum + Math.max(0, move.white), 0);
  const black = hasPositionTotals
    ? Math.max(0, entry.black ?? 0)
    : entry.moves.reduce((sum, move) => sum + Math.max(0, move.black), 0);
  const draw = hasPositionTotals
    ? Math.max(0, entry.draw ?? 0)
    : entry.moves.reduce((sum, move) => sum + Math.max(0, move.draw), 0);
  const total = white + black + draw;
  if (total <= 0) return {};
  const wins = repertoireColor === "white" ? white : black;
  const losses = repertoireColor === "white" ? black : white;
  return {
    winRate: Math.round((wins / total) * 1000) / 10,
    lossRate: Math.round((losses / total) * 1000) / 10,
    drawRate: Math.round((draw / total) * 1000) / 10,
  };
}

function getCoveragePositionWinLossRatesForResultFen(
  entry: CoveragePositionCacheEntry | null | undefined,
  resultFen: string | null | undefined,
  fallbackColor: "white" | "black",
): { winRate?: number; lossRate?: number; drawRate?: number } {
  const sideToMove = getFenSideToMove(resultFen);
  const moveColor = sideToMove ? (sideToMove === "white" ? "black" : "white") : fallbackColor;
  return getCoveragePositionWinLossRates(entry, moveColor);
}

function normalizeCoverageGraphSourceRatesByResultFen(
  node: CoverageGraphNode,
  positions: Record<string, CoveragePositionCacheEntry>,
  fallbackColor: "white" | "black",
): CoverageGraphNode {
  const fen = `${node.fen ?? ""}`.trim();
  const entry = fen ? positions[normalizeFenKey(fen)] : undefined;
  const rates = getCoveragePositionWinLossRatesForResultFen(entry, fen, fallbackColor);
  return {
    ...node,
    activeWinRate: rates.winRate ?? node.activeWinRate,
    activeLossRate: rates.lossRate ?? node.activeLossRate,
    activeDrawRate: rates.drawRate ?? node.activeDrawRate,
    children: node.children.map((child) =>
      normalizeCoverageGraphSourceRatesByResultFen(child, positions, fallbackColor),
    ),
  };
}

function isRetriableCoverageError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("(429)") ||
    normalized.includes("too many requests") ||
    normalized.includes("(504)") ||
    normalized.includes("timeout") ||
    normalized.includes("network")
  );
}

async function _withCoverageRetry<T>(run: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      const message = getErrorMessage(error);
      if (attempt >= maxAttempts || !isRetriableCoverageError(message)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 450));
    }
  }
  throw lastError ?? new Error("Coverage request failed");
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (typeof error === "object" && error && "name" in error) {
    return (error as { name?: string }).name === "AbortError";
  }
  return false;
}

async function _withCoverageRequestTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Coverage request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function _createAsyncLimiter(maxConcurrent: number) {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  let active = 0;
  const queue: Array<() => void> = [];

  const scheduleNext = () => {
    active = Math.max(0, active - 1);
    const next = queue.shift();
    if (next) next();
  };

  return async <T,>(task: () => Promise<T>): Promise<T> =>
    await new Promise<T>((resolve, reject) => {
      const runTask = () => {
        active += 1;
        void Promise.resolve().then(task).then(resolve).catch(reject).finally(scheduleNext);
      };
      if (active < limit) {
        runTask();
      } else {
        queue.push(runTask);
      }
    });
}

function _fenTurnColor(fen: string): "white" | "black" {
  const parts = fen.trim().split(/\s+/);
  return parts[1] === "b" ? "black" : "white";
}

function getFenSideToMove(fen: string | null | undefined): "white" | "black" | null {
  const turn = `${fen ?? ""}`.trim().split(/\s+/)[1];
  if (turn === "w") return "white";
  if (turn === "b") return "black";
  return null;
}

async function loadVariants(variantsDir: string): Promise<VariantInfo[]> {
  return invoke<VariantInfo[]>("variants_list_fast", { variantsDir });
}

const VARIANTS_TABLE_STATE_STORAGE_KEY = "ocs.variants.tableState.v1";

function readPersistedVariantsTableState(): PersistedVariantsTableState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(VARIANTS_TABLE_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedVariantsTableState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isVariantSearchScope(value: unknown): value is VariantSearchScope {
  return value === "nameOpening" || value === "name" || value === "opening";
}

export default function VariantsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [_tabs, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const setCoverageEngineAnalysisActive = useSetAtom(coverageEngineAnalysisActiveAtom);
  const engines = useAtomValue(enginesAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const profiles = useAtomValue(profilesAtom);
  const sessions = useAtomValue(sessionsAtom);
  const { layout } = useResponsiveLayout();
  const useWideVariantsTable = useMediaQuery("(min-width: 135em)");

  const [search, setSearch] = useState(() => readPersistedVariantsTableState().search ?? "");
  const [searchScope, setSearchScope] = useState<VariantSearchScope>(() => {
    const stored = readPersistedVariantsTableState().searchScope;
    return isVariantSearchScope(stored) ? stored : "nameOpening";
  });
  const [viewMode, setViewMode] = useState<"grid" | "table">(
    () => readPersistedVariantsTableState().viewMode ?? "table",
  );
  const [repairingLinks, setRepairingLinks] = useState(false);
  const [sortStatus, setSortStatus] = useState<DataTableSortStatus<VariantInfo>>(() => {
    const stored = readPersistedVariantsTableState().sortStatus;
    return {
      columnAccessor: (stored?.columnAccessor as keyof VariantInfo | undefined) ?? "name",
      direction: stored?.direction === "desc" ? "desc" : "asc",
    };
  });
  const [page, setPage] = useState(() => Math.max(1, readPersistedVariantsTableState().page ?? 1));
  const [pageSize, setPageSize] = useState(() => readPersistedVariantsTableState().pageSize ?? 25);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => new Set(readPersistedVariantsTableState().expandedKeys ?? []),
  );
  const [transferBusy, setTransferBusy] = useState(false);
  const [coveragePuzzleSetupTargetKey, setCoveragePuzzleSetupTargetKey] = useState<string | null>(null);
  const [generatingPuzzles, setGeneratingPuzzles] = useState(false);
  const [openingVariantsTargetKey, setOpeningVariantsTargetKey] = useState<string | null>(null);
  const [compressVariantsTargetKey, setCompressVariantsTargetKey] = useState<string | null>(null);
  const [validatingVariants, setValidatingVariants] = useState(false);
  const [resolvingValidationConflict, setResolvingValidationConflict] = useState(false);
  const [validationReport, setValidationReport] = useState<VariantValidationReport | null>(null);
  const [validationModalOpened, setValidationModalOpened] = useState(false);
  const validationActiveColorLabel =
    validationReport?.activeColor === "black"
      ? t("features.board.variants.validationBlack", { defaultValue: "Black" })
      : t("features.board.variants.validationWhite", { defaultValue: "White" });
  const [coverageGraphModalOpened, setCoverageGraphModalOpened] = useState(false);
  const [coverageGraphTargetKey, setCoverageGraphTargetKey] = useState<string | null>(null);
  const [coverageGraphDepth, setCoverageGraphDepth] = useState<number | "">("");
  const [coverageGraphLoading, setCoverageGraphLoading] = useState(false);
  const [coverageGraphRoot, setCoverageGraphRoot] = useState<CoverageGraphNode | null>(null);
  const [coverageGraphCachePath, setCoverageGraphCachePath] = useState<string | null>(null);
  const [coverageGraphSourceSignature, setCoverageGraphSourceSignature] = useState<string | null>(null);
  const [coveragePrioritySyncing, setCoveragePrioritySyncing] = useState(false);
  const [coverageBuildProgress, setCoverageBuildProgress] = useState<CoverageBuildProgress | null>(null);
  const [coverageActionNode, setCoverageActionNode] = useState<CoverageGraphNode | null>(null);
  const [coverageActionTier, setCoverageActionTier] = useState<Exclude<CoverageTier, "root">>("mainline");
  const [coverageActionSaving, setCoverageActionSaving] = useState(false);
  const [coverageActionTab, setCoverageActionTab] = useState<CoverageActionTab>("edit");
  const [coverageGraphOrientation, setCoverageGraphOrientation] = useState<"white" | "black">("white");
  const [coverageCollapsedNodeIds, setCoverageCollapsedNodeIds] = useState<Set<string>>(new Set());
  const [coverageActionLabel, setCoverageActionLabel] = useState("");
  const [coveragePuzzleTierFilter, setCoveragePuzzleTierFilter] = useState<CoveragePuzzleTierFilter>("mainline");
  const [coveragePuzzleIncludeLowSample, setCoveragePuzzleIncludeLowSample] = useState(true);
  const [coveragePuzzleName, setCoveragePuzzleName] = useState("");
  const [coveragePuzzleGenerating, setCoveragePuzzleGenerating] = useState(false);
  const [activeProfileCoverageDbPath, setActiveProfileCoverageDbPath] = useState<string | null>(null);
  const [coverageProfileTimeControlOptions, setCoverageProfileTimeControlOptions] = useState<
    CoverageProfileTimeControlCategory[]
  >([]);
  const [coverageProfileTimeControlFilters, setCoverageProfileTimeControlFilters] = useState<
    CoverageProfileTimeControlCategory[]
  >([]);
  const [_coverageProfileStatsRefreshing, setCoverageProfileStatsRefreshing] = useState(false);
  const [coverageEngineMs, setCoverageEngineMs] = useState(1000);
  const [coverageEngineEvaluating, setCoverageEngineEvaluating] = useState(false);
  const [coverageEngineProgress, setCoverageEngineProgress] = useState<CoverageEngineProgress | null>(null);
  const coverageEngineAbortRef = useRef(false);
  const coverageEngineRunIdRef = useRef<string | null>(null);
  const [criticalLineModalOpened, setCriticalLineModalOpened] = useState(false);
  const [criticalLineReport, setCriticalLineReport] = useState<CriticalLineReport | null>(null);
  const [criticalLineLoading, setCriticalLineLoading] = useState(false);
  const [criticalLineRegenerating, setCriticalLineRegenerating] = useState(false);
  const [criticalLineBuildRequest, setCriticalLineBuildRequest] = useState<{
    key: string;
    depth: number;
    mappedOnly?: boolean;
    completeLinesOnly?: boolean;
    forceRebuild?: boolean;
    bypassPositionCache?: boolean;
  } | null>(null);
  const [criticalLineReportRequestKey, setCriticalLineReportRequestKey] = useState<string | null>(null);
  const [criticalLineMappedOnly, setCriticalLineMappedOnly] = useState(false);
  const [criticalLineDismissedFenKeys, setCriticalLineDismissedFenKeys] = useState<Set<string>>(new Set());
  const coverageGraphPositionsRef = useRef<Record<string, CoveragePositionCacheEntry>>({});
  const coverageGraphBuildRunIdRef = useRef<string | null>(null);
  const criticalLineCompleteOnlyRef = useRef(false);
  const [configureBuildModalOpened, setConfigureBuildModalOpened] = useState(false);
  const [configureBuildTargetKey, setConfigureBuildTargetKey] = useState<string | null>(null);
  const [applyingBuildConfig, setApplyingBuildConfig] = useState(false);
  const [buildConfig, setBuildConfig] = useState<VariantBuildConfig>({
    dbType: "local",
    localDatabasePath: null,
    lichessSpeeds: ["bullet", "blitz", "rapid", "classical", "correspondence"],
    lichessRatings: [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500],
    lichessSince: null,
    lichessUntil: null,
    lichessPlayer: "",
    lichessColor: "white",
    masterSince: null,
    masterUntil: null,
    includeChildren: true,
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const nextState: PersistedVariantsTableState = {
      search,
      searchScope,
      viewMode,
      sortStatus: {
        columnAccessor: String(sortStatus.columnAccessor),
        direction: sortStatus.direction,
      },
      page,
      pageSize,
      expandedKeys: Array.from(expandedKeys),
    };
    try {
      window.localStorage.setItem(VARIANTS_TABLE_STATE_STORAGE_KEY, JSON.stringify(nextState));
    } catch {}
  }, [expandedKeys, page, pageSize, search, searchScope, sortStatus.columnAccessor, sortStatus.direction, viewMode]);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);
  const lichessAuthToken = useMemo(() => {
    const profileToken = profiles.find((p) => p.id === activeProfileId)?.lichessToken?.trim() ?? "";
    return profileToken.length > 0 ? profileToken : undefined;
  }, [activeProfileId, profiles]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen<CoverageGraphBuildProgressPayload>(COVERAGE_GRAPH_BUILD_PROGRESS_EVENT, (event) => {
      if (disposed) return;
      const payload = event.payload;
      const activeRunId = coverageGraphBuildRunIdRef.current;
      if (activeRunId && payload.runId && payload.runId !== activeRunId) return;
      setCoverageBuildProgress({
        phase: payload.phase,
        variantsDone: payload.variantsDone,
        variantsTotal: payload.variantsTotal,
        positionsProcessed: payload.positionsProcessed,
        positionsPending: payload.positionsPending,
      });
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!activeProfileId) {
        setActiveProfileCoverageDbPath(null);
        return;
      }
      try {
        const dbPath = await getProfileDbPath(activeProfileId);
        if (!cancelled) setActiveProfileCoverageDbPath(dbPath);
      } catch {
        if (!cancelled) setActiveProfileCoverageDbPath(null);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [activeProfileId]);

  const activeProfileCoverageIdentityNames = useMemo(() => {
    if (!activeProfileId) return [];
    const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;
    const names = new Set<string>();
    const pushName = (value?: string | null) => {
      const normalized = `${value ?? ""}`.trim();
      if (normalized.length > 0) names.add(normalized);
    };
    pushName(activeProfile?.name);
    pushName(activeProfile?.displayName);
    for (const session of sessions) {
      if (session.profileId !== activeProfileId) continue;
      pushName(session.player);
      if (session.lichess?.username) {
        pushName(session.lichess.username);
        pushName(getAccountKey("lichess", session.lichess.username));
      }
      if (session.chessCom?.username) {
        pushName(session.chessCom.username);
        pushName(getAccountKey("chesscom", session.chessCom.username));
      }
    }
    return [...names];
  }, [activeProfileId, profiles, sessions]);

  const resolveActiveProfileCoveragePlayerIds = useCallback(
    async (dbPathOverride?: string | null): Promise<number[]> => {
      const profileStatsDbPath = `${dbPathOverride ?? activeProfileCoverageDbPath ?? ""}`.trim();
      if (!profileStatsDbPath) return [];
      const candidateNames = [
        ...new Set(activeProfileCoverageIdentityNames.map((name) => name.trim()).filter(Boolean)),
      ];
      if (candidateNames.length === 0) return [];

      const candidateRawLower = new Set(candidateNames.map((name) => name.toLowerCase()));
      const candidateNormalized = new Set(
        candidateNames.map((name) => normalizeCoverageIdentityName(name)).filter((name) => name.length > 0),
      );

      const queryTerms = new Set<string>();
      for (const candidate of candidateNames) {
        const trimmed = candidate.trim();
        if (!trimmed) continue;
        queryTerms.add(trimmed);
        const stripped = stripAccountKey(trimmed).trim();
        if (stripped && stripped.toLowerCase() !== trimmed.toLowerCase()) {
          queryTerms.add(stripped);
        }
      }

      const ids = new Set<number>();
      const pageSize = 200;
      const maxPages = 25;

      for (const queryTerm of queryTerms) {
        let page = 1;
        while (page <= maxPages) {
          try {
            const response = await query_players(profileStatsDbPath, {
              name: queryTerm,
              range: undefined,
              options: {
                skipCount: false,
                page,
                pageSize,
                sort: "name",
                direction: "asc",
              },
            });

            for (const player of response.data ?? []) {
              if (typeof player.id !== "number" || !Number.isFinite(player.id)) continue;
              const rawPlayerName = `${player.name ?? ""}`.trim();
              if (!rawPlayerName) continue;
              const rawPlayerLower = rawPlayerName.toLowerCase();
              const normalizedPlayer = normalizeCoverageIdentityName(rawPlayerName);
              if (
                candidateRawLower.has(rawPlayerLower) ||
                (normalizedPlayer.length > 0 && candidateNormalized.has(normalizedPlayer))
              ) {
                ids.add(Math.trunc(player.id));
              }
            }

            const count = typeof response.count === "number" ? response.count : null;
            const reachedLastPageByCount = count != null && page * pageSize >= count;
            const reachedLastPageByData = (response.data?.length ?? 0) < pageSize;
            if (reachedLastPageByCount || reachedLastPageByData) break;
            page += 1;
          } catch {
            break;
          }
        }
      }
      return [...ids];
    },
    [activeProfileCoverageDbPath, activeProfileCoverageIdentityNames],
  );

  useEffect(() => {
    if (!activeProfileId) {
      setCoverageProfileTimeControlOptions([]);
      setCoverageProfileTimeControlFilters([]);
      return;
    }

    let cancelled = false;
    const run = async () => {
      try {
        const res = await invoke<CoverageGamesHistoryFilterMetaResponse>("dashboard_get_games_history_filter_meta", {
          req: {
            profileId: activeProfileId,
            profileUsernames: activeProfileCoverageIdentityNames,
            gameHistoryLimit: 10000,
            eventFilterId: null,
            selectedOpponentId: null,
            opponentContains: null,
            resultFilter: null,
            sourceFilter: null,
            playerColor: null,
            minMoves: null,
          },
        });
        if (cancelled) return;
        const nextOptions = (res.availableTimeControlCategories ?? []).filter(
          (value): value is CoverageProfileTimeControlCategory =>
            value === "ultra_bullet" ||
            value === "bullet" ||
            value === "blitz" ||
            value === "rapid" ||
            value === "classical" ||
            value === "correspondence" ||
            value === "daily",
        );
        setCoverageProfileTimeControlOptions(nextOptions);
        setCoverageProfileTimeControlFilters((prev) => {
          const nextSet = new Set(nextOptions);
          const retained = prev.filter((value) => nextSet.has(value));
          return retained.length > 0 ? retained : nextOptions;
        });
      } catch {
        if (!cancelled) {
          setCoverageProfileTimeControlOptions([]);
          setCoverageProfileTimeControlFilters([]);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [activeProfileCoverageIdentityNames, activeProfileId]);

  // Calculate responsive grid columns
  const isMobile = layout.files?.layoutType === "mobile" || false;
  const useCompactVariantsTable = !useWideVariantsTable;
  const gridCols = isMobile ? 1 : { base: 1, md: 2, lg: 3 };
  const variantsQueryKey = useMemo(() => ["variants", activeProfileId ?? "global"] as const, [activeProfileId]);

  const {
    data: variants = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: variantsQueryKey,
    queryFn: async () => loadVariants(await getVariantsDirectory(activeProfileId)),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnMount: false,
    refetchOnReconnect: true,
  });

  const { data: databases = [] } = useQuery({
    queryKey: ["databases"],
    queryFn: getDatabases,
  });

  const localDatabaseOptions = useMemo(
    () =>
      databases
        .filter((database) => database.type === "success")
        .map((database) => ({
          value: database.file,
          label: database.title,
        })),
    [databases],
  );

  useEffect(() => {
    if (location.pathname === "/variants") {
      void refetch();
    }
  }, [location.pathname, refetch]);

  useEffect(() => {
    let refreshTimeout: number | null = null;
    const onVariantsUpdated = () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      refreshTimeout = window.setTimeout(() => {
        refreshTimeout = null;
        void refetch();
      }, 80);
    };
    window.addEventListener("variants:links-updated", onVariantsUpdated);
    window.addEventListener("variants:updated", onVariantsUpdated);
    return () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      window.removeEventListener("variants:links-updated", onVariantsUpdated);
      window.removeEventListener("variants:updated", onVariantsUpdated);
    };
  }, [refetch]);

  useEffect(() => {
    if (buildConfig.dbType !== "local") return;
    if (buildConfig.localDatabasePath) return;
    if (localDatabaseOptions.length === 0) return;
    setBuildConfig((prev) => ({ ...prev, localDatabasePath: localDatabaseOptions[0].value }));
  }, [buildConfig.dbType, buildConfig.localDatabasePath, localDatabaseOptions]);

  const [createNewModalOpened, { open: openCreateNewModal, close: closeCreateNewModal }] = useDisclosure(false);
  const [editCommentsModalOpened, { open: openEditCommentsModal, close: closeEditCommentsModal }] =
    useDisclosure(false);
  const [selectedVariantForComments, setSelectedVariantForComments] = useState<VariantInfo | null>(null);

  const createNewForm = useForm({
    initialValues: {
      name: "",
    },
    validate: {
      name: (value) =>
        value.trim().length === 0
          ? t("features.board.variants.nameRequired", { defaultValue: "Name is required" })
          : null,
    },
  });

  const commentsForm = useForm({
    initialValues: {
      name: "",
      priority: null as number | null,
      opening: "",
      comments: "",
    },
  });

  const handleOpenConfigureBuild = useCallback(
    async (variant: VariantInfo) => {
      try {
        const metadata = await readInfoMetadata(variant.path, "variants");
        const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
        const parsed = await parseVariantBuildConfigFromTags(tags);
        const dbType = parsed.dbType ?? variant.dbType ?? "local";

        setConfigureBuildTargetKey(normalizePath(variant.path));
        setBuildConfig({
          dbType,
          localDatabasePath: parsed.localDatabasePath ?? buildConfig.localDatabasePath,
          lichessSpeeds: parsed.lichessSpeeds ?? buildConfig.lichessSpeeds,
          lichessRatings: parsed.lichessRatings ?? buildConfig.lichessRatings,
          lichessSince: parsed.lichessSince ?? null,
          lichessUntil: parsed.lichessUntil ?? null,
          lichessPlayer: parsed.lichessPlayer ?? "",
          lichessColor: parsed.lichessColor ?? "white",
          masterSince: parsed.masterSince ?? null,
          masterUntil: parsed.masterUntil ?? null,
          includeChildren: true,
        });
        setConfigureBuildModalOpened(true);
      } catch {
        setConfigureBuildTargetKey(normalizePath(variant.path));
        setBuildConfig((prev) => ({ ...prev, includeChildren: true }));
        setConfigureBuildModalOpened(true);
      }
    },
    [buildConfig.localDatabasePath, buildConfig.lichessSpeeds, buildConfig.lichessRatings],
  );

  const handleExportToFile = useCallback(async () => {
    if (!activeProfileId || transferBusy) return;
    try {
      setTransferBusy(true);
      const variantsDir = await getVariantsDirectory(activeProfileId);
      const entries = await readDir(variantsDir);
      const allEntries = await processEntriesRecursively(variantsDir, entries);
      const variantFiles = allEntries.filter(
        (entry): entry is FileMetadata => entry.type === "file" && entry.metadata.type === "variants",
      );

      const payloadVariants: VariantsPackageEntry[] = [];
      for (const variantFile of variantFiles) {
        const pgn = await readTextFile(variantFile.path);
        const metadata = await readInfoMetadata(variantFile.path, "variants");
        payloadVariants.push({
          relativePath: relativePath(variantsDir, variantFile.path).replace(/\\/g, "/"),
          pgn,
          info: metadata,
        });
      }

      const pkg: VariantsPackageFile = {
        schema: "ocs-variants-package",
        version: 1,
        exportedAt: new Date().toISOString(),
        variants: payloadVariants,
      };

      const defaultName = `variants-${activeProfileId}-${new Date().toISOString().slice(0, 10)}.ocs-variants.json`;
      const destination = await save({
        defaultPath: defaultName,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!destination) {
        return;
      }

      await writeTextFile(destination, JSON.stringify(pkg, null, 2));
      notifications.show({
        title: t("common.success"),
        message: t("features.board.variants.exportToFileDone", {
          defaultValue: "Variants package exported. Variants: {{variants}}.",
          variants: payloadVariants.length,
        }),
        color: "green",
      });
    } catch (error) {
      notifications.show({
        title: t("common.error"),
        message:
          error instanceof Error
            ? error.message
            : t("features.board.variants.exportToFileFailed", {
                defaultValue: "Failed to export variants package.",
              }),
        color: "red",
      });
    } finally {
      setTransferBusy(false);
    }
  }, [activeProfileId, t, transferBusy]);

  const handleImportFromFile = useCallback(async () => {
    if (!activeProfileId || transferBusy) return;
    try {
      setTransferBusy(true);
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      const sourceFile = Array.isArray(selected) ? selected[0] : selected;
      if (!sourceFile || typeof sourceFile !== "string") {
        return;
      }

      const raw = await readTextFile(sourceFile);
      const parsed = JSON.parse(raw) as Partial<VariantsPackageFile> | null;
      if (
        !parsed ||
        parsed.schema !== "ocs-variants-package" ||
        parsed.version !== 1 ||
        !Array.isArray(parsed.variants)
      ) {
        throw new Error(
          t("features.board.variants.invalidVariantsPackage", {
            defaultValue: "Invalid variants package format.",
          }),
        );
      }

      const variantsDir = await getVariantsDirectory(activeProfileId);
      await mkdir(variantsDir, { recursive: true });

      let importedVariants = 0;
      let overwrittenVariants = 0;
      let skippedVariants = 0;

      for (const entry of parsed.variants) {
        if (!entry || typeof entry !== "object") {
          skippedVariants += 1;
          continue;
        }

        const record = entry as Partial<VariantsPackageEntry>;
        const cleanRelativePath =
          typeof record.relativePath === "string" ? sanitizePackageRelativePath(record.relativePath) : null;
        if (!cleanRelativePath || typeof record.pgn !== "string") {
          skippedVariants += 1;
          continue;
        }

        const targetPgn = await join(variantsDir, cleanRelativePath);
        await mkdir(parentDir(targetPgn), { recursive: true });
        if (await exists(targetPgn)) {
          overwrittenVariants += 1;
        }
        await writeTextFile(targetPgn, record.pgn);

        const infoMetadata = normalizeFileInfoMetadata(record.info, "variants");
        const normalizedInfo = {
          ...createDefaultFileInfoMetadata("variants"),
          ...infoMetadata,
          type: "variants" as const,
        };
        const targetInfo = targetPgn.replace(".pgn", ".info");
        await writeTextFile(targetInfo, JSON.stringify(normalizedInfo, null, 2));
        importedVariants += 1;
      }

      await repairVariantLinks(variantsDir);
      try {
        window.dispatchEvent(new Event("variants:links-updated"));
        window.dispatchEvent(new Event("variants:updated"));
      } catch {}
      await refetch();

      notifications.show({
        title: t("common.success"),
        message: t("features.board.variants.importFromFileDone", {
          defaultValue:
            "Variants package imported. Imported: {{imported}}, overwritten: {{overwritten}}, skipped: {{skipped}}.",
          imported: importedVariants,
          overwritten: overwrittenVariants,
          skipped: skippedVariants,
        }),
        color: "green",
      });
    } catch (error) {
      notifications.show({
        title: t("common.error"),
        message:
          error instanceof Error
            ? error.message
            : t("features.board.variants.importFromFileFailed", {
                defaultValue: "Failed to import variants package.",
              }),
        color: "red",
      });
    } finally {
      setTransferBusy(false);
    }
  }, [activeProfileId, refetch, t, transferBusy]);

  const handleCreateNew = useCallback(async () => {
    try {
      const variantsDir = await getVariantsDirectory(activeProfileId);

      let filename = createNewForm.values.name.trim();

      if (!filename) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.nameRequired", { defaultValue: "Name is required" }),
          color: "red",
        });
        return;
      }

      // Sanitize filename: remove invalid characters for file names
      filename = filename.replace(/[<>:"/\\|?*]/g, "").trim();

      if (!filename) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.invalidName", {
            defaultValue: "Invalid file name. Please use only valid characters.",
          }),
          color: "red",
        });
        return;
      }

      const result = await createFile({
        filename,
        filetype: "variants",
        dir: variantsDir,
        pgn: defaultPGN(),
      });

      if (result.isOk) {
        await openFile(result.value.path, setTabs, setActiveTab);
        navigate({ to: "/analysis" });
        closeCreateNewModal();
        createNewForm.reset();
        await refetch();
      } else {
        const error = result.error;
        let errorMessage: string;
        if (error instanceof Error) {
          errorMessage = error.message || error.toString();
        } else if (error) {
          errorMessage = String(error);
        } else {
          errorMessage = t("features.board.variants.createError", { defaultValue: "Failed to create variant" });
        }

        notifications.show({
          title: t("common.error"),
          message: errorMessage,
          color: "red",
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : String(error) || t("features.board.variants.createError", { defaultValue: "Failed to create variant" });
      notifications.show({
        title: t("common.error"),
        message: errorMessage,
        color: "red",
      });
    }
  }, [activeProfileId, createNewForm, setTabs, setActiveTab, navigate, closeCreateNewModal, refetch, t]);

  const handleEdit = useCallback(
    async (variant: VariantInfo) => {
      await openFile(variant.path, setTabs, setActiveTab);
      navigate({ to: "/analysis" });
    },
    [navigate, setActiveTab, setTabs],
  );

  const handleEditComments = useCallback(
    (variant: VariantInfo) => {
      setSelectedVariantForComments(variant);
      commentsForm.setFieldValue("name", variant.name || "");
      commentsForm.setFieldValue("priority", variant.priority ?? null);
      commentsForm.setFieldValue("opening", variant.opening || "");
      commentsForm.setFieldValue("comments", variant.comments || "");
      openEditCommentsModal();
    },
    [commentsForm, openEditCommentsModal],
  );

  const handleSaveComments = useCallback(async () => {
    if (!selectedVariantForComments) return;

    try {
      const requestedName = commentsForm.values.name.trim();
      if (!requestedName) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.nameRequired", { defaultValue: "Name is required" }),
          color: "red",
        });
        return;
      }

      const sanitizedName = requestedName.replace(/[<>:"/\\|?*]/g, "").trim();
      if (!sanitizedName) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.invalidName", {
            defaultValue: "Invalid file name. Please use only valid characters.",
          }),
          color: "red",
        });
        return;
      }

      const priorityRaw = commentsForm.values.priority;
      const priorityValue =
        priorityRaw === null || priorityRaw === undefined || Number.isNaN(Number(priorityRaw))
          ? null
          : Number(priorityRaw);
      if (priorityValue !== null && (!Number.isInteger(priorityValue) || priorityValue < 1 || priorityValue > 4)) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.priorityInvalid", { defaultValue: "Priority must be between 1 and 4." }),
          color: "red",
        });
        return;
      }

      const currentPath = selectedVariantForComments.path;
      const renamedPath = currentPath.replace(/[^\\/]+\.pgn$/i, `${sanitizedName}.pgn`);
      let finalPath = currentPath;
      const renamed = sanitizedName !== selectedVariantForComments.name;

      if (renamed) {
        if (await exists(renamedPath)) {
          notifications.show({
            title: t("common.error"),
            message: t("errors.fileAlreadyExists", { defaultValue: "File already exists" }),
            color: "red",
          });
          return;
        }
        const currentInfoPath = currentPath.replace(".pgn", ".info");
        const renamedInfoPath = renamedPath.replace(".pgn", ".info");
        await rename(currentPath, renamedPath);
        if (await exists(currentInfoPath)) {
          await rename(currentInfoPath, renamedInfoPath);
        }
        finalPath = renamedPath;
      }

      const metadata = await readInfoMetadata(finalPath, "variants");

      // Remove old comments/references tags
      metadata.tags = (metadata.tags || []).filter(
        (tag: string) =>
          !tag.startsWith("opening:") &&
          !tag.startsWith("priority:") &&
          !tag.startsWith("comments:") &&
          !tag.startsWith("references:"),
      );

      // Add opening tag if not empty
      if (commentsForm.values.opening.trim()) {
        metadata.tags.push(`opening:${commentsForm.values.opening.trim()}`);
      }
      if (priorityValue !== null) {
        metadata.tags.push(`priority:${priorityValue}`);
      }

      // Add new comments tag if not empty
      if (commentsForm.values.comments.trim()) {
        metadata.tags.push(`comments:${commentsForm.values.comments.trim()}`);
      }

      await writeInfoMetadata(finalPath, metadata);

      if (renamed) {
        const legacyVariantsDir = await getVariantsDirectory(activeProfileId);
        await repairVariantLinks(legacyVariantsDir);
      }
      try {
        window.dispatchEvent(new Event("variants:links-updated"));
        window.dispatchEvent(new Event("variants:updated"));
      } catch {}

      notifications.show({
        title: t("common.success"),
        message: t("features.board.variants.commentsSaved", { defaultValue: "Comments saved successfully" }),
        color: "green",
      });
      await refetch();
      closeEditCommentsModal();
    } catch (_error) {
      notifications.show({
        title: t("common.error"),
        message: t("features.board.variants.commentsSaveError", { defaultValue: "Failed to save comments" }),
        color: "red",
      });
    }
  }, [
    activeProfileId,
    closeEditCommentsModal,
    commentsForm.values.comments,
    commentsForm.values.name,
    commentsForm.values.priority,
    commentsForm.values.opening,
    refetch,
    selectedVariantForComments,
    t,
  ]);

  const handleDelete = useCallback(
    (variant: VariantInfo) => {
      const targetKey = normalizePath(variant.path);
      const variantByKey = new Map<string, VariantInfo>();
      const variantByFileName = new Map<string, VariantInfo[]>();
      for (const item of variants) {
        const key = normalizePath(item.path);
        variantByKey.set(key, item);
        const fileName = getFileName(item.path).toLowerCase();
        const list = variantByFileName.get(fileName) ?? [];
        list.push(item);
        variantByFileName.set(fileName, list);
      }

      const resolveVariant = (
        owner: VariantInfo,
        rawPath: string,
        fallbackName?: string | null,
      ): VariantInfo | null => {
        const resolved = resolveLinkedPath(owner.path, rawPath);
        const direct = variantByKey.get(resolved);
        if (direct) return direct;
        const byPathFileName = variantByFileName.get(getFileName(rawPath).toLowerCase());
        if (byPathFileName?.length) return byPathFileName[0] ?? null;
        if (fallbackName) {
          const byNameFileName = variantByFileName.get(fallbackName.toLowerCase());
          if (byNameFileName?.length) return byNameFileName[0] ?? null;
        }
        return null;
      };

      const childrenByParent = new Map<string, Set<string>>();
      const parentByChild = new Map<string, string>();
      for (const item of variants) {
        const selfKey = normalizePath(item.path);

        if (item.parentLink?.path) {
          const parentVariant = resolveVariant(item, item.parentLink.path, item.parentLink.name);
          if (parentVariant) {
            const parentKey = normalizePath(parentVariant.path);
            if (parentKey !== selfKey) {
              parentByChild.set(selfKey, parentKey);
              const children = childrenByParent.get(parentKey) ?? new Set<string>();
              children.add(selfKey);
              childrenByParent.set(parentKey, children);
            }
          }
        }

        for (const childLink of item.childLinks ?? []) {
          if (!childLink.path) continue;
          const childVariant = resolveVariant(item, childLink.path, childLink.name);
          if (!childVariant) continue;
          const childKey = normalizePath(childVariant.path);
          if (childKey === selfKey) continue;
          const children = childrenByParent.get(selfKey) ?? new Set<string>();
          children.add(childKey);
          childrenByParent.set(selfKey, children);
          if (!parentByChild.has(childKey)) {
            parentByChild.set(childKey, selfKey);
          }
        }
      }

      const keysToDelete: string[] = [];
      const visited = new Set<string>();
      const walk = (key: string) => {
        if (visited.has(key)) return;
        visited.add(key);
        keysToDelete.push(key);
        const childKeys = Array.from(childrenByParent.get(key) ?? []).filter(
          (childKey) => parentByChild.get(childKey) === key,
        );
        for (const childKey of childKeys) {
          walk(childKey);
        }
      };
      walk(targetKey);
      const variantsToDelete = keysToDelete
        .map((key) => variantByKey.get(key))
        .filter((item): item is VariantInfo => !!item);
      const descendantCount = Math.max(0, variantsToDelete.length - 1);

      modals.openConfirmModal({
        title: t("common.delete"),
        children: (
          <Text size="sm">
            {descendantCount > 0
              ? t("features.board.variants.deleteCascadeConfirm", {
                  defaultValue: "Delete this variant and its {{count}} descendant variant(s)? This cannot be undone.",
                  count: descendantCount,
                })
              : t("features.board.variants.deleteConfirm", {
                  defaultValue: "Are you sure you want to delete this variant?",
                })}
            <br />
            <Text component="span" fw={700}>
              {variant.name}
            </Text>
          </Text>
        ),
        labels: { confirm: t("common.delete"), cancel: t("common.cancel") },
        confirmProps: { color: "red" },
        onConfirm: async () => {
          try {
            const deletedPathKeys = new Set(variantsToDelete.map((item) => normalizePath(item.path)));
            await invoke("variants_delete_files", { paths: variantsToDelete.map((item) => item.path) });
            queryClient.setQueryData<VariantInfo[]>(variantsQueryKey, (current) =>
              (current ?? []).filter((item) => !deletedPathKeys.has(normalizePath(item.path))),
            );
            notifications.show({
              title: t("common.success"),
              message:
                descendantCount > 0
                  ? t("features.board.variants.deletedCascade", {
                      defaultValue: "Deleted variant and {{count}} descendant variant(s).",
                      count: descendantCount,
                    })
                  : t("features.board.variants.deleted", { defaultValue: "Variant deleted successfully" }),
              color: "green",
            });
            void (async () => {
              try {
                const variantsDir = await getVariantsDirectory(activeProfileId);
                for (const deletedVariant of variantsToDelete) {
                  await cleanupVariantLinksAfterDelete(deletedVariant.path, variantsDir);
                }
                try {
                  window.dispatchEvent(new Event("variants:links-updated"));
                } catch {}
              } catch {
                // Ignore link cleanup errors during delete.
              }
            })();
          } catch (_error) {
            notifications.show({
              title: t("common.error"),
              message: t("features.board.variants.deleteError", { defaultValue: "Failed to delete variant" }),
              color: "red",
            });
          }
        },
      });
    },
    [activeProfileId, queryClient, t, variants, variantsQueryKey],
  );

  const handleRepairLinks = useCallback(async () => {
    try {
      setRepairingLinks(true);
      const variantsDir = await getVariantsDirectory(activeProfileId);
      const report = await repairVariantLinks(variantsDir);
      try {
        window.dispatchEvent(new Event("variants:links-updated"));
      } catch {}
      await refetch();

      notifications.show({
        title: t("common.success"),
        message: t("features.board.variants.repairLinksDone", {
          defaultValue: "Links repaired. Updated: {{updated}}, added: {{added}}, removed: {{removed}}.",
          updated: report.updatedFiles,
          added: report.addedLinks,
          removed: report.removedLinks,
        }),
        color: "green",
      });
    } catch {
      notifications.show({
        title: t("common.error"),
        message: t("features.board.variants.repairLinksFailed", { defaultValue: "Failed to repair variant links." }),
        color: "red",
      });
    } finally {
      setRepairingLinks(false);
    }
  }, [activeProfileId, refetch, t]);

  const sortVariants = useCallback(
    (a: VariantInfo, b: VariantInfo) => {
      const { columnAccessor, direction } = sortStatus;
      const aValue = a[columnAccessor as keyof VariantInfo];
      const bValue = b[columnAccessor as keyof VariantInfo];

      let comparison = 0;
      if (aValue === null && bValue === null) {
        comparison = 0;
      } else if (aValue === null) {
        comparison = 1;
      } else if (bValue === null) {
        comparison = -1;
      } else if (typeof aValue === "number" && typeof bValue === "number") {
        comparison = aValue - bValue;
      } else {
        comparison = String(aValue).localeCompare(String(bValue));
      }

      return direction === "asc" ? comparison : -comparison;
    },
    [sortStatus],
  );

  const variantTreeRoots = useMemo(() => {
    const variantByKey = new Map<string, VariantInfo>();
    const variantByFileName = new Map<string, VariantInfo[]>();
    for (const variant of variants) {
      const key = normalizePath(variant.path);
      variantByKey.set(key, variant);
      const fileName = getFileName(variant.path).toLowerCase();
      const list = variantByFileName.get(fileName) ?? [];
      list.push(variant);
      variantByFileName.set(fileName, list);
    }

    const resolveVariant = (owner: VariantInfo, rawPath: string, fallbackName?: string | null): VariantInfo | null => {
      const resolved = resolveLinkedPath(owner.path, rawPath);
      const direct = variantByKey.get(resolved);
      if (direct) return direct;
      const byPathFileName = variantByFileName.get(getFileName(rawPath).toLowerCase());
      if (byPathFileName?.length) return byPathFileName[0] ?? null;
      if (fallbackName) {
        const byNameFileName = variantByFileName.get(fallbackName.toLowerCase());
        if (byNameFileName?.length) return byNameFileName[0] ?? null;
      }
      return null;
    };

    const childrenByParent = new Map<string, Set<string>>();
    const parentByChild = new Map<string, string>();
    for (const variant of variants) {
      const selfKey = normalizePath(variant.path);

      if (variant.parentLink?.path) {
        const parentVariant = resolveVariant(variant, variant.parentLink.path, variant.parentLink.name);
        if (parentVariant) {
          const parentKey = normalizePath(parentVariant.path);
          if (parentKey !== selfKey) {
            parentByChild.set(selfKey, parentKey);
            const children = childrenByParent.get(parentKey) ?? new Set<string>();
            children.add(selfKey);
            childrenByParent.set(parentKey, children);
          }
        }
      }

      for (const childLink of variant.childLinks ?? []) {
        if (!childLink.path) continue;
        const childVariant = resolveVariant(variant, childLink.path, childLink.name);
        if (!childVariant) continue;
        const childKey = normalizePath(childVariant.path);
        if (childKey === selfKey) continue;
        const children = childrenByParent.get(selfKey) ?? new Set<string>();
        children.add(childKey);
        childrenByParent.set(selfKey, children);
        if (!parentByChild.has(childKey)) {
          parentByChild.set(childKey, selfKey);
        }
      }
    }

    const searchLower = search.trim().toLowerCase();
    const selfMatches = new Map<string, boolean>();
    for (const variant of variants) {
      const key = normalizePath(variant.path);
      if (!searchLower) {
        selfMatches.set(key, true);
        continue;
      }
      const nameMatches = variant.name.toLowerCase().includes(searchLower);
      const openingMatches = variant.opening?.toLowerCase().includes(searchLower) ?? false;
      if (searchScope === "name") {
        selfMatches.set(key, nameMatches);
        continue;
      }
      if (searchScope === "opening") {
        selfMatches.set(key, openingMatches);
        continue;
      }
      const matches = nameMatches || openingMatches;
      selfMatches.set(key, !!matches);
    }

    const visibilityMemo = new Map<string, boolean>();
    const stack = new Set<string>();
    const hasVisibleSubtree = (key: string): boolean => {
      if (visibilityMemo.has(key)) return visibilityMemo.get(key)!;
      if (stack.has(key)) return false;
      stack.add(key);
      const ownMatch = selfMatches.get(key) ?? false;
      let childMatch = false;
      const childKeys = Array.from(childrenByParent.get(key) ?? []);
      for (const childKey of childKeys) {
        if (hasVisibleSubtree(childKey)) {
          childMatch = true;
          break;
        }
      }
      stack.delete(key);
      const visible = ownMatch || childMatch;
      visibilityMemo.set(key, visible);
      return visible;
    };

    const buildNode = (key: string, lineage: Set<string>): VariantTreeNode | null => {
      if (lineage.has(key)) return null;
      if (!hasVisibleSubtree(key)) return null;
      const variant = variantByKey.get(key);
      if (!variant) return null;
      const nextLineage = new Set(lineage);
      nextLineage.add(key);
      const childKeys = Array.from(childrenByParent.get(key) ?? []);
      const sortedChildren = childKeys
        .map((childKey) => {
          const canonicalParentKey = parentByChild.get(childKey);
          if (canonicalParentKey && canonicalParentKey !== key) {
            if (!hasVisibleSubtree(childKey)) return null;
            const childVariant = variantByKey.get(childKey);
            if (!childVariant) return null;
            return {
              key: `${key}=>${childKey}`,
              canonicalKey: childKey,
              variant: childVariant,
              children: [],
              isTransposition: true,
            };
          }
          return buildNode(childKey, nextLineage);
        })
        .filter((child): child is VariantTreeNode => !!child)
        .sort((a, b) => sortVariants(a.variant, b.variant));
      return {
        key,
        variant,
        children: sortedChildren,
      };
    };

    const rootKeys = variants.map((variant) => normalizePath(variant.path)).filter((key) => !parentByChild.has(key));

    const roots = rootKeys
      .map((key) => buildNode(key, new Set<string>()))
      .filter((node): node is VariantTreeNode => !!node)
      .sort((a, b) => sortVariants(a.variant, b.variant));

    const seen = new Set<string>();
    const markSeen = (node: VariantTreeNode) => {
      if (seen.has(node.key)) return;
      seen.add(node.key);
      for (const child of node.children) {
        markSeen(child);
      }
    };
    for (const root of roots) {
      markSeen(root);
    }
    for (const variant of variants) {
      const key = normalizePath(variant.path);
      if (seen.has(key)) continue;
      const detached = buildNode(key, new Set<string>());
      if (!detached) continue;
      roots.push(detached);
      markSeen(detached);
    }

    return roots;
  }, [variants, search, searchScope, sortVariants]);

  const variantLinkGraph = useMemo(() => {
    const variantByKey = new Map<string, VariantInfo>();
    const variantByFileName = new Map<string, VariantInfo[]>();

    for (const variant of variants) {
      const key = normalizePath(variant.path);
      variantByKey.set(key, variant);
      const fileName = getFileName(variant.path).toLowerCase();
      const list = variantByFileName.get(fileName) ?? [];
      list.push(variant);
      variantByFileName.set(fileName, list);
    }

    const resolveVariant = (owner: VariantInfo, rawPath: string, fallbackName?: string | null): VariantInfo | null => {
      const resolved = resolveLinkedPath(owner.path, rawPath);
      const direct = variantByKey.get(resolved);
      if (direct) return direct;
      const byPathFileName = variantByFileName.get(getFileName(rawPath).toLowerCase());
      if (byPathFileName?.length) return byPathFileName[0] ?? null;
      if (fallbackName) {
        const byNameFileName = variantByFileName.get(fallbackName.toLowerCase());
        if (byNameFileName?.length) return byNameFileName[0] ?? null;
      }
      return null;
    };

    const childrenByParent = new Map<string, Set<string>>();
    const parentByChild = new Map<string, string>();

    for (const variant of variants) {
      const selfKey = normalizePath(variant.path);

      if (variant.parentLink?.path) {
        const parentVariant = resolveVariant(variant, variant.parentLink.path, variant.parentLink.name);
        if (parentVariant) {
          const parentKey = normalizePath(parentVariant.path);
          if (parentKey !== selfKey) {
            parentByChild.set(selfKey, parentKey);
            const children = childrenByParent.get(parentKey) ?? new Set<string>();
            children.add(selfKey);
            childrenByParent.set(parentKey, children);
          }
        }
      }

      for (const childLink of variant.childLinks ?? []) {
        if (!childLink.path) continue;
        const childVariant = resolveVariant(variant, childLink.path, childLink.name);
        if (!childVariant) continue;
        const childKey = normalizePath(childVariant.path);
        if (childKey === selfKey) continue;
        const children = childrenByParent.get(selfKey) ?? new Set<string>();
        children.add(childKey);
        childrenByParent.set(selfKey, children);
        if (!parentByChild.has(childKey)) {
          parentByChild.set(childKey, selfKey);
        }
      }
    }

    return {
      variantByKey,
      childrenByParent,
      parentByChild,
    };
  }, [variants]);

  const collectSubtreeKeys = useCallback(
    (rootKey: string) => {
      const out: string[] = [];
      const visited = new Set<string>();

      const walk = (currentKey: string) => {
        if (visited.has(currentKey)) return;
        visited.add(currentKey);
        out.push(currentKey);

        const childKeys = Array.from(variantLinkGraph.childrenByParent.get(currentKey) ?? []).filter(
          (childKey) => variantLinkGraph.parentByChild.get(childKey) === currentKey,
        );
        for (const childKey of childKeys) {
          walk(childKey);
        }
      };

      walk(rootKey);
      return out;
    },
    [variantLinkGraph],
  );

  const validateVariantConsistencyBeforeAction = useCallback(
    async (variant: VariantInfo, options: { showCleanReport?: boolean } = {}) => {
      if (validatingVariants) return false;
      setValidatingVariants(true);
      setValidationReport(null);
      try {
        const variantsDir = await getVariantsDirectory(activeProfileId);
        const report = await invoke<VariantValidationReport>("variants_validate_consistency", {
          variantsDir,
          targetPath: variant.path,
        });

        if (report.conflicts.length > 0 || options.showCleanReport) {
          setValidationReport(report);
          setValidationModalOpened(true);
        }

        if (report.conflicts.length > 0) {
          notifications.show({
            title: t("common.warning"),
            message: t("features.board.variants.validationConflictsFound", {
              defaultValue: "Detected {{count}} contradictions in active-side moves.",
              count: report.conflicts.length,
            }),
            color: "yellow",
          });
          return false;
        }

        if (options.showCleanReport) {
          notifications.show({
            title: t("common.success"),
            message: t("features.board.variants.validationNoConflicts", {
              defaultValue: "No contradictions found for active-side moves.",
            }),
            color: "green",
          });
        }

        return true;
      } catch {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.validationFailed", {
            defaultValue: "Failed to validate variant consistency.",
          }),
          color: "red",
        });
        return false;
      } finally {
        setValidatingVariants(false);
      }
    },
    [activeProfileId, t, validatingVariants],
  );

  const applyBuildConfigToVariantTree = useCallback(async () => {
    if (!configureBuildTargetKey || applyingBuildConfig) return;

    const targetKeys = buildConfig.includeChildren
      ? collectSubtreeKeys(configureBuildTargetKey)
      : [configureBuildTargetKey];
    if (targetKeys.length === 0) return;

    try {
      setApplyingBuildConfig(true);

      const localDbLabel =
        buildConfig.dbType === "local"
          ? (localDatabaseOptions.find((option) => option.value === buildConfig.localDatabasePath)?.label ?? null)
          : null;
      const localDbFileName =
        buildConfig.dbType === "local" && buildConfig.localDatabasePath
          ? (buildConfig.localDatabasePath
              .split(/[/\\]/)
              .pop()
              ?.replace(/\.db3?$/i, "") ?? null)
          : null;
      const databaseTagValue =
        buildConfig.dbType === "local"
          ? `local -${localDbLabel ?? localDbFileName ?? "unknown"}`
          : buildConfig.dbType === "lch_master"
            ? "lichess master"
            : "lichess all";
      const lchSpeedsTag = buildConfig.lichessSpeeds.join(",");
      const lchRatingsTag = buildConfig.lichessRatings.join(",");
      const lchSinceTag = formatMonthTag(buildConfig.lichessSince);
      const lchUntilTag = formatMonthTag(buildConfig.lichessUntil);
      const masterSinceTag = formatMonthTag(buildConfig.masterSince);
      const masterUntilTag = formatMonthTag(buildConfig.masterUntil);

      let updated = 0;
      for (const key of targetKeys) {
        const variant = variantLinkGraph.variantByKey.get(key);
        if (!variant) continue;

        const metadata = await readInfoMetadata(variant.path, "variants");
        metadata.tags = (metadata.tags || []).filter(
          (tag: string) =>
            !tag.startsWith("depth:") &&
            !tag.startsWith("database:") &&
            !tag.startsWith("dbType:") &&
            !tag.startsWith("dbPath:") &&
            !tag.startsWith("buildMode:") &&
            !tag.startsWith("coverage:") &&
            !tag.startsWith("minMoves:") &&
            !tag.startsWith("engineMs:") &&
            !tag.startsWith("lchSpeeds:") &&
            !tag.startsWith("lchRatings:") &&
            !tag.startsWith("lchSince:") &&
            !tag.startsWith("lchUntil:") &&
            !tag.startsWith("lchPlayer:") &&
            !tag.startsWith("lchColor:") &&
            !tag.startsWith("masterSince:") &&
            !tag.startsWith("masterUntil:"),
        );

        metadata.tags.push(`database:${databaseTagValue}`);
        metadata.tags.push(`dbType:${buildConfig.dbType}`);
        if (buildConfig.dbType === "local" && buildConfig.localDatabasePath) {
          metadata.tags.push(`dbPath:${buildConfig.localDatabasePath}`);
        }
        if (buildConfig.dbType === "lch_all") {
          metadata.tags.push(`lchSpeeds:${lchSpeedsTag}`);
          metadata.tags.push(`lchRatings:${lchRatingsTag}`);
          metadata.tags.push(`lchColor:${buildConfig.lichessColor}`);
          if (buildConfig.lichessPlayer.trim()) {
            metadata.tags.push(`lchPlayer:${buildConfig.lichessPlayer.trim()}`);
          }
          if (lchSinceTag) {
            metadata.tags.push(`lchSince:${lchSinceTag}`);
          }
          if (lchUntilTag) {
            metadata.tags.push(`lchUntil:${lchUntilTag}`);
          }
        }
        if (buildConfig.dbType === "lch_master") {
          if (masterSinceTag) {
            metadata.tags.push(`masterSince:${masterSinceTag}`);
          }
          if (masterUntilTag) {
            metadata.tags.push(`masterUntil:${masterUntilTag}`);
          }
        }

        await writeInfoMetadata(variant.path, metadata);
        updated += 1;
      }

      try {
        window.dispatchEvent(new Event("variants:links-updated"));
        window.dispatchEvent(new Event("variants:updated"));
      } catch {}
      await refetch();

      notifications.show({
        title: t("common.success"),
        message: t("features.board.variants.buildConfigApplied", {
          defaultValue: "Database source settings applied to {{count}} variants.",
          count: updated,
        }),
        color: "green",
      });
      setConfigureBuildModalOpened(false);
    } catch {
      notifications.show({
        title: t("common.error"),
        message: t("features.board.variants.buildConfigApplyFailed", {
          defaultValue: "Failed to apply database source settings.",
        }),
        color: "red",
      });
    } finally {
      setApplyingBuildConfig(false);
    }
  }, [
    applyingBuildConfig,
    buildConfig,
    collectSubtreeKeys,
    configureBuildTargetKey,
    localDatabaseOptions,
    refetch,
    t,
    variantLinkGraph.variantByKey,
  ]);

  const handleCreateOpeningVariants = useCallback(
    async (row: VariantTableRow) => {
      if (openingVariantsTargetKey) return;

      const rootKey = row.canonicalKey ?? row.key;
      const rootVariant = variantLinkGraph.variantByKey.get(rootKey);
      if (!rootVariant) return;
      const canContinue = await validateVariantConsistencyBeforeAction(rootVariant);
      if (!canContinue) return;

      setOpeningVariantsTargetKey(rootKey);
      try {
        const variantsDir = await getVariantsDirectory(activeProfileId);
        const result = await invoke<{ created: number; removed: number; rootPath: string }>(
          "variants_create_opening_variants",
          {
            variantsDir,
            targetPath: rootVariant.path,
          },
        );

        try {
          window.dispatchEvent(new Event("variants:links-updated"));
          window.dispatchEvent(new Event("variants:updated"));
        } catch {}
        await refetch();

        notifications.show({
          title: t("common.success"),
          message: t("features.board.variants.openingVariantsReplaced", {
            defaultValue: "Replaced {{removed}} existing descendants with {{count}} ECO opening variants.",
            count: result.created,
            removed: result.removed,
          }),
          color: "green",
        });
      } catch (error) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.openingVariantsFailed", {
            defaultValue: "Failed to create opening variants: {{reason}}",
            reason: getErrorMessage(error),
          }),
          color: "red",
        });
      } finally {
        setOpeningVariantsTargetKey(null);
      }
    },
    [activeProfileId, openingVariantsTargetKey, refetch, t, validateVariantConsistencyBeforeAction, variantLinkGraph],
  );

  const handleCompressVariantFamily = useCallback(
    async (row: VariantTableRow) => {
      if (compressVariantsTargetKey) return;

      const rootKey = row.canonicalKey ?? row.key;
      const rootVariant = variantLinkGraph.variantByKey.get(rootKey);
      if (!rootVariant) return;
      const subtreeKeys = collectSubtreeKeys(rootKey);
      const descendantCount = Math.max(0, subtreeKeys.length - 1);
      if (descendantCount === 0) {
        notifications.show({
          title: t("common.warning"),
          message: t("features.board.variants.compressFamilyNoChildren", {
            defaultValue: "This variant does not have child variants to compress.",
          }),
          color: "yellow",
        });
        return;
      }

      const canContinue = await validateVariantConsistencyBeforeAction(rootVariant);
      if (!canContinue) return;

      modals.openConfirmModal({
        title: t("features.board.variants.compressFamily", {
          defaultValue: "Compress variant family",
        }),
        children: (
          <Text size="sm">
            {t("features.board.variants.compressFamilyConfirm", {
              defaultValue:
                "Merge {{count}} descendant variant(s) into {{name}} and delete the child files. This cannot be undone.",
              count: descendantCount,
              name: rootVariant.name,
            })}
          </Text>
        ),
        labels: {
          confirm: t("features.board.variants.compressFamily", { defaultValue: "Compress variant family" }),
          cancel: t("common.cancel"),
        },
        confirmProps: { color: "orange" },
        onConfirm: async () => {
          setCompressVariantsTargetKey(rootKey);
          try {
            const variantsDir = await getVariantsDirectory(activeProfileId);
            const result = await invoke<{ merged: number; removed: number; rootPath: string }>(
              "variants_compress_variant_family",
              {
                variantsDir,
                targetPath: rootVariant.path,
              },
            );

            try {
              window.dispatchEvent(new Event("variants:links-updated"));
              window.dispatchEvent(new Event("variants:updated"));
            } catch {}
            await refetch();

            notifications.show({
              title: t("common.success"),
              message: t("features.board.variants.compressFamilyDone", {
                defaultValue:
                  "Compressed {{merged}} variants into the parent and removed {{removed}} child variant(s).",
                merged: result.merged,
                removed: result.removed,
              }),
              color: "green",
            });
          } catch (error) {
            notifications.show({
              title: t("common.error"),
              message: t("features.board.variants.compressFamilyFailed", {
                defaultValue: "Failed to compress variant family: {{reason}}",
                reason: getErrorMessage(error),
              }),
              color: "red",
            });
          } finally {
            setCompressVariantsTargetKey(null);
          }
        },
      });
    },
    [
      activeProfileId,
      collectSubtreeKeys,
      compressVariantsTargetKey,
      refetch,
      t,
      validateVariantConsistencyBeforeAction,
      variantLinkGraph.variantByKey,
    ],
  );
  const openCoverageGraphForKey = useCallback((key: string) => {
    coverageGraphResumeSnapshot = null;
    coverageGraphPositionsRef.current = {};
    setCoverageGraphTargetKey(key);
    setCoverageGraphDepth("");
    setCoverageGraphRoot(null);
    setCoverageCollapsedNodeIds(new Set());
    setCoverageGraphCachePath(null);
    setCoverageGraphSourceSignature(null);
    setCoverageActionNode(null);
    setCoverageActionTab("edit");
    setCoveragePuzzleTierFilter("mainline");
    setCoveragePuzzleIncludeLowSample(true);
    setCoveragePuzzleName("");
    setCoverageEngineMs(1000);
    setCoveragePrioritySyncing(false);
    setCoverageBuildProgress(null);
    setCoverageGraphModalOpened(true);
  }, []);

  useEffect(() => {
    const snapshot = coverageGraphResumeSnapshot;
    if (!snapshot) return;
    coverageGraphResumeSnapshot = null;

    setCoverageGraphTargetKey(snapshot.targetKey);
    setCoverageGraphDepth(snapshot.depth);
    setCoverageGraphRoot(snapshot.root);
    setCoverageCollapsedNodeIds(new Set(snapshot.collapsedNodeIds));
    setCoverageGraphCachePath(snapshot.cachePath);
    setCoverageGraphSourceSignature(snapshot.sourceSignature);
    setCoverageGraphOrientation(snapshot.orientation);
    setCoverageActionNode(null);
    setCoverageActionTab("edit");
    setCoveragePuzzleTierFilter("mainline");
    setCoveragePuzzleIncludeLowSample(true);
    setCoveragePuzzleName("");
    setCoverageEngineMs(1000);
    setCoveragePrioritySyncing(false);
    setCoverageBuildProgress(null);
    setCoverageGraphLoading(false);
    setCoverageGraphModalOpened(true);
  }, []);

  const handleOpenCoverageGraph = useCallback(
    async (row: VariantTableRow) => {
      const key = row.canonicalKey ?? row.key;
      const variant = variantLinkGraph.variantByKey.get(key);
      if (!variant) return;
      const canContinue = await validateVariantConsistencyBeforeAction(variant);
      if (!canContinue) return;
      openCoverageGraphForKey(key);
    },
    [openCoverageGraphForKey, validateVariantConsistencyBeforeAction, variantLinkGraph.variantByKey],
  );

  const handleOpenCoverageGraphForVariant = useCallback(
    async (variant: VariantInfo) => {
      const canContinue = await validateVariantConsistencyBeforeAction(variant);
      if (!canContinue) return;
      openCoverageGraphForKey(normalizePath(variant.path));
    },
    [openCoverageGraphForKey, validateVariantConsistencyBeforeAction],
  );

  const handleBuildCoverageGraph = useCallback(
    async (options?: {
      forceRebuild?: boolean;
      bypassPositionCache?: boolean;
      persistResults?: boolean;
      mappedOnly?: boolean;
    }) => {
      if (!coverageGraphTargetKey || coverageGraphLoading) return;
      const forceRebuild = options?.forceRebuild === true;
      const bypassPositionCache = options?.bypassPositionCache === true;
      const persistResults = options?.persistResults !== false;
      const mappedOnly = options?.mappedOnly === true;
      const requestedDepth =
        typeof coverageGraphDepth === "number" && Number.isFinite(coverageGraphDepth)
          ? Math.max(1, Math.min(20, Math.floor(coverageGraphDepth)))
          : Number.NaN;
      const selectedProfileTimeControls =
        coverageProfileTimeControlFilters.length > 0
          ? coverageProfileTimeControlFilters
          : coverageProfileTimeControlOptions;
      if (!Number.isFinite(requestedDepth)) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.coverageGraphMissingDepth", {
            defaultValue: "Choose N moves before building the coverage graph.",
          }),
          color: "red",
        });
        return;
      }
      const runId =
        globalThis.crypto?.randomUUID?.() ??
        `coverage-graph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      coverageGraphBuildRunIdRef.current = runId;
      try {
        setCoverageGraphLoading(true);
        setCoveragePrioritySyncing(false);
        setCoverageBuildProgress({
          phase: "preparing",
          variantsDone: 0,
          variantsTotal: 0,
          positionsProcessed: 0,
          positionsPending: 0,
        });

        const backendResult = await invoke<CoverageGraphBackendBuildResult>("variant_coverage_build_graph", {
          request: {
            targetKey: coverageGraphTargetKey,
            variants,
            buildConfig: {
              dbType: buildConfig.dbType,
              localDatabasePath: buildConfig.localDatabasePath,
              lichessSpeeds: buildConfig.lichessSpeeds,
              lichessRatings: buildConfig.lichessRatings,
              lichessSince: formatMonthTag(buildConfig.lichessSince),
              lichessUntil: formatMonthTag(buildConfig.lichessUntil),
              lichessPlayer: buildConfig.lichessPlayer,
              lichessColor: buildConfig.lichessColor,
              masterSince: formatMonthTag(buildConfig.masterSince),
              masterUntil: formatMonthTag(buildConfig.masterUntil),
              includeChildren: buildConfig.includeChildren,
            },
            requestedDepth,
            forceRebuild,
            bypassPositionCache,
            persistResults,
            mappedOnly,
            lichessToken: lichessAuthToken ?? null,
            activeProfileId: activeProfileId ?? null,
            profileIdentityNames: activeProfileCoverageIdentityNames,
            profileTimeControlCategories: selectedProfileTimeControls,
            runId,
          },
        });

        coverageGraphPositionsRef.current = backendResult.positions;
        setCoverageGraphRoot(backendResult.graphRoot);
        setCoverageCollapsedNodeIds(
          buildCoverageDefaultCollapsedIds(backendResult.graphRoot, COVERAGE_GRAPH_INITIAL_EXPANDED_LEVELS),
        );
        setCoverageGraphOrientation(backendResult.repertoireColor);
        setCoverageGraphCachePath(backendResult.cachePath ?? null);
        setCoverageGraphSourceSignature(persistResults ? backendResult.sourceSignature : null);
        setCriticalLineDismissedFenKeys(new Set(backendResult.criticalLineDismissedFenKeys ?? []));
        setCoverageBuildProgress(null);

        if (backendResult.cacheWritten || backendResult.priorityMetadataUpdated) {
          try {
            window.dispatchEvent(new Event("variants:updated"));
          } catch {}
          await refetch();
        }
      } catch (error) {
        const reason = getErrorMessage(error);
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.coverageGraphFailedWithReason", {
            defaultValue: "Failed to build coverage graph: {{reason}}",
            reason,
          }),
          color: "red",
        });
        setCriticalLineLoading(false);
        setCriticalLineBuildRequest(null);
        setCriticalLineReportRequestKey(null);
        setCriticalLineRegenerating(false);
      } finally {
        coverageGraphBuildRunIdRef.current = null;
        setCoverageGraphLoading(false);
        setCoverageBuildProgress((prev) => {
          if (!prev) return prev;
          return { ...prev, positionsPending: 0 };
        });
      }
    },
    [
      activeProfileCoverageIdentityNames,
      activeProfileId,
      buildConfig,
      coverageGraphDepth,
      coverageGraphLoading,
      coverageGraphTargetKey,
      coverageProfileTimeControlFilters,
      coverageProfileTimeControlOptions,
      lichessAuthToken,
      refetch,
      t,
      variants,
    ],
  );

  const showCriticalLineReport = useCallback(
    async (root: CoverageGraphNode, activeColor: "white" | "black") => {
      setCriticalLineLoading(true);
      try {
        const completeLinesOnly = criticalLineCompleteOnlyRef.current;
        const backendReport = await getCoverageCriticalLineReport(
          root,
          activeColor,
          completeLinesOnly,
          criticalLineDismissedFenKeys,
        );
        setCriticalLineReport(backendReport);
        setCriticalLineModalOpened(true);
      } catch (error) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.criticalLineReportFailed", {
            defaultValue: "Failed to inspect critical lines: {{reason}}",
            reason: getErrorMessage(error),
          }),
          color: "red",
        });
      } finally {
        setCriticalLineLoading(false);
        setCriticalLineRegenerating(false);
      }
    },
    [criticalLineDismissedFenKeys, t],
  );

  const startCriticalLineInspection = useCallback(
    async (options: { regenerate?: boolean } = {}) => {
      const requestedDepth =
        typeof coverageGraphDepth === "number" && Number.isFinite(coverageGraphDepth)
          ? Math.max(1, Math.min(20, Math.floor(coverageGraphDepth)))
          : Number.NaN;
      if (!coverageGraphTargetKey || !Number.isFinite(requestedDepth)) {
        notifications.show({
          title: t("common.warning"),
          message: t("features.board.variants.criticalLineGraphMissing", {
            defaultValue: "Choose a coverage graph depth before inspecting critical lines.",
          }),
          color: "yellow",
        });
        return;
      }

      const variant = variantLinkGraph.variantByKey.get(coverageGraphTargetKey);
      if (variant) {
        const canContinue = await validateVariantConsistencyBeforeAction(variant);
        if (!canContinue) return;
      }

      const regenerate = options.regenerate === true;
      setCriticalLineRegenerating(regenerate);
      if (regenerate) {
        setCriticalLineDismissedFenKeys(new Set());
      }
      setCriticalLineLoading(true);
      coverageGraphPositionsRef.current = {};
      criticalLineCompleteOnlyRef.current = criticalLineMappedOnly;
      setCriticalLineReport(null);
      setCriticalLineReportRequestKey(coverageGraphTargetKey);
      setCriticalLineBuildRequest({
        key: coverageGraphTargetKey,
        depth: requestedDepth,
        mappedOnly: criticalLineMappedOnly,
        completeLinesOnly: criticalLineMappedOnly,
        forceRebuild: regenerate,
        bypassPositionCache: regenerate,
      });
      setCoverageGraphRoot(null);
    },
    [
      coverageGraphDepth,
      coverageGraphTargetKey,
      criticalLineMappedOnly,
      t,
      validateVariantConsistencyBeforeAction,
      variantLinkGraph.variantByKey,
    ],
  );

  const acceptCriticalLineRisk = useCallback(
    async (item: CriticalLineReportItem) => {
      const dismissalKey = getCriticalLineDismissalKey(item.fen, item.id);
      const nextDismissedKeys = new Set(criticalLineDismissedFenKeys);
      nextDismissedKeys.add(dismissalKey);
      setCriticalLineDismissedFenKeys(nextDismissedKeys);
      setCriticalLineReport((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          nodes: prev.nodes.filter((node) => getCriticalLineDismissalKey(node.fen, node.id) !== dismissalKey),
        };
      });

      if (!coverageGraphCachePath) {
        return;
      }

      try {
        const cache = await readCoverageGraphCache(coverageGraphCachePath);
        if (!cache) return;
        const persistedKeys = new Set(cache.criticalLineDismissedFenKeys ?? []);
        persistedKeys.add(dismissalKey);
        await writeCoverageGraphCache(coverageGraphCachePath, {
          ...cache,
          criticalLineDismissedFenKeys: Array.from(persistedKeys),
          generatedAt: new Date().toISOString(),
        });
      } catch (error) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.criticalLineDismissFailed", {
            defaultValue: "Failed to update the critical line cache: {{reason}}",
            reason: getErrorMessage(error),
          }),
          color: "red",
        });
      }
    },
    [coverageGraphCachePath, criticalLineDismissedFenKeys, t],
  );

  const handleOpenCoverageCriticalLines = useCallback(async () => {
    const requestedDepth =
      typeof coverageGraphDepth === "number" && Number.isFinite(coverageGraphDepth)
        ? Math.max(1, Math.min(20, Math.floor(coverageGraphDepth)))
        : Number.NaN;
    if (!coverageGraphTargetKey || !Number.isFinite(requestedDepth)) {
      notifications.show({
        title: t("common.warning"),
        message: t("features.board.variants.criticalLineGraphMissing", {
          defaultValue: "Choose a coverage graph depth before inspecting critical lines.",
        }),
        color: "yellow",
      });
      return;
    }

    setCriticalLineLoading(false);
    setCriticalLineRegenerating(false);
    coverageGraphPositionsRef.current = {};
    setCriticalLineDismissedFenKeys(new Set());
    setCriticalLineMappedOnly(true);
    criticalLineCompleteOnlyRef.current = true;
    setCriticalLineReport(null);
    setCriticalLineModalOpened(true);
  }, [coverageGraphDepth, coverageGraphTargetKey, t]);

  const handleOpenCriticalLinesFromRow = useCallback(
    async (row: VariantTableRow) => {
      const key = row.canonicalKey ?? row.key;
      const variant = variantLinkGraph.variantByKey.get(key);
      if (!variant) return;

      const requestedDepth =
        typeof coverageGraphDepth === "number" && Number.isFinite(coverageGraphDepth)
          ? Math.max(1, Math.min(20, Math.floor(coverageGraphDepth)))
          : Math.max(1, Math.min(20, row.variant.lineDepth ?? row.variant.depth ?? 5));

      setCriticalLineLoading(false);
      setCriticalLineRegenerating(false);
      coverageGraphPositionsRef.current = {};
      setCriticalLineDismissedFenKeys(new Set());
      setCriticalLineMappedOnly(true);
      criticalLineCompleteOnlyRef.current = true;
      setCriticalLineReport(null);
      setCriticalLineModalOpened(true);
      setCriticalLineReportRequestKey(null);
      setCriticalLineBuildRequest(null);
      setCoverageGraphTargetKey(key);
      setCoverageGraphDepth(requestedDepth);
      setCoverageGraphRoot(null);
      setCoverageCollapsedNodeIds(new Set());
      setCoverageGraphCachePath(null);
      setCoverageGraphSourceSignature(null);
      setCoverageActionNode(null);
      setCoverageActionTab("edit");
      setCoveragePuzzleTierFilter("mainline");
      setCoveragePuzzleIncludeLowSample(true);
      setCoveragePuzzleName("");
      setCoverageEngineMs(1000);
      setCoveragePrioritySyncing(false);
      setCoverageBuildProgress(null);
    },
    [coverageGraphDepth, variantLinkGraph.variantByKey],
  );

  useEffect(() => {
    if (!criticalLineBuildRequest) return;
    if (coverageGraphLoading) return;
    if (coverageGraphTargetKey !== criticalLineBuildRequest.key) return;
    if (coverageGraphDepth !== criticalLineBuildRequest.depth) return;
    setCriticalLineBuildRequest(null);
    criticalLineCompleteOnlyRef.current = criticalLineBuildRequest.completeLinesOnly === true;
    void handleBuildCoverageGraph({
      forceRebuild: criticalLineBuildRequest.forceRebuild === true,
      bypassPositionCache: criticalLineBuildRequest.bypassPositionCache === true,
      persistResults: criticalLineBuildRequest.mappedOnly === true,
      mappedOnly: criticalLineBuildRequest.mappedOnly === true,
    });
  }, [
    coverageGraphDepth,
    coverageGraphLoading,
    coverageGraphTargetKey,
    criticalLineBuildRequest,
    handleBuildCoverageGraph,
  ]);

  useEffect(() => {
    if (!criticalLineReportRequestKey) return;
    if (coverageGraphLoading || !coverageGraphRoot) return;
    if (coverageGraphTargetKey !== criticalLineReportRequestKey) return;

    setCriticalLineReportRequestKey(null);
    void showCriticalLineReport(coverageGraphRoot, coverageGraphOrientation);
  }, [
    coverageGraphLoading,
    coverageGraphOrientation,
    coverageGraphRoot,
    coverageGraphTargetKey,
    criticalLineReportRequestKey,
    showCriticalLineReport,
  ]);

  const refreshCoverageGraphProfileRates = useCallback(async () => {
    if (!coverageGraphRoot || !coverageGraphCachePath || coverageGraphLoading) return;
    const existingCache = await readCoverageGraphCache(coverageGraphCachePath);
    if (!existingCache) return;

    setCoverageProfileStatsRefreshing(true);
    try {
      let resolvedProfileStatsDbPath = `${activeProfileCoverageDbPath ?? ""}`.trim();
      if (!resolvedProfileStatsDbPath && activeProfileId) {
        try {
          resolvedProfileStatsDbPath = await getProfileDbPath(activeProfileId);
        } catch {
          resolvedProfileStatsDbPath = "";
        }
      }
      const selectedProfileTimeControls =
        coverageProfileTimeControlFilters.length > 0
          ? coverageProfileTimeControlFilters
          : coverageProfileTimeControlOptions;
      const playerIds = await resolveActiveProfileCoveragePlayerIds(resolvedProfileStatsDbPath);
      const nextGraph = await applyProfileFlagsToCoverageGraph(
        coverageGraphRoot,
        existingCache.positions,
        resolvedProfileStatsDbPath || null,
        playerIds,
        coverageGraphOrientation,
        selectedProfileTimeControls,
      );
      coverageGraphPositionsRef.current = existingCache.positions;
      const normalizedGraph = normalizeCoverageGraphSourceRatesByResultFen(
        nextGraph,
        existingCache.positions,
        coverageGraphOrientation,
      );
      setCoverageGraphRoot(await applyCriticalLineFlagsToCoverageGraph(normalizedGraph, coverageGraphOrientation));
    } finally {
      setCoverageProfileStatsRefreshing(false);
    }
  }, [
    activeProfileCoverageDbPath,
    activeProfileId,
    coverageGraphCachePath,
    coverageGraphLoading,
    coverageGraphOrientation,
    coverageGraphRoot,
    coverageProfileTimeControlFilters,
    coverageProfileTimeControlOptions,
    resolveActiveProfileCoveragePlayerIds,
  ]);

  useEffect(() => {
    if (!coverageGraphModalOpened || !coverageGraphRoot || coverageGraphLoading) return;
    void refreshCoverageGraphProfileRates();
  }, [coverageGraphModalOpened, coverageGraphRoot, refreshCoverageGraphProfileRates, coverageGraphLoading]);

  const visibleCoverageGraphRoot = useMemo(
    () => applyCollapsedCoverageNodes(coverageGraphRoot, coverageCollapsedNodeIds),
    [coverageCollapsedNodeIds, coverageGraphRoot],
  );

  useEffect(() => {
    if (!coverageGraphRoot) return;
    const validIds = collectCollapsibleCoverageNodeIds(coverageGraphRoot);
    setCoverageCollapsedNodeIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [coverageGraphRoot]);

  const toggleCoverageNodeCollapsed = useCallback(
    (node: CoverageGraphNode) => {
      if (!coverageGraphRoot || node.tier === "root") return;
      setCoverageCollapsedNodeIds((prev) => {
        const fullNode = findCoverageNodeById(coverageGraphRoot, node.id);
        if (!fullNode || fullNode.children.length === 0) {
          return prev;
        }
        const next = new Set(prev);
        const isCollapsed = next.has(node.id);

        if (!isCollapsed) {
          next.add(node.id);
          return next;
        }

        // Expand only one level: reveal current node children, keep deeper levels collapsed.
        next.delete(node.id);
        const branchCollapsedIds = collectCoverageBranchCollapseIds(fullNode, 2);
        for (const collapsedId of branchCollapsedIds) {
          next.add(collapsedId);
        }
        return next;
      });
    },
    [coverageGraphRoot],
  );

  const expandCoverageNodeAllChildren = useCallback(
    (node: CoverageGraphNode) => {
      if (!coverageGraphRoot || node.tier === "root") return;
      setCoverageCollapsedNodeIds((prev) => {
        const fullNode = findCoverageNodeById(coverageGraphRoot, node.id);
        if (!fullNode || fullNode.children.length === 0) {
          return prev;
        }
        const next = new Set(prev);
        const subtreeIds = collectCoverageSubtreeNodeIds(fullNode);
        for (const id of subtreeIds) {
          next.delete(id);
        }
        return next;
      });
    },
    [coverageGraphRoot],
  );

  const handleCoverageNodeClick = useCallback(
    (node: CoverageGraphNode) => {
      setCoverageActionNode(node);
      setCoverageActionTier(node.tier === "secondary" || node.tier === "alternative" ? node.tier : "mainline");
      setCoverageActionTab(node.tier === "root" ? "puzzles" : "edit");
      setCoverageActionLabel(extractCoverageEditableLabel(node.label));
      setCoveragePuzzleTierFilter(node.tier === "secondary" || node.tier === "alternative" ? node.tier : "mainline");
      const seedSan = extractSanFromCoverageNode(node) ?? "node";
      setCoveragePuzzleName(sanitizeFileStem(`coverage-${seedSan}`));
      const variantEngineMs = coverageGraphTargetKey
        ? (variantLinkGraph.variantByKey.get(coverageGraphTargetKey)?.engineMs ?? null)
        : null;
      setCoverageEngineMs(variantEngineMs && variantEngineMs > 0 ? variantEngineMs : 1000);
    },
    [coverageGraphTargetKey, variantLinkGraph.variantByKey],
  );

  const generatePuzzlesFromCoverageNode = useCallback(async () => {
    if (!coverageActionNode) return;
    if (!coverageGraphRoot || !coverageGraphTargetKey) return;
    if (coveragePuzzleGenerating) return;

    const selectedDepth = 1;
    const selectedName = sanitizeFileStem(coveragePuzzleName.trim() || `coverage-${formatDateToPGN(new Date())}`);

    try {
      setCoveragePuzzleGenerating(true);
      const targetVariant = variantLinkGraph.variantByKey.get(coverageGraphTargetKey);
      if (!targetVariant) {
        notifications.show({
          title: t("common.error"),
          message: t("common.noRecordsFound", { defaultValue: "No records found" }),
          color: "red",
        });
        return;
      }

      const orientation = coverageGraphOrientation;
      const generatedCoverage = await generatePuzzleVariantsFromCoverageNode({
        graphRoot: coverageGraphRoot,
        actionNodeId: coverageActionNode.id,
        orientation,
        selectedDepth,
        tierFilter: coveragePuzzleTierFilter,
        includeLowSample: coveragePuzzleIncludeLowSample,
      });

      const puzzleVariantsDir = await getPuzzleVariantsDirectory(activeProfileId);
      const variantsDir = await getVariantsDirectory(activeProfileId);
      const sourceTags = buildPuzzleVariantSourceTags({
        profileId: activeProfileId,
        variantsDir,
        variantPath: targetVariant.path,
      });

      const now = formatFileTimestamp(new Date());
      let generatedFiles = 0;
      let totalPuzzles = 0;
      const emptyTiers = generatedCoverage.emptyTiers.map(coverageTierFileSuffix);

      for (const result of generatedCoverage.results) {
        const selectedTier = result.tier;
        const tierSuffix = coverageTierFileSuffix(selectedTier);

        const fileStemBase = sanitizeFileStem(
          coveragePuzzleTierFilter === "all"
            ? `${selectedName}-${tierSuffix}-d${selectedDepth}-${now}`
            : `${selectedName}-${selectedTier}-d${selectedDepth}-${now}`,
        );
        const fileStem = await resolveAvailablePgnFileStem(puzzleVariantsDir, fileStemBase);
        const tags = [
          PUZZLE_VARIANTS_TAG,
          ...sourceTags,
          `variant:${targetVariant.name}`,
          `coverageNode:${coverageActionNode.label}`,
          `coverageTier:${selectedTier}`,
          `priority:${coverageTierPriority(selectedTier) ?? ""}`,
          `coverageLowSample:${coveragePuzzleIncludeLowSample ? "include" : "exclude"}`,
          `depth:${selectedDepth}`,
          `orientation:${orientation}`,
        ];
        if (generatedCoverage.ecoVariant) {
          tags.push(`ecoVariant:${generatedCoverage.ecoVariant}`);
        }

        const createResult = await createFile({
          filename: fileStem,
          filetype: "puzzle",
          tags,
          pgn: result.pgn,
          dir: puzzleVariantsDir,
        });

        if (createResult.isErr) {
          throw createResult.error;
        }

        generatedFiles += 1;
        totalPuzzles += result.count;
      }

      if (generatedFiles === 0) {
        notifications.show({
          title: t("common.warning"),
          message: t("features.board.variants.coveragePuzzleEmpty", {
            defaultValue: "No branches available for the selected tier from this node.",
          }),
          color: "yellow",
        });
        return;
      }

      try {
        window.dispatchEvent(new Event("puzzles:updated"));
        window.dispatchEvent(new Event("puzzle-variants:updated"));
      } catch {}

      notifications.show({
        title: t("common.success"),
        message:
          coveragePuzzleTierFilter === "all"
            ? t("features.board.variants.coveragePuzzleAllDone", {
                defaultValue: "Generated {{count}} puzzles across {{files}} files.",
                count: totalPuzzles,
                files: generatedFiles,
                skipped: emptyTiers.join(", "),
              })
            : t("features.board.variants.coveragePuzzleDone", {
                defaultValue: "Generated {{count}} puzzles from selected node.",
                count: totalPuzzles,
              }),
        color: "green",
      });
      setCoverageActionNode(null);
    } catch {
      notifications.show({
        title: t("common.error"),
        message: t("common.failedToGeneratePuzzles"),
        color: "red",
      });
    } finally {
      setCoveragePuzzleGenerating(false);
    }
  }, [
    coverageActionNode,
    coverageGraphRoot,
    coverageGraphOrientation,
    coverageGraphTargetKey,
    coveragePuzzleGenerating,
    coveragePuzzleIncludeLowSample,
    coveragePuzzleName,
    coveragePuzzleTierFilter,
    activeProfileId,
    t,
    variantLinkGraph.variantByKey,
  ]);

  const goToCoverageNodeVariant = useCallback(
    async (nodeOverride?: CoverageGraphNode) => {
      const selectedNode = nodeOverride ?? coverageActionNode;
      if (!selectedNode || !coverageGraphRoot || !coverageGraphTargetKey) return;
      try {
        const sourceNodePath = findCoverageNodePathById(coverageGraphRoot, selectedNode.id);
        if (!sourceNodePath) {
          notifications.show({
            title: t("common.error"),
            message: t("features.board.variants.coverageNodeNotFound", {
              defaultValue: "Could not locate the selected node in the current graph.",
            }),
            color: "red",
          });
          return;
        }

        const sourceNode = sourceNodePath[sourceNodePath.length - 1] ?? null;
        const parentNode = sourceNodePath.length > 1 ? sourceNodePath[sourceNodePath.length - 2] : null;
        const sanSequence = buildSanSequenceFromCoveragePath(sourceNodePath);
        const targetVariant = variantLinkGraph.variantByKey.get(coverageGraphTargetKey);
        if (!targetVariant) {
          notifications.show({
            title: t("common.error"),
            message: t("common.noRecordsFound", { defaultValue: "No records found" }),
            color: "red",
          });
          return;
        }

        const orderedCandidateKeys = [
          coverageGraphTargetKey,
          ...collectSubtreeKeys(coverageGraphTargetKey).filter((key) => key !== coverageGraphTargetKey),
        ];
        const fenCandidates = [
          selectedNode.fen ?? null,
          getCoverageNodeTerminalFen(sourceNode),
          sourceNode?.fen ?? null,
          parentNode?.fen ?? null,
        ].filter(
          (value, index, array): value is string =>
            typeof value === "string" && value.trim().length > 0 && array.indexOf(value) === index,
        );
        let bestMatch: { variant: VariantInfo; position: number[]; fenPriority: number; sanScore: number } | null =
          null;

        const { commands } = await import("@/bindings");
        const { unwrap } = await import("@/utils/unwrap");

        for (const candidateKey of orderedCandidateKeys) {
          const candidate = variantLinkGraph.variantByKey.get(candidateKey);
          if (!candidate) continue;
          try {
            const count = unwrap(await commands.countPgnGames(candidate.path));
            if (count <= 0) continue;
            const games = unwrap(await commands.readGames(candidate.path, 0, 0));
            const firstGame = games[0];
            if (!firstGame) continue;
            const tree = await parsePGN(firstGame);

            let localBestPath: number[] | null = null;
            let localFenPriority = Number.POSITIVE_INFINITY;
            let localSanScore = -1;

            for (let fenPriority = 0; fenPriority < fenCandidates.length; fenPriority += 1) {
              const fenCandidate = fenCandidates[fenPriority];
              const position = findBestTreePathByFen(tree.root, fenCandidate, sanSequence);
              if (!position) continue;
              const candidateSans = getSanSequenceAtTreePath(tree.root, position);
              const sanScore = getSuffixSanMatchScore(candidateSans, sanSequence);
              if (
                localBestPath === null ||
                fenPriority < localFenPriority ||
                (fenPriority === localFenPriority && sanScore > localSanScore) ||
                (fenPriority === localFenPriority &&
                  sanScore === localSanScore &&
                  position.length > localBestPath.length)
              ) {
                localBestPath = position;
                localFenPriority = fenPriority;
                localSanScore = sanScore;
              }
            }

            // Fallback for legacy nodes where FEN cannot be matched, try exact SAN path only (no skipping).
            if (!localBestPath) {
              const sanOnlyPath = sanSequence.length > 0 ? findTreePathBySanSequence(tree.root, sanSequence) : [];
              if (sanOnlyPath) {
                localBestPath = sanOnlyPath;
                localFenPriority = Number.POSITIVE_INFINITY;
                localSanScore = getSuffixSanMatchScore(getSanSequenceAtTreePath(tree.root, sanOnlyPath), sanSequence);
              }
            }

            if (!localBestPath) continue;

            if (
              !bestMatch ||
              localFenPriority < bestMatch.fenPriority ||
              (localFenPriority === bestMatch.fenPriority && localSanScore > bestMatch.sanScore) ||
              (localFenPriority === bestMatch.fenPriority &&
                localSanScore === bestMatch.sanScore &&
                localBestPath.length > bestMatch.position.length)
            ) {
              bestMatch = {
                variant: candidate,
                position: localBestPath,
                fenPriority: localFenPriority,
                sanScore: localSanScore,
              };
            }
          } catch {
            // Ignore broken variants while resolving node jump target.
          }
        }

        if (!bestMatch) {
          notifications.show({
            title: t("common.warning"),
            message: t("features.board.variants.coverageGoToVariantMissing", {
              defaultValue: "Could not map this node to a variant move path.",
            }),
            color: "yellow",
          });
          return;
        }

        coverageGraphResumeSnapshot = {
          targetKey: coverageGraphTargetKey,
          depth:
            typeof coverageGraphDepth === "number" && Number.isFinite(coverageGraphDepth)
              ? Math.max(1, Math.floor(coverageGraphDepth))
              : 1,
          root: coverageGraphRoot,
          cachePath: coverageGraphCachePath,
          sourceSignature: coverageGraphSourceSignature,
          orientation: coverageGraphOrientation,
          collapsedNodeIds: Array.from(coverageCollapsedNodeIds),
          capturedAt: Date.now(),
        };

        await openFile(bestMatch.variant.path, setTabs, setActiveTab, {
          position: bestMatch.position,
          initialNotationView: "variations",
        });
        navigate({ to: "/analysis" });
        setCoverageActionNode(null);
      } catch {
        coverageGraphResumeSnapshot = null;
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.coverageGoToVariantFailed", {
            defaultValue: "Failed to open variant for this node.",
          }),
          color: "red",
        });
      }
    },
    [
      collectSubtreeKeys,
      coverageActionNode,
      coverageCollapsedNodeIds,
      coverageGraphCachePath,
      coverageGraphRoot,
      coverageGraphDepth,
      coverageGraphOrientation,
      coverageGraphSourceSignature,
      coverageGraphTargetKey,
      navigate,
      setActiveTab,
      setTabs,
      t,
      variantLinkGraph.variantByKey,
    ],
  );

  const applyCoverageNodeEdit = useCallback(async () => {
    if (!coverageActionNode || coverageActionNode.tier === "root") return;
    if (!coverageGraphTargetKey) return;
    if (!coverageActionNode.overrideKey) {
      notifications.show({
        title: t("common.error"),
        message: t("features.board.variants.coverageTierOverrideUnavailable", {
          defaultValue: "This node cannot be edited manually.",
        }),
        color: "red",
      });
      return;
    }

    const nextLabel = coverageActionLabel.trim();
    if (!nextLabel) {
      notifications.show({
        title: t("common.error"),
        message: t("features.board.variants.coverageRenameRequired", {
          defaultValue: "Node name is required.",
        }),
        color: "red",
      });
      return;
    }

    const overrideKey = coverageActionNode.overrideKey;
    try {
      setCoverageActionSaving(true);
      setCoverageGraphRoot((prev) => {
        if (!prev) return prev;
        const withTier = setCoverageTierByOverrideKey(prev, overrideKey, coverageActionTier);
        return setCoverageLabelByOverrideKey(withTier, overrideKey, nextLabel);
      });

      const targetVariant = variantLinkGraph.variantByKey.get(coverageGraphTargetKey);
      if (!targetVariant) return;
      const resolvedCachePath =
        coverageGraphCachePath ??
        (coverageGraphSourceSignature
          ? await getCoverageGraphCacheFilePath(targetVariant.path, coverageGraphSourceSignature)
          : null);
      if (!resolvedCachePath) {
        notifications.show({
          title: t("common.warning"),
          message: t("features.board.variants.coverageTierOverrideNeedsRebuild", {
            defaultValue: "No coverage cache found. Rebuild graph to persist manual tier changes.",
          }),
          color: "yellow",
        });
        setCoverageActionNode(null);
        return;
      }
      const existingCache = await readCoverageGraphCache(resolvedCachePath);
      if (!existingCache) {
        notifications.show({
          title: t("common.warning"),
          message: t("features.board.variants.coverageTierOverrideNeedsRebuild", {
            defaultValue: "No coverage cache found. Rebuild graph to persist manual tier changes.",
          }),
          color: "yellow",
        });
        setCoverageActionNode(null);
        return;
      }

      const graphWithTier = setCoverageTierByOverrideKey(existingCache.graphRoot, overrideKey, coverageActionTier);
      const graphWithTierAndLabel = setCoverageLabelByOverrideKey(graphWithTier, overrideKey, nextLabel);

      const nextCache: VariantCoverageCache = {
        ...existingCache,
        version: COVERAGE_GRAPH_CACHE_VERSION,
        tierOverrides: {
          ...(existingCache.tierOverrides ?? {}),
          [overrideKey]: coverageActionTier,
        },
        labelOverrides: {
          ...(existingCache.labelOverrides ?? {}),
          [overrideKey]: nextLabel,
        },
        graphRoot: graphWithTierAndLabel,
        generatedAt: new Date().toISOString(),
      };

      const separator = overrideKey.lastIndexOf("|");
      if (separator > 0) {
        const fenKey = overrideKey.slice(0, separator);
        const san = overrideKey.slice(separator + 1);
        const entry = nextCache.positions[fenKey];
        if (entry) {
          entry.moves = entry.moves.map((move) => (move.san === san ? { ...move, tier: coverageActionTier } : move));
        }
      }

      await writeCoverageGraphCache(resolvedCachePath, nextCache);
      setCoverageGraphCachePath(resolvedCachePath);
      try {
        window.dispatchEvent(new Event("variants:updated"));
      } catch {}
      notifications.show({
        title: t("common.success"),
        message: t("features.board.variants.coverageEditApplied", {
          defaultValue: "Node settings updated.",
        }),
        color: "green",
      });
      setCoverageActionNode(null);
    } catch (_error) {
      notifications.show({
        title: t("common.error"),
        message: t("features.board.variants.coverageEditFailed", {
          defaultValue: "Failed to save node settings.",
        }),
        color: "red",
      });
    } finally {
      setCoverageActionSaving(false);
    }
  }, [
    coverageActionLabel,
    coverageActionNode,
    coverageActionTier,
    coverageGraphCachePath,
    coverageGraphSourceSignature,
    coverageGraphTargetKey,
    t,
    variantLinkGraph.variantByKey,
  ]);

  useEffect(() => {
    if (!coverageEngineProgress) return;
    trackCoverageEngine(coverageEngineRunIdRef.current ?? "unknown", "front.progress.rendered", {
      total: coverageEngineProgress.total,
      completed: coverageEngineProgress.completed,
      saved: coverageEngineProgress.saved,
      cached: coverageEngineProgress.cached,
      failed: coverageEngineProgress.failed,
      currentLabel: coverageEngineProgress.currentLabel,
    });
  }, [coverageEngineProgress]);

  const runCoverageNodeEngineEval = useCallback(async () => {
    if (!coverageActionNode || !coverageGraphTargetKey) return;
    const runId = createCoverageEngineRunId();
    coverageEngineRunIdRef.current = runId;
    const disableProgressEvents = false;
    const disableProgressUi = false;
    const disableNotifications = false;
    const disableGraphCacheWrites = false;
    const updateCoverageProgress = (
      phase: string,
      updater: CoverageEngineProgress | null | ((prev: CoverageEngineProgress | null) => CoverageEngineProgress | null),
    ) => {
      trackCoverageEngine(runId, "front.progress.update.requested", { phase, disabled: disableProgressUi });
      if (disableProgressUi) return;
      setCoverageEngineProgress(updater);
    };
    const showCoverageEngineNotification = (phase: string, options: Parameters<typeof notifications.show>[0]) => {
      trackCoverageEngine(runId, "front.notification.before", {
        phase,
        disabled: disableNotifications,
        color: options.color ?? null,
      });
      if (disableNotifications) return null;
      try {
        const notificationId = notifications.show(options);
        trackCoverageEngine(runId, "front.notification.after", { phase, notificationId: notificationId ?? null });
        return notificationId;
      } catch (error) {
        trackCoverageEngine(runId, "front.notification.error", {
          phase,
          error: formatCoverageEngineUnknownError(error),
        });
        throw error;
      }
    };

    trackCoverageEngine(runId, "front.run.requested", {
      nodeId: coverageActionNode.id,
      nodeLabel: coverageActionNode.label,
      targetKey: coverageGraphTargetKey,
      disableProgressEvents,
      disableProgressUi,
      disableNotifications,
      disableGraphCacheWrites,
    });
    const sourceNode = coverageActionNode;
    trackCoverageEngine(runId, "front.source.ready", {
      sourceNodeId: sourceNode.id,
      sourceLabel: sourceNode.label,
    });

    const localEngines = engines.filter((engine): engine is Extract<(typeof engines)[number], { type: "local" }> => {
      return engine.type === "local" && `${engine.path ?? ""}`.trim().length > 0;
    });
    const targetVariant = variantLinkGraph.variantByKey.get(coverageGraphTargetKey) ?? null;
    const preferredEngineName = `${targetVariant?.engine ?? ""}`.trim().toLowerCase();
    const selectedEngine =
      localEngines.find((engine) => `${engine.name ?? ""}`.trim().toLowerCase() === preferredEngineName) ??
      localEngines.find((engine) => engine.enabled !== false) ??
      localEngines[0] ??
      null;
    if (!selectedEngine) {
      trackCoverageEngine(runId, "front.engine.missing", { localEngineCount: localEngines.length });
      showCoverageEngineNotification("missing-engine", {
        title: t("common.error"),
        message: t("features.board.variants.coverageEngineMissing", {
          defaultValue: "No local engine available. Configure an engine first.",
        }),
        color: "red",
      });
      return;
    }

    const requestedMs = coverageEngineMs || targetVariant?.engineMs || 1000;
    trackCoverageEngine(runId, "front.engine.selected", {
      engineName: selectedEngine.name,
      requestedMs,
      targetVariantPath: targetVariant?.path ?? null,
    });
    try {
      trackCoverageEngine(runId, "front.run.state.begin");
      coverageEngineAbortRef.current = false;
      setCoverageEngineAnalysisActive(true);
      trackCoverageEngine(runId, "front.database.cancel.before");
      await queryClient.cancelQueries({ queryKey: ["database-opening"] }).catch(() => {});
      trackCoverageEngine(runId, "front.database.cancel.after");
      setCoverageEngineEvaluating(true);
      updateCoverageProgress("initialize", {
        total: 0,
        completed: 0,
        saved: 0,
        cached: 0,
        failed: 0,
        currentLabel: "",
      });
      const engineSettings = (selectedEngine.settings ?? []).map((setting) => ({
        name: `${setting.name ?? ""}`,
        value: setting.value == null ? "" : String(setting.value),
      }));
      trackCoverageEngine(runId, "front.engine.options.ready", {
        engineSettingsCount: engineSettings.length,
      });
      trackCoverageEngine(runId, "front.graph-cache.path.ready", {
        graphCachePath: coverageGraphCachePath ?? null,
        writeGraphCache: !disableGraphCacheWrites,
      });
      let appliedCount = 0;
      let failedCount = 0;
      let savedCount = 0;
      let cachedCount = 0;
      let completedCount = 0;
      let totalCount = 0;
      let graphCacheWritten = false;
      const failedDetails: string[] = [];

      showCoverageEngineNotification("started", {
        title: t("features.board.variants.coverageEngineRun", { defaultValue: "Analyze branch" }),
        message: t("features.board.variants.coverageEnginePreparing", {
          defaultValue: "Preparing branch analysis.",
        }),
        color: "blue",
      });

      let unlistenProgress: (() => void) | null = null;
      try {
        if (!disableProgressEvents) {
          unlistenProgress = await listen<CoverageEngineSessionProgressPayload>(
            COVERAGE_ENGINE_SESSION_PROGRESS_EVENT,
            (event) => {
              const payload = event.payload;
              if (payload.runId && payload.runId !== runId) return;
              updateCoverageProgress("backend-progress", (prev) =>
                prev
                  ? {
                      ...prev,
                      total: payload.total,
                      completed: Math.max(prev.completed, payload.completed),
                      saved: payload.saved,
                      cached: payload.cached,
                      failed: payload.failed,
                      currentLabel: payload.label,
                    }
                  : prev,
              );
            },
          );
        }

        const backendResult = await invoke<CoverageEngineBackendRunResult>("run_coverage_engine_analysis", {
          request: {
            engineName: selectedEngine.name,
            enginePath: selectedEngine.path,
            sourceNodeId: sourceNode.id,
            sourceNode,
            graphRoot: coverageGraphRoot,
            graphCachePath: coverageGraphCachePath,
            variantPath: targetVariant?.path ?? null,
            coverageGraphSourceSignature,
            ms: requestedMs,
            engineSettings,
            emitProgress: !disableProgressEvents,
            writeGraphCache: !disableGraphCacheWrites,
            runId,
          },
        });

        savedCount = backendResult.saved;
        cachedCount = backendResult.cached;
        failedCount = backendResult.failed;
        completedCount = backendResult.completed;
        totalCount = backendResult.total;
        graphCacheWritten = backendResult.graphCacheWritten === true;
        appliedCount = backendResult.applied;
        failedDetails.push(...(backendResult.failedDetails ?? []));

        if (backendResult.updatedGraphRoot) {
          const flaggedGraph = await applyCriticalLineFlagsToCoverageGraph(
            backendResult.updatedGraphRoot,
            coverageGraphOrientation,
          );
          setCoverageGraphRoot(flaggedGraph);
          setCoverageActionNode(
            findCoverageNodeById(flaggedGraph, sourceNode.id) ?? backendResult.updatedActionNode ?? null,
          );
        } else if (backendResult.updatedActionNode) {
          setCoverageActionNode(backendResult.updatedActionNode);
        }
        if (backendResult.graphCacheWritten && backendResult.resolvedGraphCachePath) {
          setCoverageGraphCachePath(backendResult.resolvedGraphCachePath);
        }

        updateCoverageProgress("backend-done", (prev) =>
          prev
            ? {
                ...prev,
                total: backendResult.total,
                completed: completedCount,
                saved: savedCount,
                cached: cachedCount,
                failed: failedCount,
                currentLabel: "",
              }
            : prev,
        );
      } finally {
        if (unlistenProgress) {
          unlistenProgress();
        }
      }

      if (coverageEngineAbortRef.current) {
        trackCoverageEngine(runId, "front.run.cancelled", { savedCount, cachedCount, failedCount });
        updateCoverageProgress("cancelled", (prev) => (prev ? { ...prev, currentLabel: "" } : prev));
        showCoverageEngineNotification("cancelled", {
          title: t("common.warning"),
          message: t("features.board.variants.coverageEngineCancelled", {
            defaultValue: "Engine analysis stopped. Saved: {{saved}}, cached: {{cached}}, failed: {{failed}}.",
            saved: savedCount,
            cached: cachedCount,
            failed: failedCount,
          }),
          color: "yellow",
        });
        return;
      }

      if (totalCount === 0) {
        showCoverageEngineNotification("no-targets", {
          title: t("common.error"),
          message: t("features.board.variants.coverageNodeBranchMissingFen", {
            defaultValue: "Selected node and its direct children have no completed mapped response positions.",
          }),
          color: "red",
        });
        return;
      }

      if (appliedCount === 0) {
        trackCoverageEngine(runId, "front.run.no-engine-info", {
          savedCount,
          cachedCount,
          failedCount,
          failedLabels: failedDetails.slice(0, 3),
        });
        showCoverageEngineNotification("no-engine-info", {
          title: t("common.warning"),
          message:
            failedCount > 0
              ? t("features.board.variants.coverageEngineEvalPartiallyApplied", {
                  defaultValue:
                    "Engine analysis completed with warnings. Saved: {{saved}}, cached: {{cached}}, failed: {{failed}}. Failed nodes: {{failedLabels}}.",
                  saved: savedCount,
                  cached: cachedCount,
                  failed: failedCount,
                  failedLabels: failedDetails.slice(0, 3).join("; "),
                })
              : t("features.board.variants.coverageEngineNoScore", {
                  defaultValue: "Engine score not available for this node or its direct children.",
                }),
          color: "yellow",
        });
        return;
      }

      trackCoverageEngine(runId, "front.backend.apply.done", {
        savedCount,
        cachedCount,
        failedCount,
        appliedCount,
        graphCacheWritten,
      });

      const completionMessageKey =
        failedCount > 0
          ? "features.board.variants.coverageEngineEvalPartiallyApplied"
          : "features.board.variants.coverageEngineEvalApplied";
      showCoverageEngineNotification("completed", {
        title: failedCount > 0 ? t("common.warning") : t("common.success"),
        message: t(completionMessageKey, {
          defaultValue: "Engine analysis completed. Saved: {{saved}}, cached: {{cached}}, failed: {{failed}}.",
          saved: savedCount,
          cached: cachedCount,
          failed: failedCount,
          failedLabels: failedDetails.slice(0, 3).join("; "),
        }),
        color: failedCount > 0 ? "yellow" : "green",
      });
      trackCoverageEngine(runId, "front.run.completed", { savedCount, cachedCount, failedCount, completedCount });
    } catch (error) {
      trackCoverageEngine(runId, "front.run.error", {
        error: formatCoverageEngineUnknownError(error),
      });
      showCoverageEngineNotification("failed", {
        title: t("common.error"),
        message: t("features.board.variants.coverageEngineEvalFailed", {
          defaultValue: "Failed to evaluate node with engine.",
        }),
        color: "red",
      });
    } finally {
      trackCoverageEngine(runId, "front.run.finally.begin");
      setCoverageEngineEvaluating(false);
      setCoverageEngineAnalysisActive(false);
      coverageEngineAbortRef.current = false;
      trackCoverageEngine(runId, "front.run.finally.after");
    }
  }, [
    coverageActionNode,
    coverageEngineMs,
    coverageGraphCachePath,
    coverageGraphRoot,
    coverageGraphSourceSignature,
    coverageGraphTargetKey,
    engines,
    queryClient,
    setCoverageEngineAnalysisActive,
    t,
    variantLinkGraph.variantByKey,
    coverageGraphOrientation,
  ]);

  const runCoverageActionPrimary = useCallback(async () => {
    if (coverageActionTab === "edit") {
      await applyCoverageNodeEdit();
      return;
    }
    if (coverageActionTab === "puzzles") {
      await generatePuzzlesFromCoverageNode();
      return;
    }
    if (coverageActionTab === "engine") {
      await runCoverageNodeEngineEval();
    }
  }, [applyCoverageNodeEdit, coverageActionTab, generatePuzzlesFromCoverageNode, runCoverageNodeEngineEval]);

  const coverageActionPrimaryLabel = useMemo(() => {
    if (coverageActionTab === "edit") {
      return t("common.save", { defaultValue: "Save" });
    }
    if (coverageActionTab === "puzzles") {
      return t("features.board.variants.coverageGeneratePuzzles", { defaultValue: "Generate puzzles" });
    }
    if (coverageActionTab === "engine") {
      return t("features.board.variants.coverageEngineRun", { defaultValue: "Analyze branch" });
    }
    return "";
  }, [coverageActionTab, t]);

  const coverageActionPrimaryLoading = coverageActionSaving || coveragePuzzleGenerating || coverageEngineEvaluating;
  const coverageActionPrimaryDisabled =
    coverageActionPrimaryLoading ||
    !coverageActionNode ||
    (coverageActionTab === "edit" && coverageActionLabel.trim().length === 0) ||
    (coverageActionTab === "engine" && coverageEngineMs < 100);
  const showCoverageActionPrimary = coverageActionTab !== "board";
  const requestCoverageEngineAbort = useCallback((origin: string) => {
    coverageEngineAbortRef.current = true;
    trackCoverageEngine(coverageEngineRunIdRef.current ?? "unknown", "front.abort.requested", { origin });
  }, []);
  const closeCoverageActionModal = useCallback(() => {
    if (coverageEngineEvaluating) {
      trackCoverageEngine(coverageEngineRunIdRef.current ?? "unknown", "front.modal.close.blocked", {
        reason: "engine-evaluating",
      });
      return;
    }
    setCoverageActionNode(null);
  }, [coverageEngineEvaluating]);
  const coverageActionTabs = useMemo(() => {
    const tabs: Array<{ value: CoverageActionTab; label: string }> = [];
    if (coverageActionNode?.tier !== "root") {
      tabs.push({ value: "edit", label: t("features.board.variants.coverageActionEditTab", { defaultValue: "Edit" }) });
    }
    tabs.push({
      value: "puzzles",
      label: t("features.board.variants.coverageActionPuzzlesTab", { defaultValue: "Puzzles" }),
    });
    if (coverageActionNode?.fen) {
      tabs.push({
        value: "board",
        label: t("features.board.variants.coverageActionBoardTab", { defaultValue: "Board" }),
      });
    }
    tabs.push({
      value: "engine",
      label: t("features.board.variants.coverageActionEngineTab", { defaultValue: "Engine" }),
    });
    return tabs;
  }, [coverageActionNode?.fen, coverageActionNode?.tier, t]);
  const coverageActionBoardFen = `${coverageActionNode?.fen ?? ""}`.trim();
  const coverageActionBoardError = useMemo(() => {
    if (!coverageActionBoardFen) return "missing";
    const [, error] = positionFromFen(coverageActionBoardFen);
    return error ? "invalid" : null;
  }, [coverageActionBoardFen]);

  useEffect(() => {
    if (!coverageEngineEvaluating) {
      setCoverageEngineProgress(null);
    }
  }, [coverageEngineEvaluating]);

  const handleOpenGeneratePuzzles = useCallback(
    async (row: VariantTableRow) => {
      if (generatingPuzzles || coverageGraphLoading || coveragePuzzleGenerating) return;

      const key = row.canonicalKey ?? row.key;
      const variant = variantLinkGraph.variantByKey.get(key);
      if (!variant) return;
      const canContinue = await validateVariantConsistencyBeforeAction(variant);
      if (!canContinue) return;

      const requestedDepth =
        typeof coverageGraphDepth === "number" && Number.isFinite(coverageGraphDepth)
          ? Math.max(1, Math.min(20, Math.floor(coverageGraphDepth)))
          : Math.max(1, Math.min(20, variant.lineDepth ?? variant.depth ?? 5));
      const selectedProfileTimeControls =
        coverageProfileTimeControlFilters.length > 0
          ? coverageProfileTimeControlFilters
          : coverageProfileTimeControlOptions;
      const runId =
        globalThis.crypto?.randomUUID?.() ??
        `coverage-puzzles-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

      setCoveragePuzzleSetupTargetKey(key);
      setGeneratingPuzzles(true);
      setCoverageGraphLoading(true);
      setCoverageBuildProgress({
        phase: "preparing",
        variantsDone: 0,
        variantsTotal: 0,
        positionsProcessed: 0,
        positionsPending: 0,
      });
      coverageGraphBuildRunIdRef.current = runId;
      try {
        coverageGraphResumeSnapshot = null;
        coverageGraphPositionsRef.current = {};
        setCoverageGraphTargetKey(key);
        setCoverageGraphDepth(requestedDepth);
        setCoverageGraphRoot(null);
        setCoverageCollapsedNodeIds(new Set());
        setCoverageGraphCachePath(null);
        setCoverageGraphSourceSignature(null);
        setCoverageActionNode(null);
        setCoverageActionTab("puzzles");
        setCoveragePuzzleTierFilter("mainline");
        setCoveragePuzzleIncludeLowSample(true);
        setCoveragePuzzleName(sanitizeFileStem(`coverage-${variant.name}`));
        setCoverageEngineMs(variant.engineMs && variant.engineMs > 0 ? variant.engineMs : 1000);
        setCoveragePrioritySyncing(false);

        const backendResult = await invoke<CoverageGraphBackendBuildResult>("variant_coverage_build_graph", {
          request: {
            targetKey: key,
            variants,
            buildConfig: {
              dbType: buildConfig.dbType,
              localDatabasePath: buildConfig.localDatabasePath,
              lichessSpeeds: buildConfig.lichessSpeeds,
              lichessRatings: buildConfig.lichessRatings,
              lichessSince: formatMonthTag(buildConfig.lichessSince),
              lichessUntil: formatMonthTag(buildConfig.lichessUntil),
              lichessPlayer: buildConfig.lichessPlayer,
              lichessColor: buildConfig.lichessColor,
              masterSince: formatMonthTag(buildConfig.masterSince),
              masterUntil: formatMonthTag(buildConfig.masterUntil),
              includeChildren: buildConfig.includeChildren,
            },
            requestedDepth,
            forceRebuild: false,
            bypassPositionCache: false,
            persistResults: true,
            mappedOnly: false,
            lichessToken: lichessAuthToken ?? null,
            activeProfileId: activeProfileId ?? null,
            profileIdentityNames: activeProfileCoverageIdentityNames,
            profileTimeControlCategories: selectedProfileTimeControls,
            runId,
          },
        });

        coverageGraphPositionsRef.current = backendResult.positions;
        setCoverageGraphRoot(backendResult.graphRoot);
        setCoverageCollapsedNodeIds(
          buildCoverageDefaultCollapsedIds(backendResult.graphRoot, COVERAGE_GRAPH_INITIAL_EXPANDED_LEVELS),
        );
        setCoverageGraphOrientation(backendResult.repertoireColor);
        setCoverageGraphCachePath(backendResult.cachePath ?? null);
        setCoverageGraphSourceSignature(backendResult.sourceSignature);
        setCriticalLineDismissedFenKeys(new Set(backendResult.criticalLineDismissedFenKeys ?? []));
        setCoverageActionNode(backendResult.graphRoot);

        if (backendResult.cacheWritten || backendResult.priorityMetadataUpdated) {
          try {
            window.dispatchEvent(new Event("variants:updated"));
          } catch {}
          await refetch();
        }
      } catch (error) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.coverageGraphFailedWithReason", {
            defaultValue: "Failed to build coverage graph: {{reason}}",
            reason: getErrorMessage(error),
          }),
          color: "red",
        });
      } finally {
        coverageGraphBuildRunIdRef.current = null;
        setCoverageGraphLoading(false);
        setCoverageBuildProgress(null);
        setGeneratingPuzzles(false);
        setCoveragePuzzleSetupTargetKey(null);
      }
    },
    [
      activeProfileCoverageIdentityNames,
      activeProfileId,
      buildConfig,
      coverageGraphDepth,
      coverageGraphLoading,
      coverageProfileTimeControlFilters,
      coverageProfileTimeControlOptions,
      coveragePuzzleGenerating,
      generatingPuzzles,
      lichessAuthToken,
      refetch,
      t,
      validateVariantConsistencyBeforeAction,
      variantLinkGraph.variantByKey,
      variants,
    ],
  );

  const handleValidateVariantTree = useCallback(
    async (row: VariantTableRow) => {
      const key = row.canonicalKey ?? row.key;
      const variant = variantLinkGraph.variantByKey.get(key) ?? row.variant;
      await validateVariantConsistencyBeforeAction(variant, { showCleanReport: true });
    },
    [validateVariantConsistencyBeforeAction, variantLinkGraph.variantByKey],
  );

  const handleOpenValidationConflict = useCallback(
    async (conflict: VariantValidationConflict, occurrence?: VariantValidationMoveOccurrence) => {
      const targetPath = occurrence?.variantPath ?? conflict.moves[0]?.occurrences[0]?.variantPath;
      if (!targetPath) return;

      try {
        const { commands } = await import("@/bindings");
        const { unwrap } = await import("@/utils/unwrap");
        const count = unwrap(await commands.countPgnGames(targetPath));
        if (count <= 0) throw new Error("Variant has no games");
        const games = unwrap(await commands.readGames(targetPath, 0, 0));
        const firstGame = games[0];
        if (!firstGame) throw new Error("Variant has no readable PGN");
        const tree = await parsePGN(firstGame);
        const position = findFirstTreePathByFen(tree.root, conflict.fen) ?? [];

        await openFile(targetPath, setTabs, setActiveTab, {
          position,
          initialNotationView: "variations",
        });
        setValidationModalOpened(false);
        navigate({ to: "/analysis" });
      } catch {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.validationOpenConflictFailed", {
            defaultValue: "Failed to open the conflicting position.",
          }),
          color: "red",
        });
      }
    },
    [navigate, setActiveTab, setTabs, t],
  );

  const handleApplyValidationMove = useCallback(
    async (conflict: VariantValidationConflict, selectedSan: string) => {
      if (!validationReport || resolvingValidationConflict) return;
      setResolvingValidationConflict(true);
      try {
        const { commands } = await import("@/bindings");
        const { unwrap } = await import("@/utils/unwrap");
        const conflictFenKey = normalizeFenKey(conflict.fen);
        const variantPaths = Array.from(
          new Set(
            validationReport.checkedVariantPaths.length > 0
              ? validationReport.checkedVariantPaths
              : conflict.moves.flatMap((move) => move.occurrences.map((occurrence) => occurrence.variantPath)),
          ),
        );

        const parsedByPath = new Map<string, Awaited<ReturnType<typeof parsePGN>>>();
        let selectedReplyTemplate: TreeNode | null = null;

        const cloneNode = (node: TreeNode): TreeNode => ({
          ...node,
          move: node.move ? { ...node.move } : null,
          shapes: node.shapes.map((shape) => ({ ...shape })),
          annotations: [...node.annotations],
          children: node.children.map(cloneNode),
        });

        const findSelectedReply = (node: TreeNode): TreeNode | null => {
          if (normalizeFenKey(node.fen) === conflictFenKey) {
            const reply = node.children.find((child) => child.san?.trim() === selectedSan);
            if (reply) return reply;
          }
          for (const child of node.children) {
            const found = findSelectedReply(child);
            if (found) return found;
          }
          return null;
        };

        for (const path of variantPaths) {
          const count = unwrap(await commands.countPgnGames(path));
          if (count <= 0) continue;
          const games = unwrap(await commands.readGames(path, 0, 0));
          const firstGame = games[0];
          if (!firstGame) continue;
          const tree = await parsePGN(firstGame);
          parsedByPath.set(path, tree);
          selectedReplyTemplate ??= findSelectedReply(tree.root);
        }

        const selectedReply = selectedReplyTemplate;
        if (!selectedReply) {
          notifications.show({
            title: t("common.error"),
            message: t("features.board.variants.validationSelectedMoveMissing", {
              defaultValue: "The selected move was not found in the checked variants.",
            }),
            color: "red",
          });
          return;
        }

        let updatedFiles = 0;
        const applyToNode = (node: TreeNode): boolean => {
          let changed = false;
          if (normalizeFenKey(node.fen) === conflictFenKey) {
            const currentMainSan = node.children[0]?.san?.trim() ?? null;
            const hasOnlySelectedReply = node.children.length === 1 && currentMainSan === selectedSan;
            if (!hasOnlySelectedReply) {
              node.children = [cloneNode(selectedReply)];
              changed = true;
            }
          }
          for (const child of node.children) {
            changed = applyToNode(child) || changed;
          }
          return changed;
        };

        for (const [path, tree] of parsedByPath.entries()) {
          if (!applyToNode(tree.root)) continue;
          const pgn = getPGNFromReportView(tree.root, {
            headers: tree.headers,
            glyphs: true,
            comments: true,
            variations: true,
            extraMarkups: true,
          });
          unwrap(await commands.writeGame(path, 0, pgn));
          updatedFiles += 1;
        }

        const variantsDir = await getVariantsDirectory(activeProfileId);
        const refreshedReport = await invoke<VariantValidationReport>("variants_validate_consistency", {
          variantsDir,
          targetPath: validationReport.targetVariantPath,
        });
        setValidationReport(refreshedReport);
        void queryClient.invalidateQueries({ queryKey: variantsQueryKey });

        notifications.show({
          title: t("common.success"),
          message: t("features.board.variants.validationConflictResolved", {
            defaultValue: "Applied {{move}} to {{count}} variant files.",
            move: selectedSan,
            count: updatedFiles,
          }),
          color: "green",
        });
      } catch {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.validationResolveFailed", {
            defaultValue: "Failed to resolve the consistency conflict.",
          }),
          color: "red",
        });
      } finally {
        setResolvingValidationConflict(false);
      }
    },
    [activeProfileId, queryClient, resolvingValidationConflict, t, validationReport, variantsQueryKey],
  );

  const variantTableRows = useMemo(() => {
    const rows: VariantTableRow[] = [];
    const forceExpand = search.trim().length > 0;
    const walk = (node: VariantTreeNode, depth: number) => {
      const hasChildren = !node.isTransposition && node.children.length > 0;
      const expanded = !node.isTransposition && (forceExpand || expandedKeys.has(node.key));
      rows.push({
        ...node.variant,
        key: node.key,
        canonicalKey: node.canonicalKey,
        variant: node.variant,
        depth,
        hasChildren,
        expanded,
        isTransposition: node.isTransposition,
      });
      if (!hasChildren || !expanded) return;
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    };
    for (const root of variantTreeRoots) {
      walk(root, 0);
    }
    return rows;
  }, [variantTreeRoots, expandedKeys, search]);

  const visibleTreeVariants = useMemo(() => {
    const out: VariantInfo[] = [];
    const seen = new Set<string>();
    const walk = (node: VariantTreeNode) => {
      const key = node.canonicalKey ?? node.key;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(node.variant);
      }
      for (const child of node.children) {
        walk(child);
      }
    };
    for (const root of variantTreeRoots) {
      walk(root);
    }
    return out;
  }, [variantTreeRoots]);

  const premiumStats = useMemo(() => {
    const linkedVariants = variants.filter(
      (variant) => variant.parentLink || (variant.childLinks?.length ?? 0) > 0,
    ).length;
    const averageDepthSource = variants
      .map((variant) =>
        typeof variant.lineDepth === "number"
          ? variant.lineDepth
          : typeof variant.depth === "number"
            ? variant.depth
            : null,
      )
      .filter((depth): depth is number => typeof depth === "number" && Number.isFinite(depth));
    const averageDepth =
      averageDepthSource.length > 0
        ? (averageDepthSource.reduce((sum, depth) => sum + depth, 0) / averageDepthSource.length).toFixed(1)
        : "--";

    return {
      totalVariants: variants.length,
      visibleVariants: visibleTreeVariants.length,
      rootVariants: variantTreeRoots.length,
      linkedVariants,
      averageDepth,
    };
  }, [variantTreeRoots, variants, visibleTreeVariants]);

  const lichessSpeedOptions = useMemo(
    () => [
      { value: "ultraBullet", label: t("TimeControl.UltraBullet", { defaultValue: "UltraBullet" }) },
      { value: "bullet", label: t("TimeControl.Bullet", { defaultValue: "Bullet" }) },
      { value: "blitz", label: t("TimeControl.Blitz", { defaultValue: "Blitz" }) },
      { value: "rapid", label: t("TimeControl.Rapid", { defaultValue: "Rapid" }) },
      { value: "classical", label: t("TimeControl.Classical", { defaultValue: "Classical" }) },
      { value: "correspondence", label: t("TimeControl.Correspondence", { defaultValue: "Correspondence" }) },
    ],
    [t],
  );
  const lichessRatingOptions = useMemo(
    () =>
      [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500].map((value) => ({
        value: String(value),
        label: value === 0 ? "400" : String(value),
      })),
    [],
  );

  const paginatedRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    return variantTableRows.slice(start, end);
  }, [variantTableRows, page, pageSize]);

  useEffect(() => {
    if (isLoading) return;
    const maxPage = Math.max(1, Math.ceil(variantTableRows.length / pageSize));
    if (page > maxPage) {
      setPage(maxPage);
    }
  }, [isLoading, variantTableRows.length, page, pageSize]);

  const toggleRow = (rowKey: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) {
        next.delete(rowKey);
      } else {
        next.add(rowKey);
      }
      return next;
    });
  };

  const renderVariantActions = (row: VariantTableRow) => {
    const rowKey = row.canonicalKey ?? row.key;
    const isBusyCriticalLine = criticalLineReportRequestKey === rowKey;
    const isBusyGeneratePuzzles = generatingPuzzles && coveragePuzzleSetupTargetKey === rowKey;
    const isBusyOpeningVariants = openingVariantsTargetKey === rowKey;
    const isBusyCompressVariants = compressVariantsTargetKey === rowKey;

    if (useCompactVariantsTable) {
      return (
        <Menu position="bottom-end" withinPortal shadow="md">
          <Menu.Target>
            <Button size="xs" variant="light" radius="md" rightSection={<IconChevronDown size={14} />}>
              {t("common.actions", { defaultValue: "Actions" })}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconShieldCheck size={16} />}
              onClick={() => void handleValidateVariantTree(row)}
              disabled={validatingVariants}
            >
              {t("features.board.variants.validateConsistency", { defaultValue: "Validate consistency" })}
            </Menu.Item>
            <Menu.Item
              leftSection={isBusyGeneratePuzzles ? <Loader size={14} /> : <IconPuzzle size={16} />}
              onClick={() => void handleOpenGeneratePuzzles(row)}
              disabled={generatingPuzzles || coveragePuzzleGenerating || coverageGraphLoading || validatingVariants}
            >
              {t("common.generatePuzzles", { defaultValue: "Generate Puzzles" })}
            </Menu.Item>
            <Menu.Item leftSection={<IconEye size={16} />} onClick={() => handleEdit(row.variant)}>
              {t("common.view", { defaultValue: "View" })}
            </Menu.Item>
            <Menu.Item leftSection={<IconEdit size={16} />} onClick={() => handleEditComments(row.variant)}>
              {t("features.board.variants.editComments", { defaultValue: "Edit Comments / References" })}
            </Menu.Item>
            <Menu.Item
              leftSection={<IconSettings size={16} />}
              onClick={() => void handleOpenConfigureBuild(row.variant)}
            >
              {t("features.board.variants.configureBuild", { defaultValue: "Configure data source" })}
            </Menu.Item>
            <Menu.Item
              leftSection={isBusyOpeningVariants ? <Loader size={14} /> : <IconSitemap size={16} />}
              onClick={() => void handleCreateOpeningVariants(row)}
              disabled={openingVariantsTargetKey !== null || validatingVariants}
            >
              {t("features.board.variants.createOpeningVariants", {
                defaultValue: "Create ECO opening variants",
              })}
            </Menu.Item>
            <Menu.Item
              leftSection={isBusyCompressVariants ? <Loader size={14} /> : <IconFileImport size={16} />}
              onClick={() => void handleCompressVariantFamily(row)}
              disabled={compressVariantsTargetKey !== null || validatingVariants || !row.hasChildren}
            >
              {t("features.board.variants.compressFamily", {
                defaultValue: "Compress variant family",
              })}
            </Menu.Item>
            <Menu.Item
              leftSection={<IconGitBranch size={16} />}
              onClick={() => void handleOpenCoverageGraph(row)}
              disabled={validatingVariants}
            >
              {t("features.board.variants.coverageGraph", { defaultValue: "Open coverage graph" })}
            </Menu.Item>
            <Menu.Item
              leftSection={isBusyCriticalLine ? <Loader size={14} /> : <IconExclamationCircle size={16} />}
              onClick={() => void handleOpenCriticalLinesFromRow(row)}
              disabled={validatingVariants || coverageGraphLoading || criticalLineLoading}
            >
              {t("features.board.variants.criticalLineNodes", { defaultValue: "Critical lines" })}
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => handleDelete(row.variant)}>
              {t("common.delete", { defaultValue: "Delete" })}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      );
    }

    return (
      <Group gap={4} justify="flex-end" wrap="nowrap">
        <Tooltip label={t("features.board.variants.validateConsistency", { defaultValue: "Validate consistency" })}>
          <ActionIcon
            variant="subtle"
            color="teal"
            onClick={() => void handleValidateVariantTree(row)}
            disabled={validatingVariants}
          >
            <IconShieldCheck size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("common.generatePuzzles", { defaultValue: "Generate Puzzles" })}>
          <ActionIcon
            variant="subtle"
            color="yellow"
            onClick={() => void handleOpenGeneratePuzzles(row)}
            disabled={generatingPuzzles || coveragePuzzleGenerating || coverageGraphLoading || validatingVariants}
          >
            {isBusyGeneratePuzzles ? <Loader size={14} /> : <IconPuzzle size={16} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("common.view", { defaultValue: "View" })}>
          <ActionIcon variant="subtle" color="blue" onClick={() => handleEdit(row.variant)}>
            <IconEye size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("features.board.variants.editComments", { defaultValue: "Edit Comments / References" })}>
          <ActionIcon variant="subtle" color="grape" onClick={() => handleEditComments(row.variant)}>
            <IconEdit size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("features.board.variants.configureBuild", { defaultValue: "Configure data source" })}>
          <ActionIcon variant="subtle" color="cyan" onClick={() => void handleOpenConfigureBuild(row.variant)}>
            <IconSettings size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip
          label={t("features.board.variants.createOpeningVariants", {
            defaultValue: "Create ECO opening variants",
          })}
        >
          <ActionIcon
            variant="subtle"
            color="indigo"
            onClick={() => void handleCreateOpeningVariants(row)}
            disabled={openingVariantsTargetKey !== null || validatingVariants}
          >
            {isBusyOpeningVariants ? <Loader size={14} /> : <IconSitemap size={16} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip
          label={t("features.board.variants.compressFamily", {
            defaultValue: "Compress variant family",
          })}
        >
          <ActionIcon
            variant="subtle"
            color="orange"
            onClick={() => void handleCompressVariantFamily(row)}
            disabled={compressVariantsTargetKey !== null || validatingVariants || !row.hasChildren}
          >
            {isBusyCompressVariants ? <Loader size={14} /> : <IconFileImport size={16} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("features.board.variants.coverageGraph", { defaultValue: "Open coverage graph" })}>
          <ActionIcon
            variant="subtle"
            color="blue"
            onClick={() => void handleOpenCoverageGraph(row)}
            disabled={validatingVariants}
          >
            <IconGitBranch size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("features.board.variants.criticalLineNodes", { defaultValue: "Critical lines" })}>
          <ActionIcon
            variant="subtle"
            color="pink"
            onClick={() => void handleOpenCriticalLinesFromRow(row)}
            disabled={validatingVariants || coverageGraphLoading || criticalLineLoading}
          >
            {isBusyCriticalLine ? <Loader size={14} /> : <IconExclamationCircle size={16} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("common.delete", { defaultValue: "Delete" })}>
          <ActionIcon variant="subtle" color="red" onClick={() => handleDelete(row.variant)}>
            <IconTrash size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
    );
  };

  const variantsTableMinWidth = useCompactVariantsTable ? 980 : 1280;

  const columns = [
    {
      accessor: "name",
      title: t("features.board.variants.name", { defaultValue: "Name" }),
      sortable: true,
      width: useCompactVariantsTable ? "28%" : "18%",
      ellipsis: true,
      render: (row: VariantTableRow) => (
        <Group wrap="nowrap" gap="sm">
          <Group wrap="nowrap" gap={6} style={{ marginLeft: row.depth * (useCompactVariantsTable ? 10 : 16) }}>
            {row.hasChildren ? (
              <ActionIcon variant="subtle" size="sm" color="gray" onClick={() => toggleRow(row.key)}>
                {row.expanded ? <IconChevronDown size="0.9rem" /> : <IconChevronRight size="0.9rem" />}
              </ActionIcon>
            ) : (
              <Box w={22} />
            )}
            {row.isTransposition ? (
              <Tooltip label={t("features.board.variants.transpositionLink", { defaultValue: "Transposition" })}>
                <IconSitemap size="1.2rem" style={{ flexShrink: 0 }} />
              </Tooltip>
            ) : (
              <IconGitBranch size="1.2rem" style={{ flexShrink: 0 }} />
            )}
          </Group>
          <Box miw={0} style={{ flex: 1 }}>
            <Group gap={6} wrap="nowrap">
              <Text fw={600} size="sm" truncate>
                {row.variant.name}
              </Text>
              {row.isTransposition ? (
                <Badge variant="light" color="violet" size="xs">
                  {t("features.board.variants.transpositionLink", { defaultValue: "Transposition" })}
                </Badge>
              ) : null}
            </Group>
          </Box>
        </Group>
      ),
    },
    {
      accessor: "opening",
      title: t("features.board.variants.opening", { defaultValue: "Opening" }),
      sortable: true,
      width: useCompactVariantsTable ? "22%" : "21%",
      ellipsis: true,
      render: (row: VariantTableRow) =>
        row.variant.opening ? (
          <Text size="sm" truncate style={{ width: "100%" }}>
            {row.variant.opening}
          </Text>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "priority",
      title: t("features.board.variants.priority", { defaultValue: "Priority" }),
      sortable: true,
      width: useCompactVariantsTable ? "7%" : "6%",
      render: (row: VariantTableRow) =>
        row.variant.priority !== null ? (
          <Badge variant="light" color={variantPriorityColor(row.variant.priority)} size="sm">
            {row.variant.priority}
          </Badge>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "engine",
      title: t("features.board.variants.engine", { defaultValue: "Engine" }),
      sortable: true,
      width: useCompactVariantsTable ? "12%" : "10%",
      render: (row: VariantTableRow) =>
        row.variant.engine ? (
          <Badge variant="outline" size="sm" style={{ textTransform: "none" }}>
            {row.variant.engine}
            {row.variant.engineMs !== null ? ` (${row.variant.engineMs}ms)` : ""}
          </Badge>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "variantsCount",
      title: t("features.board.variants.variantsCount", { defaultValue: "Variants" }),
      sortable: true,
      width: useCompactVariantsTable ? "8%" : "7%",
      render: (row: VariantTableRow) =>
        row.variant.variantsCount !== null ? (
          <Badge variant="light" color="blue" size="sm">
            {row.variant.variantsCount}
          </Badge>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "links",
      title: t("features.board.variants.links", { defaultValue: "Links" }),
      sortable: false,
      width: useCompactVariantsTable ? "12%" : "12%",
      render: (row: VariantTableRow) => (
        <Group gap={6} wrap="wrap">
          {row.isTransposition ? (
            <Badge variant="light" color="violet" size="sm">
              {t("features.board.variants.transpositionLink", { defaultValue: "Transposition" })}
            </Badge>
          ) : null}
          {!row.isTransposition && row.variant.parentLink ? (
            <Badge variant="outline" color="teal" size="sm">
              {t("features.board.variants.parentLink", { defaultValue: "Parent" })}
            </Badge>
          ) : null}
          {!row.isTransposition && (row.variant.childLinks?.length ?? 0) > 0 ? (
            <Badge variant="light" color="cyan" size="sm">
              {t("features.board.variants.childLinks", { defaultValue: "Children" })}:{" "}
              {row.variant.childLinks?.length ?? 0}
            </Badge>
          ) : null}
          {!row.isTransposition && !row.variant.parentLink && (row.variant.childLinks?.length ?? 0) === 0 ? (
            <Text size="sm" c="dimmed" fs="italic">
              -
            </Text>
          ) : null}
        </Group>
      ),
    },
    {
      accessor: "comments",
      title: t("features.board.variants.comments", { defaultValue: "Comments / References" }),
      sortable: true,
      hidden: useCompactVariantsTable,
      width: "13%",
      ellipsis: true,
      render: (row: VariantTableRow) =>
        row.variant.comments ? (
          <Text size="sm" truncate style={{ width: "100%" }}>
            {row.variant.comments}
          </Text>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "actions",
      title: t("common.actions", { defaultValue: "Actions" }),
      textAlign: "right" as const,
      width: useCompactVariantsTable ? "11%" : "13%",
      render: renderVariantActions,
    },
  ];

  return (
    <Stack gap={0} h="100%">
      <GenericHeader
        title={t("features.board.variants.title", { defaultValue: "Variants" })}
        folder="variants"
        searchPlaceholder={t("features.board.variants.searchPlaceholder", { defaultValue: "Search variants..." })}
        query={search}
        setQuery={handleSearchChange}
        sortOptions={[
          { value: "name", label: t("features.board.variants.name", { defaultValue: "Name" }) },
          { value: "priority", label: t("features.board.variants.priority", { defaultValue: "Priority" }) },
          { value: "opening", label: t("features.board.variants.opening", { defaultValue: "Opening" }) },
        ]}
        currentSort={
          sortStatus.columnAccessor
            ? {
                field: sortStatus.columnAccessor,
                direction: sortStatus.direction === "asc" ? "asc" : "desc",
              }
            : undefined
        }
        onSortChange={(sortBy) => {
          setSortStatus({
            columnAccessor: sortBy.field as keyof VariantInfo,
            direction: sortBy.direction === "asc" ? "asc" : "desc",
          });
        }}
        viewMode={viewMode}
        setViewMode={setViewMode}
        pageKey="variants"
        actions={
          <Group gap="xs">
            <Button
              size="xs"
              radius="xl"
              variant="light"
              leftSection={<IconFileImport size="1rem" />}
              onClick={() => void handleImportFromFile()}
              disabled={!activeProfileId}
              loading={transferBusy}
            >
              {t("features.board.variants.importFromFile", { defaultValue: "Import variants file" })}
            </Button>
            <Button
              size="xs"
              radius="xl"
              variant="light"
              leftSection={<IconFileExport size="1rem" />}
              onClick={() => void handleExportToFile()}
              disabled={!activeProfileId}
              loading={transferBusy}
            >
              {t("features.board.variants.exportToFile", { defaultValue: "Export variants file" })}
            </Button>
            <Button
              size="xs"
              radius="xl"
              variant="default"
              leftSection={<IconRefresh size="1rem" />}
              loading={repairingLinks}
              onClick={() => void handleRepairLinks()}
            >
              {t("features.board.variants.repairLinks", { defaultValue: "Repair links" })}
            </Button>
            <Button size="xs" radius="xl" leftSection={<IconPlus size="1rem" />} onClick={openCreateNewModal}>
              {t("features.board.variants.createNew", { defaultValue: "Create New" })}
            </Button>
          </Group>
        }
      />
      <Box px="md" pb="md" style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: useWideVariantsTable ? 5 : 3 }} spacing="sm">
            <Card withBorder radius="lg" p="sm" style={{ background: "var(--mantine-color-dark-7)" }}>
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    {t("features.board.variants.total", { defaultValue: "Total variants" })}
                  </Text>
                  <Text fw={800} fz="lg">
                    {premiumStats.totalVariants}
                  </Text>
                </Stack>
                <ThemeIcon variant="light" color="blue" radius="md">
                  <IconGitBranch size={16} />
                </ThemeIcon>
              </Group>
            </Card>
            <Card withBorder radius="lg" p="sm" style={{ background: "var(--mantine-color-dark-7)" }}>
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    {t("features.board.variants.filtered", { defaultValue: "Filtered variants" })}
                  </Text>
                  <Text fw={800} fz="lg">
                    {premiumStats.visibleVariants}
                  </Text>
                </Stack>
                <ThemeIcon variant="light" color="teal" radius="md">
                  <IconEye size={16} />
                </ThemeIcon>
              </Group>
            </Card>
            <Card withBorder radius="lg" p="sm" style={{ background: "var(--mantine-color-dark-7)" }}>
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    {t("features.board.variants.rootLines", { defaultValue: "Root lines" })}
                  </Text>
                  <Text fw={800} fz="lg">
                    {premiumStats.rootVariants}
                  </Text>
                </Stack>
                <ThemeIcon variant="light" color="grape" radius="md">
                  <IconChevronRight size={16} />
                </ThemeIcon>
              </Group>
            </Card>
            <Card withBorder radius="lg" p="sm" style={{ background: "var(--mantine-color-dark-7)" }}>
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    {t("features.board.variants.linkedVariants", { defaultValue: "Linked variants" })}
                  </Text>
                  <Text fw={800} fz="lg">
                    {premiumStats.linkedVariants}
                  </Text>
                </Stack>
                <ThemeIcon variant="light" color="cyan" radius="md">
                  <IconShieldCheck size={16} />
                </ThemeIcon>
              </Group>
            </Card>
            <Card withBorder radius="lg" p="sm" style={{ background: "var(--mantine-color-dark-7)" }}>
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    {t("features.board.variants.averageDepth", { defaultValue: "Average depth" })}
                  </Text>
                  <Text fw={800} fz="lg">
                    {premiumStats.averageDepth}
                  </Text>
                </Stack>
                <ThemeIcon variant="light" color="yellow" radius="md">
                  <IconPuzzle size={16} />
                </ThemeIcon>
              </Group>
            </Card>
          </SimpleGrid>

          <Card
            withBorder
            p="sm"
            radius="lg"
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "auto",
              background:
                "radial-gradient(120% 170% at 100% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 17%, transparent) 0%, transparent 58%), linear-gradient(160deg, color-mix(in srgb, var(--mantine-color-dark-7) 88%, var(--mantine-color-dark-5) 12%), var(--mantine-color-dark-7))",
              borderColor: "color-mix(in srgb, var(--mantine-color-blue-8) 20%, var(--mantine-color-dark-4))",
            }}
          >
            <Group gap="sm" mb="sm" align="flex-end" wrap="wrap">
              <TextInput
                value={search}
                onChange={(event) => handleSearchChange(event.currentTarget.value)}
                placeholder={t("features.board.variants.tableFilterPlaceholder", {
                  defaultValue: "Filter variants by name or opening",
                })}
                leftSection={<IconSearch size={16} />}
                style={{ flex: "1 1 320px" }}
              />
              <Select
                value={searchScope}
                onChange={(value) => {
                  setSearchScope(isVariantSearchScope(value) ? value : "nameOpening");
                  setPage(1);
                }}
                label={t("features.board.variants.filterBy", { defaultValue: "Filter by" })}
                data={[
                  {
                    value: "nameOpening",
                    label: t("features.board.variants.filterNameOpening", { defaultValue: "Name + opening" }),
                  },
                  { value: "name", label: t("features.board.variants.filterName", { defaultValue: "Name" }) },
                  { value: "opening", label: t("features.board.variants.filterOpening", { defaultValue: "Opening" }) },
                ]}
                allowDeselect={false}
                style={{ flex: "0 1 220px" }}
              />
            </Group>
            {viewMode === "grid" ? (
              <VariantGridView
                variants={visibleTreeVariants}
                isLoading={isLoading}
                onEdit={(variant) => void handleEdit(variant)}
                onDelete={handleDelete}
                onEditComments={handleEditComments}
                onConfigure={(variant) => void handleOpenConfigureBuild(variant)}
                onCoverageGraph={handleOpenCoverageGraphForVariant}
                gridCols={gridCols}
              />
            ) : isLoading ? (
              <Center h="100%">
                <Stack align="center" gap="xs">
                  <Loader size="sm" />
                  <Text size="sm" c="dimmed">
                    {t("common.loading")}
                  </Text>
                </Stack>
              </Center>
            ) : variantTableRows.length === 0 ? (
              <Center h="100%">
                <Alert
                  title={t("common.noRecordsFound", { defaultValue: "No records found" })}
                  color="gray"
                  variant="light"
                  icon={<IconGitBranch size={20} />}
                >
                  {variants.length === 0
                    ? t("features.board.variants.empty", {
                        defaultValue: "No variants found. Create a new variant to get started.",
                      })
                    : t("features.board.variants.noResults", {
                        defaultValue: "No variants match your search criteria.",
                      })}
                </Alert>
              </Center>
            ) : (
              <DataTable
                records={paginatedRows}
                columns={columns}
                sortStatus={sortStatus as DataTableSortStatus<VariantTableRow>}
                onSortStatusChange={(status) => setSortStatus(status as DataTableSortStatus<VariantInfo>)}
                withTableBorder
                highlightOnHover
                striped
                minHeight={200}
                horizontalSpacing="xs"
                verticalAlign="center"
                noRecordsText={t("common.noRecordsFound", { defaultValue: "No records found" })}
                style={{ width: "100%", minWidth: variantsTableMinWidth }}
                styles={{ table: { tableLayout: "fixed", width: "100%", minWidth: variantsTableMinWidth } }}
                totalRecords={variantTableRows.length}
                recordsPerPage={pageSize}
                page={page}
                onPageChange={(p) => {
                  setPage(p);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                onRecordsPerPageChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
                recordsPerPageOptions={[10, 25, 50, 100]}
                borderRadius="md"
              />
            )}
          </Card>
        </Stack>
      </Box>

      <Modal
        opened={configureBuildModalOpened}
        onClose={() => setConfigureBuildModalOpened(false)}
        title={t("features.board.variants.configureBuild", { defaultValue: "Configure data source" })}
        size="lg"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t("features.board.variants.configureBuildHint", {
              defaultValue: "Set the database source and filters for this variant and optionally its descendants.",
            })}
          </Text>

          <Stack gap="xs">
            <Text size="sm" fw={700}>
              {t("features.board.tabs.database")}
            </Text>
            <SegmentedControl
              data={[
                { label: t("features.board.database.local"), value: "local" },
                { label: t("features.board.database.lichessAll"), value: "lch_all" },
                { label: t("features.board.database.lichessMaster"), value: "lch_master" },
              ]}
              value={buildConfig.dbType}
              onChange={(value) =>
                setBuildConfig((prev) => ({ ...prev, dbType: value as "local" | "lch_all" | "lch_master" }))
              }
              fullWidth
            />
            {buildConfig.dbType === "local" ? (
              <Select
                data={localDatabaseOptions}
                value={buildConfig.localDatabasePath}
                onChange={(value) => setBuildConfig((prev) => ({ ...prev, localDatabasePath: value ?? null }))}
                placeholder={t("features.board.database.selectDatabase")}
                searchable
                clearable={false}
                disabled={localDatabaseOptions.length === 0}
              />
            ) : null}
          </Stack>

          {buildConfig.dbType === "lch_all" ? (
            <Stack gap="xs">
              <MultiSelect
                label={t("features.board.database.timeControl")}
                data={lichessSpeedOptions}
                value={buildConfig.lichessSpeeds}
                onChange={(values) =>
                  setBuildConfig((prev) => ({
                    ...prev,
                    lichessSpeeds: values.filter((v): v is LichessGameSpeed =>
                      ["ultraBullet", "bullet", "blitz", "rapid", "classical", "correspondence"].includes(v),
                    ),
                  }))
                }
                clearable={false}
                searchable
              />
              <MultiSelect
                label={t("features.board.database.averageRating")}
                data={lichessRatingOptions}
                value={buildConfig.lichessRatings.map(String)}
                onChange={(values) =>
                  setBuildConfig((prev) => ({
                    ...prev,
                    lichessRatings: values
                      .map((v) => Number.parseInt(v, 10))
                      .filter((v): v is LichessRating =>
                        [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500].includes(v as LichessRating),
                      ),
                  }))
                }
                clearable={false}
                searchable
              />
              <Group grow>
                <MonthPickerInput
                  label={t("databaseOptions.since")}
                  placeholder={t("databaseOptions.pickDate")}
                  value={buildConfig.lichessSince}
                  maxDate={new Date()}
                  onChange={(value) =>
                    setBuildConfig((prev) => ({ ...prev, lichessSince: normalizeMonthPickerValue(value) }))
                  }
                  clearable
                />
                <MonthPickerInput
                  label={t("databaseOptions.until")}
                  placeholder={t("databaseOptions.pickDate")}
                  value={buildConfig.lichessUntil}
                  maxDate={new Date()}
                  onChange={(value) =>
                    setBuildConfig((prev) => ({ ...prev, lichessUntil: normalizeMonthPickerValue(value) }))
                  }
                  clearable
                />
              </Group>
              <Group grow>
                <TextInput
                  label={t("databaseOptions.player")}
                  placeholder={t("databaseOptions.playerUsername")}
                  value={buildConfig.lichessPlayer}
                  onChange={(event) =>
                    setBuildConfig((prev) => ({ ...prev, lichessPlayer: event.currentTarget.value }))
                  }
                />
                <Select
                  label={t("databaseOptions.color")}
                  data={[
                    { label: t("chess.white"), value: "white" },
                    { label: t("chess.black"), value: "black" },
                  ]}
                  value={buildConfig.lichessColor}
                  onChange={(value) =>
                    setBuildConfig((prev) => ({ ...prev, lichessColor: value === "black" ? "black" : "white" }))
                  }
                  clearable={false}
                />
              </Group>
            </Stack>
          ) : null}

          {buildConfig.dbType === "lch_master" ? (
            <Group grow>
              <MonthPickerInput
                label={t("databaseOptions.since")}
                placeholder={t("databaseOptions.pickDate")}
                value={buildConfig.masterSince}
                maxDate={new Date()}
                onChange={(value) =>
                  setBuildConfig((prev) => ({ ...prev, masterSince: normalizeMonthPickerValue(value) }))
                }
                clearable
              />
              <MonthPickerInput
                label={t("databaseOptions.until")}
                placeholder={t("databaseOptions.pickDate")}
                value={buildConfig.masterUntil}
                maxDate={new Date()}
                onChange={(value) =>
                  setBuildConfig((prev) => ({ ...prev, masterUntil: normalizeMonthPickerValue(value) }))
                }
                clearable
              />
            </Group>
          ) : null}

          <SegmentedControl
            data={[
              {
                label: t("features.board.variants.applyCurrentOnly", { defaultValue: "Current variant" }),
                value: "current",
              },
              {
                label: t("features.board.variants.applyWithChildren", { defaultValue: "Variant + descendants" }),
                value: "tree",
              },
            ]}
            value={buildConfig.includeChildren ? "tree" : "current"}
            onChange={(value) => setBuildConfig((prev) => ({ ...prev, includeChildren: value === "tree" }))}
            fullWidth
          />

          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfigureBuildModalOpened(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void applyBuildConfigToVariantTree()}
              loading={applyingBuildConfig}
              disabled={
                (buildConfig.dbType === "local" && !buildConfig.localDatabasePath) ||
                (buildConfig.dbType === "lch_all" &&
                  (buildConfig.lichessSpeeds.length === 0 || buildConfig.lichessRatings.length === 0))
              }
            >
              {t("features.board.variants.applyBuildConfig", { defaultValue: "Apply configuration" })}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={coverageGraphModalOpened}
        onClose={() => {
          setCoverageGraphModalOpened(false);
          setCoverageActionNode(null);
          setCoverageBuildProgress(null);
        }}
        title={t("features.board.variants.coverageGraph", { defaultValue: "Coverage graph" })}
        fullScreen
        styles={{
          content: {
            height: "100dvh",
            display: "flex",
            flexDirection: "column",
            background:
              "radial-gradient(100% 130% at 100% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 14%, transparent) 0%, transparent 58%), linear-gradient(160deg, color-mix(in srgb, var(--mantine-color-dark-8) 86%, var(--mantine-color-dark-6) 14%), var(--mantine-color-dark-8))",
            border: "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 16%, var(--mantine-color-dark-4))",
          },
          header: {
            background: "transparent",
            borderBottom: "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 14%, var(--mantine-color-dark-4))",
          },
          title: {
            fontWeight: 700,
          },
          body: {
            flex: 1,
            minHeight: 0,
            paddingTop: 10,
          },
        }}
      >
        <Stack gap="md" style={{ height: "calc(100dvh - 96px)", minHeight: 0 }}>
          <Card
            withBorder
            radius="lg"
            p="sm"
            style={{
              ...premiumMutedPanelStyle,
              flexShrink: 0,
              background:
                "radial-gradient(90% 140% at 100% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 13%, transparent) 0%, transparent 58%), linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-8) 88%, var(--mantine-color-dark-6) 12%), var(--mantine-color-dark-8))",
              boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.035), 0 14px 34px rgba(2, 6, 23, 0.22)",
            }}
          >
            <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
              <Group align="flex-end" gap="xs" wrap="wrap">
                <NumberInput
                  label={t("features.board.variants.nMoves", { defaultValue: "N active moves" })}
                  value={coverageGraphDepth}
                  onChange={(value) => {
                    if (typeof value === "number" && Number.isFinite(value)) {
                      setCoverageGraphDepth(Math.max(1, Math.min(20, Math.floor(value))));
                      return;
                    }
                    setCoverageGraphDepth("");
                  }}
                  placeholder={t("features.board.variants.coverageGraphDepthPlaceholder", {
                    defaultValue: "Choose moves",
                  })}
                  min={1}
                  max={20}
                  maw={140}
                  styles={COVERAGE_NUMBER_INPUT_STYLES}
                />
                <CoverageTimeControlSelector
                  value={coverageProfileTimeControlFilters}
                  onChange={(values) => {
                    const allowed = new Set(coverageProfileTimeControlOptions);
                    const nextValues = values.filter((value): value is CoverageProfileTimeControlCategory =>
                      allowed.has(value as CoverageProfileTimeControlCategory),
                    );
                    setCoverageProfileTimeControlFilters(
                      nextValues.length > 0 ? nextValues : coverageProfileTimeControlOptions,
                    );
                  }}
                  options={coverageProfileTimeControlOptions}
                  disabled={coverageProfileTimeControlOptions.length === 0}
                  t={t}
                />
                <Button
                  radius="md"
                  variant="filled"
                  color="blue"
                  styles={{
                    root: {
                      ...premiumActionButtonStyles.root,
                      minHeight: 38,
                      background:
                        "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-blue-5) 90%, var(--mantine-color-cyan-4) 10%), var(--mantine-color-blue-7))",
                      border: "1px solid color-mix(in srgb, var(--mantine-color-blue-3) 30%, transparent)",
                      boxShadow: "0 10px 22px rgba(37, 99, 235, 0.2)",
                    },
                  }}
                  onClick={() => void handleBuildCoverageGraph()}
                  loading={coverageGraphLoading}
                  disabled={typeof coverageGraphDepth !== "number" || !Number.isFinite(coverageGraphDepth)}
                >
                  {t("features.board.variants.buildCoverageGraph", { defaultValue: "Build graph" })}
                </Button>
                <Button
                  radius="md"
                  variant="light"
                  color="blue"
                  leftSection={<IconRefresh size={16} />}
                  styles={{
                    root: {
                      ...premiumActionButtonStyles.root,
                      minHeight: 38,
                      background: "color-mix(in srgb, var(--mantine-color-blue-8) 13%, var(--mantine-color-dark-7))",
                      border:
                        "1px solid color-mix(in srgb, var(--mantine-color-blue-6) 24%, var(--mantine-color-dark-4))",
                      color: "var(--mantine-color-blue-1)",
                    },
                  }}
                  onClick={() => void handleBuildCoverageGraph({ forceRebuild: true })}
                  loading={coverageGraphLoading}
                  disabled={typeof coverageGraphDepth !== "number" || !Number.isFinite(coverageGraphDepth)}
                >
                  {t("features.board.variants.rebuildCoverageGraph", { defaultValue: "Rebuild graph" })}
                </Button>
                <Button
                  radius="md"
                  variant="light"
                  color="pink"
                  leftSection={<IconExclamationCircle size={16} />}
                  onClick={() => void handleOpenCoverageCriticalLines()}
                  loading={criticalLineLoading}
                  disabled={!coverageGraphRoot || coverageGraphLoading}
                >
                  {t("features.board.variants.criticalLineNodes", { defaultValue: "Critical lines" })}
                </Button>
              </Group>
              <Group gap="xs">
                <Badge
                  variant="light"
                  radius="xl"
                  leftSection={
                    <Box w={7} h={7} style={{ borderRadius: 999, background: COVERAGE_TIER_COLORS.mainline }} />
                  }
                  styles={coverageLegendBadgeStyles(COVERAGE_TIER_COLORS.mainline)}
                >
                  {t("features.board.variants.mainline", { defaultValue: "Main lines <= 60%" })}
                </Badge>
                <Badge
                  variant="light"
                  radius="xl"
                  leftSection={
                    <Box w={7} h={7} style={{ borderRadius: 999, background: COVERAGE_TIER_COLORS.secondary }} />
                  }
                  styles={coverageLegendBadgeStyles(COVERAGE_TIER_COLORS.secondary)}
                >
                  {t("features.board.variants.secondary", { defaultValue: "Secondary <= 80%" })}
                </Badge>
                <Badge
                  variant="light"
                  radius="xl"
                  leftSection={
                    <Box w={7} h={7} style={{ borderRadius: 999, background: COVERAGE_TIER_COLORS.alternative }} />
                  }
                  styles={coverageLegendBadgeStyles(COVERAGE_TIER_COLORS.alternative)}
                >
                  {t("features.board.variants.alternative", { defaultValue: "Alternative > 80%" })}
                </Badge>
                <Badge
                  variant="light"
                  radius="xl"
                  leftSection={<Box w={7} h={7} style={{ borderRadius: 999, background: COVERAGE_UNMAPPED_COLOR }} />}
                  styles={coverageLegendBadgeStyles(COVERAGE_UNMAPPED_COLOR, "var(--mantine-color-yellow-1)")}
                >
                  {t("features.board.variants.unmappedResponseBadge", { defaultValue: "No response mapped" })}
                </Badge>
                {coveragePrioritySyncing ? (
                  <Badge color="blue" variant="light" radius="xl">
                    {t("features.board.variants.prioritySynced", { defaultValue: "Priority synced (1/2/3)" })}
                  </Badge>
                ) : null}
              </Group>
            </Group>
          </Card>

          {coverageGraphLoading && coverageBuildProgress ? (
            <Card withBorder radius="md" p="sm" style={premiumMutedPanelStyle}>
              <Text size="sm" c="dimmed">
                {coverageBuildProgress.phase === "preparing"
                  ? t("features.board.variants.coverageGraphPreparingProgress", {
                      defaultValue: "Preparing variants {{done}} / {{total}}...",
                      done: coverageBuildProgress.variantsDone,
                      total: coverageBuildProgress.variantsTotal,
                    })
                  : t("features.board.variants.coverageGraphBuildingProgress", {
                      defaultValue:
                        "Building graph: variants {{done}} / {{total}} | positions processed {{processed}} | pending {{pending}}",
                      done: coverageBuildProgress.variantsDone,
                      total: coverageBuildProgress.variantsTotal,
                      processed: coverageBuildProgress.positionsProcessed,
                      pending: coverageBuildProgress.positionsPending,
                    })}
              </Text>
            </Card>
          ) : null}

          <Box style={{ flex: 1, minHeight: 0, height: "100%" }}>
            <VariantCoverageGraph
              root={visibleCoverageGraphRoot}
              activeSide={coverageGraphOrientation}
              onNodeClick={handleCoverageNodeClick}
              onNodeToggleCollapse={toggleCoverageNodeCollapsed}
              onNodeExpandAllChildren={expandCoverageNodeAllChildren}
            />
          </Box>
        </Stack>
      </Modal>

      <Modal
        opened={criticalLineModalOpened}
        onClose={() => {
          setCriticalLineModalOpened(false);
          setCriticalLineReportRequestKey(null);
          setCriticalLineBuildRequest(null);
          setCriticalLineLoading(false);
          setCriticalLineRegenerating(false);
        }}
        title={t("features.board.variants.criticalLineNodesTitle", { defaultValue: "Critical lines" })}
        centered
        size="xl"
      >
        <Stack gap="md">
          <Card withBorder radius="md" p="sm" style={premiumMutedPanelStyle}>
            <Group justify="space-between" align="center" gap="md" wrap="wrap">
              <Stack gap={2}>
                <Text fw={700}>
                  {t("features.board.variants.criticalLineRunTitle", { defaultValue: "Inspect mapped lines" })}
                </Text>
                <Text size="sm" c="dimmed">
                  {t("features.board.variants.criticalLineRunDescription", {
                    defaultValue:
                      "Uses the configured data source, saves a cache file, and reports only complete mapped lines.",
                  })}
                </Text>
              </Stack>
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="light"
                  color="blue"
                  loading={criticalLineLoading && !criticalLineRegenerating}
                  disabled={criticalLineLoading || coverageGraphLoading}
                  onClick={() => void startCriticalLineInspection()}
                >
                  {t("features.board.variants.criticalLineRunCached", { defaultValue: "Run with cache" })}
                </Button>
                <Button
                  size="xs"
                  variant="light"
                  color="red"
                  loading={criticalLineLoading && criticalLineRegenerating}
                  disabled={criticalLineLoading || coverageGraphLoading}
                  onClick={() => void startCriticalLineInspection({ regenerate: true })}
                >
                  {t("features.board.variants.criticalLineRegenerate", {
                    defaultValue: "Regenerate from scratch",
                  })}
                </Button>
              </Group>
            </Group>
          </Card>

          {criticalLineLoading ? (
            <Group gap="sm">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">
                {t("features.board.variants.criticalLineLoading", {
                  defaultValue: "Inspecting critical lines in backend...",
                })}
              </Text>
            </Group>
          ) : !criticalLineReport ? (
            <Alert color="blue" variant="light" icon={<IconExclamationCircle size={18} />}>
              {t("features.board.variants.criticalLineReady", {
                defaultValue: "Run the inspection to generate or load the critical-lines cache.",
              })}
            </Alert>
          ) : criticalLineReport.nodes.length === 0 ? (
            <Alert color="teal" variant="light" icon={<IconShieldCheck size={18} />}>
              {t("features.board.variants.criticalLineEmpty", {
                defaultValue: "No critical lines were found for this graph.",
              })}
            </Alert>
          ) : (
            <Stack gap="sm">
              <Group justify="space-between" align="center">
                <Text size="sm" c="dimmed">
                  {t("features.board.variants.criticalLineSummary", {
                    defaultValue: "{{count}} critical lines found.",
                    count: criticalLineReport.nodes.length,
                  })}
                </Text>
                <Badge color={criticalLineReport.activeColor === "white" ? "blue" : "gray"} variant="light">
                  {criticalLineReport.activeColor}
                </Badge>
              </Group>
              {criticalLineReport.nodes.map((item, index) => (
                <Card
                  key={`${item.id}-${index}-${item.path.join("/")}`}
                  withBorder
                  radius="md"
                  p="sm"
                  style={premiumMutedPanelStyle}
                >
                  <Group justify="space-between" align="flex-start" gap="md" wrap="nowrap">
                    <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
                      <Group gap="xs" wrap="wrap">
                        {item.reasons.includes("source") ? (
                          <Badge color="red" variant="light">
                            {t("features.board.variants.criticalLineReasonSource", {
                              defaultValue: "Source W/L risk",
                            })}
                          </Badge>
                        ) : null}
                        {item.reasons.includes("engine") ? (
                          <Badge color="pink" variant="light">
                            {t("features.board.variants.criticalLineReasonEngine", {
                              defaultValue: "Engine favors opponent",
                            })}
                          </Badge>
                        ) : null}
                      </Group>
                      <Text fw={800} truncate>
                        {item.label}
                      </Text>
                      {item.openingName ? (
                        <Text size="sm" c="dimmed" truncate>
                          {item.openingName}
                        </Text>
                      ) : null}
                      <Text size="xs" c="dimmed" truncate>
                        {item.path.join(" -> ")}
                      </Text>
                      <Group gap="md" wrap="wrap">
                        <Text size="xs">
                          {t("features.board.variants.coverageCardSource", { defaultValue: "SOURCE" })}:{" "}
                          <Text span fw={700}>
                            {formatCoverageWinLoss(item.sourceWinRate, item.sourceLossRate)}
                          </Text>
                        </Text>
                        <Text size="xs">
                          {t("features.board.variants.coverageCardEval", { defaultValue: "EVAL" })}:{" "}
                          <Text span fw={700}>
                            {item.engineAdvantage || "--"}
                          </Text>
                        </Text>
                      </Group>
                    </Stack>
                    <Stack gap="xs" align="flex-end">
                      <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconExternalLink size={14} />}
                        onClick={() => {
                          setCriticalLineModalOpened(false);
                          void goToCoverageNodeVariant(item.node);
                        }}
                      >
                        {t("features.board.variants.coverageGoToVariant", { defaultValue: "Go to variant" })}
                      </Button>
                      <Button
                        size="xs"
                        variant="subtle"
                        color="yellow"
                        onClick={() => void acceptCriticalLineRisk(item)}
                      >
                        {t("features.board.variants.criticalLineAcceptRisk", { defaultValue: "Accept risk" })}
                      </Button>
                    </Stack>
                  </Group>
                </Card>
              ))}
            </Stack>
          )}
        </Stack>
      </Modal>

      <Modal
        opened={coverageActionNode !== null}
        onClose={closeCoverageActionModal}
        title={t("features.board.variants.coverageNodeActions", { defaultValue: "Node actions" })}
        centered
        size="lg"
        closeOnClickOutside={!coverageEngineEvaluating}
        closeOnEscape={!coverageEngineEvaluating}
        withCloseButton={!coverageEngineEvaluating}
      >
        <Stack gap="md">
          <SegmentedControl
            value={coverageActionTab}
            onChange={(value) => {
              const nextValue: CoverageActionTab =
                value === "edit" || value === "puzzles" || value === "board" || value === "engine" ? value : "puzzles";
              setCoverageActionTab(coverageActionTabs.some((tab) => tab.value === nextValue) ? nextValue : "puzzles");
            }}
            data={coverageActionTabs}
            fullWidth
            radius="md"
          />

          <Card withBorder radius="md" p="sm">
            {coverageActionTab === "edit" ? (
              <Stack gap="sm">
                <SegmentedControl
                  value={coverageActionTier}
                  onChange={(value) =>
                    setCoverageActionTier(value === "secondary" || value === "alternative" ? value : "mainline")
                  }
                  data={[
                    { value: "mainline", label: t("features.board.variants.mainlineShort", { defaultValue: "ML" }) },
                    {
                      value: "secondary",
                      label: t("features.board.variants.secondaryShort", { defaultValue: "Secondary" }),
                    },
                    {
                      value: "alternative",
                      label: t("features.board.variants.alternativeShort", { defaultValue: "Alternative" }),
                    },
                  ]}
                  fullWidth
                />
                <TextInput
                  label={t("features.board.variants.coverageRenameLabel", { defaultValue: "Node name" })}
                  value={coverageActionLabel}
                  onChange={(event) => setCoverageActionLabel(event.currentTarget.value)}
                />
              </Stack>
            ) : coverageActionTab === "puzzles" ? (
              <Stack gap="sm">
                <TextInput
                  label={t("features.board.variants.coveragePuzzleName", { defaultValue: "Puzzle file name" })}
                  value={coveragePuzzleName}
                  onChange={(event) => setCoveragePuzzleName(event.currentTarget.value)}
                />
                <Group grow>
                  <SegmentedControl
                    value={coveragePuzzleTierFilter}
                    onChange={(value) =>
                      setCoveragePuzzleTierFilter(
                        value === "secondary" || value === "alternative" || value === "all" ? value : "mainline",
                      )
                    }
                    data={[
                      {
                        value: "all",
                        label: t("features.board.variants.coveragePuzzleAll", { defaultValue: "All" }),
                      },
                      { value: "mainline", label: t("features.board.variants.mainlineShort", { defaultValue: "ML" }) },
                      {
                        value: "secondary",
                        label: t("features.board.variants.secondaryShort", { defaultValue: "Secondary" }),
                      },
                      {
                        value: "alternative",
                        label: t("features.board.variants.alternativeShort", { defaultValue: "Alternative" }),
                      },
                    ]}
                    fullWidth
                  />
                </Group>
                <Checkbox
                  checked={coveragePuzzleIncludeLowSample}
                  onChange={(event) => setCoveragePuzzleIncludeLowSample(event.currentTarget.checked)}
                  label={t("features.board.variants.coveragePuzzleIncludeLowSample", {
                    defaultValue: "Include low sample nodes (< 5000 games)",
                  })}
                />
              </Stack>
            ) : coverageActionTab === "engine" ? (
              <Stack gap="sm">
                <NumberInput
                  label={t("features.board.variants.coverageEngineMs", { defaultValue: "Engine time per move (ms)" })}
                  value={coverageEngineMs}
                  onChange={(value) => {
                    if (typeof value === "number" && Number.isFinite(value)) {
                      setCoverageEngineMs(Math.max(100, Math.min(60_000, Math.floor(value))));
                      return;
                    }
                    setCoverageEngineMs(1000);
                  }}
                  min={100}
                  max={60000}
                  step={100}
                />
                {coverageEngineProgress ? (
                  <Stack gap={6}>
                    <Progress
                      value={
                        coverageEngineProgress.total > 0
                          ? (coverageEngineProgress.completed / coverageEngineProgress.total) * 100
                          : 0
                      }
                      animated={coverageEngineEvaluating}
                    />
                    <Text size="xs" c="dimmed">
                      {t("features.board.variants.coverageEngineProgress", {
                        defaultValue: "Analyzing {{completed}}/{{total}}. Current: {{current}}.",
                        completed: coverageEngineProgress.completed,
                        total: coverageEngineProgress.total,
                        current: coverageEngineProgress.currentLabel || "--",
                      })}
                    </Text>
                    <Group gap="xs">
                      <Badge color="green" variant="light">
                        {t("features.board.variants.coverageEngineSaved", {
                          defaultValue: "Saved {{count}}",
                          count: coverageEngineProgress.saved,
                        })}
                      </Badge>
                      <Badge color="blue" variant="light">
                        {t("features.board.variants.coverageEngineCached", {
                          defaultValue: "Cached {{count}}",
                          count: coverageEngineProgress.cached,
                        })}
                      </Badge>
                      <Badge color="red" variant="light">
                        {t("features.board.variants.coverageEngineFailed", {
                          defaultValue: "Failed {{count}}",
                          count: coverageEngineProgress.failed,
                        })}
                      </Badge>
                    </Group>
                  </Stack>
                ) : null}
              </Stack>
            ) : coverageActionBoardError ? (
              <Text size="sm" c="dimmed">
                {coverageActionBoardError === "missing"
                  ? t("features.board.variants.coverageNodeMissingFen", {
                      defaultValue: "Selected node has no position context (FEN).",
                    })
                  : t("features.board.variants.coverageBoardInvalidFen", {
                      defaultValue: "Could not render this node board because the FEN is invalid.",
                    })}
              </Text>
            ) : (
              <Center>
                <Box style={{ width: "100%", maxWidth: 360 }}>
                  <Chessground
                    fen={coverageActionBoardFen}
                    orientation={coverageGraphOrientation}
                    viewOnly
                    coordinates={false}
                  />
                </Box>
              </Center>
            )}
          </Card>

          <Text size="xs" c="dimmed">
            {coverageActionTab === "edit"
              ? t("features.board.variants.coverageEditHint", {
                  defaultValue: "Update node settings and save changes.",
                })
              : coverageActionTab === "puzzles"
                ? t("features.board.variants.coveragePuzzleHint", {
                    defaultValue: "Generate puzzles from this node using the selected tier.",
                  })
                : coverageActionTab === "engine"
                  ? t("features.board.variants.coverageEngineHint", {
                      defaultValue:
                        "Run engine analysis for this node and its direct children, then store the advantage labels in the graph.",
                    })
                  : t("features.board.variants.coverageBoardHint", {
                      defaultValue: "Board preview after this move using active side orientation.",
                    })}
          </Text>
          <Group justify="flex-end" gap="xs">
            {coverageActionNode?.tier !== "root" ? (
              <Button variant="light" onClick={() => void goToCoverageNodeVariant()} disabled={!coverageActionNode}>
                {t("features.board.variants.coverageGoToVariant", { defaultValue: "Go to variant" })}
              </Button>
            ) : null}
            <Button variant="default" onClick={closeCoverageActionModal} disabled={coverageEngineEvaluating}>
              {t("common.cancel")}
            </Button>
            {coverageEngineEvaluating ? (
              <Button variant="light" color="red" onClick={() => requestCoverageEngineAbort("stop-button")}>
                {t("common.stop", { defaultValue: "Stop" })}
              </Button>
            ) : null}
            {showCoverageActionPrimary ? (
              <Button
                onClick={() => void runCoverageActionPrimary()}
                loading={coverageActionPrimaryLoading}
                disabled={coverageActionPrimaryDisabled}
              >
                {coverageActionPrimaryLabel}
              </Button>
            ) : null}
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={validationModalOpened}
        onClose={() => setValidationModalOpened(false)}
        title={
          <Stack gap={2}>
            <Text fw={800} size="xl">
              {t("features.board.variants.validationReportTitle", { defaultValue: "Variants consistency report" })}
            </Text>
            <Text size="sm" c="dimmed">
              {t("features.board.variants.validationReportDescription", {
                defaultValue:
                  "These positions contain more than one selected move for the active side. Choose the single move that should remain and review each conflicting variant.",
              })}
            </Text>
          </Stack>
        }
        size={1120}
        padding="lg"
        styles={{
          body: {
            display: "flex",
            flex: 1,
            flexDirection: "column",
            minHeight: 0,
            overflow: "hidden",
          },
          content: {
            display: "flex",
            flexDirection: "column",
            height: "min(92dvh, 900px)",
          },
          header: {
            flexShrink: 0,
          },
          title: {
            flex: 1,
            minWidth: 0,
          },
        }}
      >
        {validationReport ? (
          <Stack gap="md" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="xs">
              <Card withBorder radius="md" p="sm" style={premiumMutedPanelStyle}>
                <Group gap="sm" wrap="nowrap">
                  <ThemeIcon variant="light" color="blue" size="lg" radius="md">
                    <IconVersions size={18} />
                  </ThemeIcon>
                  <Box style={{ minWidth: 0 }}>
                    <Text size="xs" c="dimmed">
                      {t("features.board.variants.validationMetricVariant", { defaultValue: "Variant" })}
                    </Text>
                    <Text fw={800} truncate>
                      {validationReport.targetVariantName}
                    </Text>
                  </Box>
                </Group>
              </Card>
              <Card withBorder radius="md" p="sm" style={premiumMutedPanelStyle}>
                <Group gap="sm" wrap="nowrap">
                  <ThemeIcon variant="light" color="indigo" size="lg" radius="md">
                    <IconGitBranch size={18} />
                  </ThemeIcon>
                  <Box>
                    <Text size="xs" c="dimmed">
                      {t("features.board.variants.validationMetricActiveSide", { defaultValue: "Active side" })}
                    </Text>
                    <Text fw={800}>{validationActiveColorLabel}</Text>
                  </Box>
                </Group>
              </Card>
              <Card withBorder radius="md" p="sm" style={premiumMutedPanelStyle}>
                <Group gap="sm" wrap="nowrap">
                  <ThemeIcon
                    variant="light"
                    color={validationReport.conflicts.length > 0 ? "yellow" : "green"}
                    size="lg"
                    radius="md"
                  >
                    {validationReport.conflicts.length > 0 ? <IconAlertTriangle size={18} /> : <IconCheck size={18} />}
                  </ThemeIcon>
                  <Box>
                    <Text size="xs" c="dimmed">
                      {t("features.board.variants.validationMetricIssues", { defaultValue: "Issues" })}
                    </Text>
                    <Text fw={800}>{validationReport.conflicts.length}</Text>
                  </Box>
                </Group>
              </Card>
              <Card withBorder radius="md" p="sm" style={premiumMutedPanelStyle}>
                <Group gap="sm" wrap="nowrap">
                  <ThemeIcon variant="light" color="cyan" size="lg" radius="md">
                    <IconSearch size={18} />
                  </ThemeIcon>
                  <Box>
                    <Text size="xs" c="dimmed">
                      {t("features.board.variants.validationMetricPositions", { defaultValue: "Positions checked" })}
                    </Text>
                    <Text fw={800}>{validationReport.checkedPositions}</Text>
                  </Box>
                </Group>
              </Card>
            </SimpleGrid>

            {validationReport.orientationMismatches.length > 0 ? (
              <Alert color="yellow" variant="light">
                <Text size="sm" fw={600}>
                  {t("features.board.variants.validationOrientationMismatch", {
                    defaultValue: "Orientation mismatch detected in:",
                  })}
                </Text>
                <Text size="sm">{validationReport.orientationMismatches.join(", ")}</Text>
              </Alert>
            ) : null}

            {validationReport.skippedVariants.length > 0 ? (
              <Alert color="gray" variant="light">
                <Text size="sm" fw={600}>
                  {t("features.board.variants.validationSkipped", {
                    defaultValue: "Variants skipped (no readable PGN):",
                  })}
                </Text>
                <Text size="sm">{validationReport.skippedVariants.join(", ")}</Text>
              </Alert>
            ) : null}

            {validationReport.conflicts.length === 0 ? (
              <Alert color="green" variant="light">
                {t("features.board.variants.validationNoConflicts", {
                  defaultValue: "No contradictions found for active-side moves.",
                })}
              </Alert>
            ) : (
              <Stack gap="sm" style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 6 }}>
                {validationReport.conflicts.map((conflict, conflictIndex) => {
                  const conflictingMoveLabels = conflict.moves.map((move) => move.san).join(" / ");
                  const occurrenceCount = conflict.moves.reduce((sum, move) => sum + move.occurrences.length, 0);
                  return (
                    <Box
                      key={conflict.fen}
                      style={{
                        ...premiumMutedPanelStyle,
                        border:
                          "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 18%, var(--mantine-color-dark-4))",
                        borderRadius: 8,
                        background:
                          "radial-gradient(120% 160% at 100% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 14%, transparent) 0%, transparent 58%), linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-7) 90%, var(--mantine-color-dark-6) 10%), var(--mantine-color-dark-7))",
                        overflow: "visible",
                        padding: "var(--mantine-spacing-md)",
                      }}
                    >
                      <Stack gap="md">
                        <Group justify="space-between" align="flex-start" gap="md">
                          <Group align="flex-start" gap="sm" style={{ minWidth: 0, flex: 1 }}>
                            <ThemeIcon color="yellow" variant="light" radius="md" size="lg">
                              <IconAlertTriangle size={18} />
                            </ThemeIcon>
                            <Box style={{ minWidth: 0, flex: 1 }}>
                              <Group gap="xs" mb={4}>
                                <Badge variant="light" color="gray" radius="xl">
                                  {conflictIndex + 1}
                                </Badge>
                                <Text fw={800}>
                                  {t("features.board.variants.validationIssueTitle", {
                                    defaultValue: "Inconsistent move selection",
                                  })}
                                </Text>
                              </Group>
                              <Text size="sm" c="dimmed">
                                {t("features.board.variants.validationIssueDescription", {
                                  defaultValue:
                                    "{{color}} has {{count}} conflicting selected moves from this position.",
                                  color: validationActiveColorLabel,
                                  count: conflict.moves.length,
                                })}
                              </Text>
                              <Group gap="xs" mt="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                                <Text size="xs" c="dimmed" fw={700}>
                                  {t("features.board.variants.validationFen", { defaultValue: "FEN" })}
                                </Text>
                                <Code
                                  style={{
                                    maxWidth: "100%",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {conflict.fen}
                                </Code>
                                <CopyButton value={conflict.fen}>
                                  {({ copied, copy }) => (
                                    <ActionIcon
                                      size="sm"
                                      variant="subtle"
                                      color={copied ? "teal" : "gray"}
                                      onClick={copy}
                                      aria-label={t("common.copy", { defaultValue: "Copy" })}
                                    >
                                      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                                    </ActionIcon>
                                  )}
                                </CopyButton>
                              </Group>
                            </Box>
                          </Group>
                          <Box
                            style={{
                              flexShrink: 0,
                              minWidth: 250,
                              paddingLeft: 16,
                              borderLeft:
                                "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 16%, var(--mantine-color-dark-4))",
                            }}
                          >
                            <Text size="xs" c="dimmed" fw={700} mb={6}>
                              {t("features.board.variants.validationConflictingMoves", {
                                defaultValue: "Conflicting moves",
                              })}
                            </Text>
                            <Group gap="xs" wrap="nowrap">
                              {conflict.moves.map((move, moveIndex) => (
                                <Group key={`${conflict.fen}-summary-${move.san}`} gap="xs" wrap="nowrap">
                                  {moveIndex > 0 ? <IconRefresh size={16} color="var(--mantine-color-red-5)" /> : null}
                                  <Badge
                                    variant="light"
                                    color="teal"
                                    radius="sm"
                                    size="xl"
                                    style={{
                                      minWidth: 110,
                                      justifyContent: "center",
                                      border:
                                        "1px solid color-mix(in srgb, var(--mantine-color-teal-5) 34%, transparent)",
                                    }}
                                  >
                                    {move.san}
                                  </Badge>
                                </Group>
                              ))}
                            </Group>
                          </Box>
                        </Group>

                        <Box
                          style={{
                            border:
                              "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 12%, var(--mantine-color-dark-4))",
                            borderRadius: 8,
                            overflowX: "auto",
                          }}
                        >
                          <Box
                            style={{
                              minWidth: 760,
                            }}
                          >
                            <Box
                              style={{
                                display: "grid",
                                gridTemplateColumns: "120px minmax(0, 1fr) 146px",
                                gap: 0,
                                background:
                                  "color-mix(in srgb, var(--mantine-color-blue-9) 10%, var(--mantine-color-dark-7))",
                                borderBottom:
                                  "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 12%, var(--mantine-color-dark-4))",
                              }}
                            >
                              <Text size="xs" c="dimmed" fw={700} px="sm" py={7}>
                                {t("features.board.variants.validationSelectedMove", {
                                  defaultValue: "Selected move",
                                })}
                              </Text>
                              <Text size="xs" c="dimmed" fw={700} px="sm" py={7}>
                                {t("features.board.variants.validationVariantBranch", {
                                  defaultValue: "Variant / Branch",
                                })}
                              </Text>
                              <Text size="xs" c="dimmed" fw={700} px="sm" py={7}>
                                {t("common.actions", { defaultValue: "Actions" })}
                              </Text>
                            </Box>
                            {conflict.moves.flatMap((move) =>
                              move.occurrences.map((occurrence, occurrenceIndex) => (
                                <Box
                                  key={`${conflict.fen}-${move.san}-${occurrence.variantPath}-${occurrence.variantName}-${occurrence.line}`}
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns: "120px minmax(0, 1fr) 146px",
                                    alignItems: "center",
                                    borderTop:
                                      occurrenceIndex === 0
                                        ? "0"
                                        : "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 8%, var(--mantine-color-dark-4))",
                                  }}
                                >
                                  <Box px="sm" py={7}>
                                    <Badge
                                      variant="outline"
                                      color="teal"
                                      radius="sm"
                                      style={{ minWidth: 58, justifyContent: "center" }}
                                    >
                                      {move.san}
                                    </Badge>
                                  </Box>
                                  <Box px="sm" py={7} style={{ minWidth: 0 }}>
                                    <Text size="xs" c="dimmed" truncate>
                                      {conflict.fen}
                                    </Text>
                                    <Group gap={5} wrap="nowrap" style={{ minWidth: 0 }}>
                                      <IconGitBranch size={13} color="var(--mantine-color-blue-4)" />
                                      <Text size="xs" c="dimmed" truncate>
                                        {occurrence.variantName}
                                      </Text>
                                      <IconChevronRight size={12} color="var(--mantine-color-dimmed)" />
                                      <Text size="xs" truncate>
                                        {occurrence.line}
                                      </Text>
                                    </Group>
                                  </Box>
                                  <Box px="sm" py={7}>
                                    <Button
                                      size="compact-xs"
                                      variant="light"
                                      rightSection={<IconArrowRight size={13} />}
                                      onClick={() => void handleOpenValidationConflict(conflict, occurrence)}
                                    >
                                      {t("features.board.variants.validationGoToVariant", {
                                        defaultValue: "Go to variant",
                                      })}
                                    </Button>
                                  </Box>
                                </Box>
                              )),
                            )}
                          </Box>
                        </Box>

                        <Group justify="space-between" gap="sm">
                          <Text size="xs" c="dimmed">
                            {t("features.board.variants.validationResolveIssue", {
                              defaultValue: "Resolve this issue:",
                            })}{" "}
                            {t("features.board.variants.validationConflictSummary", {
                              defaultValue: "{{moves}} across {{count}} occurrence(s)",
                              moves: conflictingMoveLabels,
                              count: occurrenceCount,
                            })}
                          </Text>
                          <Group gap="xs">
                            {conflict.moves.map((move) => (
                              <Button
                                key={`${conflict.fen}-keep-${move.san}`}
                                size="xs"
                                color="teal"
                                leftSection={<IconCheck size={14} />}
                                loading={resolvingValidationConflict}
                                onClick={() => void handleApplyValidationMove(conflict, move.san)}
                              >
                                {t("features.board.variants.validationKeepMoveForAll", {
                                  defaultValue: "Keep {{move}} for all",
                                  move: move.san,
                                })}
                              </Button>
                            ))}
                            <Button
                              size="xs"
                              variant="default"
                              leftSection={<IconEye size={14} />}
                              onClick={() => void handleOpenValidationConflict(conflict)}
                            >
                              {t("features.board.variants.validationReviewManually", {
                                defaultValue: "Review manually",
                              })}
                            </Button>
                          </Group>
                        </Group>
                      </Stack>
                    </Box>
                  );
                })}
              </Stack>
            )}
          </Stack>
        ) : null}
      </Modal>

      <Modal
        opened={createNewModalOpened}
        onClose={closeCreateNewModal}
        title={t("features.board.variants.createNew", { defaultValue: "Create New Variant" })}
      >
        <form onSubmit={createNewForm.onSubmit(handleCreateNew)}>
          <Stack>
            <TextInput
              label={t("features.board.variants.name", { defaultValue: "Name" })}
              placeholder={t("features.board.variants.namePlaceholder", { defaultValue: "Enter variant name..." })}
              {...createNewForm.getInputProps("name")}
              required
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={closeCreateNewModal}>
                {t("common.cancel")}
              </Button>
              <Button type="submit">{t("common.create")}</Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <Modal
        opened={editCommentsModalOpened}
        onClose={closeEditCommentsModal}
        title={t("features.board.variants.editComments", { defaultValue: "Edit Comments / References" })}
      >
        <form onSubmit={commentsForm.onSubmit(handleSaveComments)}>
          <Stack>
            <TextInput
              label={t("features.board.variants.name", { defaultValue: "Name" })}
              placeholder={t("features.board.variants.namePlaceholder", { defaultValue: "Enter variant name..." })}
              {...commentsForm.getInputProps("name")}
              required
            />
            <NumberInput
              label={t("features.board.variants.priority", { defaultValue: "Priority" })}
              placeholder={t("features.board.variants.priorityPlaceholder", { defaultValue: "Set priority (1-4)" })}
              min={1}
              max={4}
              allowDecimal={false}
              {...commentsForm.getInputProps("priority")}
            />
            <TextInput
              label={t("features.board.variants.opening", { defaultValue: "Opening" })}
              placeholder={t("features.board.variants.openingPlaceholder", { defaultValue: "Enter opening name..." })}
              {...commentsForm.getInputProps("opening")}
            />
            <Textarea
              label={t("features.board.variants.comments", { defaultValue: "Comments / References" })}
              placeholder={t("features.board.variants.commentsPlaceholder", {
                defaultValue: "Add your comments or references here...",
              })}
              {...commentsForm.getInputProps("comments")}
              autosize
              minRows={4}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={closeEditCommentsModal}>
                {t("common.cancel")}
              </Button>
              <Button type="submit">
                {t("features.board.variants.saveComments", { defaultValue: "Save Comments" })}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
