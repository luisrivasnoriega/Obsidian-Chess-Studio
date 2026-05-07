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
  Group,
  Loader,
  Modal,
  MultiSelect,
  NumberInput,
  Popover,
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
import { useDisclosure } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import {
  IconChevronDown,
  IconChevronRight,
  IconEdit,
  IconEye,
  IconFileExport,
  IconFileImport,
  IconGitBranch,
  IconPlus,
  IconPuzzle,
  IconRefresh,
  IconSettings,
  IconShieldCheck,
  IconTrash,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, readDir, readTextFile, remove, rename, writeTextFile } from "@tauri-apps/plugin-fs";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { DataTable, type DataTableSortStatus } from "mantine-datatable";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { activeProfileIdAtom, activeTabAtom, enginesAtom, profilesAtom, sessionsAtom, tabsAtom } from "@/state/atoms";
import { premiumActionButtonStyles, premiumMutedPanelStyle } from "@/styles/premiumSurface";
import { getAccountKey, stripAccountKey } from "@/utils/accountKeys";
import { defaultPGN, getMoveText, parsePGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { setCoverageExplorerCache } from "@/utils/coverageExplorerCache";
import { getDatabases, type Opening, query_players, searchPosition } from "@/utils/db";
import { getDocumentDir } from "@/utils/documentDir";
import { createFile, openFile, readInfoMetadata, writeInfoMetadata } from "@/utils/files";
import { formatDateToPGN, parseDate } from "@/utils/format";
import { getLichessGames, getMasterGames } from "@/utils/lichess/api";
import type { LichessGameSpeed, LichessRating } from "@/utils/lichess/explorer";
import { getProfileDbPath } from "@/utils/profileDb";
import { generatePuzzleVariantsFromTree, type PuzzleTreeNodeDto } from "@/utils/puzzleVariants";
import type { TreeNode } from "@/utils/treeReducer";
import { PuzzleVariantsModal } from "../boards/components/PuzzleVariantsModal";
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
import { getVariantsDirectory } from "./utils/profileDir";

type VariantTreeNode = {
  key: string;
  variant: VariantInfo;
  children: VariantTreeNode[];
};

type VariantTableRow = VariantInfo & {
  key: string;
  variant: VariantInfo;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
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
    occurrences: VariantValidationMoveOccurrence[];
  }>;
};

