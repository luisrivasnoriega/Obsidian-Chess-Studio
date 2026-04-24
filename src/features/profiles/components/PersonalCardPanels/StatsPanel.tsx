import { BarChart } from "@mantine/charts";
import {
  Box,
  Button,
  DEFAULT_THEME,
  Divider,
  Flex,
  Group,
  Menu,
  Modal,
  Progress,
  Select,
  Stack,
  Table,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NormalizedGame, PlayerGameInfo } from "@/bindings";
import { commands } from "@/bindings";
import type { EloBucket, ProfileSidebarStats } from "@/bindings/playerStats";
import { playerStatsCommands } from "@/bindings/playerStats";
import { ChartSizeGuard } from "@/components/ChartSizeGuard";
import {
  activeTabAtom,
  defaultProfileStatsUiState,
  profileStatsUiStateByProfileAtom,
  sessionsAtom,
  tabsAtom,
} from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { getDocumentDir } from "@/utils/documentDir";
import { createFile } from "@/utils/files";
import { formatDateToPGN } from "@/utils/format";
import { createPlayerStatsFilters, createSiteStatsSignature } from "@/utils/playerStats";
import { getProfileDbPath } from "@/utils/profileDb";
import {
  type ForkPiece,
  type ForkStats,
  generateProfileMissedForkPuzzles,
  getProfileForkStats,
  getProfileMissedForkGames,
  type MissedForkGameRow,
} from "@/utils/profileForkStats";
import { getProfileIntensityAccuracy, type IntensityAccuracyBucket } from "@/utils/profileIntensityAccuracy";
import { getProfileIntensityBreakdown, type IntensityBreakdown } from "@/utils/profileIntensityBreakdown";
import { getProfileIntensityGames, type IntensityGameRow, type IntensityKey } from "@/utils/profileIntensityGames";
import { getProfileIntensityOutcomes, type IntensityOutcomeBucket } from "@/utils/profileIntensityOutcomes";
import { getProfileOutcomeAccuracy, type OutcomeAccuracyStats } from "@/utils/profileOutcomeAccuracy";
import { getProfileOutcomeReasonBreakdown, type OutcomeReasonBreakdown } from "@/utils/profileOutcomeReasons";
import { getProfilePhaseAccuracy, type PhaseAccuracyBucket } from "@/utils/profilePhaseAccuracy";
import { getProfilePhaseGames, type PhaseGameRow } from "@/utils/profilePhaseGames";
import { getProfilePhaseOutcomes, type PhaseOutcomeBucket } from "@/utils/profilePhaseOutcomes";
import {
  getProfileWeaknessModel,
  type ProfileWeaknessModel,
  type ProfileWeaknessSignal,
} from "@/utils/profileWeaknessModel";
import { createTab } from "@/utils/tabs";
import { unwrap } from "@/utils/unwrap";
import { DateRange } from "./DateRangeTabs";
import { PanelLoadGate } from "./PanelLoadGate";
import PlayerSidebarCard, { type PlatformFilter, type TimeControlFilter } from "./PlayerSidebarCard";

type StatGroupBy = "phase" | "outcomeAccuracy" | "outcomeReason" | "intensity" | "weakness";
type TacticalFilter = "none" | "forks";
type WeaknessSignalsByColorPayload = {
  white?: ProfileWeaknessSignal[];
  black?: ProfileWeaknessSignal[];
};

type PhaseKey = "opening" | "middlegame" | "endgame";
const FORK_PIECES: ForkPiece[] = ["pawn", "knight", "bishop", "rook", "queen", "king"];

function createPgnFromNormalizedGame(game: NormalizedGame): string {
  const resultTag = game.result || "*";
  const movesText = (game.moves || "").trim();
  const hasResult = /(?:1-0|0-1|1\/2-1\/2|\*)$/.test(movesText);
  const movetext = movesText ? (hasResult ? movesText : `${movesText} ${resultTag}`) : resultTag;

  let pgn = `[Event "${game.event || "Online Game"}"]\n`;
  pgn += `[Site "${game.site || "Online"}"]\n`;
  pgn += `[Date "${game.date || "????.??.??"}"]\n`;
  if (game.round) {
    pgn += `[Round "${game.round}"]\n`;
  }
  pgn += `[White "${game.white || "White"}"]\n`;
  pgn += `[Black "${game.black || "Black"}"]\n`;
  pgn += `[Result "${resultTag}"]\n`;
  if (game.white_elo) {
    pgn += `[WhiteElo "${game.white_elo}"]\n`;
  }
  if (game.black_elo) {
    pgn += `[BlackElo "${game.black_elo}"]\n`;
  }
  if (game.time_control) {
    pgn += `[TimeControl "${game.time_control}"]\n`;
  }
  if (game.eco) {
    pgn += `[ECO "${game.eco}"]\n`;
  }
  pgn += "\n";
  pgn += movetext;
  return pgn;
}
function PhaseBar({ won, drawn, lost }: { won: number; drawn: number; lost: number }) {
  const total = won + drawn + lost;
  if (total <= 0) {
    return (
      <Progress.Root size="lg">
        <Progress.Section value={100} color="dark.4">
          <Progress.Label />
        </Progress.Section>
      </Progress.Root>
    );
  }

  return (
    <Progress.Root size="lg">
      <Progress.Section value={(won / total) * 100} color="green">
        <Progress.Label>{won / total >= 0.2 ? `${Math.round((won / total) * 100)}%` : undefined}</Progress.Label>
      </Progress.Section>
      <Progress.Section value={(drawn / total) * 100} color="gray">
        <Progress.Label>{drawn / total >= 0.2 ? `${Math.round((drawn / total) * 100)}%` : undefined}</Progress.Label>
      </Progress.Section>
      <Progress.Section value={(lost / total) * 100} color="red">
        <Progress.Label>{lost / total >= 0.2 ? `${Math.round((lost / total) * 100)}%` : undefined}</Progress.Label>
      </Progress.Section>
    </Progress.Root>
  );
}

function phaseLabel(t: (key: string, opts?: any) => string, phase: PhaseKey) {
  switch (phase) {
    case "opening":
      return t("common.opening", { defaultValue: "Opening" });
    case "middlegame":
      return t("common.middlegame", { defaultValue: "Middlegame" });
    case "endgame":
      return t("common.endgame", { defaultValue: "Endgame" });
  }
}