type VariantValidationReport = {
  targetVariantName: string;
  activeColor: "white" | "black";
  checkedVariants: number;
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

type VariantCoverageBuildConfigDto = {
  dbType: VariantBuildConfig["dbType"];
  localDatabasePath: string | null;
  lichessSpeeds: LichessGameSpeed[];
  lichessRatings: LichessRating[];
  lichessSince: string | null;
  lichessUntil: string | null;
  lichessPlayer: string;
  lichessColor: "white" | "black";
  masterSince: string | null;
  masterUntil: string | null;
  includeChildren: boolean;
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
};

type CoveragePositionCacheEntry = {
  fen: string;
  totalGames: number;
  moves: CoverageMoveEntry[];
};

type CoverageRawMoveEntry = {
  san: string;
  games: number;
  white?: number;
  black?: number;
  draw?: number;
  nextFen?: string | null;
};

type VariantCoverageCache = {
  version: 6;
  sourceSignature: string;
  maxMoves: number;
  positions: Record<string, CoveragePositionCacheEntry>;
  tierOverrides?: Record<string, Exclude<CoverageTier, "root">>;
  labelOverrides?: Record<string, string>;
  graphRoot: CoverageGraphNode;
  repertoireColor: "white" | "black";
  generatedAt: string;
};

type LegacyVariantCoverageCache = {
  version: 3 | 4;
  sourceSignature: string;
  maxMoves: number;
  positions: Record<string, CoveragePositionCacheEntry>;
  tierOverrides?: Record<string, Exclude<CoverageTier, "root">>;
  labelOverrides?: Record<string, string>;
  graphRoot?: CoverageGraphNode;
  repertoireColor?: "white" | "black";
  generatedAt: string;
};

type CoverageBuildProgress = {
  phase: "preparing" | "building";
  variantsDone: number;
  variantsTotal: number;
  positionsProcessed: number;
  positionsPending: number;
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

type CoverageEngineBestLine = {
  score: { value: { type: "cp" | "mate"; value: number } };
  sanMoves?: string[] | null;
  multipv?: number | null;
};

const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;
const COVERAGE_GRAPH_CACHE_VERSION = 6;
const COVERAGE_BUILD_FETCH_CONCURRENCY = 4;
const COVERAGE_BUILD_OPENING_LOOKUP_CONCURRENCY = 8;
const COVERAGE_GRAPH_INITIAL_EXPANDED_LEVELS = 3;
const COVERAGE_PROFILE_STATS_MAX_ACTIVE_DEPTH = COVERAGE_GRAPH_INITIAL_EXPANDED_LEVELS;
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

function sanitizeFileStem(input: string): string {
  const cleaned = input.replace(/[<>:"/\\|?*]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "puzzles";
}

function normalizeFenKey(fen: string): string {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) {
    return fen.trim();
  }
  return `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]}`;
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
  refreshing,
  t,
}: {
  value: CoverageProfileTimeControlCategory[];
  options: CoverageProfileTimeControlCategory[];
  onChange: (values: CoverageProfileTimeControlCategory[]) => void;
  disabled: boolean;
  refreshing: boolean;
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
              {refreshing ? <Loader size={16} /> : <IconChevronDown size={16} color="var(--mantine-color-gray-4)" />}
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

function formatOpeningNameForCoverageNode(
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

function getTagValue(tags: string[], prefix: string): string | null {
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

async function buildSourceSignature(config: VariantBuildConfig): Promise<string> {
  const payload: VariantCoverageBuildConfigDto = {
    dbType: config.dbType,
    localDatabasePath: config.localDatabasePath,
    lichessSpeeds: config.lichessSpeeds,
    lichessRatings: config.lichessRatings,
    lichessSince: formatMonthTag(config.lichessSince),
    lichessUntil: formatMonthTag(config.lichessUntil),
    lichessPlayer: config.lichessPlayer,
    lichessColor: config.lichessColor,
    masterSince: formatMonthTag(config.masterSince),
    masterUntil: formatMonthTag(config.masterUntil),
    includeChildren: config.includeChildren,
  };
  return await invoke<string>("variant_coverage_build_source_signature", { config: payload });
}

type CoverageOpeningRow = {
  san: string;
  games: number;
  white: number;
  black: number;
  draw: number;
};

function toCoverageOpenings(openings: Opening[]): CoverageOpeningRow[] {
  return openings
    .map((opening) => ({
      san: opening.move,
      games: opening.white + opening.black + opening.draw,
      white: opening.white,
      black: opening.black,
      draw: opening.draw,
    }))
    .filter((row) => row.san.trim().length > 0 && row.games > 0)
    .sort((a, b) => b.games - a.games);
}

function formatEngineAdvantageForRepertoire(
  score: { value: { type: "cp" | "mate"; value: number } } | null | undefined,
  fen: string,
  repertoireColor: "white" | "black",
): string | null {
  if (!score?.value || typeof score.value.value !== "number") return null;
  const sideToMove = fenTurnColor(fen);
  const perspective = sideToMove === repertoireColor ? 1 : -1;
  if (score.value.type === "mate") {
    const mate = Math.trunc(score.value.value * perspective);
    const prefix = mate > 0 ? "+" : "";
    return `M${prefix}${mate}`;
  }
  const cp = score.value.value * perspective;
  const pawns = cp / 100;
  const prefix = pawns > 0 ? "+" : "";
  return `${prefix}${pawns.toFixed(2)}`;
}

function isCoverageEngineBestLine(value: unknown): value is CoverageEngineBestLine {
  if (!value || typeof value !== "object") return false;
  const score = (value as { score?: unknown }).score;
  if (!score || typeof score !== "object") return false;
  const scoreValue = (score as { value?: unknown }).value;
  if (!scoreValue || typeof scoreValue !== "object") return false;
  const type = (scoreValue as { type?: unknown }).type;
  const rawValue = (scoreValue as { value?: unknown }).value;
  return (type === "cp" || type === "mate") && typeof rawValue === "number" && Number.isFinite(rawValue);
}

function getNextFenFromSan(fen: string, san: string): string | null {
  const [position, error] = positionFromFen(fen);
  if (error || !position) return null;
  const move = parseSan(position, san);
  if (!move) return null;
  position.play(move);
  return makeFen(position.toSetup());
}

function buildCoverageTierOverrideKey(fen: string, san: string): string {
  return `${normalizeFenKey(fen)}|${san.trim()}`;
}

async function getCoverageGraphCacheFilePath(variantPath: string, sourceSignature: string): Promise<string> {
  return await invoke<string>("variant_coverage_graph_cache_path", {
    variantPath,
    sourceSignature,
  });
}

function parseLegacyCoverageCacheFromMetadata(rawMetadata: unknown): LegacyVariantCoverageCache | null {
  if (!rawMetadata || typeof rawMetadata !== "object") return null;
  const candidate = (rawMetadata as Record<string, unknown>).coverageGraphCache;
  if (!candidate || typeof candidate !== "object") return null;
  const cache = candidate as Record<string, unknown>;
  if (cache.version !== 3 && cache.version !== 4) return null;
  if (typeof cache.sourceSignature !== "string") return null;
  if (typeof cache.maxMoves !== "number") return null;
  if (!cache.positions || typeof cache.positions !== "object") return null;
  return cache as LegacyVariantCoverageCache;
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

async function trimCoverageGraphByDepth(root: CoverageGraphNode, maxActiveMoves: number): Promise<CoverageGraphNode> {
  return await invoke<CoverageGraphNode>("variant_coverage_trim_graph_by_depth", {
    root,
    maxActiveMoves,
  });
}

async function applyLowSampleFlagsToGraph(
  root: CoverageGraphNode,
  positions: Record<string, CoveragePositionCacheEntry>,
  repertoireColor: "white" | "black",
): Promise<CoverageGraphNode> {
  return await invoke<CoverageGraphNode>("variant_coverage_apply_position_flags", {
    root,
    positions,
    repertoireColor,
  });
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

function serializeCoverageTierOverrides(
  tierOverrides: Map<string, Exclude<CoverageTier, "root">>,
): Record<string, Exclude<CoverageTier, "root">> {
  const record: Record<string, Exclude<CoverageTier, "root">> = {};
  for (const [key, tier] of tierOverrides.entries()) {
    record[key] = tier;
  }
  return record;
}

async function classifyCoveragePosition(
  fen: string,
  moves: CoverageRawMoveEntry[],
  tierOverrides: Map<string, Exclude<CoverageTier, "root">>,
  repertoireColor: "white" | "black",
): Promise<CoveragePositionCacheEntry> {
  return await invoke<CoveragePositionCacheEntry>("variant_coverage_classify_position", {
    fen,
    moves,
    tierOverrides: serializeCoverageTierOverrides(tierOverrides),
    repertoireColor,
  });
}

async function getCachedCoveragePosition(
  sourceSignature: string,
  fen: string,
  tierOverrides: Map<string, Exclude<CoverageTier, "root">>,
  repertoireColor: "white" | "black",
): Promise<CoveragePositionCacheEntry | null> {
  return await invoke<CoveragePositionCacheEntry | null>("variant_coverage_get_cached_position", {
    sourceSignature,
    fen,
    tierOverrides: serializeCoverageTierOverrides(tierOverrides),
    repertoireColor,
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

function setCoverageEngineInfoByFenMap(
  node: CoverageGraphNode,
  engineInfoByFen: Map<string, { advantage: string; engineName: string; engineMs: number }>,
): CoverageGraphNode {
  const nodeFen = `${node.fen ?? ""}`.trim();
  const nodeFenKey = nodeFen ? normalizeFenKey(nodeFen) : null;
  const nextChildren = node.children.map((child) => setCoverageEngineInfoByFenMap(child, engineInfoByFen));
  const engineInfo = nodeFenKey ? engineInfoByFen.get(nodeFenKey) : null;
  if (engineInfo) {
    return {
      ...node,
      engineAdvantage: engineInfo.advantage,
      engineName: engineInfo.engineName,
      engineMs: engineInfo.engineMs,
      children: nextChildren,
    };
  }
  return {
    ...node,
    children: nextChildren,
  };
}

function collectCoverageSubtreeFens(node: CoverageGraphNode, output: string[] = []): string[] {
  const fen = `${node.fen ?? ""}`.trim();
  if (fen) output.push(fen);
  for (const child of node.children) {
    collectCoverageSubtreeFens(child, output);
  }
  return output;
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

function collectCoverageEngineAnnotationsByFen(
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

function applyCoverageEngineAnnotationsByFen(
  node: CoverageGraphNode,
  annotationsByFen: Map<string, CoverageEngineAnnotation>,
): CoverageGraphNode {
  const nextChildren = node.children.map((child) => applyCoverageEngineAnnotationsByFen(child, annotationsByFen));
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
        activeWinRate: forcedReply ? forcedReply.activeWinRate : node.activeWinRate,
        activeLossRate: forcedReply ? forcedReply.activeLossRate : node.activeLossRate,
        profileWinRate: forcedReply ? forcedReply.profileWinRate : node.profileWinRate,
        profileLossRate: forcedReply ? forcedReply.profileLossRate : node.profileLossRate,
        engineAdvantage: forcedReply ? forcedReply.engineAdvantage : node.engineAdvantage,
        engineName: forcedReply ? forcedReply.engineName : node.engineName,
        engineMs: forcedReply ? forcedReply.engineMs : node.engineMs,
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

async function withCoverageRetry<T>(run: () => Promise<T>): Promise<T> {
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

async function withCoverageRequestTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
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

function createAsyncLimiter(maxConcurrent: number) {
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

function fenTurnColor(fen: string): "white" | "black" {
  const parts = fen.trim().split(/\s+/);
  return parts[1] === "b" ? "black" : "white";
}

function computeVariantActiveLineDepth(tree: Awaited<ReturnType<typeof parsePGN>> | null): number | null {
  if (!tree?.root) return null;
  const activeColor: "white" | "black" = tree.headers.orientation === "black" ? "black" : "white";

  let maxActiveMoves = 0;
  const walk = (node: TreeNode, activeMoves: number) => {
    const children = Array.isArray(node.children) ? node.children : [];
    if (children.length === 0) {
      if (activeMoves > maxActiveMoves) {
        maxActiveMoves = activeMoves;
      }
      return;
    }

    const sideToMove = fenTurnColor(node.fen);
    for (const child of children) {
      const nextActiveMoves = activeMoves + (sideToMove === activeColor ? 1 : 0);
      walk(child, nextActiveMoves);
    }
  };

  walk(tree.root, 0);
  return maxActiveMoves;
}

async function loadVariants(variantsDir: string): Promise<VariantInfo[]> {
  const scanDirs = [variantsDir];
  const allEntries: Array<FileMetadata> = [];
  for (const dir of scanDirs) {
    if (!(await exists(dir))) {
      continue;
    }
    const entries = await readDir(dir);
    const resolved = await processEntriesRecursively(dir, entries);
    allEntries.push(...resolved.filter((entry): entry is FileMetadata => entry.type === "file"));
  }

  if (allEntries.length === 0) {
    return [];
  }
  const seenPaths = new Set<string>();
  const variantFiles = allEntries.filter((file) => {
    if (file.metadata.type !== "variants") {
      return false;
    }
    const key = file.path.replace(/\\/g, "/").toLowerCase();
    if (seenPaths.has(key)) {
      return false;
    }
    seenPaths.add(key);
    return true;
  });

  const variants: VariantInfo[] = [];

  for (const file of variantFiles) {
    try {
      let gameTree: Awaited<ReturnType<typeof parsePGN>> | null = null;
      try {
        // Read the first game to extract richer metadata.
        // If PGN is empty/corrupt, keep the variant visible via .info metadata.
        const { commands } = await import("@/bindings");
        const { unwrap } = await import("@/utils/unwrap");
        const count = unwrap(await commands.countPgnGames(file.path));
        if (count > 0) {
          const games = unwrap(await commands.readGames(file.path, 0, 0));
          const firstGame = games[0];
          if (firstGame) {
            gameTree = await parsePGN(firstGame);
          }
        }
      } catch {
        // Keep metadata-only fallback.
      }

      const tags = file.metadata.tags || [];

      // Priority: metadata tags > PGN headers
      const openingTag = getTagValue(tags, "opening:");
      const priorityTag = getTagValue(tags, "priority:");
      const fenTag = getTagValue(tags, "fen:");
      const depth = getTagValue(tags, "depth:");
      const database = getTagValue(tags, "database:");
      const engine = getTagValue(tags, "engine:");
      const engineMs = getTagValue(tags, "engineMs:");
      const buildConfig = await parseVariantBuildConfigFromTags(tags);
      const variantsCount =
        tags
          .find((tag) => tag.startsWith("variantsCount:"))
          ?.slice("variantsCount:".length)
          .trim() || null;
      const commentsTag =
        tags
          .find((tag) => tag.startsWith("comments:"))
          ?.slice("comments:".length)
          .trim() || null;
      const referencesTag =
        tags
          .find((tag) => tag.startsWith("references:"))
          ?.slice("references:".length)
          .trim() || null;
      const comments = commentsTag || referencesTag || null;
      const parentLink = file.metadata.type === "variants" ? (file.metadata.links?.parent ?? null) : null;
      const childLinks =
        file.metadata.type === "variants" && Array.isArray(file.metadata.links?.children)
          ? file.metadata.links.children
          : [];

      // Fallback to PGN-derived headers if metadata tags don't exist
      const opening = openingTag || gameTree?.headers?.eco || null;
      const fen = fenTag || gameTree?.headers?.fen || null;
      const lineDepth = computeVariantActiveLineDepth(gameTree);

      const parsedPriority = priorityTag ? Number.parseInt(priorityTag, 10) : Number.NaN;

      variants.push({
        name: file.name,
        path: file.path,
        priority: Number.isFinite(parsedPriority) ? parsedPriority : null,
        opening: opening || null,
        fen: fen || null,
        depth: depth ? Number.parseInt(depth, 10) : null,
        lineDepth,
        database: database || null,
        engine: engine || null,
        engineMs: engineMs ? Number.parseInt(engineMs, 10) : null,
        dbType: buildConfig.dbType ?? null,
        variantsCount: variantsCount ? Number.parseInt(variantsCount, 10) : null,
        comments: comments,
        parentLink,
        childLinks,
      });
    } catch (error) {
      console.error(`Error loading variant ${file.path}:`, error);
    }
  }

  return variants;
}

export default function VariantsPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [_tabs, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const engines = useAtomValue(enginesAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const profiles = useAtomValue(profilesAtom);
  const sessions = useAtomValue(sessionsAtom);
  const { layout } = useResponsiveLayout();

  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "table">("table");
  const [repairingLinks, setRepairingLinks] = useState(false);
  const [sortStatus, setSortStatus] = useState<DataTableSortStatus<VariantInfo>>({
    columnAccessor: "name",
    direction: "asc",
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [transferBusy, setTransferBusy] = useState(false);
  const [puzzleModalOpened, setPuzzleModalOpened] = useState(false);
  const [puzzleDepth, setPuzzleDepth] = useState(1);
  const [maxPuzzleDepth, setMaxPuzzleDepth] = useState(24);
  const [puzzleTargetKey, setPuzzleTargetKey] = useState<string | null>(null);
  const [generatingPuzzles, setGeneratingPuzzles] = useState(false);
  const [validatingVariants, setValidatingVariants] = useState(false);
  const [validationReport, setValidationReport] = useState<VariantValidationReport | null>(null);
  const [validationModalOpened, setValidationModalOpened] = useState(false);
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
  const [coveragePuzzleTierFilter, setCoveragePuzzleTierFilter] = useState<Exclude<CoverageTier, "root">>("mainline");
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
  const [coverageProfileStatsRefreshing, setCoverageProfileStatsRefreshing] = useState(false);
  const [coverageEngineMs, setCoverageEngineMs] = useState(1000);
  const [coverageEngineEvaluating, setCoverageEngineEvaluating] = useState(false);
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
  const lichessAuthToken = useMemo(() => {
    const profileToken = profiles.find((p) => p.id === activeProfileId)?.lichessToken?.trim() ?? "";
    return profileToken.length > 0 ? profileToken : undefined;
  }, [activeProfileId, profiles]);
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
  const gridCols = isMobile ? 1 : { base: 1, md: 2, lg: 3 };

  const {
    data: variants = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["variants", activeProfileId ?? "global"],
    queryFn: async () => loadVariants(await getVariantsDirectory(activeProfileId)),
    staleTime: 0,
    gcTime: 60_000,
    refetchOnMount: "always",
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
    const onVariantsUpdated = () => {
      void refetch();
    };
    window.addEventListener("variants:links-updated", onVariantsUpdated);
    window.addEventListener("variants:updated", onVariantsUpdated);
    return () => {
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

      console.log("Creating variant file:", { filename, dir: variantsDir, profileId: activeProfileId });
      const result = await createFile({
        filename,
        filetype: "variants",
        dir: variantsDir,
        pgn: defaultPGN(),
      });

      console.log("Create file result:", { isOk: result.isOk, isErr: result.isErr });

      if (result.isOk) {
        console.log("File created successfully:", result.value.path);
        await openFile(result.value.path, setTabs, setActiveTab);
        navigate({ to: "/analysis" });
        closeCreateNewModal();
        createNewForm.reset();
        await refetch();
      } else {
        const error = result.error;
        console.error("Create file error details:", { error, type: typeof error, isError: error instanceof Error });

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
      console.error("Unexpected error creating variant:", error);
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
        const variantsDir = await getVariantsDirectory(activeProfileId);
        await repairVariantLinks(variantsDir);
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
      modals.openConfirmModal({
        title: t("common.delete"),
        children: (
          <Text size="sm">
            {t("features.board.variants.deleteConfirm", {
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
            await remove(variant.path);
            // Also delete the .info file if it exists
            const infoPath = variant.path.replace(".pgn", ".info");
            if (await exists(infoPath)) {
              await remove(infoPath);
            }
            try {
              const variantDir = variant.path.replace(/[\\/][^\\/]+$/, "");
              const report = await cleanupVariantLinksAfterDelete(variant.path, variantDir);
              if (report.updatedFiles > 0 || report.removedLinks > 0) {
                try {
                  window.dispatchEvent(new Event("variants:links-updated"));
                } catch {}
              }
            } catch {
              // Ignore link cleanup errors during delete.
            }
            notifications.show({
              title: t("common.success"),
              message: t("features.board.variants.deleted", { defaultValue: "Variant deleted successfully" }),
              color: "green",
            });
            await refetch();
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
    [refetch, t],
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
      const matches =
        variant.name.toLowerCase().includes(searchLower) ||
        variant.opening?.toLowerCase().includes(searchLower) ||
        variant.database?.toLowerCase().includes(searchLower) ||
        variant.engine?.toLowerCase().includes(searchLower) ||
        variant.parentLink?.name?.toLowerCase().includes(searchLower) ||
        variant.childLinks?.some(
          (link) => link.name.toLowerCase().includes(searchLower) || link.label?.toLowerCase().includes(searchLower),
        ) ||
        variant.comments?.toLowerCase().includes(searchLower) ||
        (variant.engineMs !== null && String(variant.engineMs).includes(searchLower)) ||
        (variant.variantsCount !== null && String(variant.variantsCount).includes(searchLower));
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
      const childKeys = Array.from(childrenByParent.get(key) ?? []).filter(
        (childKey) => parentByChild.get(childKey) === key,
      );
      const sortedChildren = childKeys
        .map((childKey) => buildNode(childKey, nextLineage))
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
  }, [variants, search, sortVariants]);

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

  const openCoverageGraphForKey = useCallback((key: string) => {
    coverageGraphResumeSnapshot = null;
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
    (row: VariantTableRow) => {
      openCoverageGraphForKey(row.key);
    },
    [openCoverageGraphForKey],
  );

  const handleOpenCoverageGraphForVariant = useCallback(
    (variant: VariantInfo) => {
      openCoverageGraphForKey(normalizePath(variant.path));
    },
    [openCoverageGraphForKey],
  );

  const fetchCoverageOpenings = useCallback(
    async (fen: string, config: VariantBuildConfig, signal?: AbortSignal): Promise<CoverageOpeningRow[]> => {
      if (config.dbType === "local") {
        if (!config.localDatabasePath) return [];
        const [openings] = await searchPosition(
          {
            path: config.localDatabasePath,
            fen,
            type: "exact",
            players: [],
            color: "any",
            result: "any",
          },
          "variants-coverage",
          signal,
        );
        return toCoverageOpenings(openings);
      }

      if (config.dbType === "lch_all") {
        const payload = await getLichessGames(
          fen,
          {
            speeds: config.lichessSpeeds,
            ratings: config.lichessRatings,
            color: config.lichessColor,
            player: config.lichessPlayer.trim() || undefined,
            since: config.lichessSince ?? undefined,
            until: config.lichessUntil ?? undefined,
          },
          lichessAuthToken,
          signal,
        );
        return toCoverageOpenings(
          payload.moves.map((move) => ({
            move: move.san,
            white: move.white,
            black: move.black,
            draw: move.draws,
          })),
        );
      }

      const payload = await getMasterGames(
        fen,
        {
          since: config.masterSince ?? undefined,
          until: config.masterUntil ?? undefined,
        },
        lichessAuthToken,
        signal,
      );
      return toCoverageOpenings(
        payload.moves.map((move) => ({
          move: move.san,
          white: move.white,
          black: move.black,
          draw: move.draws,
        })),
      );
    },
    [lichessAuthToken],
  );

  const handleBuildCoverageGraph = useCallback(
    async (options?: { forceRebuild?: boolean }) => {
      if (!coverageGraphTargetKey || coverageGraphLoading) return;
      const forceRebuild = options?.forceRebuild === true;
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

        const targetVariant = variantLinkGraph.variantByKey.get(coverageGraphTargetKey);
        if (!targetVariant) return;

        const targetMetadata = await readInfoMetadata(targetVariant.path, "variants");
        const targetTags = Array.isArray(targetMetadata.tags) ? targetMetadata.tags : [];
        const parsedConfig = await parseVariantBuildConfigFromTags(targetTags);
        const resolvedConfig: VariantBuildConfig = {
          ...buildConfig,
          ...parsedConfig,
          dbType: parsedConfig.dbType ?? buildConfig.dbType,
          localDatabasePath: parsedConfig.localDatabasePath ?? buildConfig.localDatabasePath,
          lichessSpeeds: parsedConfig.lichessSpeeds ?? buildConfig.lichessSpeeds,
          lichessRatings: parsedConfig.lichessRatings ?? buildConfig.lichessRatings,
          lichessSince: parsedConfig.lichessSince ?? buildConfig.lichessSince,
          lichessUntil: parsedConfig.lichessUntil ?? buildConfig.lichessUntil,
          lichessPlayer: parsedConfig.lichessPlayer ?? buildConfig.lichessPlayer,
          lichessColor: parsedConfig.lichessColor ?? buildConfig.lichessColor,
          masterSince: parsedConfig.masterSince ?? buildConfig.masterSince,
          masterUntil: parsedConfig.masterUntil ?? buildConfig.masterUntil,
        };
        if (resolvedConfig.dbType !== "local" && !lichessAuthToken) {
          throw new Error(
            t("features.board.variants.coverageGraphMissingToken", {
              defaultValue:
                "Lichess token not found for the active profile. Add a token in Profiles before building a graph with Lichess sources.",
            }),
          );
        }

        const sourceSignature = await buildSourceSignature(resolvedConfig);
        const subtreeKeys = collectSubtreeKeys(coverageGraphTargetKey);
        if (subtreeKeys.length === 0) return;
        const variantsTotal = subtreeKeys.length;
        const cacheFilePath = await getCoverageGraphCacheFilePath(targetVariant.path, sourceSignature);
        const existingCache = await readCoverageGraphCache(cacheFilePath);
        let resolvedProfileStatsDbPath = `${activeProfileCoverageDbPath ?? ""}`.trim();
        if (!resolvedProfileStatsDbPath && activeProfileId) {
          try {
            resolvedProfileStatsDbPath = await getProfileDbPath(activeProfileId);
          } catch {
            resolvedProfileStatsDbPath = "";
          }
        }
        const resolvedProfilePlayerIds = await resolveActiveProfileCoveragePlayerIds(resolvedProfileStatsDbPath);
        const legacyCache = existingCache ? null : parseLegacyCoverageCacheFromMetadata(targetMetadata);
        const { commands } = await import("@/bindings");
        const runCoverageFetch = createAsyncLimiter(COVERAGE_BUILD_FETCH_CONCURRENCY);
        const runOpeningLookup = createAsyncLimiter(COVERAGE_BUILD_OPENING_LOOKUP_CONCURRENCY);
        const openingNameByFenKey = new Map<string, string | null>();
        const openingNameInFlightByFenKey = new Map<string, Promise<string | null>>();
        const seedOpeningNamesFromGraph = (node?: CoverageGraphNode | null) => {
          if (!node) return;
          const stack: CoverageGraphNode[] = [node];
          while (stack.length > 0) {
            const current = stack.pop();
            if (!current) continue;
            const currentFen = `${current.fen ?? ""}`.trim();
            const currentFenKey = currentFen ? normalizeFenKey(currentFen) : null;
            if (currentFenKey && typeof current.openingName === "string") {
              openingNameByFenKey.set(currentFenKey, current.openingName);
            }
            for (const child of current.children) {
              stack.push(child);
            }
          }
        };
        if (existingCache?.sourceSignature === sourceSignature) {
          seedOpeningNamesFromGraph(existingCache.graphRoot);
        }

        const getOpeningNameByFen = async (fen?: string | null): Promise<string | null> => {
          const normalizedFen = `${fen ?? ""}`.trim();
          if (!normalizedFen) return null;
          const fenKey = normalizeFenKey(normalizedFen);
          if (openingNameByFenKey.has(fenKey)) {
            return openingNameByFenKey.get(fenKey) ?? null;
          }
          const pending = openingNameInFlightByFenKey.get(fenKey);
          if (pending) {
            return await pending;
          }

          const request = runOpeningLookup(async () => {
            try {
              const result = await commands.getOpeningInfoFromFen(normalizedFen);
              if (result.status !== "ok") {
                openingNameByFenKey.set(fenKey, null);
                return null;
              }
              const openingName = formatOpeningNameForCoverageNode(result.data) ?? null;
              openingNameByFenKey.set(fenKey, openingName);
              return openingName;
            } catch {
              openingNameByFenKey.set(fenKey, null);
              return null;
            }
          });
          openingNameInFlightByFenKey.set(fenKey, request);
          try {
            return await request;
          } finally {
            openingNameInFlightByFenKey.delete(fenKey);
          }
        };
        const resolveCoverageOpeningName = async (
          fen: string | null | undefined,
          fallbackOpeningName: string | null | undefined,
        ): Promise<string | null> => {
          return (await getOpeningNameByFen(fen)) ?? fallbackOpeningName ?? null;
        };

        const enrichCoverageGraphNodeOpenings = async (
          node: CoverageGraphNode,
          inheritedOpeningName: string | null = null,
        ): Promise<CoverageGraphNode> => {
          const openingName = await resolveCoverageOpeningName(node.fen, inheritedOpeningName);
          const children = await Promise.all(
            node.children.map((child) => enrichCoverageGraphNodeOpenings(child, openingName)),
          );
          return {
            ...node,
            openingName,
            children,
          };
        };

        if (
          !forceRebuild &&
          existingCache &&
          existingCache.sourceSignature === sourceSignature &&
          existingCache.maxMoves >= requestedDepth
        ) {
          setCoverageGraphOrientation(existingCache.repertoireColor);
          const graphWithOpenings = await enrichCoverageGraphNodeOpenings(existingCache.graphRoot);
          const graphWithPositionFlags = await applyLowSampleFlagsToGraph(
            graphWithOpenings,
            existingCache.positions,
            existingCache.repertoireColor,
          );
          const graphWithProfileFlags = await applyProfileFlagsToCoverageGraph(
            graphWithPositionFlags,
            existingCache.positions,
            resolvedProfileStatsDbPath || null,
            resolvedProfilePlayerIds,
            existingCache.repertoireColor,
            selectedProfileTimeControls,
          );
          const trimmedGraph = await trimCoverageGraphByDepth(graphWithProfileFlags, requestedDepth);
          setCoverageGraphRoot(trimmedGraph);
          setCoverageCollapsedNodeIds(
            buildCoverageDefaultCollapsedIds(trimmedGraph, COVERAGE_GRAPH_INITIAL_EXPANDED_LEVELS),
          );
          setCoverageGraphCachePath(cacheFilePath);
          setCoverageGraphSourceSignature(sourceSignature);
          setCoverageBuildProgress(null);
          return;
        }

        let variantsDone = 0;
        let positionsProcessed = 0;
        let positionsPending = 0;
        let lastProgressUpdate = 0;
        const pushProgress = (phase: CoverageBuildProgress["phase"], force = false) => {
          const now = Date.now();
          if (!force && now - lastProgressUpdate < 120) return;
          lastProgressUpdate = now;
          setCoverageBuildProgress({
            phase,
            variantsDone,
            variantsTotal,
            positionsProcessed,
            positionsPending,
          });
        };
        pushProgress("preparing", true);

        const sourceCompatibleCache =
          existingCache && existingCache.sourceSignature === sourceSignature
            ? existingCache
            : legacyCache && legacyCache.sourceSignature === sourceSignature
              ? legacyCache
              : null;
        const profileStatsDbPath = resolvedProfileStatsDbPath;
        const shouldFetchProfileStats = profileStatsDbPath.length > 0;
        let resolvedProfilePlayerIdsPromise: Promise<number[]> | null = Promise.resolve(resolvedProfilePlayerIds);
        const getResolvedProfilePlayerIds = async (): Promise<number[]> => {
          if (!shouldFetchProfileStats || !profileStatsDbPath) return [];
          if (resolvedProfilePlayerIdsPromise) return await resolvedProfilePlayerIdsPromise;
          resolvedProfilePlayerIdsPromise = resolveActiveProfileCoveragePlayerIds(profileStatsDbPath);
          return await resolvedProfilePlayerIdsPromise;
        };
        const preservedEngineAnnotations = collectCoverageEngineAnnotationsByFen(sourceCompatibleCache?.graphRoot);
        const positionCache = new Map<string, CoveragePositionCacheEntry>();
        const tierOverrides = new Map<string, Exclude<CoverageTier, "root">>();
        const labelOverrides = new Map<string, string>();
        if (sourceCompatibleCache?.tierOverrides && typeof sourceCompatibleCache.tierOverrides === "object") {
          for (const [overrideKey, tier] of Object.entries(sourceCompatibleCache.tierOverrides)) {
            if (tier === "mainline" || tier === "secondary" || tier === "alternative") {
              tierOverrides.set(overrideKey, tier);
            }
          }
        }
        const sourceLabelOverrides = sourceCompatibleCache?.labelOverrides;
        if (sourceLabelOverrides && typeof sourceLabelOverrides === "object") {
          for (const [overrideKey, rawLabel] of Object.entries(sourceLabelOverrides)) {
            const normalized = `${rawLabel ?? ""}`.trim();
            if (normalized.length > 0) {
              labelOverrides.set(overrideKey, normalized);
            }
          }
        }
        if (!forceRebuild && sourceCompatibleCache) {
          for (const [fenKey, entry] of Object.entries(sourceCompatibleCache.positions)) {
            positionCache.set(fenKey, entry);
          }
        }
        const positionEntryInFlightByFenKey = new Map<string, Promise<CoveragePositionCacheEntry>>();

        const getPositionEntry = async (fen: string): Promise<CoveragePositionCacheEntry> => {
          const fenKey = normalizeFenKey(fen);
          const cached = positionCache.get(fenKey);
          if (cached) {
            const needsHydration = cached.moves.some(
              (move) => move.lowSample == null || move.activeWinRate == null || move.activeLossRate == null,
            );
            if (!needsHydration) return cached;
            const hydrated = await classifyCoveragePosition(
              cached.fen || fen,
              cached.moves,
              tierOverrides,
              repertoireColor,
            );
            positionCache.set(fenKey, hydrated);
            return hydrated;
          }
          const existingInFlight = positionEntryInFlightByFenKey.get(fenKey);
          if (existingInFlight) {
            return await existingInFlight;
          }

          const request = runCoverageFetch(async () => {
            let persistedPosition: CoveragePositionCacheEntry | null = null;
            try {
              persistedPosition = await getCachedCoveragePosition(sourceSignature, fen, tierOverrides, repertoireColor);
            } catch {
              persistedPosition = null;
            }
            if (persistedPosition) {
              positionCache.set(fenKey, persistedPosition);
              return persistedPosition;
            }

            const openings = await withCoverageRetry(
              async () =>
                await withCoverageRequestTimeout(
                  async (signal) => await fetchCoverageOpenings(fen, resolvedConfig, signal),
                  12_000,
                ),
            );
            if (resolvedConfig.dbType === "local") {
              try {
                await setCoverageExplorerCache(sourceSignature, fen, openings);
              } catch {
                // Cache write is best effort; the build should continue even if persistence fails.
              }
            }
            const entry = await classifyCoveragePosition(fen, openings, tierOverrides, repertoireColor);
            positionCache.set(fenKey, entry);
            return entry;
          });

          positionEntryInFlightByFenKey.set(fenKey, request);
          try {
            return await request;
          } finally {
            positionEntryInFlightByFenKey.delete(fenKey);
          }
        };

        const profilePositionCache = new Map<string, CoveragePositionCacheEntry>();
        const profilePositionEntryInFlightByFenKey = new Map<string, Promise<CoveragePositionCacheEntry | null>>();
        const getActiveProfilePositionEntry = async (
          fen: string,
          options?: { activeMovesUsed?: number },
        ): Promise<CoveragePositionCacheEntry | null> => {
          if (!shouldFetchProfileStats) return null;
          const activeMovesUsed = options?.activeMovesUsed ?? 0;
          if (activeMovesUsed > COVERAGE_PROFILE_STATS_MAX_ACTIVE_DEPTH) {
            return null;
          }
          const fenKey = normalizeFenKey(fen);
          const cached = profilePositionCache.get(fenKey);
          if (cached) return cached;
          const existingInFlight = profilePositionEntryInFlightByFenKey.get(fenKey);
          if (existingInFlight) {
            return await existingInFlight;
          }

          const request = runCoverageFetch(async () => {
            const profilePlayerIds = await getResolvedProfilePlayerIds();
            if (profilePlayerIds.length === 0) {
              const emptyEntry: CoveragePositionCacheEntry = { fen, totalGames: 0, moves: [] };
              profilePositionCache.set(fenKey, emptyEntry);
              return emptyEntry;
            }
            if (!profileStatsDbPath) {
              const emptyEntry: CoveragePositionCacheEntry = { fen, totalGames: 0, moves: [] };
              profilePositionCache.set(fenKey, emptyEntry);
              return emptyEntry;
            }
            const entry = await withCoverageRetry(
              async () =>
                await withCoverageRequestTimeout(
                  async () =>
                    await invoke<CoveragePositionCacheEntry>("variant_coverage_get_profile_position", {
                      dbPath: profileStatsDbPath,
                      fen,
                      playerIds: profilePlayerIds,
                      repertoireColor,
                      timeControlCategories: selectedProfileTimeControls,
                    }),
                  12_000,
                ),
            );
            profilePositionCache.set(fenKey, entry);
            return entry;
          });

          profilePositionEntryInFlightByFenKey.set(fenKey, request);
          try {
            return await request;
          } catch {
            return null;
          } finally {
            profilePositionEntryInFlightByFenKey.delete(fenKey);
          }
        };

        const variantRootFenByKey = new Map<string, string>();
        const variantTreesByKey = new Map<string, Array<Awaited<ReturnType<typeof parsePGN>>>>();
        const { unwrap } = await import("@/utils/unwrap");
        for (const key of subtreeKeys) {
          const variant = variantLinkGraph.variantByKey.get(key);
          if (!variant) continue;
          try {
            const count = unwrap(await commands.countPgnGames(variant.path));
            if (count <= 0) continue;
            const endIndex = key === coverageGraphTargetKey ? Math.max(0, count - 1) : 0;
            const games = unwrap(await commands.readGames(variant.path, 0, endIndex));
            const trees: Array<Awaited<ReturnType<typeof parsePGN>>> = [];
            for (const game of games) {
              if (!game) continue;
              try {
                const tree = await parsePGN(game);
                trees.push(tree);
              } catch {
                // Ignore malformed games while building coverage graph context.
              }
            }
            if (trees.length === 0) continue;
            variantTreesByKey.set(key, trees);
            variantRootFenByKey.set(key, trees[0].root.fen);
          } catch {
            // Ignore invalid variant files in coverage graph.
          } finally {
            variantsDone += 1;
            pushProgress("preparing");
          }
        }
        pushProgress("preparing", true);

        const variantNamesByFen = new Map<string, string[]>();
        for (const key of subtreeKeys) {
          const variant = variantLinkGraph.variantByKey.get(key);
          const rootFen = variantRootFenByKey.get(key);
          if (!variant || !rootFen) continue;
          const fenKey = normalizeFenKey(rootFen);
          const current = variantNamesByFen.get(fenKey) ?? [];
          if (!current.includes(variant.name)) {
            current.push(variant.name);
            variantNamesByFen.set(fenKey, current);
          }
        }

        const formatCoverageNodeLabel = (san: string, percent: number, variantNames: string[] | undefined) => {
          if (!variantNames || variantNames.length === 0) return `${san} ${percent}%`;
          return `${san} ${percent}% - ${variantNames.join(" / ")}`;
        };

        const targetTrees = variantTreesByKey.get(coverageGraphTargetKey) ?? [];
        const targetTree = targetTrees[0];
        const repertoireColor: "white" | "black" = targetTree?.headers.orientation === "black" ? "black" : "white";
        const targetChildLinks = targetVariant.childLinks ?? [];
        const compareAnchorPath = (aPath: number[], bPath: number[]) => {
          const max = Math.max(aPath.length, bPath.length);
          for (let i = 0; i < max; i += 1) {
            const aValue = aPath[i];
            const bValue = bPath[i];
            if (aValue == null && bValue == null) return 0;
            if (aValue == null) return -1;
            if (bValue == null) return 1;
            if (aValue !== bValue) return aValue - bValue;
          }
          return 0;
        };
        const findTreeBranchAnchor = (
          node: TreeNode,
          path: number[],
        ): {
          anchorFen: string;
          anchorPath: number[];
          anchorPly: number;
          labels: Set<string>;
        } | null => {
          const children = Array.isArray(node.children) ? node.children : [];
          if (children.length === 0) return null;

          const sideToMove = fenTurnColor(node.fen);
          const isOpponentTurn = sideToMove !== repertoireColor;
          if (isOpponentTurn && children.length > 1) {
            const labels = new Set<string>();
            for (const child of children) {
              const san = child.san?.trim();
              if (san) labels.add(san);
            }
            return {
              anchorFen: node.fen,
              anchorPath: [...path],
              anchorPly: path.length,
              labels,
            };
          }

          if (children.length === 1) {
            return findTreeBranchAnchor(children[0], [...path, 0]);
          }

          if (!isOpponentTurn && children.length > 1) {
            const labels = new Set<string>();
            for (const child of children) {
              const san = child.san?.trim();
              if (san) labels.add(san);
            }
            return {
              anchorFen: node.fen,
              anchorPath: [...path],
              anchorPly: path.length,
              labels,
            };
          }

          return null;
        };

        const treeBranchCandidatesByFen = new Map<
          string,
          {
            anchorFen: string;
            anchorPath: number[];
            anchorPly: number;
            labels: Set<string>;
          }
        >();
        const collectTreeBranchCandidates = (node: TreeNode, path: number[]) => {
          const children = Array.isArray(node.children) ? node.children : [];
          if (children.length === 0) return;
          const sideToMove = fenTurnColor(node.fen);
          if (sideToMove !== repertoireColor) {
            const fenKey = normalizeFenKey(node.fen);
            const labels = new Set<string>();
            for (const child of children) {
              const san = child.san?.trim();
              if (san) labels.add(san);
            }
            if (labels.size > 0) {
              const existing = treeBranchCandidatesByFen.get(fenKey);
              if (!existing) {
                treeBranchCandidatesByFen.set(fenKey, {
                  anchorFen: node.fen,
                  anchorPath: [...path],
                  anchorPly: path.length,
                  labels,
                });
              } else {
                for (const label of labels) existing.labels.add(label);
                if (
                  path.length < existing.anchorPath.length ||
                  (path.length === existing.anchorPath.length && compareAnchorPath(path, existing.anchorPath) < 0)
                ) {
                  existing.anchorPath = [...path];
                  existing.anchorPly = path.length;
                  existing.anchorFen = node.fen;
                }
              }
            }
          }
          for (let i = 0; i < children.length; i += 1) {
            collectTreeBranchCandidates(children[i], [...path, i]);
          }
        };
        for (const tree of targetTrees) {
          collectTreeBranchCandidates(tree.root, []);
        }

        const anchorGroups = new Map<
          string,
          {
            anchorFen: string;
            anchorPath: number[];
            anchorPly: number;
            labels: Set<string>;
          }
        >();
        for (const link of targetChildLinks) {
          const fenKey = normalizeFenKey(link.anchorFen);
          const label = (link.label ?? "").trim();
          const existing = anchorGroups.get(fenKey);
          if (!existing) {
            const labels = new Set<string>();
            if (label) labels.add(label);
            anchorGroups.set(fenKey, {
              anchorFen: link.anchorFen,
              anchorPath: Array.isArray(link.anchorPath) ? [...link.anchorPath] : [],
              anchorPly: link.anchorPly,
              labels,
            });
            continue;
          }
          if (label) existing.labels.add(label);
          if (link.anchorPly < existing.anchorPly) {
            existing.anchorPly = link.anchorPly;
          }
          if (Array.isArray(link.anchorPath) && link.anchorPath.length < existing.anchorPath.length) {
            existing.anchorPath = [...link.anchorPath];
          }
        }
        const multiGameBranchCandidates = Array.from(treeBranchCandidatesByFen.values()).filter(
          (candidate) => candidate.labels.size >= 2,
        );
        const orderedTreeBranchCandidates = multiGameBranchCandidates.sort((a, b) => {
          if (a.anchorPly !== b.anchorPly) return a.anchorPly - b.anchorPly;
          const pathCompare = compareAnchorPath(a.anchorPath, b.anchorPath);
          if (pathCompare !== 0) return pathCompare;
          return b.labels.size - a.labels.size;
        });
        const treeBranchAnchor =
          orderedTreeBranchCandidates[0] ?? (targetTree ? findTreeBranchAnchor(targetTree.root, []) : null);
        const anchorCandidates = treeBranchAnchor ? [treeBranchAnchor] : Array.from(anchorGroups.values());
        const orderedAnchors = anchorCandidates.sort((a, b) => {
          if (a.anchorPly !== b.anchorPly) return a.anchorPly - b.anchorPly;
          const pathCompare = compareAnchorPath(a.anchorPath, b.anchorPath);
          if (pathCompare !== 0) return pathCompare;
          return b.labels.size - a.labels.size;
        });
        const firstBranchAnchor = orderedAnchors[0];

        const orientationMovesByFen = new Map<string, Set<string>>();
        const collectOrientationMoves = (node: TreeNode) => {
          const sideToMove = fenTurnColor(node.fen);
          if (sideToMove === repertoireColor) {
            const fenKey = normalizeFenKey(node.fen);
            const moves = orientationMovesByFen.get(fenKey) ?? new Set<string>();
            for (const child of node.children) {
              const san = child.san?.trim();
              if (!san) continue;
              moves.add(san);
            }
            orientationMovesByFen.set(fenKey, moves);
          }
          for (const child of node.children) {
            collectOrientationMoves(child);
          }
        };
        for (const [treeKey, trees] of variantTreesByKey.entries()) {
          for (const tree of trees) {
            const variantOrientation: "white" | "black" = tree.headers.orientation === "black" ? "black" : "white";
            if (variantOrientation !== repertoireColor && treeKey !== coverageGraphTargetKey) {
              continue;
            }
            collectOrientationMoves(tree.root);
          }
        }

        const formatOrientationNodeLabel = (san: string, variantNames: string[] | undefined) => {
          if (!variantNames || variantNames.length === 0) return san;
          return `${san} - ${variantNames.join(" / ")}`;
        };

        const expandNode = async (
          fen: string,
          parentNode: CoverageGraphNode,
          remainingMoves: number,
          activeMovesUsed: number,
        ) => {
          if (remainingMoves <= 0) return;
          positionsProcessed += 1;
          positionsPending = Math.max(0, positionsPending - 1);
          pushProgress("building");

          const sideToMove = fenTurnColor(fen);
          if (sideToMove === repertoireColor) {
            const orientationMoves = Array.from(orientationMovesByFen.get(normalizeFenKey(fen)) ?? []);
            if (orientationMoves.length === 0) {
              // No mapped repertoire response from this position: stop branch early without extra API calls.
              return;
            }

            const entry = await getPositionEntry(fen);
            const percentBySan = new Map<string, number>();
            for (const move of entry.moves) {
              percentBySan.set(move.san, move.percent);
            }
            const profileMoveBySan = new Map<string, CoverageMoveEntry>();
            const profileEntry = await getActiveProfilePositionEntry(fen, { activeMovesUsed });
            for (const move of profileEntry?.moves ?? []) {
              profileMoveBySan.set(move.san, move);
            }
            const childExpansions: Array<Promise<void>> = [];
            for (const san of orientationMoves) {
              const nextFen = getNextFenFromSan(fen, san);
              const destinationVariantNames = nextFen ? variantNamesByFen.get(normalizeFenKey(nextFen)) : undefined;
              const responsePercent = percentBySan.get(san);
              const responseMove = entry.moves.find((move) => move.san === san);
              const profileMove = profileMoveBySan.get(san);
              const overrideKey = buildCoverageTierOverrideKey(fen, san);
              const openingName = await resolveCoverageOpeningName(nextFen, parentNode.openingName ?? null);
              const childNode: CoverageGraphNode = {
                id: `${parentNode.id}|forced:${san}|${remainingMoves}`,
                label: formatOrientationNodeLabel(san, destinationVariantNames),
                openingName,
                tier: "root",
                percent: typeof responsePercent === "number" ? responsePercent : undefined,
                fen: nextFen ?? null,
                overrideKey,
                activeMovesUsed: activeMovesUsed + 1,
                activeWinRate: responseMove?.activeWinRate ?? undefined,
                activeLossRate: responseMove?.activeLossRate ?? undefined,
                profileWinRate: profileMove?.activeWinRate ?? undefined,
                profileLossRate: profileMove?.activeLossRate ?? undefined,
                children: [],
              };
              parentNode.children.push(childNode);
              if (nextFen && remainingMoves >= 1) {
                positionsPending += 1;
                pushProgress("building");
                childExpansions.push(expandNode(nextFen, childNode, remainingMoves - 1, activeMovesUsed + 1));
              }
            }
            if (childExpansions.length > 0) {
              await Promise.all(childExpansions);
            }
            return;
          }

          const entry = await getPositionEntry(fen);
          const visibleMoves = entry.moves.filter((move) => {
            const nextFenKey = move.nextFen ? normalizeFenKey(move.nextFen) : null;
            const hasMappedResponse = nextFenKey ? (orientationMovesByFen.get(nextFenKey)?.size ?? 0) > 0 : false;
            if (move.tier === "alternative" && !hasMappedResponse) return false;
            return true;
          });
          const profileMoveBySan = new Map<string, CoverageMoveEntry>();
          if (visibleMoves.length > 0) {
            const profileEntry = await getActiveProfilePositionEntry(fen, { activeMovesUsed });
            for (const move of profileEntry?.moves ?? []) {
              profileMoveBySan.set(move.san, move);
            }
          }
          const childExpansions: Array<Promise<void>> = [];
          for (const move of visibleMoves) {
            const nextFenKey = move.nextFen ? normalizeFenKey(move.nextFen) : null;
            const hasMappedResponse = nextFenKey ? (orientationMovesByFen.get(nextFenKey)?.size ?? 0) > 0 : false;

            const destinationVariantNames = move.nextFen
              ? variantNamesByFen.get(normalizeFenKey(move.nextFen))
              : undefined;
            const overrideKey = buildCoverageTierOverrideKey(fen, move.san);
            const customLabel = labelOverrides.get(overrideKey);
            const profileMove = profileMoveBySan.get(move.san);
            const sourceWinRate = move.activeWinRate ?? undefined;
            const sourceLossRate = move.activeLossRate ?? undefined;
            const profileWinRate = profileMove?.activeWinRate ?? undefined;
            const profileLossRate = profileMove?.activeLossRate ?? undefined;
            const openingName = await resolveCoverageOpeningName(move.nextFen, parentNode.openingName ?? null);
            const childNode: CoverageGraphNode = {
              id: `${parentNode.id}|${move.san}|${remainingMoves}`,
              label: formatCoverageNodeLabel(customLabel ?? move.san, move.percent, destinationVariantNames),
              openingName,
              tier: move.tier,
              percent: move.percent,
              lowSample: move.lowSample ?? false,
              fen: move.nextFen,
              overrideKey,
              activeMovesUsed,
              activeWinRate: sourceWinRate,
              activeLossRate: sourceLossRate,
              profileWinRate,
              profileLossRate,
              children: [],
            };
            parentNode.children.push(childNode);
            if (move.nextFen && remainingMoves >= 1 && hasMappedResponse) {
              positionsPending += 1;
              pushProgress("building");
              childExpansions.push(expandNode(move.nextFen, childNode, remainingMoves, activeMovesUsed));
            }
          }
          if (childExpansions.length > 0) {
            await Promise.all(childExpansions);
          }
        };

        const rootNode: CoverageGraphNode = {
          id: `coverage:${coverageGraphTargetKey}`,
          label: targetVariant.name,
          openingName: null,
          tier: "root",
          fen: null,
          activeMovesUsed: 0,
          children: [],
        };
        const targetRootFen = variantRootFenByKey.get(coverageGraphTargetKey) ?? targetVariant.fen ?? null;
        if (!targetRootFen) {
          throw new Error(
            t("features.board.variants.coverageGraphMissingRootFen", {
              defaultValue: "Could not determine root FEN for the selected variant.",
            }),
          );
        }
        rootNode.fen = targetRootFen;
        rootNode.openingName = await getOpeningNameByFen(targetRootFen);
        const branchStartFen = firstBranchAnchor?.anchorFen ?? targetRootFen;
        let branchParentNode = rootNode;
        if (firstBranchAnchor && targetTree && firstBranchAnchor.anchorPath.length > 0) {
          const sanSequence: string[] = [];
          let node: TreeNode | null = targetTree.root;
          for (const index of firstBranchAnchor.anchorPath) {
            const nextNode: TreeNode | undefined = node ? node.children[index] : undefined;
            if (!nextNode) {
              node = null;
              break;
            }
            if (nextNode.san) sanSequence.push(nextNode.san);
            node = nextNode;
          }
          if (node && sanSequence.length > 0) {
            branchParentNode = {
              id: `${rootNode.id}|prelude`,
              label: sanSequence.join(" "),
              openingName: await resolveCoverageOpeningName(branchStartFen, rootNode.openingName),
              tier: "root",
              fen: branchStartFen,
              activeMovesUsed: 0,
              children: [],
            };
            rootNode.children.push(branchParentNode);
          }
        }
        positionsPending += 1;
        pushProgress("building");
        await expandNode(branchStartFen, branchParentNode, requestedDepth, 0);
        positionsPending = 0;
        pushProgress("building", true);

        const priorityUpdates = new Map<string, number>();
        for (const key of subtreeKeys) {
          if (key === coverageGraphTargetKey) continue;
          const variant = variantLinkGraph.variantByKey.get(key);
          if (!variant?.parentLink) continue;
          const anchorFenKey = normalizeFenKey(variant.parentLink.anchorFen);
          const anchorEntry = positionCache.get(anchorFenKey);
          if (!anchorEntry) continue;

          const label = (variant.parentLink.label ?? "").trim();
          let matchedMove = label ? anchorEntry.moves.find((move) => move.san === label) : undefined;
          if (!matchedMove) {
            const rootFen = variantRootFenByKey.get(key);
            if (rootFen) {
              matchedMove = anchorEntry.moves.find(
                (move) => move.nextFen && normalizeFenKey(move.nextFen) === normalizeFenKey(rootFen),
              );
            }
          }
          if (!matchedMove) continue;
          if (matchedMove.tier === "mainline") {
            priorityUpdates.set(key, 1);
          } else if (matchedMove.tier === "secondary") {
            priorityUpdates.set(key, 2);
          } else {
            priorityUpdates.set(key, 3);
          }
        }

        for (const [key, priority] of priorityUpdates.entries()) {
          const variant = variantLinkGraph.variantByKey.get(key);
          if (!variant) continue;
          const metadata = await readInfoMetadata(variant.path, "variants");
          metadata.tags = (metadata.tags || []).filter((tag) => !tag.startsWith("priority:"));
          metadata.tags.push(`priority:${priority}`);
          await writeInfoMetadata(variant.path, metadata);
        }
        if (priorityUpdates.size > 0) {
          setCoveragePrioritySyncing(true);
        }

        const positionsRecord: Record<string, CoveragePositionCacheEntry> = {};
        for (const [fenKey, value] of positionCache.entries()) {
          positionsRecord[fenKey] = value;
        }
        const tierOverridesRecord: Record<string, Exclude<CoverageTier, "root">> = {};
        for (const [overrideKey, tier] of tierOverrides.entries()) {
          tierOverridesRecord[overrideKey] = tier;
        }
        const labelOverridesRecord: Record<string, string> = {};
        for (const [overrideKey, label] of labelOverrides.entries()) {
          labelOverridesRecord[overrideKey] = label;
        }
        const rootNodeWithEngineAnnotations =
          preservedEngineAnnotations.size > 0
            ? applyCoverageEngineAnnotationsByFen(rootNode, preservedEngineAnnotations)
            : rootNode;
        const nextCache: VariantCoverageCache = {
          version: COVERAGE_GRAPH_CACHE_VERSION,
          sourceSignature,
          maxMoves: requestedDepth,
          positions: positionsRecord,
          tierOverrides: tierOverridesRecord,
          labelOverrides: labelOverridesRecord,
          graphRoot: rootNodeWithEngineAnnotations,
          repertoireColor,
          generatedAt: new Date().toISOString(),
        };
        await writeCoverageGraphCache(cacheFilePath, nextCache);
        setCoverageGraphCachePath(cacheFilePath);
        setCoverageGraphSourceSignature(sourceSignature);

        try {
          window.dispatchEvent(new Event("variants:updated"));
        } catch {}
        await refetch();
        const graphWithWinrate = await applyLowSampleFlagsToGraph(
          rootNodeWithEngineAnnotations,
          positionsRecord,
          repertoireColor,
        );
        const graphWithProfileFlags = await applyProfileFlagsToCoverageGraph(
          graphWithWinrate,
          positionsRecord,
          profileStatsDbPath || null,
          resolvedProfilePlayerIds,
          repertoireColor,
          selectedProfileTimeControls,
        );
        setCoverageGraphRoot(graphWithProfileFlags);
        setCoverageCollapsedNodeIds(
          buildCoverageDefaultCollapsedIds(graphWithProfileFlags, COVERAGE_GRAPH_INITIAL_EXPANDED_LEVELS),
        );
        setCoverageGraphOrientation(repertoireColor);
        pushProgress("building", true);
      } catch (error) {
        console.error("Coverage graph build failed", error);
        const reason = getErrorMessage(error);
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.coverageGraphFailedWithReason", {
            defaultValue: "Failed to build coverage graph: {{reason}}",
            reason,
          }),
          color: "red",
        });
      } finally {
        setCoverageGraphLoading(false);
        setCoverageBuildProgress((prev) => {
          if (!prev) return prev;
          return { ...prev, positionsPending: 0 };
        });
      }
    },
    [
      buildConfig,
      collectSubtreeKeys,
      coverageGraphDepth,
      coverageGraphLoading,
      coverageGraphTargetKey,
      coverageProfileTimeControlFilters,
      coverageProfileTimeControlOptions,
      fetchCoverageOpenings,
      activeProfileId,
      activeProfileCoverageDbPath,
      lichessAuthToken,
      refetch,
      resolveActiveProfileCoveragePlayerIds,
      t,
      variantLinkGraph.variantByKey,
    ],
  );

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
      setCoverageGraphRoot(nextGraph);
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
      const seedSan = extractSanFromCoverageLabel(node.label) ?? "node";
      setCoveragePuzzleName(sanitizeFileStem(`coverage-${seedSan}`));
      const variantEngineMs = coverageGraphTargetKey
        ? (variantLinkGraph.variantByKey.get(coverageGraphTargetKey)?.engineMs ?? null)
        : null;
      setCoverageEngineMs(variantEngineMs && variantEngineMs > 0 ? variantEngineMs : 1000);
    },
    [coverageGraphTargetKey, variantLinkGraph.variantByKey],
  );

  const _applyCoverageNodeTierOverride = useCallback(async () => {
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

    const overrideKey = coverageActionNode.overrideKey;
    try {
      setCoverageActionSaving(true);

      setCoverageGraphRoot((prev) => {
        if (!prev) return prev;
        return setCoverageTierByOverrideKey(prev, overrideKey, coverageActionTier);
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

      const nextCache: VariantCoverageCache = {
        ...existingCache,
        version: COVERAGE_GRAPH_CACHE_VERSION,
        tierOverrides: {
          ...(existingCache.tierOverrides ?? {}),
          [overrideKey]: coverageActionTier,
        },
        graphRoot: setCoverageTierByOverrideKey(existingCache.graphRoot, overrideKey, coverageActionTier),
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
        message: t("features.board.variants.coverageTierOverrideApplied", {
          defaultValue: "Manual tier applied.",
        }),
        color: "green",
      });
      setCoverageActionNode(null);
    } catch (error) {
      notifications.show({
        title: t("common.error"),
        message: t("features.board.variants.coverageTierOverrideFailed", {
          defaultValue: "Failed to save manual tier change.",
        }),
        color: "red",
      });
      console.error("Failed to apply coverage tier override", error);
    } finally {
      setCoverageActionSaving(false);
    }
  }, [
    coverageActionNode,
    coverageActionTier,
    coverageGraphCachePath,
    coverageGraphSourceSignature,
    coverageGraphTargetKey,
    t,
    variantLinkGraph.variantByKey,
  ]);

  const _applyCoverageNodeLabelOverride = useCallback(async () => {
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
        return setCoverageLabelByOverrideKey(prev, overrideKey, nextLabel);
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

      const nextCache: VariantCoverageCache = {
        ...existingCache,
        version: COVERAGE_GRAPH_CACHE_VERSION,
        labelOverrides: {
          ...(existingCache.labelOverrides ?? {}),
          [overrideKey]: nextLabel,
        },
        graphRoot: setCoverageLabelByOverrideKey(existingCache.graphRoot, overrideKey, nextLabel),
        generatedAt: new Date().toISOString(),
      };
      await writeCoverageGraphCache(resolvedCachePath, nextCache);
      setCoverageGraphCachePath(resolvedCachePath);
      try {
        window.dispatchEvent(new Event("variants:updated"));
      } catch {}
      notifications.show({
        title: t("common.success"),
        message: t("features.board.variants.coverageRenameApplied", {
          defaultValue: "Node name updated.",
        }),
        color: "green",
      });
      setCoverageActionNode(null);
    } catch (error) {
      notifications.show({
        title: t("common.error"),
        message: t("features.board.variants.coverageRenameFailed", {
          defaultValue: "Failed to save node name.",
        }),
        color: "red",
      });
      console.error("Failed to apply coverage label override", error);
    } finally {
      setCoverageActionSaving(false);
    }
  }, [
    coverageActionLabel,
    coverageActionNode,
    coverageGraphCachePath,
    coverageGraphSourceSignature,
    coverageGraphTargetKey,
    t,
    variantLinkGraph.variantByKey,
  ]);

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

      const sourceNodeRaw = findCoverageNodeById(coverageGraphRoot, coverageActionNode.id);
      if (!sourceNodeRaw) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.coverageNodeNotFound", {
            defaultValue: "Could not locate the selected node in the current graph.",
          }),
          color: "red",
        });
        return;
      }

      const sourceNode =
        sourceNodeRaw.children.length === 1 && sourceNodeRaw.children[0].tier === "root"
          ? sourceNodeRaw.children[0]
          : sourceNodeRaw;

      const startFen = sourceNode.fen;
      if (!startFen) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.coverageNodeMissingFen", {
            defaultValue: "Selected node has no position context (FEN).",
          }),
          color: "red",
        });
        return;
      }
      const startFenKey = normalizeFenKey(startFen);

      const resolvePuzzleSourceNode = (node: CoverageGraphNode): CoverageGraphNode =>
        node.children.length === 1 && node.children[0].tier === "root" ? node.children[0] : node;

      const transpositionSourceNodes: CoverageGraphNode[] = [];
      const seenSourceIds = new Set<string>();
      const collectTranspositionSourceNodes = (node: CoverageGraphNode) => {
        const resolved = resolvePuzzleSourceNode(node);
        const resolvedFen = `${resolved.fen ?? ""}`.trim();
        if (resolvedFen.length > 0 && normalizeFenKey(resolvedFen) === startFenKey && !seenSourceIds.has(resolved.id)) {
          seenSourceIds.add(resolved.id);
          transpositionSourceNodes.push(resolved);
        }
        for (const child of node.children) {
          collectTranspositionSourceNodes(child);
        }
      };
      collectTranspositionSourceNodes(coverageGraphRoot);
      if (transpositionSourceNodes.length === 0) {
        transpositionSourceNodes.push(sourceNode);
      }

      const hasTierInSubtree = (node: CoverageGraphNode, selectedTier: Exclude<CoverageTier, "root">): boolean => {
        const isEligibleBySample = coveragePuzzleIncludeLowSample || !node.lowSample;
        if (node.tier === selectedTier && isEligibleBySample) return true;
        for (const child of node.children) {
          if (hasTierInSubtree(child, selectedTier)) return true;
        }
        return false;
      };

      const toFilteredPuzzleChildren = (parent: CoverageGraphNode): PuzzleTreeNodeDto[] => {
        const out: PuzzleTreeNodeDto[] = [];
        for (const child of parent.children) {
          if (child.tier !== "root") {
            const isEligibleBySample = coveragePuzzleIncludeLowSample || !child.lowSample;
            const isSelectedTier = child.tier === coveragePuzzleTierFilter && isEligibleBySample;
            const connectsToSelectedTier = hasTierInSubtree(child, coveragePuzzleTierFilter);
            // Keep connectors so selected-tier branches deeper in the tree remain reachable.
            if (!isSelectedTier && !connectsToSelectedTier) {
              continue;
            }
          }
          const san = extractSanFromCoverageLabel(child.label);
          if (!san || !child.fen) {
            continue;
          }
          out.push({
            fen: child.fen,
            san,
            children: toFilteredPuzzleChildren(child),
          });
        }
        return out;
      };

      const allowedStartKeys = new Set<string>();
      const collectAllowedStartKeys = (parent: CoverageGraphNode) => {
        for (const child of parent.children) {
          if (
            child.tier === coveragePuzzleTierFilter &&
            child.overrideKey &&
            (coveragePuzzleIncludeLowSample || !child.lowSample)
          ) {
            const hasPlayableReply = child.children.some((replyNode) => {
              const replySan = extractSanFromCoverageLabel(replyNode.label);
              return Boolean(replySan && replyNode.fen);
            });
            if (hasPlayableReply) {
              allowedStartKeys.add(child.overrideKey);
            }
          }
          collectAllowedStartKeys(child);
        }
      };
      for (const transpositionSourceNode of transpositionSourceNodes) {
        collectAllowedStartKeys(transpositionSourceNode);
      }

      const mergedPuzzleChildren: PuzzleTreeNodeDto[] = [];
      for (const transpositionSourceNode of transpositionSourceNodes) {
        mergedPuzzleChildren.push(...toFilteredPuzzleChildren(transpositionSourceNode));
      }

      const puzzleRoot: PuzzleTreeNodeDto = {
        fen: startFen,
        san: null,
        children: mergedPuzzleChildren,
      };

      if (puzzleRoot.children.length === 0) {
        notifications.show({
          title: t("common.warning"),
          message: t("features.board.variants.coveragePuzzleEmpty", {
            defaultValue: "No branches available for the selected tier from this node.",
          }),
          color: "yellow",
        });
        return;
      }
      if (allowedStartKeys.size === 0) {
        notifications.show({
          title: t("common.warning"),
          message: t("features.board.variants.coveragePuzzleEmpty", {
            defaultValue: "No branches available for the selected tier from this node.",
          }),
          color: "yellow",
        });
        return;
      }

      const { commands } = await import("@/bindings");
      const { unwrap } = await import("@/utils/unwrap");
      const count = unwrap(await commands.countPgnGames(targetVariant.path));
      if (count <= 0) {
        notifications.show({
          title: t("common.error"),
          message: t("common.noRecordsFound", { defaultValue: "No records found" }),
          color: "red",
        });
        return;
      }
      const games = unwrap(await commands.readGames(targetVariant.path, 0, 0));
      const firstGame = games[0];
      if (!firstGame) {
        notifications.show({
          title: t("common.error"),
          message: t("common.noRecordsFound", { defaultValue: "No records found" }),
          color: "red",
        });
        return;
      }
      const tree = await parsePGN(firstGame);
      const orientation: "white" | "black" = tree.headers.orientation === "black" ? "black" : "white";
      const result = await generatePuzzleVariantsFromTree({
        root: puzzleRoot,
        orientation,
        selectedDepth,
        allowedStartKeys: Array.from(allowedStartKeys),
      });

      const documentDir = await getDocumentDir();
      if (!documentDir) {
        notifications.show({
          title: t("common.error"),
          message: t("errors.missingFilePath"),
          color: "red",
        });
        return;
      }

      const now = formatDateToPGN(new Date());
      const fileStem = sanitizeFileStem(`${selectedName}-${coveragePuzzleTierFilter}-d${selectedDepth}-${now}`);
      const tags = [
        "puzzle-variants",
        `variant:${targetVariant.name}`,
        `coverageNode:${coverageActionNode.label}`,
        `coverageTier:${coveragePuzzleTierFilter}`,
        `coverageLowSample:${coveragePuzzleIncludeLowSample ? "include" : "exclude"}`,
        `depth:${selectedDepth}`,
        `orientation:${orientation}`,
      ];

      const createResult = await createFile({
        filename: fileStem,
        filetype: "puzzle",
        tags,
        pgn: result.pgn,
        dir: documentDir,
      });

      if (createResult.isErr) {
        notifications.show({
          title: t("common.error"),
          message: t("common.failedToGeneratePuzzles"),
          color: "red",
        });
        return;
      }

      try {
        window.dispatchEvent(new Event("puzzles:updated"));
        window.dispatchEvent(new Event("puzzle-variants:updated"));
      } catch {}

      notifications.show({
        title: t("common.success"),
        message: t("features.board.variants.coveragePuzzleDone", {
          defaultValue: "Generated {{count}} puzzles from selected node.",
          count: result.count,
        }),
        color: "green",
      });
      setCoverageActionNode(null);
    } catch (error) {
      console.error("Failed to generate puzzles from coverage node", error);
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
    coverageGraphTargetKey,
    coveragePuzzleGenerating,
    coveragePuzzleIncludeLowSample,
    coveragePuzzleName,
    coveragePuzzleTierFilter,
    t,
    variantLinkGraph.variantByKey,
  ]);

  const goToCoverageNodeVariant = useCallback(async () => {
    if (!coverageActionNode || !coverageGraphRoot || !coverageGraphTargetKey) return;
    try {
      const sourceNodePath = findCoverageNodePathById(coverageGraphRoot, coverageActionNode.id);
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
      const fenCandidates = [sourceNode?.fen ?? null, parentNode?.fen ?? null].filter(
        (value, index, array): value is string =>
          typeof value === "string" && value.trim().length > 0 && array.indexOf(value) === index,
      );
      let bestMatch: { variant: VariantInfo; position: number[]; fenPriority: number; sanScore: number } | null = null;

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
              (fenPriority === localFenPriority && sanScore === localSanScore && position.length > localBestPath.length)
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
    } catch (error) {
      coverageGraphResumeSnapshot = null;
      console.error("Failed to navigate to coverage node variant", error);
      notifications.show({
        title: t("common.error"),
        message: t("features.board.variants.coverageGoToVariantFailed", {
          defaultValue: "Failed to open variant for this node.",
        }),
        color: "red",
      });
    }
  }, [
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
  ]);

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
    } catch (error) {
      notifications.show({
        title: t("common.error"),
        message: t("features.board.variants.coverageEditFailed", {
          defaultValue: "Failed to save node settings.",
        }),
        color: "red",
      });
      console.error("Failed to save coverage node edit", error);
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

  const runCoverageNodeEngineEval = useCallback(async () => {
    if (!coverageActionNode || !coverageGraphTargetKey) return;
    const sourceNode = coverageGraphRoot
      ? (findCoverageNodeById(coverageGraphRoot, coverageActionNode.id) ?? coverageActionNode)
      : coverageActionNode;
    const nodeFens = [
      ...new Map(collectCoverageSubtreeFens(sourceNode).map((fen) => [normalizeFenKey(fen), fen])).values(),
    ];
    if (nodeFens.length === 0) {
      notifications.show({
        title: t("common.error"),
        message: t("features.board.variants.coverageNodeBranchMissingFen", {
          defaultValue: "Selected node and its children have no position context (FEN).",
        }),
        color: "red",
      });
      return;
    }

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
      notifications.show({
        title: t("common.error"),
        message: t("features.board.variants.coverageEngineMissing", {
          defaultValue: "No local engine available. Configure an engine first.",
        }),
        color: "red",
      });
      return;
    }

    const safeMs = Math.max(100, Math.min(60_000, Math.floor(coverageEngineMs || targetVariant?.engineMs || 1000)));
    const engineTabPrefix = `coverage-node-eval-${Date.now()}`;
    try {
      setCoverageEngineEvaluating(true);
      const { commands } = await import("@/bindings");
      const { unwrap } = await import("@/utils/unwrap");
      const extraOptions = (selectedEngine.settings ?? []).map((option) => ({
        name: option.name,
        value: option.value == null ? "" : String(option.value),
      }));
      const engineInfoByFen = new Map<string, { advantage: string; engineName: string; engineMs: number }>();
      let failedCount = 0;

      for (let index = 0; index < nodeFens.length; index += 1) {
        const nodeFen = nodeFens[index];
        if (!nodeFen) continue;
        const engineTabId = `${engineTabPrefix}-${index}`;
        try {
          const startedAt = Date.now();
          const maxWaitMs = safeMs + 3000;
          let bestLine: CoverageEngineBestLine | null = null;

          while (Date.now() - startedAt <= maxWaitMs) {
            const result = unwrap(
              await commands.getBestMoves(
                selectedEngine.name,
                selectedEngine.path,
                engineTabId,
                { t: "Time", c: safeMs },
                {
                  fen: nodeFen,
                  moves: [],
                  extraOptions,
                },
              ),
            );
            const lines = Array.isArray(result?.[1]) ? [...result[1]] : [];
            const candidate =
              lines.filter(isCoverageEngineBestLine).sort((a, b) => (a.multipv ?? 1) - (b.multipv ?? 1))[0] ?? null;
            if (candidate) {
              bestLine = candidate;
            }
            const progress = typeof result?.[0] === "number" ? result[0] : 0;
            if (bestLine && progress >= 99.9 && Date.now() - startedAt >= safeMs) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 80));
          }

          const baseAdvantage = formatEngineAdvantageForRepertoire(bestLine?.score, nodeFen, coverageGraphOrientation);
          if (!baseAdvantage) {
            failedCount += 1;
            continue;
          }

          const bestSan = `${bestLine?.sanMoves?.[0] ?? ""}`.trim();
          const advantageText = bestSan.length > 0 ? `${baseAdvantage} (${bestSan})` : baseAdvantage;
          engineInfoByFen.set(normalizeFenKey(nodeFen), {
            advantage: advantageText,
            engineName: selectedEngine.name,
            engineMs: safeMs,
          });
        } catch (error) {
          console.error("Failed to evaluate coverage node position", error);
          failedCount += 1;
        } finally {
          try {
            await commands.stopEngine(selectedEngine.path, engineTabId);
          } catch {
            // Best effort cleanup.
          }
        }
      }

      if (engineInfoByFen.size === 0) {
        notifications.show({
          title: t("common.warning"),
          message: t("features.board.variants.coverageEngineNoScore", {
            defaultValue: "Engine score not available for this node or its children.",
          }),
          color: "yellow",
        });
        return;
      }

      setCoverageGraphRoot((prev) => {
        if (!prev) return prev;
        return setCoverageEngineInfoByFenMap(prev, engineInfoByFen);
      });
      setCoverageActionNode((prev) => {
        if (!prev) return prev;
        const prevFen = `${prev.fen ?? ""}`.trim();
        const nextEngineInfo = prevFen ? engineInfoByFen.get(normalizeFenKey(prevFen)) : null;
        if (!nextEngineInfo) return prev;
        return {
          ...prev,
          engineAdvantage: nextEngineInfo.advantage,
          engineName: nextEngineInfo.engineName,
          engineMs: nextEngineInfo.engineMs,
        };
      });

      const resolvedCachePath =
        coverageGraphCachePath ??
        (coverageGraphSourceSignature && targetVariant
          ? await getCoverageGraphCacheFilePath(targetVariant.path, coverageGraphSourceSignature)
          : null);
      if (resolvedCachePath) {
        const existingCache = await readCoverageGraphCache(resolvedCachePath);
        if (existingCache) {
          const nextCache: VariantCoverageCache = {
            ...existingCache,
            version: COVERAGE_GRAPH_CACHE_VERSION,
            graphRoot: setCoverageEngineInfoByFenMap(existingCache.graphRoot, engineInfoByFen),
            generatedAt: new Date().toISOString(),
          };
          await writeCoverageGraphCache(resolvedCachePath, nextCache);
          setCoverageGraphCachePath(resolvedCachePath);
        }
      }

      notifications.show({
        title: t("common.success"),
        message: t("features.board.variants.coverageEngineEvalApplied", {
          defaultValue: "Engine advantage saved for this node and its children.",
          count: engineInfoByFen.size,
          failed: failedCount,
        }),
        color: "green",
      });
    } catch (error) {
      console.error("Failed to evaluate coverage node", error);
      notifications.show({
        title: t("common.error"),
        message: t("features.board.variants.coverageEngineEvalFailed", {
          defaultValue: "Failed to evaluate node with engine.",
        }),
        color: "red",
      });
    } finally {
      setCoverageEngineEvaluating(false);
    }
  }, [
    coverageActionNode,
    coverageEngineMs,
    coverageGraphCachePath,
    coverageGraphOrientation,
    coverageGraphRoot,
    coverageGraphSourceSignature,
    coverageGraphTargetKey,
    engines,
    t,
    variantLinkGraph.variantByKey,
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

  const handleOpenGeneratePuzzles = useCallback((row: VariantTableRow) => {
    setPuzzleTargetKey(row.key);
    setMaxPuzzleDepth(24);
    const initialDepth = row.variant.depth && row.variant.depth > 0 ? Math.min(row.variant.depth, 24) : 1;
    setPuzzleDepth(initialDepth);
    setPuzzleModalOpened(true);
  }, []);

  const generatePuzzlesForVariantTree = useCallback(
    async (selectedDepth: number) => {
      if (!puzzleTargetKey || generatingPuzzles) return;
      setGeneratingPuzzles(true);

      try {
        const documentDir = await getDocumentDir();
        if (!documentDir) {
          notifications.show({
            title: t("common.error"),
            message: t("errors.missingFilePath"),
            color: "red",
          });
          return;
        }

        const { commands } = await import("@/bindings");
        const { unwrap } = await import("@/utils/unwrap");

        const targetVariant = variantLinkGraph.variantByKey.get(puzzleTargetKey);
        if (!targetVariant) {
          notifications.show({
            title: t("common.error"),
            message: t("common.noRecordsFound", { defaultValue: "No records found" }),
            color: "red",
          });
          return;
        }

        const subtreeKeys = collectSubtreeKeys(puzzleTargetKey);
        const seenFensGlobal = new Set<string>();

        let totalPuzzles = 0;
        let generatedFromVariants = 0;
        let failedVariants = 0;

        for (let variantIndex = 0; variantIndex < subtreeKeys.length; variantIndex += 1) {
          const key = subtreeKeys[variantIndex];
          const variant = variantLinkGraph.variantByKey.get(key);
          if (!variant) continue;

          try {
            const count = unwrap(await commands.countPgnGames(variant.path));
            if (count <= 0) {
              failedVariants += 1;
              continue;
            }

            const games = unwrap(await commands.readGames(variant.path, 0, 0));
            const firstGame = games[0];
            if (!firstGame) {
              failedVariants += 1;
              continue;
            }

            const tree = await parsePGN(firstGame);
            const orientation: "white" | "black" = tree.headers.orientation === "black" ? "black" : "white";

            const toDedupedDto = (node: TreeNode): PuzzleTreeNodeDto => {
              const children: PuzzleTreeNodeDto[] = [];
              for (const child of node.children) {
                const fenKey = normalizeFenKey(child.fen);
                if (seenFensGlobal.has(fenKey)) {
                  continue;
                }
                seenFensGlobal.add(fenKey);
                children.push(toDedupedDto(child));
              }
              return {
                fen: node.fen,
                san: node.san ?? null,
                children,
              };
            };

            const dedupedRoot = toDedupedDto(tree.root);
            if (dedupedRoot.children.length === 0) {
              continue;
            }

            const result = await generatePuzzleVariantsFromTree({
              root: dedupedRoot,
              orientation,
              selectedDepth,
            });

            const now = formatDateToPGN(new Date());
            const fileStem = sanitizeFileStem(`${variant.name}-puzzles-d${selectedDepth}-${now}-${variantIndex + 1}`);

            const mainlineNodes: TreeNode[] = [];
            let currentNode: TreeNode = tree.root;
            const maxMainlinePlies = 80;
            while (mainlineNodes.length < maxMainlinePlies && currentNode.children.length > 0) {
              const child = currentNode.children.find((c) => c.san) ?? currentNode.children[0];
              if (!child?.san) break;
              mainlineNodes.push(child);
              currentNode = child;
            }

            const mainline = mainlineNodes
              .map((move, index) =>
                getMoveText(move, {
                  glyphs: false,
                  comments: false,
                  extraMarkups: false,
                  isFirst: index === 0 || move.halfMoves % 2 === 0,
                }),
              )
              .join("")
              .trim();

            const tags = [
              "puzzle-variants",
              `variant:${variant.name}`,
              `depth:${selectedDepth}`,
              `orientation:${orientation}`,
            ];
            if (mainline) {
              tags.push(`mainline:${mainline}`);
            }

            const createResult = await createFile({
              filename: fileStem,
              filetype: "puzzle",
              tags,
              pgn: result.pgn,
              dir: documentDir,
            });
            if (createResult.isErr) {
              failedVariants += 1;
              continue;
            }

            totalPuzzles += result.count;
            generatedFromVariants += 1;
          } catch {
            failedVariants += 1;
          }
        }

        try {
          window.dispatchEvent(new Event("puzzles:updated"));
          window.dispatchEvent(new Event("puzzle-variants:updated"));
        } catch {}

        notifications.show({
          title: generatedFromVariants > 0 ? t("common.success") : t("common.error"),
          message: t("features.board.variants.generatePuzzlesDone", {
            defaultValue: "Generated {{puzzles}} puzzles from {{variants}} variants (failed: {{failed}}).",
            puzzles: totalPuzzles,
            variants: generatedFromVariants,
            failed: failedVariants,
          }),
          color: generatedFromVariants > 0 ? "green" : "red",
        });
      } catch {
        notifications.show({
          title: t("common.error"),
          message: t("common.failedToGeneratePuzzles"),
          color: "red",
        });
      } finally {
        setGeneratingPuzzles(false);
        setPuzzleTargetKey(null);
      }
    },
    [collectSubtreeKeys, generatingPuzzles, puzzleTargetKey, t, variantLinkGraph],
  );

  const handleValidateVariantTree = useCallback(
    async (row: VariantTableRow) => {
      if (validatingVariants) return;
      setValidatingVariants(true);
      setValidationReport(null);
      try {
        const { commands } = await import("@/bindings");
        const { unwrap } = await import("@/utils/unwrap");

        let familyRootKey = row.key;
        const visitedRoots = new Set<string>();
        while (!visitedRoots.has(familyRootKey)) {
          visitedRoots.add(familyRootKey);
          const parentKey = variantLinkGraph.parentByChild.get(familyRootKey);
          if (!parentKey) break;
          familyRootKey = parentKey;
        }

        const subtreeKeys = collectSubtreeKeys(familyRootKey);
        if (subtreeKeys.length === 0) {
          notifications.show({
            title: t("common.error"),
            message: t("common.noRecordsFound", { defaultValue: "No records found" }),
            color: "red",
          });
          return;
        }

        const targetVariant = variantLinkGraph.variantByKey.get(familyRootKey);
        if (!targetVariant) {
          notifications.show({
            title: t("common.error"),
            message: t("common.noRecordsFound", { defaultValue: "No records found" }),
            color: "red",
          });
          return;
        }

        const fenMoves = new Map<string, Map<string, VariantValidationMoveOccurrence[]>>();
        const skippedVariants: string[] = [];
        const orientationMismatches: string[] = [];
        let activeColor: "white" | "black" | null = null;
        let checkedVariants = 0;

        for (const key of subtreeKeys) {
          const variant = variantLinkGraph.variantByKey.get(key);
          if (!variant) continue;

          try {
            const count = unwrap(await commands.countPgnGames(variant.path));
            if (count <= 0) {
              skippedVariants.push(variant.name);
              continue;
            }
            const games = unwrap(await commands.readGames(variant.path, 0, 0));
            const firstGame = games[0];
            if (!firstGame) {
              skippedVariants.push(variant.name);
              continue;
            }

            const tree = await parsePGN(firstGame);
            const variantOrientation: "white" | "black" = tree.headers.orientation === "black" ? "black" : "white";
            if (!activeColor) {
              activeColor = variantOrientation;
            } else if (activeColor !== variantOrientation) {
              orientationMismatches.push(`${variant.name} (${variantOrientation})`);
            }
            checkedVariants += 1;

            const pathMoves: string[] = [];
            const walk = (node: TreeNode) => {
              const sideToMove = fenTurnColor(node.fen);
              for (const child of node.children) {
                const childSan = child.san?.trim();
                if (!childSan) {
                  pathMoves.push("?");
                  walk(child);
                  pathMoves.pop();
                  continue;
                }

                pathMoves.push(childSan);
                if (activeColor && sideToMove === activeColor) {
                  const fenKey = normalizeFenKey(node.fen);
                  const movesMap = fenMoves.get(fenKey) ?? new Map<string, VariantValidationMoveOccurrence[]>();
                  const moveOcc = movesMap.get(childSan) ?? [];
                  moveOcc.push({
                    variantName: variant.name,
                    variantPath: variant.path,
                    line: pathMoves.join(" "),
                  });
                  movesMap.set(childSan, moveOcc);
                  fenMoves.set(fenKey, movesMap);
                }
                walk(child);
                pathMoves.pop();
              }
            };

            walk(tree.root);
          } catch {
            skippedVariants.push(variant.name);
          }
        }

        if (!activeColor) {
          notifications.show({
            title: t("common.error"),
            message: t("common.noRecordsFound", { defaultValue: "No records found" }),
            color: "red",
          });
          return;
        }

        const conflicts: VariantValidationConflict[] = [];
        for (const [fen, movesMap] of fenMoves.entries()) {
          if (movesMap.size <= 1) continue;
          const moves = Array.from(movesMap.entries())
            .map(([san, occurrences]) => ({
              san,
              occurrences,
            }))
            .sort((a, b) => a.san.localeCompare(b.san));
          conflicts.push({
            fen,
            moves,
          });
        }
        conflicts.sort((a, b) => a.fen.localeCompare(b.fen));

        setValidationReport({
          targetVariantName: targetVariant.name,
          activeColor,
          checkedVariants,
          checkedPositions: fenMoves.size,
          conflicts,
          skippedVariants,
          orientationMismatches,
        });
        setValidationModalOpened(true);

        notifications.show({
          title: conflicts.length > 0 ? t("common.warning") : t("common.success"),
          message:
            conflicts.length > 0
              ? t("features.board.variants.validationConflictsFound", {
                  defaultValue: "Detected {{count}} contradictions in active-side moves.",
                  count: conflicts.length,
                })
              : t("features.board.variants.validationNoConflicts", {
                  defaultValue: "No contradictions found for active-side moves.",
                }),
          color: conflicts.length > 0 ? "yellow" : "green",
        });
      } finally {
        setValidatingVariants(false);
      }
    },
    [collectSubtreeKeys, t, validatingVariants, variantLinkGraph],
  );

  const variantTableRows = useMemo(() => {
    const rows: VariantTableRow[] = [];
    const forceExpand = search.trim().length > 0;
    const walk = (node: VariantTreeNode, depth: number) => {
      const hasChildren = node.children.length > 0;
      const expanded = forceExpand || expandedKeys.has(node.key);
      rows.push({
        ...node.variant,
        key: node.key,
        variant: node.variant,
        depth,
        hasChildren,
        expanded,
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
    const walk = (node: VariantTreeNode) => {
      out.push(node.variant);
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
    const maxPage = Math.max(1, Math.ceil(variantTableRows.length / pageSize));
    if (page > maxPage) {
      setPage(maxPage);
    }
  }, [variantTableRows.length, page, pageSize]);

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

  const columns = [
    {
      accessor: "name",
      title: t("features.board.variants.name", { defaultValue: "Name" }),
      sortable: true,
      render: (row: VariantTableRow) => (
        <Group wrap="nowrap" gap="sm">
          <Group wrap="nowrap" gap={6} style={{ marginLeft: row.depth * 16 }}>
            {row.hasChildren ? (
              <ActionIcon variant="subtle" size="sm" color="gray" onClick={() => toggleRow(row.key)}>
                {row.expanded ? <IconChevronDown size="0.9rem" /> : <IconChevronRight size="0.9rem" />}
              </ActionIcon>
            ) : (
              <Box w={22} />
            )}
            <IconGitBranch size="1.2rem" style={{ flexShrink: 0 }} />
          </Group>
          <Box miw={0} style={{ flex: 1 }}>
            <Text fw={600} size="sm" truncate>
              {row.variant.name}
            </Text>
          </Box>
        </Group>
      ),
    },
    {
      accessor: "opening",
      title: t("features.board.variants.opening", { defaultValue: "Opening" }),
      sortable: true,
      render: (row: VariantTableRow) =>
        row.variant.opening ? (
          <Text size="sm" truncate style={{ maxWidth: 250 }}>
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
      render: (row: VariantTableRow) =>
        row.variant.priority !== null ? (
          <Badge variant="light" color="indigo" size="sm">
            {row.variant.priority}
          </Badge>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "fen",
      title: t("features.board.variants.fen", { defaultValue: "FEN" }),
      sortable: true,
      render: (row: VariantTableRow) =>
        row.variant.fen ? (
          <Code
            fz="xs"
            style={{
              maxWidth: 300,
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.variant.fen}
          </Code>
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
      render: (row: VariantTableRow) =>
        row.variant.engine ? (
          <Badge variant="outline" size="sm" style={{ textTransform: "none" }}>
            {row.variant.engine}
          </Badge>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "engineMs",
      title: t("features.board.variants.engineMs", { defaultValue: "Engine Time (ms)" }),
      sortable: true,
      render: (row: VariantTableRow) =>
        row.variant.engineMs !== null ? (
          <Text size="sm">{row.variant.engineMs}</Text>
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
      render: (row: VariantTableRow) => (
        <Group gap={6} wrap="wrap">
          {row.variant.parentLink ? (
            <Badge variant="outline" color="teal" size="sm">
              {t("features.board.variants.parentLink", { defaultValue: "Parent" })}
            </Badge>
          ) : null}
          {(row.variant.childLinks?.length ?? 0) > 0 ? (
            <Badge variant="light" color="cyan" size="sm">
              {t("features.board.variants.childLinks", { defaultValue: "Children" })}:{" "}
              {row.variant.childLinks?.length ?? 0}
            </Badge>
          ) : null}
          {!row.variant.parentLink && (row.variant.childLinks?.length ?? 0) === 0 ? (
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
      render: (row: VariantTableRow) =>
        row.variant.comments ? (
          <Text size="sm" truncate style={{ maxWidth: 300 }}>
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
      render: (row: VariantTableRow) => (
        <Group gap="xs" justify="flex-end">
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
              onClick={() => handleOpenGeneratePuzzles(row)}
              disabled={generatingPuzzles}
            >
              <IconPuzzle size={16} />
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
          <Tooltip label={t("features.board.variants.coverageGraph", { defaultValue: "Open coverage graph" })}>
            <ActionIcon variant="subtle" color="blue" onClick={() => handleOpenCoverageGraph(row)}>
              <IconGitBranch size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("common.delete", { defaultValue: "Delete" })}>
            <ActionIcon variant="subtle" color="red" onClick={() => handleDelete(row.variant)}>
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      ),
    },
  ];

  return (
    <Stack gap={0} h="100%">
      <GenericHeader
        title={t("features.board.variants.title", { defaultValue: "Variants" })}
        folder="variants"
        searchPlaceholder={t("features.board.variants.searchPlaceholder", { defaultValue: "Search variants..." })}
        query={search}
        setQuery={setSearch}
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
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="sm">
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
              overflow: "hidden",
              background:
                "radial-gradient(120% 170% at 100% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 17%, transparent) 0%, transparent 58%), linear-gradient(160deg, color-mix(in srgb, var(--mantine-color-dark-7) 88%, var(--mantine-color-dark-5) 12%), var(--mantine-color-dark-7))",
              borderColor: "color-mix(in srgb, var(--mantine-color-blue-8) 20%, var(--mantine-color-dark-4))",
            }}
          >
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
                noRecordsText={t("common.noRecordsFound", { defaultValue: "No records found" })}
                style={{ flex: 1 }}
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

      <PuzzleVariantsModal
        opened={puzzleModalOpened}
        onClose={() => setPuzzleModalOpened(false)}
        puzzleDepth={puzzleDepth}
        maxPuzzleDepth={maxPuzzleDepth}
        setPuzzleDepth={setPuzzleDepth}
        onGenerate={(depth) => void generatePuzzlesForVariantTree(depth)}
      />

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
                  refreshing={coverageProfileStatsRefreshing}
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
              onNodeClick={handleCoverageNodeClick}
              onNodeToggleCollapse={toggleCoverageNodeCollapsed}
              onNodeExpandAllChildren={expandCoverageNodeAllChildren}
            />
          </Box>
        </Stack>
      </Modal>

      <Modal
        opened={coverageActionNode !== null}
        onClose={() => setCoverageActionNode(null)}
        title={t("features.board.variants.coverageNodeActions", { defaultValue: "Node actions" })}
        centered
        size="lg"
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
                      setCoveragePuzzleTierFilter(value === "secondary" || value === "alternative" ? value : "mainline")
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
                        "Run engine analysis for this node and its children, then store the advantage labels in the graph.",
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
            <Button variant="default" onClick={() => setCoverageActionNode(null)}>
              {t("common.cancel")}
            </Button>
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
        title={t("features.board.variants.validationReportTitle", { defaultValue: "Variants consistency report" })}
        size="xl"
      >
        {validationReport ? (
          <Stack gap="sm">
            <Text size="sm">
              {t("features.board.variants.validationSummary", {
                defaultValue:
                  "Variant: {{variant}} | Active side: {{color}} | Variants checked: {{variants}} | Positions checked: {{positions}} | Contradictions: {{conflicts}}",
                variant: validationReport.targetVariantName,
                color: validationReport.activeColor,
                variants: validationReport.checkedVariants,
                positions: validationReport.checkedPositions,
                conflicts: validationReport.conflicts.length,
              })}
            </Text>

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
              <Stack gap="xs" style={{ maxHeight: 460, overflowY: "auto", paddingRight: 4 }}>
                {validationReport.conflicts.map((conflict) => (
                  <Alert key={conflict.fen} color="red" variant="light">
                    <Stack gap={4}>
                      <Text size="sm" fw={700}>
                        {t("features.board.variants.validationFen", { defaultValue: "FEN" })}:{" "}
                        <Code>{conflict.fen}</Code>
                      </Text>
                      {conflict.moves.map((move) => (
                        <Box key={`${conflict.fen}-${move.san}`}>
                          <Text size="sm" fw={600}>
                            {t("features.board.variants.validationMove", { defaultValue: "Move" })}: {move.san}
                          </Text>
                          {move.occurrences.map((occurrence, index) => (
                            <Text key={`${occurrence.variantPath}-${index}`} size="xs" c="dimmed">
                              {occurrence.variantName} {"->"} {occurrence.line}
                            </Text>
                          ))}
                        </Box>
                      ))}
                    </Stack>
                  </Alert>
                ))}
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