function formatAccuracy(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }
  return `${value.toFixed(1)}%`;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function formatSignedMetric(value: number | null, digits = 1): string {
  if (value == null || Number.isNaN(value)) {
    return "--";
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function normalizeWeaknessSignalKey(signalKey: string): string {
  return signalKey === "WM_MAROCCZY_10_15" ? "WM_MAROCZY_10_15" : signalKey;
}

function isColorAwareStructureSignal(signalKey: string): boolean {
  return (
    signalKey === "WM_MAROCZY_10_15" ||
    signalKey === "WM_VS_DRAGON_10_18" ||
    signalKey === "WM_IQP_12_30" ||
    signalKey === "WM_CARLSBAD_12_32" ||
    signalKey === "WM_HANGING_PAWNS_12_30" ||
    signalKey === "WM_STONEWALL_10_25" ||
    signalKey === "WM_VS_BENONI_10_25" ||
    signalKey === "WM_VS_ACCELERATED_DRAGON_8_16" ||
    signalKey === "WM_FRENCH_CHAIN_8_22" ||
    signalKey === "WM_KID_LOCKED_CENTER_10_25" ||
    signalKey === "WM_GRUNFELD_BROAD_CENTER_8_18"
  );
}

function weaknessSignalTitle(
  t: (key: string, opts?: any) => string,
  signal: ProfileWeaknessSignal,
  impact: Record<string, unknown>,
  trigger: Record<string, unknown>,
): string {
  const normalizedSignalKey = normalizeWeaknessSignalKey(signal.signalKey);
  const dominantColor =
    typeof trigger.dominantColor === "string" ? trigger.dominantColor.trim().toLowerCase() : "mixed";
  const colorKey = dominantColor === "white" || dominantColor === "black" ? dominantColor : "mixed";
  const keyByColor = `profiles.stats.weakness.signals.${normalizedSignalKey}.titleByColor.${colorKey}`;
  const key = `profiles.stats.weakness.signals.${normalizedSignalKey}.title`;
  if (signal.signalKey === "WM_FALLBACK_LOSS_CLUSTER") {
    const groupKey = typeof impact.groupKey === "string" ? impact.groupKey : "-";
    return t(key, { defaultValue: signal.title, groupKey });
  }
  if (isColorAwareStructureSignal(normalizedSignalKey)) {
    return t(keyByColor, { defaultValue: signal.title });
  }
  return t(key, { defaultValue: signal.title });
}

function weaknessSignalTriggerText(
  t: (key: string, opts?: any) => string,
  signal: ProfileWeaknessSignal,
  impact: Record<string, unknown>,
  trigger: Record<string, unknown>,
): string {
  const normalizedSignalKey = normalizeWeaknessSignalKey(signal.signalKey);
  const dominantColor =
    typeof trigger.dominantColor === "string" ? trigger.dominantColor.trim().toLowerCase() : "mixed";
  const colorKey = dominantColor === "white" || dominantColor === "black" ? dominantColor : "mixed";
  const keyByColor = `profiles.stats.weakness.signals.${normalizedSignalKey}.triggerByColor.${colorKey}`;
  const key = `profiles.stats.weakness.signals.${normalizedSignalKey}.trigger`;
  const deltaAcpl = asFiniteNumber(impact.deltaAcpl);
  const deltaLossRate = asFiniteNumber(impact.deltaLossRate);
  const deltaAccuracy = asFiniteNumber(impact.deltaAccuracy);
  const deltaBlunderRate = asFiniteNumber(impact.deltaBlunderRate);
  const deltaMistakeRate = asFiniteNumber(impact.deltaMistakeRate);
  const deltaInaccuracyRate = asFiniteNumber(impact.deltaInaccuracyRate);
  const groupKey = typeof impact.groupKey === "string" ? impact.groupKey : "-";

  const baseKey = isColorAwareStructureSignal(normalizedSignalKey) ? keyByColor : key;
  return t(baseKey, {
    defaultValue: signal.triggerText,
    groupKey,
    deltaAcpl: formatSignedMetric(deltaAcpl),
    deltaLossRate: formatSignedMetric(deltaLossRate),
    deltaAccuracy: formatSignedMetric(deltaAccuracy),
    deltaBlunderRate: formatSignedMetric(deltaBlunderRate),
    deltaMistakeRate: formatSignedMetric(deltaMistakeRate),
    deltaInaccuracyRate: formatSignedMetric(deltaInaccuracyRate),
  });
}

function weaknessSignalAttackPlan(
  t: (key: string, opts?: any) => string,
  signal: ProfileWeaknessSignal,
  trigger: Record<string, unknown>,
): string {
  const normalizedSignalKey = normalizeWeaknessSignalKey(signal.signalKey);
  const dominantColor =
    typeof trigger.dominantColor === "string" ? trigger.dominantColor.trim().toLowerCase() : "mixed";
  const colorKey = dominantColor === "white" || dominantColor === "black" ? dominantColor : "mixed";
  const keyByColor = `profiles.stats.weakness.signals.${normalizedSignalKey}.attackPlanByColor.${colorKey}`;
  const key = `profiles.stats.weakness.signals.${normalizedSignalKey}.attackPlan`;
  const baseKey = isColorAwareStructureSignal(normalizedSignalKey) ? keyByColor : key;
  return t(baseKey, { defaultValue: signal.attackPlan });
}

function weaknessOutcomeLabel(t: (key: string, opts?: any) => string, outcome: unknown): string {
  const normalized = typeof outcome === "string" ? outcome.trim().toLowerCase() : "unknown";
  if (normalized === "win" || normalized === "loss" || normalized === "draw") {
    return t(`profiles.stats.weakness.outcomes.${normalized}`, { defaultValue: normalized });
  }
  return t("profiles.stats.weakness.outcomes.unknown", { defaultValue: "unknown" });
}

function weaknessEvidenceText(
  t: (key: string, opts?: any) => string,
  signal: ProfileWeaknessSignal,
  ev: { evidenceText: string; evidenceJson: string; gameId?: number | null },
): string {
  const payload = parseJsonObject(ev.evidenceJson);
  const gameId =
    asFiniteNumber(payload.gameId) ??
    asFiniteNumber(ev.gameId) ??
    asFiniteNumber((payload as { game_id?: unknown }).game_id) ??
    null;
  const opponent =
    (typeof payload.opponentName === "string" && payload.opponentName.trim()) ||
    t("profiles.stats.weakness.unknownOpponent", { defaultValue: "unknown opponent" });
  const outcome = weaknessOutcomeLabel(t, payload.outcome);

  if (signal.signalKey === "WM_FALLBACK_LOSS_CLUSTER") {
    const groupKey = typeof payload.groupKey === "string" ? payload.groupKey : "-";
    return t("profiles.stats.weakness.signals.WM_FALLBACK_LOSS_CLUSTER.evidence", {
      defaultValue: ev.evidenceText,
      gameId: gameId == null ? "-" : Math.round(gameId),
      groupKey,
      outcome,
    });
  }

  const acpl = asFiniteNumber(payload.acpl);
  const accuracy = asFiniteNumber(payload.accuracy);
  return t("profiles.stats.weakness.genericEvidence", {
    defaultValue: ev.evidenceText,
    gameId: gameId == null ? "-" : Math.round(gameId),
    opponent,
    outcome,
    acpl: acpl == null ? "-" : acpl.toFixed(1),
    accuracy: accuracy == null ? "-" : accuracy.toFixed(1),
  });
}

function weaknessTimeControlLabel(t: (key: string, opts?: any) => string, value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "bullet") return t("TimeControl.Bullet", { defaultValue: "Bullet" });
  if (normalized === "blitz") return t("TimeControl.Blitz", { defaultValue: "Blitz" });
  if (normalized === "rapid") return t("TimeControl.Rapid", { defaultValue: "Rapid" });
  if (normalized === "classical") return t("TimeControl.Classical", { defaultValue: "Classical" });
  return value;
}

function weaknessContextLabel(t: (key: string, opts?: any) => string, raw: string): string {
  const [kind, value] = raw.split(":");
  if (!kind || !value) return raw;

  if (kind === "timeControl") {
    return t("profiles.stats.weakness.contextTypes.timeControl", {
      defaultValue: "Time control: {{value}}",
      value: weaknessTimeControlLabel(t, value),
    });
  }
  if (kind === "openingFamily") {
    return t("profiles.stats.weakness.contextTypes.openingFamily", {
      defaultValue: "Opening family: {{value}}",
      value,
    });
  }
  if (kind === "color") {
    const colorKey = value.trim().toLowerCase();
    const colorValue =
      colorKey === "white"
        ? t("profiles.stats.weakness.colors.white", { defaultValue: "White" })
        : colorKey === "black"
          ? t("profiles.stats.weakness.colors.black", { defaultValue: "Black" })
          : value;
    return t("profiles.stats.weakness.contextTypes.color", {
      defaultValue: "Color: {{value}}",
      value: colorValue,
    });
  }
  return raw;
}

type MainlineNode = { children: MainlineNode[] };

function mainlinePathFromPly(root: MainlineNode, ply: number): number[] {
  const path: number[] = [];
  let node: MainlineNode | undefined = root;
  const safePly = Math.max(0, Math.floor(ply));
  for (let i = 0; i < safePly; i++) {
    if (!node?.children?.length) break;
    path.push(0);
    node = node.children[0];
  }
  return path;
}

export default function StatsPanel({
  playerName,
  info,
  profileId,
  isLoading,
}: {
  playerName: string;
  info: PlayerGameInfo;
  profileId?: string;
  isLoading?: boolean;
}) {
  const { t } = useTranslation();
  const isStackedLayout = useMediaQuery(`(width < ${DEFAULT_THEME.breakpoints.md})`);
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [activeTab, setActiveTab] = useAtom(activeTabAtom);
  const [profileStatsUiStateByProfile, setProfileStatsUiStateByProfile] = useAtom(profileStatsUiStateByProfileAtom);
  const sessions = useAtomValue(sessionsAtom);

  const effectiveProfileId = useMemo(() => {
    const explicit = profileId?.trim();
    if (explicit) return explicit;
    const player = playerName.trim().toLowerCase();
    if (!player) return undefined;

    const sessionMatch = sessions.find((s) => {
      const identity = (s.player || s.lichess?.username || s.chessCom?.username || "").trim().toLowerCase();
      return identity === player && !!s.profileId?.trim();
    });
    return sessionMatch?.profileId?.trim() || undefined;
  }, [profileId, playerName, sessions]);

  const statsSig = useMemo(() => createSiteStatsSignature(info?.site_stats_data), [info?.site_stats_data]);

  const {
    data: profileSidebarStats,
    isLoading: isLoadingProfileSidebarStats,
    isFetching: isFetchingProfileSidebarStats,
  } = useQuery<ProfileSidebarStats | null>({
    queryKey: ["profileSidebarStats", effectiveProfileId ?? null],
    queryFn: async () => {
      if (!effectiveProfileId) return null;
      return unwrap(await playerStatsCommands.getProfileSidebarStats(effectiveProfileId));
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !!effectiveProfileId,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const { data: localEloBuckets = [] } = useQuery<EloBucket[]>({
    queryKey: ["playerEloBuckets", statsSig.key],
    queryFn: async () => unwrap(await playerStatsCommands.calculatePlayerEloBuckets(info?.site_stats_data ?? [])),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !effectiveProfileId && statsSig.games > 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const eloBuckets = profileSidebarStats?.elo_buckets ?? localEloBuckets;

  const opponentEloOptions = useMemo(() => {
    return [
      { value: "all", label: t("common.all", { defaultValue: "All" }) },
      ...eloBuckets.map((bucket) => ({ value: bucket.value, label: bucket.label })),
    ];
  }, [eloBuckets, t]);

  const persistedStatsUiState = effectiveProfileId
    ? (profileStatsUiStateByProfile[effectiveProfileId] ?? defaultProfileStatsUiState)
    : defaultProfileStatsUiState;
  const hydratedStatsProfileRef = useRef<string | null>(null);
  const [opponentEloBucket, setOpponentEloBucket] = useState<string>(persistedStatsUiState.opponentEloBucket);
  const [platform, setPlatform] = useState<PlatformFilter>(persistedStatsUiState.platform as PlatformFilter);
  const [timeControl, setTimeControl] = useState<TimeControlFilter>(
    persistedStatsUiState.timeControl as TimeControlFilter,
  );
  const [dateRange, setDateRange] = useState<DateRange | null>(
    (persistedStatsUiState.dateRange as DateRange | null) ?? DateRange.AllTime,
  );
  const [groupBy, setGroupBy] = useState<StatGroupBy>(persistedStatsUiState.groupBy as StatGroupBy);
  const [tacticalFilter, setTacticalFilter] = useState<TacticalFilter>(
    persistedStatsUiState.tacticalFilter as TacticalFilter,
  );
  const [detailsPhase, setDetailsPhase] = useState<PhaseKey | null>(null);
  const [detailsIntensity, setDetailsIntensity] = useState<IntensityKey | null>(null);
  const [detailsPage, setDetailsPage] = useState(1);
  const [forkDetailsPiece, setForkDetailsPiece] = useState<ForkPiece | null>(null);
  const [forkDetailsPage, setForkDetailsPage] = useState(1);
  const [isGeneratingForkPuzzles, setIsGeneratingForkPuzzles] = useState(false);
  const isWeaknessView = groupBy === "weakness";
  const isForksView = tacticalFilter === "forks" && !isWeaknessView;

  useEffect(() => {
    const profileKey = effectiveProfileId ?? null;
    if (hydratedStatsProfileRef.current === profileKey) return;
    hydratedStatsProfileRef.current = profileKey;

    const persisted = profileKey ? (profileStatsUiStateByProfile[profileKey] ?? defaultProfileStatsUiState) : null;
    if (!persisted) return;

    setPlatform(persisted.platform as PlatformFilter);
    setTimeControl(persisted.timeControl as TimeControlFilter);
    setOpponentEloBucket(persisted.opponentEloBucket);
    setDateRange((persisted.dateRange as DateRange | null) ?? DateRange.AllTime);
    setGroupBy(persisted.groupBy as StatGroupBy);
    setTacticalFilter(persisted.tacticalFilter as TacticalFilter);
    setDetailsPhase(null);
    setDetailsIntensity(null);
    setDetailsPage(1);
    setForkDetailsPiece(null);
    setForkDetailsPage(1);
  }, [effectiveProfileId, profileStatsUiStateByProfile]);

  useEffect(() => {
    if (!effectiveProfileId) return;
    const normalizedDateRange = (dateRange as DateRange | null) ?? null;

    setProfileStatsUiStateByProfile((prev) => {
      const current = prev[effectiveProfileId];
      const next = {
        platform,
        timeControl,
        opponentEloBucket,
        dateRange: normalizedDateRange,
        groupBy,
        tacticalFilter,
      };

      if (
        current?.platform === next.platform &&
        current?.timeControl === next.timeControl &&
        current?.opponentEloBucket === next.opponentEloBucket &&
        current?.dateRange === next.dateRange &&
        current?.groupBy === next.groupBy &&
        current?.tacticalFilter === next.tacticalFilter
      ) {
        return prev;
      }

      return {
        ...prev,
        [effectiveProfileId]: next,
      };
    });
  }, [
    dateRange,
    effectiveProfileId,
    groupBy,
    opponentEloBucket,
    platform,
    setProfileStatsUiStateByProfile,
    tacticalFilter,
    timeControl,
  ]);

  const { data: localSidebarModel } = useQuery({
    queryKey: ["playerSidebarModel", statsSig.key],
    queryFn: async () => unwrap(await playerStatsCommands.calculatePlayerSidebarModel(info?.site_stats_data ?? [])),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !effectiveProfileId && statsSig.games > 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const sidebarModel = profileSidebarStats?.sidebar_model ?? localSidebarModel;

  const filters = useMemo(
    () => createPlayerStatsFilters(platform, timeControl, opponentEloBucket, dateRange),
    [platform, timeControl, opponentEloBucket, dateRange],
  );

  const {
    data: buckets = [],
    isLoading: isLoadingBuckets,
    isFetching: isFetchingBuckets,
  } = useQuery<PhaseOutcomeBucket[]>({
    queryKey: [
      "profilePhaseStats",
      effectiveProfileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
      tacticalFilter,
    ],
    queryFn: async () => {
      if (!effectiveProfileId) return [];
      if (groupBy !== "phase") return [];
      return await getProfilePhaseOutcomes({ profileId: effectiveProfileId, filters });
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !!effectiveProfileId && statsSig.games > 0 && !isForksView && !isWeaknessView,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const {
    data: phaseAccuracy = [],
    isLoading: isLoadingPhaseAccuracy,
    isFetching: isFetchingPhaseAccuracy,
  } = useQuery<PhaseAccuracyBucket[]>({
    queryKey: [
      "profilePhaseAccuracy",
      effectiveProfileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
      groupBy,
    ],
    queryFn: async () => {
      if (!effectiveProfileId) return [];
      if (groupBy !== "phase") return [];
      return await getProfilePhaseAccuracy({ profileId: effectiveProfileId, filters });
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !!effectiveProfileId && statsSig.games > 0 && !isForksView && !isWeaknessView && groupBy === "phase",
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const {
    data: outcomeAccuracy,
    isLoading: isLoadingOutcomeAccuracy,
    isFetching: isFetchingOutcomeAccuracy,
  } = useQuery<OutcomeAccuracyStats | null>({
    queryKey: [
      "profileOutcomeAccuracy",
      effectiveProfileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
      groupBy,
    ],
    queryFn: async () => {
      if (!effectiveProfileId) return null;
      return await getProfileOutcomeAccuracy({ profileId: effectiveProfileId, filters });
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled:
      !!effectiveProfileId && statsSig.games > 0 && !isForksView && !isWeaknessView && groupBy === "outcomeAccuracy",
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const {
    data: forkStats,
    isLoading: isLoadingForkStats,
    isFetching: isFetchingForkStats,
  } = useQuery<ForkStats | null>({
    queryKey: [
      "profileForkStats",
      effectiveProfileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
      groupBy,
    ],
    queryFn: async () => {
      if (!effectiveProfileId) return null;
      return await getProfileForkStats({ profileId: effectiveProfileId, filters });
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !!effectiveProfileId && statsSig.games > 0 && isForksView,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const {
    data: weaknessModel,
    isLoading: isLoadingWeaknessModel,
    isFetching: isFetchingWeaknessModel,
    error: weaknessModelError,
  } = useQuery<ProfileWeaknessModel | null>({
    queryKey: [
      "profileWeaknessModel",
      effectiveProfileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
      groupBy,
    ],
    queryFn: async () => {
      if (!effectiveProfileId) return null;
      return await getProfileWeaknessModel({ profileId: effectiveProfileId, limit: 12, filters });
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !!effectiveProfileId && statsSig.games > 0 && isWeaknessView,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const {
    data: outcomeReasonBreakdown,
    isLoading: isLoadingOutcomeReasonBreakdown,
    isFetching: isFetchingOutcomeReasonBreakdown,
  } = useQuery<OutcomeReasonBreakdown | null>({
    queryKey: [
      "profileOutcomeReasonBreakdown",
      effectiveProfileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
      groupBy,
    ],
    queryFn: async () => {
      if (!effectiveProfileId) return null;
      return await getProfileOutcomeReasonBreakdown({ profileId: effectiveProfileId, filters });
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled:
      !!effectiveProfileId && statsSig.games > 0 && !isForksView && !isWeaknessView && groupBy === "outcomeReason",
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const {
    data: intensityBreakdown,
    isLoading: isLoadingIntensityBreakdown,
    isFetching: isFetchingIntensityBreakdown,
  } = useQuery<IntensityBreakdown | null>({
    queryKey: [
      "profileIntensityBreakdown",
      effectiveProfileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
      groupBy,
    ],
    queryFn: async () => {
      if (!effectiveProfileId) return null;
      return await getProfileIntensityBreakdown({ profileId: effectiveProfileId, filters });
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !!effectiveProfileId && statsSig.games > 0 && !isForksView && !isWeaknessView && groupBy === "intensity",
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const {
    data: intensityOutcomes = [],
    isLoading: isLoadingIntensityOutcomes,
    isFetching: isFetchingIntensityOutcomes,
  } = useQuery<IntensityOutcomeBucket[]>({
    queryKey: [
      "profileIntensityOutcomes",
      effectiveProfileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
      groupBy,
    ],
    queryFn: async () => {
      if (!effectiveProfileId) return [];
      return await getProfileIntensityOutcomes({ profileId: effectiveProfileId, filters });
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !!effectiveProfileId && statsSig.games > 0 && !isForksView && !isWeaknessView && groupBy === "intensity",
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const {
    data: intensityAccuracy = [],
    isLoading: isLoadingIntensityAccuracy,
    isFetching: isFetchingIntensityAccuracy,
  } = useQuery<IntensityAccuracyBucket[]>({
    queryKey: [
      "profileIntensityAccuracy",
      effectiveProfileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
      groupBy,
    ],
    queryFn: async () => {
      if (!effectiveProfileId) return [];
      return await getProfileIntensityAccuracy({ profileId: effectiveProfileId, filters });
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !!effectiveProfileId && statsSig.games > 0 && !isForksView && !isWeaknessView && groupBy === "intensity",
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const isAnyLoading =
    isLoading ||
    isLoadingProfileSidebarStats ||
    isFetchingProfileSidebarStats ||
    (isWeaknessView
      ? isLoadingWeaknessModel || isFetchingWeaknessModel
      : isForksView
        ? isLoadingForkStats || isFetchingForkStats
        : (groupBy === "phase" &&
            (isLoadingBuckets || isFetchingBuckets || isLoadingPhaseAccuracy || isFetchingPhaseAccuracy)) ||
          (groupBy === "outcomeAccuracy" && (isLoadingOutcomeAccuracy || isFetchingOutcomeAccuracy)) ||
          (groupBy === "outcomeReason" && (isLoadingOutcomeReasonBreakdown || isFetchingOutcomeReasonBreakdown)) ||
          (groupBy === "intensity" &&
            (isLoadingIntensityBreakdown ||
              isFetchingIntensityBreakdown ||
              isLoadingIntensityOutcomes ||
              isFetchingIntensityOutcomes ||
              isLoadingIntensityAccuracy ||
              isFetchingIntensityAccuracy)));
  const hasDataContext = !!info;
  const hasPanelData = isWeaknessView
    ? (weaknessModel?.signals.length ?? 0) > 0 || (weaknessModel?.totalGames ?? 0) > 0
    : isForksView
      ? true
      : groupBy === "phase"
        ? buckets.some((b) => (b.won ?? 0) + (b.drawn ?? 0) + (b.lost ?? 0) > 0)
        : groupBy === "outcomeAccuracy"
          ? (outcomeAccuracy?.wonCount ?? 0) + (outcomeAccuracy?.drawnCount ?? 0) + (outcomeAccuracy?.lostCount ?? 0) >
            0
          : groupBy === "outcomeReason"
            ? true
            : (intensityBreakdown?.calmCount ?? 0) +
                (intensityBreakdown?.balancedCount ?? 0) +
                (intensityBreakdown?.edgeCount ?? 0) +
                (intensityBreakdown?.intenseCount ?? 0) +
                (intensityBreakdown?.suddenCount ?? 0) +
                (intensityBreakdown?.wildCount ?? 0) +
                (intensityBreakdown?.giftedCount ?? 0) >
              0;

  const visiblePlatforms = platform === "all" ? (["Chess.com", "Lichess"] as const) : ([platform] as const);
  const groupByOptions = useMemo(() => {
    return [
      { value: "phase", label: t("profiles.stats.groupBy.phase", { defaultValue: "Game phase" }) },
      {
        value: "outcomeAccuracy",
        label: t("profiles.stats.groupBy.outcomeAccuracy", { defaultValue: "Average accuracy by result" }),
      },
      {
        value: "outcomeReason",
        label: t("profiles.stats.groupBy.outcomeReason", { defaultValue: "Win/Loss by ending type" }),
      },
      {
        value: "intensity",
        label: t("profiles.stats.groupBy.intensity", { defaultValue: "By intensity" }),
      },
      {
        value: "weakness",
        label: t("profiles.stats.groupBy.weakness", { defaultValue: "Weakness model" }),
      },
    ];
  }, [t]);

  const tacticalFilterOptions = useMemo(() => {
    return [
      { value: "none", label: t("profiles.stats.tactical.none", { defaultValue: "None" }) },
      { value: "forks", label: t("profiles.stats.tactical.forks", { defaultValue: "Forks / double attacks" }) },
    ];
  }, [t]);

  const phaseOrder: PhaseKey[] = ["opening", "middlegame", "endgame"];
  const byPhase = useMemo(() => {
    const map = new Map<PhaseKey, { won: number; drawn: number; lost: number }>();
    for (const phase of phaseOrder) {
      map.set(phase, { won: 0, drawn: 0, lost: 0 });
    }
    for (const b of buckets) {
      const p = (b.phase ?? "endgame") as PhaseKey;
      const cur = map.get(p) ?? { won: 0, drawn: 0, lost: 0 };
      map.set(p, {
        won: cur.won + (b.won ?? 0),
        drawn: cur.drawn + (b.drawn ?? 0),
        lost: cur.lost + (b.lost ?? 0),
      });
    }
    return map;
  }, [buckets, phaseOrder]);

  const totals = useMemo(() => {
    let won = 0;
    let drawn = 0;
    let lost = 0;
    for (const v of byPhase.values()) {
      won += v.won;
      drawn += v.drawn;
      lost += v.lost;
    }
    return { won, drawn, lost, total: won + drawn + lost };
  }, [byPhase]);
  const phaseAccuracyChartData = useMemo(() => {
    const byKey = new Map(phaseAccuracy.map((p) => [p.phase, p]));
    return (["opening", "middlegame", "endgame"] as const).map((phase) => {
      const row = byKey.get(phase);
      return {
        phase: phaseLabel(t, phase),
        avgAccuracy: row?.avgAccuracy ?? 0,
        count: row?.count ?? 0,
      };
    });
  }, [phaseAccuracy, t]);

  const detailsLimit = 50;
  const detailsOffset = (detailsPage - 1) * detailsLimit;
  const intensityLabelByKey = useMemo(
    (): Record<IntensityKey, string> => ({
      calm: t("profiles.stats.intensity.rows.calm", { defaultValue: "Calm" }),
      balanced: t("profiles.stats.intensity.rows.balanced", { defaultValue: "Balanced" }),
      edge: t("profiles.stats.intensity.rows.edge", { defaultValue: "On edge" }),
      intense: t("profiles.stats.intensity.rows.intense", { defaultValue: "Intense" }),
      sudden: t("profiles.stats.intensity.rows.sudden", { defaultValue: "Sudden" }),
      wild: t("profiles.stats.intensity.rows.wild", { defaultValue: "Wild" }),
      gifted: t("profiles.stats.intensity.rows.gifted", { defaultValue: "Gifted" }),
    }),
    [t],
  );
  const intensityKeyByLabel = useMemo(() => {
    return Object.fromEntries(
      Object.entries(intensityLabelByKey).map(([key, label]) => [label, key as IntensityKey]),
    ) as Record<string, IntensityKey>;
  }, [intensityLabelByKey]);
  const intensityChartData = useMemo(() => {
    return intensityOutcomes.map((row) => ({
      intensityKey: row.intensity,
      intensity: intensityLabelByKey[row.intensity] ?? row.intensity,
      won: row.won ?? 0,
      drawn: row.drawn ?? 0,
      lost: row.lost ?? 0,
    }));
  }, [intensityOutcomes, intensityLabelByKey]);
  const intensityAccuracyChartData = useMemo(() => {
    return intensityAccuracy.map((row) => ({
      intensity: intensityLabelByKey[row.intensity] ?? row.intensity,
      avgAccuracy: row.avgAccuracy ?? 0,
      count: row.count ?? 0,
    }));
  }, [intensityAccuracy, intensityLabelByKey]);

  const generateMissedForkPuzzles = async (piece: ForkPiece | "all") => {
    if (!effectiveProfileId || isGeneratingForkPuzzles) {
      return;
    }

    setIsGeneratingForkPuzzles(true);
    try {
      const result = await generateProfileMissedForkPuzzles({
        profileId: effectiveProfileId,
        filters,
        piece: piece === "all" ? null : piece,
      });

      if ((result.count ?? 0) <= 0 || !result.pgn?.trim()) {
        notifications.show({
          title: t("common.puzzle", { defaultValue: "Puzzle" }),
          message: t("profiles.stats.forks.puzzleGeneration.noPositions", {
            defaultValue: "No missed fork positions found for the selected scope.",
          }),
          color: "yellow",
        });
        return;
      }

      const documentDir = await getDocumentDir();
      const dayStamp = formatDateToPGN(new Date()) ?? "undated";
      const fileScope = piece === "all" ? "all" : piece;
      const filename = `missed-forks-${fileScope}-${dayStamp}-${Date.now()}`;
      const file = await createFile({
        filename,
        filetype: "puzzle",
        pgn: result.pgn,
        tags: ["forks", "missed-forks", piece === "all" ? "scope:all" : `piece:${piece}`],
        dir: documentDir,
      });

      if (file.isErr) {
        throw file.error;
      }

      try {
        window.dispatchEvent(new Event("puzzles:updated"));
      } catch {
        // no-op
      }

      notifications.show({
        title: t("common.save"),
        message: t("profiles.stats.forks.puzzleGeneration.success", {
          defaultValue: "{{count}} puzzles created from missed forks",
          count: result.count ?? 0,
        }),
        color: "green",
      });
    } catch {
      notifications.show({
        title: t("common.error"),
        message: t("profiles.stats.forks.puzzleGeneration.failed", {
          defaultValue: "Failed to generate puzzles from missed forks.",
        }),
        color: "red",
      });
    } finally {
      setIsGeneratingForkPuzzles(false);
    }
  };

  const {
    data: detailGames = [],
    isFetching: isFetchingDetails,
    isLoading: isLoadingDetails,
    error: detailsError,
  } = useQuery<PhaseGameRow[]>({
    queryKey: [
      "profilePhaseGames",
      effectiveProfileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
      detailsPhase ?? null,
      detailsPage,
    ],
    queryFn: async () => {
      if (!effectiveProfileId || !detailsPhase) return [];
      return await getProfilePhaseGames({
        profileId: effectiveProfileId,
        filters,
        phase: detailsPhase,
        limit: detailsLimit,
        offset: detailsOffset,
      });
    },
    enabled: !!effectiveProfileId && !!detailsPhase && statsSig.games > 0,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const {
    data: intensityDetailGames = [],
    isFetching: isFetchingIntensityDetails,
    isLoading: isLoadingIntensityDetails,
    error: intensityDetailsError,
  } = useQuery<IntensityGameRow[]>({
    queryKey: [
      "profileIntensityGames",
      effectiveProfileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
      detailsIntensity ?? null,
      detailsPage,
    ],
    queryFn: async () => {
      if (!effectiveProfileId || !detailsIntensity) return [];
      return await getProfileIntensityGames({
        profileId: effectiveProfileId,
        filters,
        intensity: detailsIntensity,
        limit: detailsLimit,
        offset: detailsOffset,
      });
    },
    enabled: !!effectiveProfileId && !!detailsIntensity && statsSig.games > 0,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const forkDetailsLimit = 50;
  const forkDetailsOffset = (forkDetailsPage - 1) * forkDetailsLimit;
  const {
    data: missedForkDetailGames = [],
    isFetching: isFetchingForkDetails,
    isLoading: isLoadingForkDetails,
    error: forkDetailsError,
  } = useQuery<MissedForkGameRow[]>({
    queryKey: [
      "profileMissedForkGames",
      effectiveProfileId ?? null,
      statsSig.key,
      filters.platform,
      filters.time_control,
      filters.opponent_elo_bucket,
      filters.date_range,
      forkDetailsPiece ?? null,
      forkDetailsPage,
    ],
    queryFn: async () => {
      if (!effectiveProfileId || !forkDetailsPiece) return [];
      return await getProfileMissedForkGames({
        profileId: effectiveProfileId,
        filters,
        piece: forkDetailsPiece,
        limit: forkDetailsLimit,
        offset: forkDetailsOffset,
      });
    },
    enabled: !!effectiveProfileId && !!forkDetailsPiece && statsSig.games > 0 && isForksView,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const activeDetailGames: Array<PhaseGameRow | IntensityGameRow> =
    groupBy === "intensity" ? intensityDetailGames : detailGames;
  const isLoadingActiveDetails = groupBy === "intensity" ? isLoadingIntensityDetails : isLoadingDetails;
  const isFetchingActiveDetails = groupBy === "intensity" ? isFetchingIntensityDetails : isFetchingDetails;
  const activeDetailsError = groupBy === "intensity" ? intensityDetailsError : detailsError;

  const hasNextPage = activeDetailGames.length === detailsLimit;
  const weaknessModelWithColorSplit = weaknessModel as
    | (ProfileWeaknessModel & { signalsByColor?: WeaknessSignalsByColorPayload })
    | null;
  const weaknessSignalsByColor = weaknessModelWithColorSplit?.signalsByColor;
  const weaknessSignalsWhite = Array.isArray(weaknessSignalsByColor?.white) ? weaknessSignalsByColor.white : [];
  const weaknessSignalsBlack = Array.isArray(weaknessSignalsByColor?.black) ? weaknessSignalsByColor.black : [];
  const hasColorSignalSplit = weaknessSignalsWhite.length > 0 || weaknessSignalsBlack.length > 0;
  const weaknessSignals = hasColorSignalSplit
    ? [...weaknessSignalsWhite, ...weaknessSignalsBlack].sort((a, b) => b.score - a.score)
    : (weaknessModel?.signals ?? []);
  const weaknessSignalSummaryCount = hasColorSignalSplit
    ? weaknessSignalsWhite.length + weaknessSignalsBlack.length
    : weaknessSignals.length;
  const weaknessBriefingSignals = weaknessSignals.slice(0, 3);
  const weaknessModelErrorMessage =
    weaknessModelError instanceof Error
      ? weaknessModelError.message
      : weaknessModelError
        ? String(weaknessModelError)
        : null;

  const openGame = async (gameId: number, ply?: number) => {
    if (!effectiveProfileId) return;

    try {
      const currentActiveTab = activeTab;
      const dbPath = await getProfileDbPath(effectiveProfileId);
      const game = unwrap(await commands.getGame(dbPath, gameId));
      const pgn = createPgnFromNormalizedGame(game);
      const tree = await parsePGN(pgn);
      const position = typeof ply === "number" ? mainlinePathFromPly(tree.root, ply) : undefined;

      await createTab({
        tab: {
          name: `${tree.headers?.white || "White"} - ${tree.headers?.black || "Black"}`,
          type: "analysis",
        },
        setTabs,
        setActiveTab,
        pgn,
        headers: tree.headers,
        position,
        autoActivate: false,
      });

      if (currentActiveTab) {
        requestAnimationFrame(() => setActiveTab(currentActiveTab));
      } else {
        const profilesTab = tabs.find((tab) => tab.type === "profiles");
        if (profilesTab) setActiveTab(profilesTab.value);
      }

      notifications.show({
        title: t("features.dashboard.gameOpened", { defaultValue: "Game opened" }),
        message: t("features.dashboard.gameOpenedMessage", { defaultValue: "Opened in a new tab." }),
        color: "green",
      });
    } catch (error) {
      console.error("Error opening game:", error);
      notifications.show({
        title: t("features.dashboard.error", { defaultValue: "Error" }),
        message: t("features.dashboard.errorOpeningGame", { defaultValue: "Error opening game." }),
        color: "red",
      });
    }
  };

  const renderWeaknessSignalCards = (signals: ProfileWeaknessSignal[], keyPrefix: string) => (
    <Stack gap="md">
      {signals.map((signal: ProfileWeaknessSignal) => {
        const impact = parseJsonObject(signal.impactJson);
        const trigger = parseJsonObject(signal.triggerJson);
        const deltaAcpl = asFiniteNumber(impact.deltaAcpl);
        const deltaLossRate = asFiniteNumber(impact.deltaLossRate);
        const deltaAccuracy = asFiniteNumber(impact.deltaAccuracy);
        const deltaBlunderRate = asFiniteNumber(impact.deltaBlunderRate);
        const deltaMistakeRate = asFiniteNumber(impact.deltaMistakeRate);
        const deltaInaccuracyRate = asFiniteNumber(impact.deltaInaccuracyRate);
        const deltaLossRateCiLow = asFiniteNumber(impact.deltaLossRateCiLow);
        const deltaLossRateCiHigh = asFiniteNumber(impact.deltaLossRateCiHigh);
        const deltaLossRateCi =
          deltaLossRateCiLow == null || deltaLossRateCiHigh == null
            ? "--"
            : `[${formatSignedMetric(deltaLossRateCiLow, 1)}, ${formatSignedMetric(deltaLossRateCiHigh, 1)}]`;
        const confidenceBand = typeof trigger.confidenceBand === "string" ? trigger.confidenceBand : null;
        const supportTier = typeof trigger.supportTier === "string" ? trigger.supportTier : null;
        const baselineMode = typeof impact.baselineMode === "string" ? impact.baselineMode : null;
        const trend =
          trigger.trend && typeof trigger.trend === "object" ? (trigger.trend as Record<string, unknown>) : null;
        const trendLabelRaw = typeof trend?.label === "string" ? String(trend?.label) : "insufficientData";
        const trendLabel = t(`profiles.stats.weakness.trendValues.${trendLabelRaw}`, {
          defaultValue: trendLabelRaw,
        });
        const trendRecentCount = asFiniteNumber(trend?.recentCount);
        const trendPreviousCount = asFiniteNumber(trend?.previousCount);
        const trendDeltaLossPp = asFiniteNumber(trend?.deltaLossRatePp);
        const trendDeltaAcpl = asFiniteNumber(trend?.deltaAcpl);
        const trendDetail = t("profiles.stats.weakness.trendDetail", {
          defaultValue: "Recent {{recent}} vs previous {{previous}}",
          recent: trendRecentCount == null ? "-" : Math.round(trendRecentCount),
          previous: trendPreviousCount == null ? "-" : Math.round(trendPreviousCount),
        });
        const trendDeltaDetail = t("profiles.stats.weakness.trendDeltaDetail", {
          defaultValue: "dLoss {{dloss}} pp, dACPL {{dacpl}}",
          dloss: trendDeltaLossPp == null ? "--" : formatSignedMetric(trendDeltaLossPp, 1),
          dacpl: trendDeltaAcpl == null ? "--" : formatSignedMetric(trendDeltaAcpl, 1),
        });
        const contextsTop = Array.isArray(trigger.contextsTop)
          ? trigger.contextsTop.filter((ctx): ctx is { key: string; count: number } => {
              if (!ctx || typeof ctx !== "object") return false;
              const key = (ctx as { key?: unknown }).key;
              const count = (ctx as { count?: unknown }).count;
              return typeof key === "string" && typeof count === "number" && Number.isFinite(count);
            })
          : [];
        const opponentsTop = Array.isArray(trigger.opponentsTop)
          ? trigger.opponentsTop.filter((opp): opp is { name: string; count: number } => {
              if (!opp || typeof opp !== "object") return false;
              const name = (opp as { name?: unknown }).name;
              const count = (opp as { count?: unknown }).count;
              return typeof name === "string" && typeof count === "number" && Number.isFinite(count);
            })
          : [];
        const contextText = contextsTop
          .slice(0, 3)
          .map((ctx) => `${weaknessContextLabel(t, ctx.key)} (${ctx.count})`)
          .join(", ");
        const opponentText = opponentsTop
          .slice(0, 3)
          .map((opp) => `${opp.name} (${opp.count})`)
          .join(", ");

        return (
          <Box
            key={`${keyPrefix}-${signal.signalKey}`}
            style={{
              border: "1px solid var(--mantine-color-dark-4)",
              borderRadius: 8,
              padding: "12px",
            }}
          >
            <Stack gap={8}>
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Box style={{ minWidth: 0 }}>
                  <Text fw={700}>{weaknessSignalTitle(t, signal, impact, trigger)}</Text>
                  <Text size="sm" c="dimmed">
                    {weaknessSignalTriggerText(t, signal, impact, trigger)}
                  </Text>
                </Box>
                <Text fw={700} c="blue.4">
                  {t("profiles.stats.weakness.score", {
                    defaultValue: "Score {{score}}",
                    score: signal.score.toFixed(1),
                  })}
                </Text>
              </Group>

              <Group gap="md" wrap="wrap">
                <Text size="xs">
                  {t("profiles.stats.weakness.support", {
                    defaultValue: "Support: {{count}}",
                    count: signal.support,
                  })}
                </Text>
                <Text size="xs">
                  {t("profiles.stats.weakness.confidence", {
                    defaultValue: "Confidence: {{value}}%",
                    value: Math.round(signal.confidence * 100),
                  })}
                </Text>
                <Text size="xs">
                  {t("profiles.stats.weakness.severity", {
                    defaultValue: "Severity: {{value}}%",
                    value: Math.round(signal.severity * 100),
                  })}
                </Text>
                <Text size="xs">
                  {t("profiles.stats.weakness.controllability", {
                    defaultValue: "Controllability: {{value}}%",
                    value: Math.round(signal.controllability * 100),
                  })}
                </Text>
                <Text size="xs">
                  {t("profiles.stats.weakness.recency", {
                    defaultValue: "Recency: {{value}}%",
                    value: Math.round(signal.recency * 100),
                  })}
                </Text>
                <Text size="xs">
                  {t("profiles.stats.weakness.confidenceBand", {
                    defaultValue: "Confidence band: {{value}}",
                    value: confidenceBand
                      ? t(`profiles.stats.weakness.bands.${confidenceBand}`, {
                          defaultValue: confidenceBand,
                        })
                      : "--",
                  })}
                </Text>
                <Text size="xs">
                  {t("profiles.stats.weakness.supportTier", {
                    defaultValue: "Support tier: {{value}}",
                    value: supportTier
                      ? t(`profiles.stats.weakness.supportTiers.${supportTier}`, {
                          defaultValue: supportTier,
                        })
                      : "--",
                  })}
                </Text>
                <Text size="xs">
                  {t("profiles.stats.weakness.baseline", {
                    defaultValue: "Baseline: {{value}}",
                    value: baselineMode
                      ? t(`profiles.stats.weakness.baselineModes.${baselineMode}`, {
                          defaultValue: baselineMode,
                        })
                      : "--",
                  })}
                </Text>
                <Text size="xs">
                  {t("profiles.stats.weakness.trend", {
                    defaultValue: "Trend: {{value}}",
                    value: trendLabel,
                  })}
                </Text>
                <Text size="xs" c="dimmed">
                  {trendDetail} | {trendDeltaDetail}
                </Text>
              </Group>

              <Group gap="md" wrap="wrap">
                <Text size="xs" c="orange.3">
                  {t("profiles.stats.weakness.deltaAcpl", {
                    defaultValue: "Delta ACPL: {{value}}",
                    value: deltaAcpl == null ? "--" : `${deltaAcpl > 0 ? "+" : ""}${deltaAcpl.toFixed(1)}`,
                  })}
                </Text>
                <Text size="xs" c="red.3">
                  {t("profiles.stats.weakness.deltaLossRate", {
                    defaultValue: "Delta loss rate: {{value}} pp",
                    value: deltaLossRate == null ? "--" : `${deltaLossRate > 0 ? "+" : ""}${deltaLossRate.toFixed(1)}`,
                  })}
                </Text>
                <Text size="xs" c="red.2">
                  {t("profiles.stats.weakness.deltaLossRateCi", {
                    defaultValue: "Delta loss CI (95%): {{value}} pp",
                    value: deltaLossRateCi,
                  })}
                </Text>
                <Text size="xs" c="yellow.3">
                  {t("profiles.stats.weakness.deltaAccuracy", {
                    defaultValue: "Delta accuracy: {{value}}%",
                    value: deltaAccuracy == null ? "--" : `${deltaAccuracy > 0 ? "+" : ""}${deltaAccuracy.toFixed(1)}`,
                  })}
                </Text>
                <Text size="xs" c="pink.3">
                  {t("profiles.stats.weakness.deltaBlunderRate", {
                    defaultValue: "Delta blunder rate: {{value}} pp",
                    value:
                      deltaBlunderRate == null
                        ? "--"
                        : `${deltaBlunderRate > 0 ? "+" : ""}${deltaBlunderRate.toFixed(1)}`,
                  })}
                </Text>
                <Text size="xs" c="violet.3">
                  {t("profiles.stats.weakness.deltaMistakeRate", {
                    defaultValue: "Delta mistake rate: {{value}} pp",
                    value:
                      deltaMistakeRate == null
                        ? "--"
                        : `${deltaMistakeRate > 0 ? "+" : ""}${deltaMistakeRate.toFixed(1)}`,
                  })}
                </Text>
                <Text size="xs" c="teal.3">
                  {t("profiles.stats.weakness.deltaInaccuracyRate", {
                    defaultValue: "Delta inaccuracy rate: {{value}} pp",
                    value:
                      deltaInaccuracyRate == null
                        ? "--"
                        : `${deltaInaccuracyRate > 0 ? "+" : ""}${deltaInaccuracyRate.toFixed(1)}`,
                  })}
                </Text>
              </Group>

              {contextText ? (
                <Text size="xs" c="dimmed">
                  {t("profiles.stats.weakness.contexts", {
                    defaultValue: "Best contexts: {{contexts}}",
                    contexts: contextText,
                  })}
                </Text>
              ) : null}
              {opponentText ? (
                <Text size="xs" c="dimmed">
                  {t("profiles.stats.weakness.opponents", {
                    defaultValue: "Rivals exploiting this pattern: {{opponents}}",
                    opponents: opponentText,
                  })}
                </Text>
              ) : null}

              <Text size="sm">
                <Text span fw={600}>
                  {t("profiles.stats.weakness.attackPlan", { defaultValue: "Attack plan: " })}
                </Text>
                {weaknessSignalAttackPlan(t, signal, trigger)}
              </Text>

              {signal.evidence.length > 0 ? (
                <Stack gap={4}>
                  <Text size="xs" fw={600}>
                    {t("profiles.stats.weakness.evidence", { defaultValue: "Evidence" })}
                  </Text>
                  {signal.evidence.slice(0, 3).map((ev) => (
                    <Text key={`${keyPrefix}-${signal.signalKey}-${ev.evidenceRank}`} size="xs" c="dimmed">
                      - {weaknessEvidenceText(t, signal, ev)}
                    </Text>
                  ))}
                </Stack>
              ) : null}
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );

  return (
    <Flex
      h="100%"
      align="stretch"
      direction={isStackedLayout ? "column" : "row"}
      gap="md"
      style={{ minHeight: 0, minWidth: 0, width: "100%" }}
      data-testid="stats-panel"
    >
      {/* LEFT */}
      <Box
        style={{
          flex: isStackedLayout ? "0 0 auto" : "0 0 25%",
          width: isStackedLayout ? "100%" : undefined,
          minWidth: isStackedLayout ? 0 : 280,
          minHeight: 0,
        }}
      >
        <PlayerSidebarCard
          playerName={playerName}
          model={sidebarModel ?? null}
          visiblePlatforms={[...visiblePlatforms]}
          platform={platform}
          onPlatformChange={setPlatform}
          timeControl={timeControl}
          onTimeControlChange={setTimeControl}
          opponentEloOptions={opponentEloOptions}
          opponentEloBucket={opponentEloBucket}
          onOpponentEloChange={setOpponentEloBucket}
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          isLoading={isAnyLoading}
          extraFilters={
            <Stack gap="xs">
              <Select
                label={t("profiles.stats.groupBy.label", { defaultValue: "Group by" })}
                data={groupByOptions}
                value={groupBy}
                onChange={(v) => setGroupBy((v as StatGroupBy) || "phase")}
                clearable={false}
                size="xs"
              />
              <Select
                label={t("profiles.stats.tactical.label", { defaultValue: "Tactical filter" })}
                data={tacticalFilterOptions}
                value={tacticalFilter}
                onChange={(v) => setTacticalFilter((v as TacticalFilter) || "none")}
                clearable={false}
                size="xs"
              />
            </Stack>
          }
        />
      </Box>

      {/* RIGHT */}
      <Box
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          width: "100%",
        }}
      >
        <Box style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", width: "100%" }}>
          <PanelLoadGate
            isLoading={isAnyLoading}
            isFetching={
              isWeaknessView
                ? isFetchingWeaknessModel
                : isForksView
                  ? isFetchingForkStats
                  : groupBy === "phase"
                    ? isFetchingBuckets || isFetchingPhaseAccuracy
                    : groupBy === "outcomeAccuracy"
                      ? isFetchingOutcomeAccuracy
                      : groupBy === "outcomeReason"
                        ? isFetchingOutcomeReasonBreakdown
                        : isFetchingIntensityBreakdown
            }
            hasData={hasDataContext && hasPanelData}
            message={t("profiles.stats.loading", { defaultValue: "Loading stats..." })}
          >
            <Stack p="md" gap="md">
              {groupBy === "phase" ? (
                <>
                  <Stack gap={4}>
                    <Text fw={700}>{t("profiles.stats.title", { defaultValue: "Wins / losses by game phase" })}</Text>
                    <Text size="sm" c="dimmed">
                      {t("profiles.stats.subtitle", {
                        defaultValue: "Shows where games became decisively won or lost, based on analyzed games only.",
                      })}
                    </Text>
                  </Stack>

                  {totals.total > 0 ? (
                    <Group gap="md" wrap="wrap">
                      <Text size="sm">
                        {t("profiles.stats.summary", {
                          defaultValue: "{{total}} analyzed games ({{won}}W {{drawn}}D {{lost}}L)",
                          total: totals.total,
                          won: totals.won,
                          drawn: totals.drawn,
                          lost: totals.lost,
                        })}
                      </Text>
                    </Group>
                  ) : (
                    <Text size="sm" c="dimmed">
                      {t("profiles.stats.noData", {
                        defaultValue: "No analyzed games found for the selected filters.",
                      })}
                    </Text>
                  )}

                  <Divider />

                  <Stack gap="sm">
                    {phaseOrder.map((phase) => {
                      const v = byPhase.get(phase)!;
                      const total = v.won + v.drawn + v.lost;
                      return (
                        <UnstyledButton
                          key={phase}
                          onClick={() => {
                            setDetailsPhase(phase);
                            setDetailsIntensity(null);
                            setDetailsPage(1);
                          }}
                          style={{ display: "block", textAlign: "left" }}
                        >
                          <Stack gap={6}>
                            <Group justify="space-between" wrap="nowrap">
                              <Text fw={600}>{phaseLabel(t, phase)}</Text>
                              <Text size="sm" c="dimmed">
                                {total > 0
                                  ? t("profiles.stats.phaseCount", {
                                      defaultValue: "{{total}} games",
                                      total,
                                    })
                                  : t("profiles.stats.phaseCount", { defaultValue: "0 games", total: 0 })}
                              </Text>
                            </Group>
                            <PhaseBar won={v.won} drawn={v.drawn} lost={v.lost} />
                            <Text size="xs" c="dimmed">
                              {t("profiles.stats.phaseBreakdown", {
                                defaultValue: "{{won}}W - {{drawn}}D - {{lost}}L",
                                won: v.won,
                                drawn: v.drawn,
                                lost: v.lost,
                              })}
                            </Text>
                          </Stack>
                        </UnstyledButton>
                      );
                    })}
                  </Stack>

                  <Divider />

                  <Stack gap={6}>
                    <Text fw={700} size="sm">
                      {t("profiles.stats.phaseAccuracyChart.title", {
                        defaultValue: "Average accuracy by game phase",
                      })}
                    </Text>
                    <ChartSizeGuard height={320}>
                      <BarChart
                        h={320}
                        data={phaseAccuracyChartData}
                        dataKey="phase"
                        gridAxis="y"
                        valueFormatter={(value) => `${Number(value).toFixed(1)}%`}
                        yAxisProps={{ domain: [0, 100] }}
                        series={[
                          {
                            name: "avgAccuracy",
                            label: t("profiles.stats.phaseAccuracyChart.series", {
                              defaultValue: "Average accuracy",
                            }),
                            color: "cyan.6",
                          },
                        ]}
                      />
                    </ChartSizeGuard>
                  </Stack>
                </>
              ) : groupBy === "outcomeAccuracy" ? (
                <>
                  <Stack gap={4}>
                    <Text fw={700}>
                      {t("profiles.stats.accuracyByResult.title", { defaultValue: "Average accuracy by result" })}
                    </Text>
                    <Text size="sm" c="dimmed">
                      {t("profiles.stats.accuracyByResult.subtitle", {
                        defaultValue: "Average engine accuracy split by wins, draws, and losses.",
                      })}
                    </Text>
                  </Stack>

                  <Divider />

                  <Stack gap="xs">
                    <Group justify="space-between" wrap="nowrap">
                      <Text fw={600}>{t("profiles.stats.accuracyByResult.rows.won", { defaultValue: "Won" })}</Text>
                      <Group gap="sm">
                        <Text size="sm" c="dimmed">
                          {t("profiles.stats.phaseCount", {
                            defaultValue: "{{total}} games",
                            total: outcomeAccuracy?.wonCount ?? 0,
                          })}
                        </Text>
                        <Text fw={700}>{formatAccuracy(outcomeAccuracy?.wonAvgAccuracy)}</Text>
                      </Group>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text fw={600}>{t("profiles.stats.accuracyByResult.rows.drawn", { defaultValue: "Drawn" })}</Text>
                      <Group gap="sm">
                        <Text size="sm" c="dimmed">
                          {t("profiles.stats.phaseCount", {
                            defaultValue: "{{total}} games",
                            total: outcomeAccuracy?.drawnCount ?? 0,
                          })}
                        </Text>
                        <Text fw={700}>{formatAccuracy(outcomeAccuracy?.drawnAvgAccuracy)}</Text>
                      </Group>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text fw={600}>{t("profiles.stats.accuracyByResult.rows.lost", { defaultValue: "Lost" })}</Text>
                      <Group gap="sm">
                        <Text size="sm" c="dimmed">
                          {t("profiles.stats.phaseCount", {
                            defaultValue: "{{total}} games",
                            total: outcomeAccuracy?.lostCount ?? 0,
                          })}
                        </Text>
                        <Text fw={700}>{formatAccuracy(outcomeAccuracy?.lostAvgAccuracy)}</Text>
                      </Group>
                    </Group>
                  </Stack>
                </>
              ) : groupBy === "weakness" ? (
                <>
                  <Stack gap={4}>
                    <Text fw={700}>{t("profiles.stats.weakness.title", { defaultValue: "Weakness model" })}</Text>
                    <Text size="sm" c="dimmed">
                      {t("profiles.stats.weakness.subtitle", {
                        defaultValue: "Ranks strategic weaknesses from analyzed games to guide practical game plans.",
                      })}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t("profiles.stats.weakness.scopeNote", {
                        defaultValue:
                          "This model uses the current platform, time control, opponent Elo, and date filters.",
                      })}
                    </Text>
                  </Stack>

                  <Divider />

                  {!effectiveProfileId ? (
                    <Text size="sm" c="red">
                      {t("profiles.stats.weakness.missingProfileId", {
                        defaultValue: "Cannot load weakness model: missing profile id for this player context.",
                      })}
                    </Text>
                  ) : null}

                  {weaknessModelErrorMessage ? (
                    <Text size="sm" c="red">
                      {t("profiles.stats.weakness.queryError", {
                        defaultValue: "Weakness model query failed: {{message}}",
                        message: weaknessModelErrorMessage,
                      })}
                    </Text>
                  ) : null}

                  <Group gap="md" wrap="wrap">
                    <Text size="sm">
                      {t("profiles.stats.weakness.summary", {
                        defaultValue:
                          "{{signals}} signals from {{scored}} scored games ({{total}} total, {{backfilled}} backfilled).",
                        signals: weaknessSignalSummaryCount,
                        scored: weaknessModel?.scoredGames ?? 0,
                        total: weaknessModel?.totalGames ?? 0,
                        backfilled: weaknessModel?.backfilledGames ?? 0,
                      })}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t("profiles.stats.weakness.generatedAt", {
                        defaultValue: "Generated at {{date}}",
                        date: weaknessModel?.generatedAt ?? "-",
                      })}
                    </Text>
                  </Group>

                  {weaknessBriefingSignals.length > 0 ? (
                    <Stack gap={4}>
                      <Text size="sm" fw={600}>
                        {t("profiles.stats.weakness.briefingTitle", {
                          defaultValue: "Exploit briefing",
                        })}
                      </Text>
                      {weaknessBriefingSignals.map((signal, idx) => (
                        <Text key={`brief-${idx}-${signal.signalKey}`} size="sm" c="dimmed">
                          {idx + 1}.{" "}
                          {weaknessSignalTriggerText(
                            t,
                            signal,
                            parseJsonObject(signal.impactJson),
                            parseJsonObject(signal.triggerJson),
                          )}
                        </Text>
                      ))}
                    </Stack>
                  ) : null}

                  {weaknessSignalSummaryCount === 0 ? (
                    <Text size="sm" c="dimmed">
                      {t("profiles.stats.weakness.noData", {
                        defaultValue: "No weakness signals reached minimum support yet.",
                      })}
                    </Text>
                  ) : hasColorSignalSplit ? (
                    <Stack gap="md">
                      <Stack gap="xs">
                        <Group justify="space-between" wrap="nowrap">
                          <Text fw={700}>
                            {t("profiles.stats.weakness.groups.whiteTitle", {
                              defaultValue: "White signals",
                            })}
                          </Text>
                          <Text size="sm" c="dimmed">
                            {weaknessSignalsWhite.length}
                          </Text>
                        </Group>
                        {weaknessSignalsWhite.length > 0 ? (
                          renderWeaknessSignalCards(weaknessSignalsWhite, "white")
                        ) : (
                          <Text size="sm" c="dimmed">
                            {t("profiles.stats.weakness.groups.noSignals", {
                              defaultValue: "No signals for this color with current filters.",
                            })}
                          </Text>
                        )}
                      </Stack>
                      <Stack gap="xs">
                        <Group justify="space-between" wrap="nowrap">
                          <Text fw={700}>
                            {t("profiles.stats.weakness.groups.blackTitle", {
                              defaultValue: "Black signals",
                            })}
                          </Text>
                          <Text size="sm" c="dimmed">
                            {weaknessSignalsBlack.length}
                          </Text>
                        </Group>
                        {weaknessSignalsBlack.length > 0 ? (
                          renderWeaknessSignalCards(weaknessSignalsBlack, "black")
                        ) : (
                          <Text size="sm" c="dimmed">
                            {t("profiles.stats.weakness.groups.noSignals", {
                              defaultValue: "No signals for this color with current filters.",
                            })}
                          </Text>
                        )}
                      </Stack>
                    </Stack>
                  ) : (
                    renderWeaknessSignalCards(weaknessSignals, "all")
                  )}
                </>
              ) : isForksView ? (
                <>
                  <Stack gap={4}>
                    <Text fw={700}>{t("profiles.stats.forks.title", { defaultValue: "Forks / double attacks" })}</Text>
                    <Text size="sm" c="dimmed">
                      {t("profiles.stats.forks.subtitle", {
                        defaultValue: "Detected from analyzed games: found, missed, and allowed forks.",
                      })}
                    </Text>
                  </Stack>

                  <Divider />

                  <Group justify="space-between" wrap="nowrap">
                    <Text fw={600}>{t("profiles.stats.forks.foundVsMissed.found", { defaultValue: "Found" })}</Text>
                    <Text fw={700}>{forkStats?.foundCount ?? 0}</Text>
                  </Group>
                  <Group justify="space-between" wrap="nowrap">
                    <Text fw={600}>
                      {t("profiles.stats.forks.foundVsMissed.missed", { defaultValue: "Not found" })}
                    </Text>
                    <Group gap="xs" wrap="nowrap">
                      <Text fw={700}>{forkStats?.missedCount ?? 0}</Text>
                      <Menu withinPortal position="bottom-end">
                        <Menu.Target>
                          <Button
                            size="compact-sm"
                            variant="subtle"
                            loading={isGeneratingForkPuzzles}
                            disabled={(forkStats?.missedCount ?? 0) <= 0}
                          >
                            {t("profiles.stats.forks.puzzleGeneration.button", {
                              defaultValue: "Generate puzzles",
                            })}
                          </Button>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item
                            onClick={() => {
                              void generateMissedForkPuzzles("all");
                            }}
                          >
                            {t("profiles.stats.forks.puzzleGeneration.all", {
                              defaultValue: "Generate all",
                            })}
                          </Menu.Item>
                          <Menu.Divider />
                          {FORK_PIECES.map((piece) => (
                            <Menu.Item
                              key={piece}
                              onClick={() => {
                                void generateMissedForkPuzzles(piece);
                              }}
                            >
                              {t("profiles.stats.forks.puzzleGeneration.byPiece", {
                                defaultValue: "Generate by {{piece}}",
                                piece: t(`profiles.stats.forks.pieces.${piece}`, { defaultValue: piece }),
                              })}
                            </Menu.Item>
                          ))}
                        </Menu.Dropdown>
                      </Menu>
                    </Group>
                  </Group>

                  <Divider />

                  <Stack gap="xs">
                    <Text fw={700} size="sm">
                      {t("profiles.stats.forks.foundByPiece", { defaultValue: "Found by piece" })}
                    </Text>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.forks.pieces.pawn", { defaultValue: "Pawn" })}</Text>
                      <Text fw={600}>{forkStats?.foundPawnCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.forks.pieces.knight", { defaultValue: "Knight" })}</Text>
                      <Text fw={600}>{forkStats?.foundKnightCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.forks.pieces.bishop", { defaultValue: "Bishop" })}</Text>
                      <Text fw={600}>{forkStats?.foundBishopCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.forks.pieces.rook", { defaultValue: "Rook" })}</Text>
                      <Text fw={600}>{forkStats?.foundRookCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.forks.pieces.queen", { defaultValue: "Queen" })}</Text>
                      <Text fw={600}>{forkStats?.foundQueenCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.forks.pieces.king", { defaultValue: "King" })}</Text>
                      <Text fw={600}>{forkStats?.foundKingCount ?? 0}</Text>
                    </Group>
                  </Stack>

                  <Divider />

                  <Stack gap="xs">
                    <Text fw={700} size="sm">
                      {t("profiles.stats.forks.missedByPiece", { defaultValue: "Not found by piece" })}
                    </Text>
                    {[
                      { piece: "pawn" as const, count: forkStats?.missedPawnCount ?? 0 },
                      { piece: "knight" as const, count: forkStats?.missedKnightCount ?? 0 },
                      { piece: "bishop" as const, count: forkStats?.missedBishopCount ?? 0 },
                      { piece: "rook" as const, count: forkStats?.missedRookCount ?? 0 },
                      { piece: "queen" as const, count: forkStats?.missedQueenCount ?? 0 },
                      { piece: "king" as const, count: forkStats?.missedKingCount ?? 0 },
                    ].map(({ piece, count }) => (
                      <UnstyledButton
                        key={piece}
                        disabled={count <= 0}
                        onClick={() => {
                          if (count <= 0) return;
                          setForkDetailsPiece(piece);
                          setForkDetailsPage(1);
                        }}
                      >
                        <Group justify="space-between" wrap="nowrap">
                          <Text>{t(`profiles.stats.forks.pieces.${piece}`, { defaultValue: piece })}</Text>
                          <Text fw={600}>{count}</Text>
                        </Group>
                      </UnstyledButton>
                    ))}
                  </Stack>

                  <Divider />

                  <Stack gap="xs">
                    <Text fw={700} size="sm">
                      {t("profiles.stats.forks.allowedByPiece", { defaultValue: "Allowed forks by piece" })}
                    </Text>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.forks.pieces.pawn", { defaultValue: "Pawn" })}</Text>
                      <Text fw={600}>{forkStats?.allowedPawnCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.forks.pieces.knight", { defaultValue: "Knight" })}</Text>
                      <Text fw={600}>{forkStats?.allowedKnightCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.forks.pieces.bishop", { defaultValue: "Bishop" })}</Text>
                      <Text fw={600}>{forkStats?.allowedBishopCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.forks.pieces.rook", { defaultValue: "Rook" })}</Text>
                      <Text fw={600}>{forkStats?.allowedRookCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.forks.pieces.queen", { defaultValue: "Queen" })}</Text>
                      <Text fw={600}>{forkStats?.allowedQueenCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.forks.pieces.king", { defaultValue: "King" })}</Text>
                      <Text fw={600}>{forkStats?.allowedKingCount ?? 0}</Text>
                    </Group>
                  </Stack>
                </>
              ) : groupBy === "outcomeReason" ? (
                <>
                  <Stack gap={4}>
                    <Text fw={700}>
                      {t("profiles.stats.outcomeReason.title", { defaultValue: "Win/Loss by ending type" })}
                    </Text>
                    <Text size="sm" c="dimmed">
                      {t("profiles.stats.outcomeReason.subtitle", {
                        defaultValue: "Breakdown of game results by how the game ended.",
                      })}
                    </Text>
                  </Stack>

                  <Divider />

                  <Stack gap="xs">
                    <Text fw={700} size="sm">
                      {t("profiles.stats.outcomeReason.winsTitle", { defaultValue: "Wins" })}
                    </Text>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.outcomeReason.rows.abandon", { defaultValue: "Abandon" })}</Text>
                      <Text fw={600}>{outcomeReasonBreakdown?.wonAbandonCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.outcomeReason.rows.checkmate", { defaultValue: "Checkmate" })}</Text>
                      <Text fw={600}>{outcomeReasonBreakdown?.wonCheckmateCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.outcomeReason.rows.timeout", { defaultValue: "Time out" })}</Text>
                      <Text fw={600}>{outcomeReasonBreakdown?.wonTimeoutCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>
                        {t("profiles.stats.outcomeReason.rows.resignForfeit", {
                          defaultValue: "Resign / inactivity / forfeit",
                        })}
                      </Text>
                      <Text fw={600}>{outcomeReasonBreakdown?.wonResignForfeitCount ?? 0}</Text>
                    </Group>
                  </Stack>

                  <Divider />

                  <Stack gap="xs">
                    <Text fw={700} size="sm">
                      {t("profiles.stats.outcomeReason.lossesTitle", { defaultValue: "Losses" })}
                    </Text>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.outcomeReason.rows.abandon", { defaultValue: "Abandon" })}</Text>
                      <Text fw={600}>{outcomeReasonBreakdown?.lostAbandonCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.outcomeReason.rows.checkmate", { defaultValue: "Checkmate" })}</Text>
                      <Text fw={600}>{outcomeReasonBreakdown?.lostCheckmateCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.outcomeReason.rows.timeout", { defaultValue: "Time out" })}</Text>
                      <Text fw={600}>{outcomeReasonBreakdown?.lostTimeoutCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>
                        {t("profiles.stats.outcomeReason.rows.resignForfeit", {
                          defaultValue: "Resign / inactivity / forfeit",
                        })}
                      </Text>
                      <Text fw={600}>{outcomeReasonBreakdown?.lostResignForfeitCount ?? 0}</Text>
                    </Group>
                  </Stack>

                  <Divider />

                  <Stack gap="xs">
                    <Text fw={700} size="sm">
                      {t("profiles.stats.outcomeReason.drawsTitle", { defaultValue: "Draws" })}
                    </Text>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.outcomeReason.rows.agreement", { defaultValue: "Agreement" })}</Text>
                      <Text fw={600}>{outcomeReasonBreakdown?.drawnAgreementCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>
                        {t("profiles.stats.outcomeReason.rows.fiftyMoveRule", {
                          defaultValue: "50-move rule",
                        })}
                      </Text>
                      <Text fw={600}>{outcomeReasonBreakdown?.drawnFiftyMoveRuleCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>
                        {t("profiles.stats.outcomeReason.rows.timeoutVsInsufficientMaterial", {
                          defaultValue: "Timeout vs insufficient material",
                        })}
                      </Text>
                      <Text fw={600}>{outcomeReasonBreakdown?.drawnTimeoutVsInsufficientMaterialCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>
                        {t("profiles.stats.outcomeReason.rows.insufficientMaterial", {
                          defaultValue: "Insufficient material",
                        })}
                      </Text>
                      <Text fw={600}>{outcomeReasonBreakdown?.drawnInsufficientMaterialCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.outcomeReason.rows.repetition", { defaultValue: "Repetition" })}</Text>
                      <Text fw={600}>{outcomeReasonBreakdown?.drawnRepetitionCount ?? 0}</Text>
                    </Group>
                    <Group justify="space-between" wrap="nowrap">
                      <Text>{t("profiles.stats.outcomeReason.rows.stalemate", { defaultValue: "Stalemate" })}</Text>
                      <Text fw={600}>{outcomeReasonBreakdown?.drawnStalemateCount ?? 0}</Text>
                    </Group>
                  </Stack>
                </>
              ) : (
                <>
                  <Stack gap={4}>
                    <Text fw={700}>{t("profiles.stats.intensity.title", { defaultValue: "By intensity" })}</Text>
                    <Text size="sm" c="dimmed">
                      {t("profiles.stats.intensity.subtitle", {
                        defaultValue: "Classifies analyzed games by graph tension and swing patterns.",
                      })}
                    </Text>
                  </Stack>

                  <Divider />

                  <Stack gap="xs">
                    <UnstyledButton
                      onClick={() => {
                        setDetailsIntensity("calm");
                        setDetailsPhase(null);
                        setDetailsPage(1);
                      }}
                    >
                      <Group justify="space-between" wrap="nowrap">
                        <Text>{t("profiles.stats.intensity.rows.calm", { defaultValue: "Calm" })}</Text>
                        <Text fw={600}>{intensityBreakdown?.calmCount ?? 0}</Text>
                      </Group>
                    </UnstyledButton>
                    <UnstyledButton
                      onClick={() => {
                        setDetailsIntensity("balanced");
                        setDetailsPhase(null);
                        setDetailsPage(1);
                      }}
                    >
                      <Group justify="space-between" wrap="nowrap">
                        <Text>{t("profiles.stats.intensity.rows.balanced", { defaultValue: "Balanced" })}</Text>
                        <Text fw={600}>{intensityBreakdown?.balancedCount ?? 0}</Text>
                      </Group>
                    </UnstyledButton>
                    <UnstyledButton
                      onClick={() => {
                        setDetailsIntensity("edge");
                        setDetailsPhase(null);
                        setDetailsPage(1);
                      }}
                    >
                      <Group justify="space-between" wrap="nowrap">
                        <Text>{t("profiles.stats.intensity.rows.edge", { defaultValue: "On edge" })}</Text>
                        <Text fw={600}>{intensityBreakdown?.edgeCount ?? 0}</Text>
                      </Group>
                    </UnstyledButton>
                    <UnstyledButton
                      onClick={() => {
                        setDetailsIntensity("intense");
                        setDetailsPhase(null);
                        setDetailsPage(1);
                      }}
                    >
                      <Group justify="space-between" wrap="nowrap">
                        <Text>{t("profiles.stats.intensity.rows.intense", { defaultValue: "Intense" })}</Text>
                        <Text fw={600}>{intensityBreakdown?.intenseCount ?? 0}</Text>
                      </Group>
                    </UnstyledButton>
                    <UnstyledButton
                      onClick={() => {
                        setDetailsIntensity("sudden");
                        setDetailsPhase(null);
                        setDetailsPage(1);
                      }}
                    >
                      <Group justify="space-between" wrap="nowrap">
                        <Text>{t("profiles.stats.intensity.rows.sudden", { defaultValue: "Sudden" })}</Text>
                        <Text fw={600}>{intensityBreakdown?.suddenCount ?? 0}</Text>
                      </Group>
                    </UnstyledButton>
                    <UnstyledButton
                      onClick={() => {
                        setDetailsIntensity("wild");
                        setDetailsPhase(null);
                        setDetailsPage(1);
                      }}
                    >
                      <Group justify="space-between" wrap="nowrap">
                        <Text>{t("profiles.stats.intensity.rows.wild", { defaultValue: "Wild" })}</Text>
                        <Text fw={600}>{intensityBreakdown?.wildCount ?? 0}</Text>
                      </Group>
                    </UnstyledButton>
                    <UnstyledButton
                      onClick={() => {
                        setDetailsIntensity("gifted");
                        setDetailsPhase(null);
                        setDetailsPage(1);
                      }}
                    >
                      <Group justify="space-between" wrap="nowrap">
                        <Text>{t("profiles.stats.intensity.rows.gifted", { defaultValue: "Gifted" })}</Text>
                        <Text fw={600}>{intensityBreakdown?.giftedCount ?? 0}</Text>
                      </Group>
                    </UnstyledButton>
                  </Stack>

                  <Divider />

                  <Stack gap={6}>
                    <Text fw={700} size="sm">
                      {t("profiles.stats.intensity.chartTitle", {
                        defaultValue: "Intensity split by result (W/D/L)",
                      })}
                    </Text>
                    <ChartSizeGuard height={390}>
                      <BarChart
                        h={390}
                        data={intensityChartData}
                        dataKey="intensity"
                        type="stacked"
                        withLegend
                        gridAxis="y"
                        barChartProps={{
                          onClick: (event) => {
                            const activeLabel = `${(event as { activeLabel?: string } | null)?.activeLabel ?? ""}`;
                            const key = intensityKeyByLabel[activeLabel];
                            if (key) {
                              setDetailsIntensity(key);
                              setDetailsPhase(null);
                              setDetailsPage(1);
                            }
                          },
                        }}
                        series={[
                          {
                            name: "won",
                            label: t("profiles.stats.accuracyByResult.rows.won", { defaultValue: "Won" }),
                            color: "green.6",
                          },
                          {
                            name: "drawn",
                            label: t("profiles.stats.accuracyByResult.rows.drawn", { defaultValue: "Drawn" }),
                            color: "gray.6",
                          },
                          {
                            name: "lost",
                            label: t("profiles.stats.accuracyByResult.rows.lost", { defaultValue: "Lost" }),
                            color: "red.6",
                          },
                        ]}
                      />
                    </ChartSizeGuard>
                  </Stack>

                  <Divider />

                  <Stack gap={6}>
                    <Text fw={700} size="sm">
                      {t("profiles.stats.intensity.accuracyChartTitle", {
                        defaultValue: "Average accuracy by intensity",
                      })}
                    </Text>
                    <ChartSizeGuard height={360}>
                      <BarChart
                        h={360}
                        data={intensityAccuracyChartData}
                        dataKey="intensity"
                        gridAxis="y"
                        valueFormatter={(value) => `${Number(value).toFixed(1)}%`}
                        yAxisProps={{ domain: [0, 100] }}
                        series={[
                          {
                            name: "avgAccuracy",
                            label: t("profiles.stats.accuracyByResult.title", {
                              defaultValue: "Average accuracy by result",
                            }),
                            color: "blue.6",
                          },
                        ]}
                      />
                    </ChartSizeGuard>
                  </Stack>
                </>
              )}
            </Stack>
          </PanelLoadGate>
        </Box>
      </Box>

      <Modal
        opened={(groupBy === "phase" && detailsPhase != null) || (groupBy === "intensity" && detailsIntensity != null)}
        onClose={() => {
          setDetailsPhase(null);
          setDetailsIntensity(null);
        }}
        title={t("profiles.stats.details.title", { defaultValue: "Games" })}
        size="xl"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t("profiles.stats.details.subtitle", {
              defaultValue: "Showing games for {{phase}}.",
              phase:
                groupBy === "intensity"
                  ? detailsIntensity
                    ? intensityLabelByKey[detailsIntensity]
                    : ""
                  : detailsPhase
                    ? phaseLabel(t, detailsPhase)
                    : "",
            })}
          </Text>

          {activeDetailsError ? (
            <Text size="sm" c="red">
              {t("profiles.stats.details.error", { defaultValue: "Failed to load games." })}
            </Text>
          ) : null}

          <PanelLoadGate
            isLoading={isLoadingActiveDetails}
            isFetching={isFetchingActiveDetails}
            hasData={groupBy === "intensity" ? detailsIntensity != null : detailsPhase != null}
            message={t("profiles.stats.details.loading", { defaultValue: "Loading games..." })}
          >
            {activeDetailGames.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t("profiles.stats.details.noData", { defaultValue: "No games found." })}
              </Text>
            ) : (
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("profiles.stats.details.columns.date", { defaultValue: "Date" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.white", { defaultValue: "White" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.black", { defaultValue: "Black" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.result", { defaultValue: "Result" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.site", { defaultValue: "Site" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.action", { defaultValue: "Action" })}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {activeDetailGames.map((g) => (
                    <Table.Tr key={g.gameId}>
                      <Table.Td>{g.date ?? "-"}</Table.Td>
                      <Table.Td>{g.white}</Table.Td>
                      <Table.Td>{g.black}</Table.Td>
                      <Table.Td>{g.result ?? "-"}</Table.Td>
                      <Table.Td>{g.site}</Table.Td>
                      <Table.Td>
                        <Button size="xs" variant="light" onClick={() => openGame(g.gameId)}>
                          {t("features.dashboard.openGame", { defaultValue: "Open Game" })}
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </PanelLoadGate>

          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {t("profiles.stats.details.page", { defaultValue: "Page {{page}}", page: detailsPage })}
            </Text>
            <Group>
              <Button
                size="xs"
                variant="default"
                disabled={detailsPage <= 1}
                onClick={() => setDetailsPage((p) => Math.max(1, p - 1))}
              >
                {t("common.previous", { defaultValue: "Previous" })}
              </Button>
              <Button size="xs" variant="default" disabled={!hasNextPage} onClick={() => setDetailsPage((p) => p + 1)}>
                {t("common.next", { defaultValue: "Next" })}
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={isForksView && forkDetailsPiece != null}
        onClose={() => setForkDetailsPiece(null)}
        title={t("profiles.stats.forks.details.title", {
          defaultValue: "Missed forks - {{piece}}",
          piece: forkDetailsPiece ? t(`profiles.stats.forks.pieces.${forkDetailsPiece}`) : "",
        })}
        size="xl"
      >
        <Stack gap="sm">
          {forkDetailsError ? (
            <Text size="sm" c="red">
              {t("profiles.stats.details.error", { defaultValue: "Failed to load games." })}
            </Text>
          ) : null}

          <PanelLoadGate
            isLoading={isLoadingForkDetails}
            isFetching={isFetchingForkDetails}
            hasData={isForksView && forkDetailsPiece != null}
            message={t("profiles.stats.details.loading", { defaultValue: "Loading games..." })}
          >
            {missedForkDetailGames.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t("profiles.stats.details.noData", { defaultValue: "No games found." })}
              </Text>
            ) : (
              <Table striped highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("profiles.stats.details.columns.date", { defaultValue: "Date" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.white", { defaultValue: "White" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.black", { defaultValue: "Black" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.result", { defaultValue: "Result" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.site", { defaultValue: "Site" })}</Table.Th>
                    <Table.Th>{t("profiles.stats.forks.details.ply", { defaultValue: "Ply" })}</Table.Th>
                    <Table.Th>
                      {t("profiles.stats.forks.details.engineComment", { defaultValue: "Engine comment" })}
                    </Table.Th>
                    <Table.Th>{t("profiles.stats.details.columns.action", { defaultValue: "Action" })}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {missedForkDetailGames.map((g, idx) => (
                    <Table.Tr key={`${g.gameId}-${g.ply}-${idx}`}>
                      <Table.Td>{g.date ?? "-"}</Table.Td>
                      <Table.Td>{g.white}</Table.Td>
                      <Table.Td>{g.black}</Table.Td>
                      <Table.Td>{g.result ?? "-"}</Table.Td>
                      <Table.Td>{g.site}</Table.Td>
                      <Table.Td>{g.ply}</Table.Td>
                      <Table.Td style={{ minWidth: 320 }}>
                        <Text size="xs" c="dimmed">
                          {g.engineLineComment ??
                            t("profiles.stats.forks.details.engineCommentUnavailable", {
                              defaultValue: "Engine line not available for this row.",
                            })}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Button size="xs" variant="light" onClick={() => openGame(g.gameId, g.ply)}>
                          {t("profiles.stats.forks.details.openAtPosition", { defaultValue: "Open at position" })}
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </PanelLoadGate>

          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {t("profiles.stats.details.page", { defaultValue: "Page {{page}}", page: forkDetailsPage })}
            </Text>
            <Group>
              <Button
                size="xs"
                variant="default"
                disabled={forkDetailsPage <= 1}
                onClick={() => setForkDetailsPage((p) => Math.max(1, p - 1))}
              >
                {t("common.previous", { defaultValue: "Previous" })}
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={missedForkDetailGames.length < forkDetailsLimit}
                onClick={() => setForkDetailsPage((p) => p + 1)}
              >
                {t("common.next", { defaultValue: "Next" })}
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>
    </Flex>
  );
}
