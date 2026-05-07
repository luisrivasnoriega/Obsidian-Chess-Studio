import {
  Box,
  Button,
  Card,
  Center,
  Grid,
  Group,
  Loader,
  LoadingOverlay,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconChartBar,
  IconChess,
  IconFlame,
  IconRefresh,
  IconStar,
  IconTargetArrow,
  IconTrophy,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { appDataDir, resolve } from "@tauri-apps/api/path";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Event, GameQuery, GamesHistoryRow, MoveAnalysis } from "@/bindings";
import { commands, type GoMode } from "@/bindings";
import { detectProfileBookReview } from "@/features/boards/utils/postGameReview";
import { activeProfileIdAtom, activeTabAtom, enginesAtom, profilesAtom, sessionsAtom, tabsAtom } from "@/state/atoms";
import { addAnalysis } from "@/state/store/tree";
import { getAccountKey, stripAccountKey } from "@/utils/accountKeys";
import { getAnalyzedGamesBulk, getGameStatsBulk, saveAnalyzedGame, saveGameStats } from "@/utils/analyzedGames";
import { applyProfileBookPriorityToMainline, clearBookErrorAnnotations } from "@/utils/bookErrors";
import { getGameStats, getMainLine, getPGN, parsePGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { query_games, query_players } from "@/utils/db";
import { calculateEstimatedElo } from "@/utils/eloEstimation";
import type { LocalEngine } from "@/utils/engines";
import {
  type FavoriteGame,
  getAllFavoriteGames,
  isFavoriteGame,
  removeFavoriteGame,
  saveFavoriteGame,
} from "@/utils/favoriteGames";
import { fetchFidePlayer } from "@/utils/fide";
import {
  deleteGameRecord,
  type GameRecord,
  type GameStats,
  getRecentGames,
  updateGameRecord,
} from "@/utils/gameRecords";
import { finishPerfBaselineSpan, perfBaselinePoint, startPerfBaselineSpan } from "@/utils/perfBaseline";
import { getProfileDbPath } from "@/utils/profileDb";
import { saveProfileGameAnalysisStats } from "@/utils/profileGameAnalysisStats";
import { syncSessionGamesToProfileDb } from "@/utils/profileGameSync";
import { areLastActivityMapsEqual, loadProfilesLastActivityMap } from "@/utils/profileLastActivity";
import { getPuzzleStats, type PuzzleStats } from "@/utils/puzzleStreak";
import type { Session } from "@/utils/session";
import { createTab, genID, type Tab } from "@/utils/tabs";
import { createNode, defaultTree, type TreeState } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";
import { AnalyzeAllModal } from "./components/AnalyzeAllModal";
import { GamesHistoryCard } from "./components/GamesHistoryCard";
import { PuzzleStatsCard } from "./components/PuzzleStatsCard";
import { PuzzleVariantsCard } from "./components/PuzzleVariantsCard";
import { UserProfileCard } from "./components/UserProfileCard";
import { WelcomeCard } from "./components/WelcomeCard";
import type { ChessComGameWithEvent, DashboardLichessGame, TimeControlCategory } from "./types";
import { calculateOnlineRating } from "./utils/calculateOnlineRating";
import { getChessTitle } from "./utils/chessTitle";
import {
  convertNormalizedToChessComGame,
  convertNormalizedToLichessGame,
  createChessComGameHeaders,
  createLichessGameHeaders,
  createLocalGameHeaders,
  createPGNFromMoves,
  hasEnoughMovesInPgn,
} from "./utils/gameHelpers";

const DEFAULT_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const KPI_SAMPLE_SIZE = 100;
const KPI_FETCH_LIMIT = 5000;
const QUALITY_TREND_WEEKS = 4;
const DEFAULT_PUZZLE_STATS: PuzzleStats = {
  currentStreak: 0,
  target: 30,
  history: [],
};

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function normalizePuzzleStats(raw: unknown): PuzzleStats {
  if (!raw || typeof raw !== "object") return DEFAULT_PUZZLE_STATS;
  const candidate = raw as {
    currentStreak?: unknown;
    streak?: unknown;
    target?: unknown;
    history?: unknown;
  };
  const currentStreakSource =
    typeof candidate.currentStreak === "number"
      ? candidate.currentStreak
      : typeof candidate.streak === "number"
        ? candidate.streak
        : 0;
  const currentStreak = Number.isFinite(currentStreakSource) ? Math.max(0, currentStreakSource) : 0;
  const targetSource =
    typeof candidate.target === "number" && Number.isFinite(candidate.target) ? candidate.target : 30;
  const target = Math.max(1, targetSource);
  const history = Array.isArray(candidate.history)
    ? candidate.history
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const row = entry as { day?: unknown; solved?: unknown };
          const day = typeof row.day === "string" ? row.day : "";
          const solved = typeof row.solved === "number" && Number.isFinite(row.solved) ? row.solved : 0;
          return { day, solved };
        })
        .filter((entry): entry is { day: string; solved: number } => entry !== null)
    : [];
  return {
    currentStreak,
    target,
    history,
  };
}

type DashboardOverviewMetrics = {
  weekStartMs: number;
  weekEndMs: number;
  weekGamesCount: number;
  weekWins: number;
  weekLosses: number;
  weekDraws: number;
  weekOutcomeCount: number;
  weekWinRate: number;
  previousWeekGamesCount: number;
  previousWeekWins: number;
  previousWeekLosses: number;
  previousWeekDraws: number;
  previousWeekOutcomeCount: number;
  previousWeekWinRate: number;
  sampleGamesCount: number;
  sampleSize: number;
  sampleAvgEstimatedElo: number | null;
  weekAvgEstimatedElo: number | null;
  previousWeekAvgEstimatedElo: number | null;
  weekBlunderRate: number | null;
  previousWeekBlunderRate: number | null;
  blunderDeltaPp: number | null;
  weekBrilliantRate: number | null;
  previousWeekBrilliantRate: number | null;
  brilliantDeltaPp: number | null;
  weekMistakeRate: number | null;
  previousWeekMistakeRate: number | null;
  mistakeDeltaPp: number | null;
  weekInaccuracyRate: number | null;
  previousWeekInaccuracyRate: number | null;
  inaccuracyDeltaPp: number | null;
  weekAccuracy: number | null;
  previousWeekAccuracy: number | null;
  accuracyDelta: number | null;
  weekAcpl: number | null;
  previousWeekAcpl: number | null;
  acplDelta: number | null;
  weekAnalyzedGames: number;
  previousWeekAnalyzedGames: number;
  blunderRateTrend: Array<number | null>;
  weekAcplByTimeControl: {
    classical: number | null;
    rapid: number | null;
    blitz: number | null;
    bullet: number | null;
  };
  weekAccuracyByColor: {
    white: number | null;
    black: number | null;
  };
  puzzleVariantsColorCoverage: {
    whitePuzzles: number;
    blackPuzzles: number;
    totalPuzzles: number;
    whitePercent: number;
    blackPercent: number;
  };
};

type DashboardQualityInsights = {
  weekBlunderRate: number | null;
  previousWeekBlunderRate: number | null;
  blunderDeltaPp: number | null;
  weekBrilliantRate: number | null;
  previousWeekBrilliantRate: number | null;
  brilliantDeltaPp: number | null;
  weekMistakeRate: number | null;
  previousWeekMistakeRate: number | null;
  mistakeDeltaPp: number | null;
  weekInaccuracyRate: number | null;
  previousWeekInaccuracyRate: number | null;
  inaccuracyDeltaPp: number | null;
  weekAccuracy: number | null;
  previousWeekAccuracy: number | null;
  accuracyDelta: number | null;
  weekAcpl: number | null;
  previousWeekAcpl: number | null;
  acplDelta: number | null;
  weekAnalyzedGames: number;
  previousWeekAnalyzedGames: number;
  blunderRateTrend: Array<number | null>;
};

type DashboardRatingKey = "classical" | "rapid" | "blitz" | "bullet";

type DashboardRatingSource = "lichess" | "chesscom" | "fide";

type DashboardRatingHistory = {
  classical?: number;
  rapid?: number;
  blitz?: number;
  bullet?: number;
};

type DashboardRatingSourceMeta = {
  source: DashboardRatingSource;
  games: number;
  username?: string;
};

const DEFAULT_QUALITY_INSIGHTS: DashboardQualityInsights = {
  weekBlunderRate: null,
  previousWeekBlunderRate: null,
  blunderDeltaPp: null,
  weekBrilliantRate: null,
  previousWeekBrilliantRate: null,
  brilliantDeltaPp: null,
  weekMistakeRate: null,
  previousWeekMistakeRate: null,
  mistakeDeltaPp: null,
  weekInaccuracyRate: null,
  previousWeekInaccuracyRate: null,
  inaccuracyDeltaPp: null,
  weekAccuracy: null,
  previousWeekAccuracy: null,
  accuracyDelta: null,
  weekAcpl: null,
  previousWeekAcpl: null,
  acplDelta: null,
  weekAnalyzedGames: 0,
  previousWeekAnalyzedGames: 0,
  blunderRateTrend: Array.from({ length: QUALITY_TREND_WEEKS }, () => null),
};
type AnalyzeAllType = "local" | "chesscom" | "lichess" | "chessbase" | "all";
type AnalyzeAllOpenPayload = {
  type: AnalyzeAllType;
  opponentContains: string | null;
  resultFilter: string | null;
  playerColor: "white" | "black" | null;
  minMoves: number | null;
};
type AnalyzeAllScopeFilters = {
  opponentContains: string | null;
  resultFilter: string | null;
  playerColor: "white" | "black" | null;
  minMoves: number | null;
};

type DashboardAnalyzeAllBackendJob = {
  jobId: string;
  fen: string | null;
  moves: string[] | null;
  pgn: string | null;
};

type DashboardAnalyzeAllResultPayload = {
  runId: string;
  jobId: string;
  index: number;
  total: number;
  success: boolean;
  analysis: MoveAnalysis[] | null;
  error: string | null;
  cancelled: boolean;
};

function hasCoreAnalysisStats(row: Pick<GamesHistoryRow, "accuracy" | "acpl">): boolean {
  return (
    typeof row.accuracy === "number" &&
    Number.isFinite(row.accuracy) &&
    row.accuracy > 0 &&
    typeof row.acpl === "number" &&
    Number.isFinite(row.acpl) &&
    row.acpl > 0
  );
}

function isRowReadyForAnalyzeSkip(row: Pick<GamesHistoryRow, "isAnalyzed" | "accuracy" | "acpl">): boolean {
  return !!row.isAnalyzed && hasCoreAnalysisStats(row);
}

function normalizePgnElo(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.round(raw);
}

function _hasPgnHeaders(pgn?: string | null): boolean {
  if (!pgn) return false;
  return /\[[A-Za-z0-9_]+\s+"[^"]*"\]/.test(pgn);
}

function buildTreeFromUciMoves(initialFen: string, moves: string[]): TreeState | null {
  const fen = initialFen?.trim() || DEFAULT_START_FEN;
  const [pos, err] = positionFromFen(fen);
  if (!pos || err) return null;

  const tree = defaultTree(fen);
  let node = tree.root;

  for (const rawMove of moves) {
    const uci = rawMove.trim();
    if (!uci) continue;
    const move = parseUci(uci);
    if (!move) return null;

    const san = makeSan(pos, move);
    pos.play(move);

    const child = createNode({
      fen: makeFen(pos.toSetup()),
      move,
      san,
      halfMoves: node.halfMoves + 1,
    });
    node.children.push(child);
    node = child;
  }

  tree.position = [];
  return tree;
}

function getOpponentRatingFromTree(tree: TreeState, userColor: "white" | "black"): number | null {
  const headers = tree.headers;
  const elo = userColor === "white" ? headers.black_elo : headers.white_elo;
  return normalizePgnElo(elo);
}

function buildStatsPayloadForBackend(
  reportStats: ReturnType<typeof getGameStats>,
  userColor: "white" | "black",
  tree: TreeState,
): GameStats | null {
  const accuracy = userColor === "white" ? reportStats.whiteAccuracy : reportStats.blackAccuracy;
  const acpl = userColor === "white" ? reportStats.whiteCPL : reportStats.blackCPL;
  if (!(accuracy > 0 || acpl > 0)) return null;

  const playerEstimatedElo = acpl > 0 ? calculateEstimatedElo(acpl) : null;
  const opponentAcpl = userColor === "white" ? reportStats.blackCPL : reportStats.whiteCPL;
  const opponentEstimatedElo = opponentAcpl > 0 ? calculateEstimatedElo(opponentAcpl) : null;
  const opponentRatingElo = getOpponentRatingFromTree(tree, userColor);

  return {
    accuracy,
    acpl,
    ...(playerEstimatedElo != null ? { estimatedElo: playerEstimatedElo } : {}),
    ...(opponentEstimatedElo != null ? { opponentEstimatedElo } : {}),
    ...(opponentRatingElo != null ? { opponentRatingElo } : {}),
  };
}

export default function DashboardPage() {
  const [isFirstOpen, setIsFirstOpen] = useState(false);
  useEffect(() => {
    const key = "obsidian-chess-studio.firstOpen";

    const hasSeen = localStorage.getItem(key);
    if (!hasSeen) {
      localStorage.setItem(key, "true");
      setIsFirstOpen(true);
    } else {
      setIsFirstOpen(false);
    }
  }, []);
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [_tabs, setTabs] = useAtom(tabsAtom);
  const [_activeTab, setActiveTab] = useAtom(activeTabAtom);

  const [sessions, setSessions] = useAtom(sessionsAtom);
  const [profiles, setProfiles] = useAtom(profilesAtom);
  const [activeProfileId, setActiveProfileId] = useAtom(activeProfileIdAtom);
  const [lastActivityMap, setLastActivityMap] = useState<Map<string, number | null>>(new Map());
  const [isProfileSyncing, setIsProfileSyncing] = useState(false);

  // Load last activity dates for all profiles
  useEffect(() => {
    let cancelled = false;
    const loadLastActivities = async () => {
      const activityMap = await loadProfilesLastActivityMap({
        profileIds: profiles.map((profile) => profile.id),
        sessions,
      });

      if (!cancelled) {
        setLastActivityMap((prev) => (areLastActivityMapsEqual(prev, activityMap) ? prev : activityMap));
      }
    };

    void loadLastActivities();
    return () => {
      cancelled = true;
    };
  }, [profiles, sessions]);

  const sortedProfiles = useMemo(() => {
    const list = [...profiles];
    list.sort((a, b) => {
      const aDate = lastActivityMap.get(a.id) ?? null;
      const bDate = lastActivityMap.get(b.id) ?? null;

      // When sorting by lastActivity, nulls always go to the end
      if (aDate === null && bDate === null) {
        // If both are null, sort by name
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      }
      if (aDate === null) return 1; // a goes to end
      if (bDate === null) return -1; // b goes to end

      // Both have dates, compare them (most recent first)
      return bDate - aDate;
    });
    return list;
  }, [profiles, lastActivityMap]);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) ?? null,
    [profiles, activeProfileId],
  );

  const sessionMeta = useCallback((session: Session) => {
    if (session.lichess?.username) return { platform: "lichess" as const, username: session.lichess.username };
    if (session.chessCom?.username) return { platform: "chesscom" as const, username: session.chessCom.username };
    return { platform: "unknown" as const, username: "-" };
  }, []);

  const upsertSession = useCallback(
    (session: Session) => {
      setSessions((prev) => {
        const nextMeta = sessionMeta(session);
        const nextKey = `${session.profileId ?? ""}:${nextMeta.platform}:${nextMeta.username}`;
        const filtered = prev.filter((existing) => {
          const meta = sessionMeta(existing);
          const key = `${existing.profileId ?? ""}:${meta.platform}:${meta.username}`;
          return key !== nextKey;
        });
        return [...filtered, { ...session, updatedAt: session.updatedAt ?? Date.now() }];
      });
    },
    [sessionMeta, setSessions],
  );

  const syncActiveProfileInPlace = useCallback(async () => {
    if (isProfileSyncing) {
      notifications.show({
        title: t("common.warning", { defaultValue: "Warning" }),
        message: t("profiles.sync.inProgress", { defaultValue: "A profile update is already running." }),
        color: "yellow",
        autoClose: 3000,
      });
      return;
    }

    if (!activeProfile) {
      notifications.show({
        title: t("common.warning", { defaultValue: "Warning" }),
        message: t("profiles.selectProfile", { defaultValue: "Select profile" }),
        color: "yellow",
        autoClose: 3000,
      });
      return;
    }

    const linkedSessions = sessions.filter((session) => session.profileId === activeProfile.id);
    const syncableSessions = linkedSessions.filter((session) => {
      const meta = sessionMeta(session);
      return (meta.platform === "lichess" || meta.platform === "chesscom") && meta.username !== "-";
    });

    if (syncableSessions.length === 0) {
      notifications.show({
        title: t("common.warning", { defaultValue: "Warning" }),
        message: t("profiles.sync.noAccounts", { defaultValue: "This profile has no linked accounts to update." }),
        color: "yellow",
        autoClose: 3000,
      });
      return;
    }

    setIsProfileSyncing(true);
    let importedGames = 0;

    try {
      const orderedSessions = [...syncableSessions].sort((a, b) => {
        const aPlatform = sessionMeta(a).platform;
        const bPlatform = sessionMeta(b).platform;
        if (aPlatform === bPlatform) return 0;
        return aPlatform === "lichess" ? -1 : 1;
      });

      for (const session of orderedSessions) {
        const meta = sessionMeta(session);
        const username = meta.username;
        const notificationId = `dashboard-sync:${activeProfile.id}:${meta.platform}:${username}`;

        notifications.show({
          id: notificationId,
          title: t("accounts.processingGames", { defaultValue: "Processing Games..." }),
          message: `${activeProfile.name} - ${username} (${meta.platform})`,
          loading: true,
          autoClose: false,
        });

        try {
          const result = await syncSessionGamesToProfileDb({
            profile: activeProfile,
            session,
            onBatchUpdate: (update) => {
              const message =
                update.totalBatches > 0
                  ? `${activeProfile.name} - ${username} (${update.platform}) ${t("accounts.sync.batchProgress", {
                      defaultValue: "Batch {{current}} of {{total}}",
                      current: update.currentBatch,
                      total: update.totalBatches,
                    })}`
                  : `${activeProfile.name} - ${username} (${update.platform})`;

              notifications.update({
                id: notificationId,
                message,
                loading: true,
                autoClose: false,
              });
            },
          });

          importedGames += result.importedGames ?? 0;
          if (result.updatedSession) upsertSession(result.updatedSession);

          notifications.update({
            id: notificationId,
            title: t("common.success", { defaultValue: "Success" }),
            message: `${activeProfile.name} - ${username} (${meta.platform})`,
            color: "green",
            loading: false,
            autoClose: 2500,
          });
        } catch (error) {
          notifications.update({
            id: notificationId,
            title: t("common.error", { defaultValue: "Error" }),
            message: `${t("accounts.databaseLoadError", { defaultValue: "Error loading database" })}: ${String(error)}`,
            color: "red",
            loading: false,
            autoClose: 4000,
          });
        }
      }
    } finally {
      setIsProfileSyncing(false);
    }

    if (importedGames > 0) {
      window.dispatchEvent(new Event("dashboard:games-history:refresh"));
      window.dispatchEvent(new Event("chesscom:games:updated"));
      window.dispatchEvent(new Event("lichess:games:updated"));
      const activityMap = await loadProfilesLastActivityMap({
        profileIds: profiles.map((profile) => profile.id),
        sessions,
      });
      setLastActivityMap((prev) => (areLastActivityMapsEqual(prev, activityMap) ? prev : activityMap));
    }

    notifications.show({
      title: t("common.success", { defaultValue: "Success" }),
      message: t("profiles.sync.completed", {
        defaultValue: "Profile {{profile}} updated.",
        profile: activeProfile.name,
      }),
      color: "green",
      autoClose: 2500,
    });
  }, [activeProfile, isProfileSyncing, profiles, sessionMeta, sessions, t, upsertSession]);

  const topProfileOptions = useMemo(() => sortedProfiles.slice(0, 5), [sortedProfiles]);
  const otherProfileOptions = useMemo(() => sortedProfiles.slice(5), [sortedProfiles]);

  const activeProfileSessions = useMemo(
    () => sessions.filter((s) => (activeProfileId ? s.profileId === activeProfileId : true)),
    [sessions, activeProfileId],
  );

  const profileLichessUsernames = useMemo(
    () => [...new Set(activeProfileSessions.map((s) => s.lichess?.username).filter(Boolean) as string[])],
    [activeProfileSessions],
  );
  const profileChessComUsernames = useMemo(
    () => [...new Set(activeProfileSessions.map((s) => s.chessCom?.username).filter(Boolean) as string[])],
    [activeProfileSessions],
  );
  const profileSessionPlayerNames = useMemo(
    () => [...new Set(activeProfileSessions.map((s) => s.player?.trim()).filter(Boolean) as string[])],
    [activeProfileSessions],
  );
  const profileUsernames = useMemo(() => {
    const lichessKeys = profileLichessUsernames.map((username) => getAccountKey("lichess", username));
    const chessComKeys = profileChessComUsernames.map((username) => getAccountKey("chesscom", username));
    const displayName = (activeProfile?.displayName ?? "").trim();
    const profileName = (activeProfile?.name ?? "").trim();
    const names = [
      ...profileLichessUsernames,
      ...profileChessComUsernames,
      ...profileSessionPlayerNames,
      ...lichessKeys,
      ...chessComKeys,
      ...(displayName ? [displayName] : []),
      ...(profileName ? [profileName] : []),
    ];
    return [...new Set(names)];
  }, [
    profileLichessUsernames,
    profileChessComUsernames,
    profileSessionPlayerNames,
    activeProfile?.displayName,
    activeProfile?.name,
  ]);
  const engines = useAtomValue(enginesAtom);
  const localEngines = engines.filter((e): e is LocalEngine => e.type === "local");
  const defaultEngine = localEngines.find((e) => e.enabled) ?? (localEngines.length > 0 ? localEngines[0] : null);

  // Map external key -> internal profile DB game id (Games.ID as string).
  // This guarantees analysis.db3 is keyed by (profileId, Games.ID) even when callers don't pass meta.
  const profileDbIdByExternalKeyRef = useRef<Map<string, string>>(new Map());

  const [activeGamesTab, setActiveGamesTab] = useState<string | null>("games");
  const [analyzeAllModalOpened, setAnalyzeAllModalOpened] = useState(false);
  const [analyzeAllGameType, setAnalyzeAllGameType] = useState<AnalyzeAllType | null>(null);
  const [analyzeAllScopeFilters, setAnalyzeAllScopeFilters] = useState<AnalyzeAllScopeFilters>({
    opponentContains: null,
    resultFilter: null,
    playerColor: null,
    minMoves: null,
  });
  const [analyzeAllScopedRows, setAnalyzeAllScopedRows] = useState<GamesHistoryRow[]>([]);
  const [analyzeAllCounts, setAnalyzeAllCounts] = useState<{
    type: AnalyzeAllType;
    total: number;
    unanalyzed: number;
  } | null>(null);
  const [analyzeAllMissingBalancedStatsCount, setAnalyzeAllMissingBalancedStatsCount] = useState(0);

  // FIDE player information
  const [fidePlayer, setFidePlayer] = useState<{
    name: string;
    firstName: string;
    gender: "male" | "female";
    title?: string;
    standardRating?: number;
    rapidRating?: number;
    blitzRating?: number;
    worldRank?: number;
    nationalRank?: number;
    photo?: string;
    age?: number;
    birthYear?: number;
  } | null>(null);
  const [isLoadingFideData, setIsLoadingFideData] = useState(false);
  const [hasLoadedFideData, setHasLoadedFideData] = useState(false);
  const [_hasLoadedOverview, setHasLoadedOverview] = useState(false);
  const [_hasLoadedRecentGames, setHasLoadedRecentGames] = useState(false);
  const [_hasLoadedLichessGames, setHasLoadedLichessGames] = useState(false);
  const [_hasLoadedChessComGames, setHasLoadedChessComGames] = useState(false);
  const [_hasLoadedEventOptions, setHasLoadedEventOptions] = useState(false);
  const fideLoadRequestIdRef = useRef(0);

  const displayName = activeProfile?.displayName ?? "";
  const lichessToken = activeProfile?.lichessToken ?? "";
  const activeFideId = (activeProfile?.fideId ?? "").trim();

  const loadMainAccountData = useCallback(async () => {
    const requestId = fideLoadRequestIdRef.current + 1;
    fideLoadRequestIdRef.current = requestId;
    const isCurrentRequest = () => fideLoadRequestIdRef.current === requestId;

    if (!activeFideId) {
      if (isCurrentRequest()) {
        setFidePlayer(null);
        setHasLoadedFideData(true);
        setIsLoadingFideData(false);
      }
      return;
    }
    setIsLoadingFideData(true);

    try {
      const player = await fetchFidePlayer(activeFideId);
      if (!player) {
        if (isCurrentRequest()) {
          setFidePlayer(null);
          setHasLoadedFideData(true);
          setIsLoadingFideData(false);
        }
        return;
      }

      if (isCurrentRequest()) {
        setFidePlayer({
          name: player.name,
          firstName: player.firstName,
          gender: player.gender,
          title: player.title,
          standardRating: player.standardRating ?? player.rating,
          rapidRating: player.rapidRating,
          blitzRating: player.blitzRating,
          worldRank: player.worldRank,
          nationalRank: player.nationalRank,
          photo: player.photo,
          age: player.age,
          birthYear: player.birthYear,
        });
        setHasLoadedFideData(true);
      }
    } catch {
      if (isCurrentRequest()) {
        setFidePlayer(null);
        setHasLoadedFideData(true);
      }
    } finally {
      if (isCurrentRequest()) {
        setIsLoadingFideData(false);
      }
    }
  }, [activeFideId]);

  useEffect(() => {
    void loadMainAccountData();
  }, [loadMainAccountData]);

  const sumLichessPerfGames = useCallback((perfs: unknown) => {
    if (!perfs || typeof perfs !== "object") return 0;
    let total = 0;
    for (const value of Object.values(perfs as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      if (!("games" in value)) continue;
      const games = (value as { games?: unknown }).games;
      if (typeof games === "number") total += games;
    }
    return total;
  }, []);

  const getChessComRecordGames = useCallback(
    (record?: { win?: number; loss?: number; draw?: number } | null) =>
      (record?.win ?? 0) + (record?.loss ?? 0) + (record?.draw ?? 0),
    [],
  );

  const getSessionGameCount = useCallback(
    (session: Session | undefined) => {
      if (!session) return 0;
      let total = 0;

      total += sumLichessPerfGames(session.lichess?.account?.perfs);

      const chessComStats = session.chessCom?.stats;
      if (chessComStats) {
        const addPerf = (perf?: { record?: { win?: number; loss?: number; draw?: number } }) => {
          if (!perf?.record) return;
          total += getChessComRecordGames(perf.record);
        };
        addPerf(chessComStats.chess_daily);
        addPerf(chessComStats.chess_rapid);
        addPerf(chessComStats.chess_blitz);
        addPerf(chessComStats.chess_bullet);
      }

      return total;
    },
    [getChessComRecordGames, sumLichessPerfGames],
  );

  // Find the main session - prioritize exact username matches over player name matches
  // This ensures we pick the most active account (by games played) for the main card
  const mainSession = useMemo(() => {
    if (!activeProfileSessions.length) return undefined;
    const sorted = [...activeProfileSessions].sort((a, b) => {
      const gamesDiff = getSessionGameCount(b) - getSessionGameCount(a);
      if (gamesDiff !== 0) return gamesDiff;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
    return sorted[0];
  }, [activeProfileSessions, getSessionGameCount]);

  const ratingSelection = useMemo(() => {
    type Candidate = {
      key: DashboardRatingKey;
      source: "lichess" | "chesscom";
      username: string;
      rating: number;
      games: number;
      updatedAt: number;
    };

    const candidates: Record<DashboardRatingKey, Candidate[]> = {
      classical: [],
      rapid: [],
      blitz: [],
      bullet: [],
    };

    const pushCandidate = (
      key: DashboardRatingKey,
      source: "lichess" | "chesscom",
      username: string,
      rating: number | undefined,
      games: number | undefined,
      updatedAt: number,
    ) => {
      if (typeof rating !== "number" || !Number.isFinite(rating)) return;
      candidates[key].push({
        key,
        source,
        username,
        rating,
        games: Math.max(0, games ?? 0),
        updatedAt,
      });
    };

    for (const session of activeProfileSessions) {
      const updatedAt = session.updatedAt ?? 0;
      if (session.lichess?.account) {
        const username = session.lichess.username || session.lichess.account.username;
        const perfs = session.lichess.account.perfs;
        pushCandidate("classical", "lichess", username, perfs?.classical?.rating, perfs?.classical?.games, updatedAt);
        pushCandidate("rapid", "lichess", username, perfs?.rapid?.rating, perfs?.rapid?.games, updatedAt);
        pushCandidate("blitz", "lichess", username, perfs?.blitz?.rating, perfs?.blitz?.games, updatedAt);
        pushCandidate("bullet", "lichess", username, perfs?.bullet?.rating, perfs?.bullet?.games, updatedAt);
      }

      if (session.chessCom?.stats) {
        const username = session.chessCom.username;
        const stats = session.chessCom.stats;
        pushCandidate(
          "rapid",
          "chesscom",
          username,
          stats.chess_rapid?.last?.rating,
          getChessComRecordGames(stats.chess_rapid?.record),
          updatedAt,
        );
        pushCandidate(
          "blitz",
          "chesscom",
          username,
          stats.chess_blitz?.last?.rating,
          getChessComRecordGames(stats.chess_blitz?.record),
          updatedAt,
        );
        pushCandidate(
          "bullet",
          "chesscom",
          username,
          stats.chess_bullet?.last?.rating,
          getChessComRecordGames(stats.chess_bullet?.record),
          updatedAt,
        );
      }
    }

    const ratingHistory: DashboardRatingHistory = {};
    const ratingSources: Partial<Record<DashboardRatingKey, DashboardRatingSourceMeta>> = {};
    const controls: DashboardRatingKey[] = ["classical", "rapid", "blitz", "bullet"];

    for (const key of controls) {
      const sorted = [...candidates[key]].sort((a, b) => {
        if (b.games !== a.games) return b.games - a.games;
        return b.updatedAt - a.updatedAt;
      });
      const selected = sorted.find((candidate) => candidate.games > 0);
      if (!selected) continue;
      ratingHistory[key] = selected.rating;
      ratingSources[key] = {
        source: selected.source,
        games: selected.games,
        username: selected.username,
      };
    }

    return {
      ratingHistory,
      ratingSources,
    };
  }, [activeProfileSessions, getChessComRecordGames]);

  const ratingHistory = ratingSelection.ratingHistory;
  const ratingSources = ratingSelection.ratingSources;

  // Keep title/rank behavior stable when there are no rhythm ratings available.
  const averageOnlineRating = useMemo(() => {
    const values = Object.values(ratingHistory).filter((value): value is number => typeof value === "number");
    if (values.length === 0) return calculateOnlineRating(mainSession);
    return Math.round(values.reduce((acc, value) => acc + value, 0) / values.length);
  }, [mainSession, ratingHistory]);

  let user = {
    name: activeProfile?.name ?? t("dashboard.noMainAccount"),
    handle: "",
    rating: averageOnlineRating,
  };
  let platform: "lichess" | "chesscom" | null = null;
  if (mainSession?.lichess?.account) {
    platform = "lichess";
    user = {
      name: mainSession.lichess.account.username,
      handle: `@${mainSession.lichess.account.username}`,
      rating: averageOnlineRating,
    };
  } else if (mainSession?.chessCom?.stats) {
    platform = "chesscom";
    user = {
      name: mainSession.chessCom.username,
      handle: `@${mainSession.chessCom.username}`,
      rating: averageOnlineRating,
    };
  }

  const linkedOnlineAccounts = useMemo(() => {
    const unique = new Map<string, { platform: "lichess" | "chesscom"; username: string }>();
    for (const session of activeProfileSessions) {
      if (session.lichess?.username) {
        const username = session.lichess.username;
        unique.set(`lichess:${username.toLowerCase()}`, { platform: "lichess", username });
      }
      if (session.chessCom?.username) {
        const username = session.chessCom.username;
        unique.set(`chesscom:${username.toLowerCase()}`, { platform: "chesscom", username });
      }
    }
    return [...unique.values()];
  }, [activeProfileSessions]);

  // Memoize fideInfo to ensure WelcomeCard updates when fidePlayer changes
  const fideInfo = useMemo(() => {
    if (!fidePlayer) return undefined;
    return {
      title: fidePlayer.title,
      standardRating: fidePlayer.standardRating,
      rapidRating: fidePlayer.rapidRating,
      blitzRating: fidePlayer.blitzRating,
      worldRank: fidePlayer.worldRank,
      nationalRank: fidePlayer.nationalRank,
      photo: fidePlayer.photo,
      age: fidePlayer.age,
    };
  }, [fidePlayer]);

  const lichessUsernames = profileLichessUsernames;
  const chessComUsernames = profileChessComUsernames;

  const [recentGames, setRecentGames] = useState<GameRecord[]>([]);
  const [gameHistoryLimit, setGameHistoryLimit] = useState(100);
  const [eventFilterId, setEventFilterId] = useState<number | null>(null);
  const [eventOptions, setEventOptions] = useState<Event[]>([]);
  const [eventSearch, setEventSearch] = useState("");
  const [isLoadingEventOptions, setIsLoadingEventOptions] = useState(false);
  const [debouncedEventSearch] = useDebouncedValue(eventSearch, 250);
  const [activeProfileDbPath, setActiveProfileDbPath] = useState<string | null>(null);
  const [selectedOpponentName, setSelectedOpponentName] = useState<string | null>(null);
  const [selectedOpponentId, setSelectedOpponentId] = useState<number | null>(null);
  const [timeControlCategory, setTimeControlCategory] = useState<TimeControlCategory | null>(null);
  const [_isLoadingRecentGames, setIsLoadingRecentGames] = useState(false);

  useEffect(() => {
    if (!activeProfileId) {
      profileDbIdByExternalKeyRef.current = new Map();
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const res = (await invoke<{
          rows?: Array<{ kind: string; gameKey: string; analysisGameId: string }>;
        }>("dashboard_get_games_history_rows", {
          req: {
            profileId: activeProfileId,
            profileUsernames,
            gameHistoryLimit,
            page: 1,
            pageSize: gameHistoryLimit,
            eventFilterId: null,
            selectedOpponentId: null,
            opponentContains: null,
            timeControlCategory: null,
            resultFilter: null,
            sortBy: "date",
            sortDirection: "desc",
          },
        })) ?? { rows: [] };

        const next = new Map<string, string>();
        for (const r of res.rows ?? []) {
          next.set(`${String(r.kind).toLowerCase()}:${r.gameKey}`, r.analysisGameId);
        }
        if (!cancelled) profileDbIdByExternalKeyRef.current = next;
      } catch {
        if (!cancelled) profileDbIdByExternalKeyRef.current = new Map();
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, profileUsernames, gameHistoryLimit]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!activeProfileId) {
        setActiveProfileDbPath(null);
        return;
      }
      try {
        const dbPath = await getProfileDbPath(activeProfileId);
        if (!cancelled) setActiveProfileDbPath(dbPath);
      } catch {
        if (!cancelled) setActiveProfileDbPath(null);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [activeProfileId]);

  useEffect(() => {
    if (!activeProfileDbPath || !selectedOpponentName) {
      setSelectedOpponentId(null);
      return;
    }

    let cancelled = false;
    const run = async () => {
      try {
        const name = selectedOpponentName.trim();
        if (!name) {
          setSelectedOpponentId(null);
          return;
        }
        const normalizedTarget = stripAccountKey(name).trim().toLowerCase();
        if (!normalizedTarget) {
          setSelectedOpponentId(null);
          return;
        }

        const pageSize = 100;
        // Safety cap to avoid unbounded scans on very large databases.
        const hardMaxPages = 50;
        let foundId: number | null = null;
        let page = 1;

        while (page <= hardMaxPages) {
          const res = await query_players(activeProfileDbPath, {
            options: {
              skipCount: false,
              page,
              pageSize,
              sort: "name",
              direction: "asc",
            },
            name,
            range: null,
          });

          const exact = (res.data ?? []).find((p) => {
            const raw = (p.name ?? "").trim().toLowerCase();
            if (!raw) return false;
            if (raw === normalizedTarget) return true;
            return stripAccountKey(raw).trim().toLowerCase() === normalizedTarget;
          });
          if (exact?.id != null) {
            foundId = exact.id;
            break;
          }

          const count = typeof res.count === "number" ? res.count : null;
          const reachedLastPageByCount = count != null && page * pageSize >= count;
          const reachedLastPageByData = (res.data?.length ?? 0) < pageSize;
          if (reachedLastPageByCount || reachedLastPageByData) {
            break;
          }
          page += 1;
        }

        if (cancelled) return;
        setSelectedOpponentId(foundId);
      } catch {
        if (!cancelled) setSelectedOpponentId(null);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [activeProfileDbPath, selectedOpponentName]);

  useEffect(() => {
    if (!activeProfileId) {
      setEventOptions([]);
      setIsLoadingEventOptions(false);
      setHasLoadedEventOptions(true);
      return;
    }

    let cancelled = false;
    const loadEvents = async () => {
      setIsLoadingEventOptions(true);
      try {
        const dbPath = await getProfileDbPath(activeProfileId);
        const result = await commands.getTournaments(dbPath, {
          name: debouncedEventSearch || null,
          options: {
            skipCount: true,
            sort: "id",
            direction: "asc",
            page: 1,
            pageSize: 200,
          },
        });

        if (!cancelled && result.status === "ok") {
          setEventOptions(result.data.data);
        }
      } catch {
        if (!cancelled) {
          setEventOptions([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingEventOptions(false);
          setHasLoadedEventOptions(true);
        }
      }
    };

    void loadEvents();
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, debouncedEventSearch]);

  useEffect(() => {
    setEventFilterId(null);
    setEventSearch("");
    setTimeControlCategory(null);
  }, []);

  const getOrientationFromFen = useCallback((fen?: string | null) => {
    if (!fen) return null;
    const parts = fen.trim().split(/\s+/);
    const turn = parts[1];
    if (turn === "w") return "white";
    if (turn === "b") return "black";
    return null;
  }, []);

  const getOrientationFromPgn = useCallback(
    (pgn?: string | null) => {
      if (!pgn) return null;
      const match = pgn.match(/\[FEN\s+"([^"]+)"\]/i);
      return getOrientationFromFen(match?.[1]);
    },
    [getOrientationFromFen],
  );

  const loadGames = useCallback(async () => {
    setIsLoadingRecentGames(true);
    try {
      const games = await getRecentGames(activeProfileId, gameHistoryLimit);
      // Filter out games with less than 5 moves (moves may be empty when loaded from profile DB; use pgn)
      const filteredGames = games.filter((g) => {
        if (g.moves?.length >= 5) return true;
        if (g.pgn) {
          const movesSection = g.pgn.split(/\n\n/)[1] || g.pgn;
          const moveCount = (movesSection.match(/\d+\./g)?.length ?? 0) * 2;
          return moveCount >= 5;
        }
        return false;
      });
      setRecentGames(filteredGames);
    } catch {
    } finally {
      setIsLoadingRecentGames(false);
      setHasLoadedRecentGames(true);
    }
  }, [activeProfileId, gameHistoryLimit]);

  useEffect(() => {
    loadGames();

    // Listen for games:updated event to refresh local games after analysis
    const handleGamesUpdated = () => {
      loadGames();
    };
    window.addEventListener("games:updated", handleGamesUpdated);

    return () => {
      window.removeEventListener("games:updated", handleGamesUpdated);
    };
  }, [loadGames]);

  const [lichessGames, setLichessGames] = useState<DashboardLichessGame[]>([]);
  const [isLoadingLichessGames, setIsLoadingLichessGames] = useState(false);
  const lichessLoadRequestIdRef = useRef(0);
  const hasEnoughMoves = useCallback((pgn?: string | null) => hasEnoughMovesInPgn(pgn, 5), []);
  useEffect(() => {
    let disposed = false;

    const loadGamesFromProfileDatabase = async () => {
      const requestId = lichessLoadRequestIdRef.current + 1;
      lichessLoadRequestIdRef.current = requestId;
      const isCurrentRequest = () => !disposed && lichessLoadRequestIdRef.current === requestId;

      if (!activeProfileId) {
        if (isCurrentRequest()) {
          setLichessGames([]);
          setIsLoadingLichessGames(false);
          setHasLoadedLichessGames(true);
        }
        return;
      }
      if (lichessUsernames.length === 0) {
        if (isCurrentRequest()) {
          setLichessGames([]);
          setIsLoadingLichessGames(false);
          setHasLoadedLichessGames(true);
        }
        return;
      }

      if (isCurrentRequest()) {
        setIsLoadingLichessGames(true);
      }

      try {
        const dbPath = await getProfileDbPath(activeProfileId);
        // Keep the online cache independent from table filters; scoped filtering is applied by
        // dashboard_get_games_history_rows when rendering/analyzing rows.
        const queryResult = await query_games(dbPath, {
          options: {
            page: 1,
            pageSize: gameHistoryLimit,
            sort: "date",
            direction: "desc",
            skipCount: true,
          },
        } as unknown as GameQuery);

        const lichessRows = (queryResult.data ?? []).filter((g) => g.site?.toLowerCase().includes("lichess.org"));
        const analyzedGames = await getAnalyzedGamesBulk(
          lichessRows.map((g) => String(g.id)),
          activeProfileId,
        );
        const games = lichessRows
          .map((g) => {
            const analyzedPgn = analyzedGames.get(String(g.id)) ?? null;
            const base = convertNormalizedToLichessGame(g);
            return {
              ...base,
              eventId: g.event_id,
              eventName: g.event ?? null,
              ...(analyzedPgn ? { pgn: analyzedPgn } : {}),
            };
          })
          .filter((g) => hasEnoughMoves(g.pgn))
          .slice(0, gameHistoryLimit);

        if (isCurrentRequest()) {
          setLichessGames(games);
        }
      } catch {
        if (isCurrentRequest()) {
          setLichessGames([]);
        }
      } finally {
        if (isCurrentRequest()) {
          setIsLoadingLichessGames(false);
          setHasLoadedLichessGames(true);
        }
      }
    };

    void loadGamesFromProfileDatabase();

    const handleLichessGamesUpdated = () => {
      void loadGamesFromProfileDatabase();
    };

    window.addEventListener("lichess:games:updated", handleLichessGamesUpdated);

    return () => {
      disposed = true;
      window.removeEventListener("lichess:games:updated", handleLichessGamesUpdated);
    };
  }, [activeProfileId, gameHistoryLimit, hasEnoughMoves, lichessUsernames]);

  const [chessComGames, setChessComGames] = useState<ChessComGameWithEvent[]>([]);
  const [isLoadingChessComGames, setIsLoadingChessComGames] = useState(false);
  const chessComLoadRequestIdRef = useRef(0);
  useEffect(() => {
    let disposed = false;

    const loadGamesFromProfileDatabase = async () => {
      const requestId = chessComLoadRequestIdRef.current + 1;
      chessComLoadRequestIdRef.current = requestId;
      const isCurrentRequest = () => !disposed && chessComLoadRequestIdRef.current === requestId;

      if (!activeProfileId) {
        if (isCurrentRequest()) {
          setChessComGames([]);
          setIsLoadingChessComGames(false);
          setHasLoadedChessComGames(true);
        }
        return;
      }
      if (chessComUsernames.length === 0) {
        if (isCurrentRequest()) {
          setChessComGames([]);
          setIsLoadingChessComGames(false);
          setHasLoadedChessComGames(true);
        }
        return;
      }

      if (isCurrentRequest()) {
        setIsLoadingChessComGames(true);
      }

      try {
        const dbPath = await getProfileDbPath(activeProfileId);
        // Keep the online cache independent from table filters; scoped filtering is applied by
        // dashboard_get_games_history_rows when rendering/analyzing rows.
        const queryResult = await query_games(dbPath, {
          options: {
            page: 1,
            pageSize: gameHistoryLimit,
            sort: "date",
            direction: "desc",
            skipCount: true,
          },
        } as unknown as GameQuery);

        const chessComRows = (queryResult.data ?? []).filter((g) => g.site?.toLowerCase().includes("chess.com"));
        const analyzedGames = await getAnalyzedGamesBulk(
          chessComRows.map((g) => String(g.id)),
          activeProfileId,
        );
        const games = chessComRows
          .map((g) => {
            const analyzedPgn = analyzedGames.get(String(g.id)) ?? null;
            const base = convertNormalizedToChessComGame(g);
            return {
              ...base,
              eventId: g.event_id,
              eventName: g.event ?? null,
              ...(analyzedPgn ? { pgn: analyzedPgn } : {}),
            };
          })
          .filter((g) => hasEnoughMoves(g.pgn))
          .slice(0, gameHistoryLimit);

        if (isCurrentRequest()) {
          setChessComGames(games);
        }
      } catch {
        if (isCurrentRequest()) {
          setChessComGames([]);
        }
      } finally {
        if (isCurrentRequest()) {
          setIsLoadingChessComGames(false);
          setHasLoadedChessComGames(true);
        }
      }
    };

    void loadGamesFromProfileDatabase();

    const handleChessComGamesUpdated = () => {
      void loadGamesFromProfileDatabase();
    };

    window.addEventListener("chesscom:games:updated", handleChessComGamesUpdated);

    return () => {
      disposed = true;
      window.removeEventListener("chesscom:games:updated", handleChessComGamesUpdated);
    };
  }, [activeProfileId, gameHistoryLimit, hasEnoughMoves, chessComUsernames]);

  const [puzzleStats, setPuzzleStats] = useState<PuzzleStats>(() => {
    const initial = getPuzzleStats();
    return normalizePuzzleStats(initial);
  });
  const [favoriteGames, setFavoriteGames] = useState<FavoriteGame[]>([]);
  const [dashboardOverview, setDashboardOverview] = useState<DashboardOverviewMetrics | null>(null);
  const [_isProfileCardsLoading, setIsProfileCardsLoading] = useState(false);
  const dashboardOverviewRequestRef = useRef(0);
  const [isDashboardLoadGateTimedOut, setIsDashboardLoadGateTimedOut] = useState(false);

  // Load favorite games
  const loadFavoriteGames = useCallback(async () => {
    try {
      const favorites = await getAllFavoriteGames();
      setFavoriteGames(favorites);
    } catch {}
  }, []);

  useEffect(() => {
    if (!activeProfileId) {
      setIsProfileCardsLoading(false);
      setHasLoadedOverview(true);
      return;
    }
    setIsProfileCardsLoading(true);
    setHasLoadedFideData(!activeFideId);
    setHasLoadedOverview(false);
    setHasLoadedRecentGames(false);
    setHasLoadedLichessGames(false);
    setHasLoadedChessComGames(false);
    setHasLoadedEventOptions(false);
  }, [activeProfileId, activeFideId]);

  useEffect(() => {
    if (!activeProfileId) {
      setIsDashboardLoadGateTimedOut(false);
      return;
    }

    setIsDashboardLoadGateTimedOut(false);
    const timeoutId = window.setTimeout(() => {
      setIsDashboardLoadGateTimedOut(true);
    }, 8000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeProfileId]);

  const loadDashboardOverview = useCallback(async () => {
    const requestId = dashboardOverviewRequestRef.current + 1;
    dashboardOverviewRequestRef.current = requestId;

    if (!activeProfileId) {
      setDashboardOverview(null);
      setIsProfileCardsLoading(false);
      setHasLoadedOverview(true);
      return;
    }

    try {
      const res = await invoke<DashboardOverviewMetrics>("dashboard_get_overview_metrics", {
        req: {
          profileId: activeProfileId,
          profileUsernames,
          gameHistoryLimit: KPI_FETCH_LIMIT,
          sampleSize: KPI_SAMPLE_SIZE,
          trendWeeks: QUALITY_TREND_WEEKS,
        },
      });
      if (requestId !== dashboardOverviewRequestRef.current) return;
      setDashboardOverview(res);
    } catch {
      if (requestId !== dashboardOverviewRequestRef.current) return;
      setDashboardOverview(null);
    } finally {
      if (requestId === dashboardOverviewRequestRef.current) {
        setIsProfileCardsLoading(false);
        setHasLoadedOverview(true);
      }
    }
  }, [activeProfileId, profileUsernames]);

  const handleAnalyzeAll = useCallback(
    async ({ type, opponentContains, resultFilter, playerColor, minMoves }: AnalyzeAllOpenPayload) => {
      const normalizedOpponentContains = opponentContains?.trim() || null;
      const normalizedMinMoves =
        typeof minMoves === "number" && Number.isFinite(minMoves) && minMoves > 0 ? Math.floor(minMoves) : null;
      const scopeFilters: AnalyzeAllScopeFilters = {
        opponentContains: normalizedOpponentContains,
        resultFilter: resultFilter ?? null,
        playerColor: playerColor ?? null,
        minMoves: normalizedMinMoves,
      };

      setAnalyzeAllGameType(type);
      setAnalyzeAllScopeFilters(scopeFilters);
      setAnalyzeAllScopedRows([]);
      setAnalyzeAllCounts(null);
      setAnalyzeAllMissingBalancedStatsCount(0);
      setAnalyzeAllModalOpened(true);

      if (!activeProfileId) {
        return;
      }

      try {
        const res = (await invoke<{ rows?: GamesHistoryRow[] }>("dashboard_get_games_history_rows", {
          req: {
            profileId: activeProfileId,
            profileUsernames,
            gameHistoryLimit,
            page: 1,
            pageSize: gameHistoryLimit,
            eventFilterId,
            selectedOpponentId,
            opponentContains: normalizedOpponentContains,
            timeControlCategory,
            resultFilter: resultFilter ?? null,
            playerColor: playerColor ?? null,
            minMoves: normalizedMinMoves,
            sortBy: "date",
            sortDirection: "desc",
          },
        })) ?? { rows: [] };

        const analyzeMinMoves = Math.max(5, normalizedMinMoves ?? 0);
        const scopedRows = (res.rows ?? []).filter((row) => (row.moves ?? 0) >= analyzeMinMoves);
        setAnalyzeAllScopedRows(scopedRows);
        const rowsForType = scopedRows.filter((row) => (type === "all" ? true : row.kind === type));
        const total = rowsForType.length;
        const unanalyzed = rowsForType.filter((row) => !isRowReadyForAnalyzeSkip(row)).length;

        setAnalyzeAllCounts({ type, total, unanalyzed });

        const analyzedRows = rowsForType.filter((row) => row.isAnalyzed && !!row.pgn?.trim());
        if (!analyzedRows.length) {
          setAnalyzeAllMissingBalancedStatsCount(0);
          return;
        }

        const statsLookupIds = Array.from(
          new Set(analyzedRows.flatMap((row) => [row.analysisGameId, row.gameKey]).filter((id) => id.trim() !== "")),
        );
        const statsById = await getGameStatsBulk(statsLookupIds, activeProfileId);
        const missingCount = analyzedRows.reduce((count, row) => {
          const stats = statsById.get(row.analysisGameId) ?? statsById.get(row.gameKey) ?? null;
          if (!stats || stats.resistance == null || stats.eloEstimatedBalanced == null) {
            return count + 1;
          }
          return count;
        }, 0);
        setAnalyzeAllMissingBalancedStatsCount(missingCount);
      } catch {
        setAnalyzeAllScopedRows([]);
        setAnalyzeAllMissingBalancedStatsCount(0);
      }
    },
    [activeProfileId, profileUsernames, gameHistoryLimit, eventFilterId, selectedOpponentId, timeControlCategory],
  );

  const handleBackfillMissingBalancedStats = useCallback(async () => {
    if (!activeProfileId || !analyzeAllGameType) return;

    const analyzeMinMoves = Math.max(5, analyzeAllScopeFilters.minMoves ?? 0);
    const scopedRowsForRun = analyzeAllScopedRows.filter((row) => (row.moves ?? 0) >= analyzeMinMoves);
    const rowsForSelectedType = scopedRowsForRun.filter((row) =>
      analyzeAllGameType === "all" ? true : row.kind === analyzeAllGameType,
    );
    const analyzedRows = rowsForSelectedType.filter((row) => row.isAnalyzed && !!row.pgn?.trim());

    if (!analyzedRows.length) {
      setAnalyzeAllMissingBalancedStatsCount(0);
      return;
    }

    const statsLookupIds = Array.from(
      new Set(analyzedRows.flatMap((row) => [row.analysisGameId, row.gameKey]).filter((id) => id.trim() !== "")),
    );
    const statsById = await getGameStatsBulk(statsLookupIds, activeProfileId);

    const missingRows = analyzedRows.filter((row) => {
      const stats = statsById.get(row.analysisGameId) ?? statsById.get(row.gameKey) ?? null;
      return !stats || stats.resistance == null || stats.eloEstimatedBalanced == null;
    });

    if (!missingRows.length) {
      setAnalyzeAllMissingBalancedStatsCount(0);
      return;
    }

    notifications.show({
      title: t("features.dashboard.backfillBalancedStatsStarted", { defaultValue: "Completing balanced stats" }),
      message: t("features.dashboard.backfillBalancedStatsStartedMessage", {
        defaultValue: "Checking {{count}} analyzed games with missing balanced metrics.",
        count: missingRows.length,
      }),
      color: "blue",
    });

    let updated = 0;
    let skipped = 0;
    let pendingRefreshUpdates = 0;

    const emitGamesHistoryRefresh = () => {
      window.dispatchEvent(new Event("dashboard:games-history:refresh"));
    };

    for (const row of missingRows) {
      const pgn = row.pgn?.trim() ?? "";
      if (!pgn) {
        skipped++;
        continue;
      }

      try {
        const tree = await parsePGN(pgn);
        const reportStats = getGameStats(tree.root);
        const userColor = row.color === "black" ? "black" : "white";
        const computed = buildStatsPayloadForBackend(reportStats, userColor, tree);
        if (!computed) {
          skipped++;
          continue;
        }

        const existingStats = statsById.get(row.analysisGameId) ?? statsById.get(row.gameKey) ?? null;
        const accuracy = existingStats?.accuracy ?? computed.accuracy;
        const acpl = existingStats?.acpl ?? computed.acpl;
        if (!(Number.isFinite(accuracy) && Number.isFinite(acpl))) {
          skipped++;
          continue;
        }

        const mergedStats: GameStats = {
          accuracy,
          acpl,
          ...(existingStats?.estimatedElo != null
            ? { estimatedElo: existingStats.estimatedElo }
            : computed.estimatedElo != null
              ? { estimatedElo: computed.estimatedElo }
              : {}),
          ...(computed.opponentEstimatedElo != null ? { opponentEstimatedElo: computed.opponentEstimatedElo } : {}),
          ...(computed.opponentRatingElo != null ? { opponentRatingElo: computed.opponentRatingElo } : {}),
        };

        const gameIdToSave = statsById.has(row.analysisGameId)
          ? row.analysisGameId
          : statsById.has(row.gameKey)
            ? row.gameKey
            : row.analysisGameId || row.gameKey;

        if (!gameIdToSave) {
          skipped++;
          continue;
        }

        await saveGameStats(gameIdToSave, mergedStats, activeProfileId);
        statsById.set(gameIdToSave, mergedStats);
        updated++;
        pendingRefreshUpdates++;
        if (pendingRefreshUpdates >= 10) {
          emitGamesHistoryRefresh();
          pendingRefreshUpdates = 0;
        }
      } catch {
        skipped++;
      }
    }

    const remainingMissing = Math.max(0, missingRows.length - updated);
    setAnalyzeAllMissingBalancedStatsCount(remainingMissing);

    if (updated > 0) {
      emitGamesHistoryRefresh();
    }

    notifications.show({
      title: t("features.dashboard.backfillBalancedStatsDone", { defaultValue: "Balanced stats updated" }),
      message: t("features.dashboard.backfillBalancedStatsDoneMessage", {
        defaultValue: "Updated {{updated}} games. Skipped {{skipped}}.",
        updated,
        skipped,
      }),
      color: updated > 0 ? "green" : "yellow",
    });
  }, [activeProfileId, analyzeAllGameType, analyzeAllScopeFilters.minMoves, analyzeAllScopedRows, t]);

  useEffect(() => {
    loadFavoriteGames();

    const handleFavoritesUpdated = () => {
      loadFavoriteGames();
    };
    window.addEventListener("favorites:updated", handleFavoritesUpdated);

    return () => {
      window.removeEventListener("favorites:updated", handleFavoritesUpdated);
    };
  }, [loadFavoriteGames]);

  useEffect(() => {
    void loadDashboardOverview();

    const refresh = () => {
      void loadDashboardOverview();
    };

    window.addEventListener("dashboard:games-history:refresh", refresh);
    window.addEventListener("chesscom:games:updated", refresh);
    window.addEventListener("lichess:games:updated", refresh);
    window.addEventListener("games:updated", refresh);

    return () => {
      window.removeEventListener("dashboard:games-history:refresh", refresh);
      window.removeEventListener("chesscom:games:updated", refresh);
      window.removeEventListener("lichess:games:updated", refresh);
      window.removeEventListener("games:updated", refresh);
    };
  }, [loadDashboardOverview]);

  useEffect(() => {
    const update = () => {
      const nextStats = getPuzzleStats();
      if (isPromiseLike(nextStats)) {
        void Promise.resolve(nextStats)
          .then((resolved) => {
            setPuzzleStats(normalizePuzzleStats(resolved));
          })
          .catch(() => {
            setPuzzleStats(DEFAULT_PUZZLE_STATS);
          });
        return;
      }
      setPuzzleStats(normalizePuzzleStats(nextStats));
    };
    const onVisibility = () => {
      if (!document.hidden) update();
    };
    window.addEventListener("storage", update);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const PLAY_CHESS = {
    icon: <IconChess size={50} />,
    title: t("features.dashboard.cards.playChess.title"),
    description: t("features.dashboard.cards.playChess.desc"),
    label: t("features.dashboard.cards.playChess.button"),
    onClick: () => {
      const uuid = genID();
      setTabs((prev: Tab[]) => {
        return [
          ...prev,
          {
            value: uuid,
            name: t("features.dashboard.newGame"),
            type: "play",
          },
        ];
      });
      setActiveTab(uuid);
      navigate({ to: "/play" });
    },
  };

  const qualityInsights = useMemo<DashboardQualityInsights>(() => {
    if (!dashboardOverview) {
      return DEFAULT_QUALITY_INSIGHTS;
    }
    return {
      weekBlunderRate: dashboardOverview.weekBlunderRate,
      previousWeekBlunderRate: dashboardOverview.previousWeekBlunderRate,
      blunderDeltaPp: dashboardOverview.blunderDeltaPp,
      weekBrilliantRate: dashboardOverview.weekBrilliantRate,
      previousWeekBrilliantRate: dashboardOverview.previousWeekBrilliantRate,
      brilliantDeltaPp: dashboardOverview.brilliantDeltaPp,
      weekMistakeRate: dashboardOverview.weekMistakeRate,
      previousWeekMistakeRate: dashboardOverview.previousWeekMistakeRate,
      mistakeDeltaPp: dashboardOverview.mistakeDeltaPp,
      weekInaccuracyRate: dashboardOverview.weekInaccuracyRate,
      previousWeekInaccuracyRate: dashboardOverview.previousWeekInaccuracyRate,
      inaccuracyDeltaPp: dashboardOverview.inaccuracyDeltaPp,
      weekAccuracy: dashboardOverview.weekAccuracy,
      previousWeekAccuracy: dashboardOverview.previousWeekAccuracy,
      accuracyDelta: dashboardOverview.accuracyDelta,
      weekAcpl: dashboardOverview.weekAcpl,
      previousWeekAcpl: dashboardOverview.previousWeekAcpl,
      acplDelta: dashboardOverview.acplDelta,
      weekAnalyzedGames: dashboardOverview.weekAnalyzedGames,
      previousWeekAnalyzedGames: dashboardOverview.previousWeekAnalyzedGames,
      blunderRateTrend:
        dashboardOverview.blunderRateTrend?.length > 0
          ? dashboardOverview.blunderRateTrend
          : Array.from({ length: QUALITY_TREND_WEEKS }, () => null),
    };
  }, [dashboardOverview]);

  const dashboardSummary = useMemo(() => {
    const weeklyPuzzleSolved = puzzleStats.history.reduce((acc, row) => acc + row.solved, 0);

    return {
      wins: dashboardOverview?.weekWins ?? 0,
      losses: dashboardOverview?.weekLosses ?? 0,
      draws: dashboardOverview?.weekDraws ?? 0,
      outcomeCount: dashboardOverview?.weekOutcomeCount ?? 0,
      gamesCount: dashboardOverview?.weekGamesCount ?? 0,
      winRate: dashboardOverview?.weekWinRate ?? 0,
      previousGamesCount: dashboardOverview?.previousWeekGamesCount ?? 0,
      previousWinRate: dashboardOverview?.previousWeekWinRate ?? 0,
      weeklyPuzzleSolved,
      linkedAccounts: activeProfileSessions.length,
      weekAvgElo: dashboardOverview?.weekAvgEstimatedElo ?? null,
      previousWeekAvgElo: dashboardOverview?.previousWeekAvgEstimatedElo ?? null,
      weekAcplByTimeControl: dashboardOverview?.weekAcplByTimeControl ?? {
        classical: null,
        rapid: null,
        blitz: null,
        bullet: null,
      },
      weekAccuracyByColor: dashboardOverview?.weekAccuracyByColor ?? {
        white: null,
        black: null,
      },
      puzzleVariantsColorCoverage: dashboardOverview?.puzzleVariantsColorCoverage ?? {
        whitePuzzles: 0,
        blackPuzzles: 0,
        totalPuzzles: 0,
        whitePercent: 0,
        blackPercent: 0,
      },
    };
  }, [dashboardOverview, puzzleStats.history, activeProfileSessions.length]);

  const previousWeekLabel = t("features.dashboard.previousWeek", { defaultValue: "Previous" });
  const formatPercent = (value: number | null | undefined, decimals = 0): string => {
    if (value == null || !Number.isFinite(value)) return "--";
    const fixed = value.toFixed(decimals);
    return `${fixed.replace(/\.0+$/, "")}%`;
  };
  const formatNumber = (value: number | null | undefined, decimals = 1): string => {
    if (value == null || !Number.isFinite(value)) return "--";
    const fixed = value.toFixed(decimals);
    return fixed.replace(/\.0+$/, "");
  };
  const buildWeekHint = (previousValue: string | number) =>
    `${t("features.dashboard.thisWeek")}\n${previousWeekLabel}: ${previousValue}`;

  const kpiCards = [
    {
      key: "games",
      label: t("features.dashboard.games"),
      value: dashboardSummary.gamesCount,
      hint: buildWeekHint(dashboardSummary.previousGamesCount),
      color: "blue",
      icon: <IconChartBar size={18} />,
    },
    {
      key: "winrate",
      label: t("features.dashboard.winRate"),
      value: formatPercent(dashboardSummary.winRate),
      hint: buildWeekHint(formatPercent(dashboardSummary.previousWinRate)),
      color: "teal",
      icon: <IconTrophy size={18} />,
    },
    {
      key: "elo",
      label: t("dashboard.estimatedElo"),
      value: dashboardSummary.weekAvgElo ?? "--",
      hint: buildWeekHint(dashboardSummary.previousWeekAvgElo ?? "--"),
      color: "cyan",
      icon: <IconStar size={18} />,
    },
    {
      key: "brilliant-rate",
      label: t("chess.annotate.brilliant"),
      value: formatPercent(qualityInsights.weekBrilliantRate, 1),
      hint: buildWeekHint(formatPercent(qualityInsights.previousWeekBrilliantRate, 1)),
      color: "yellow",
      icon: <IconTargetArrow size={18} />,
    },
    {
      key: "acpl-by-time-control",
      label: t("features.dashboard.kpi.acplByTimeControl"),
      value: `C ${formatNumber(dashboardSummary.weekAcplByTimeControl.classical)} · R ${formatNumber(dashboardSummary.weekAcplByTimeControl.rapid)}`,
      hint: `Bz ${formatNumber(dashboardSummary.weekAcplByTimeControl.blitz)} · Bu ${formatNumber(dashboardSummary.weekAcplByTimeControl.bullet)}`,
      color: "grape",
      icon: <IconStar size={18} />,
    },
    {
      key: "accuracy-by-color",
      label: t("features.dashboard.kpi.accuracyByColor"),
      value: `W ${formatPercent(dashboardSummary.weekAccuracyByColor.white, 1)} · B ${formatPercent(dashboardSummary.weekAccuracyByColor.black, 1)}`,
      hint: t("features.dashboard.thisWeek"),
      color: "teal",
      icon: <IconTrophy size={18} />,
    },
    {
      key: "puzzle-variants-by-color",
      label: t("features.dashboard.kpi.puzzleVariantsByColor"),
      value: `W ${dashboardSummary.puzzleVariantsColorCoverage.whitePercent}% · B ${dashboardSummary.puzzleVariantsColorCoverage.blackPercent}%`,
      hint: `W ${dashboardSummary.puzzleVariantsColorCoverage.whitePuzzles} · B ${dashboardSummary.puzzleVariantsColorCoverage.blackPuzzles}`,
      color: "orange",
      icon: <IconFlame size={18} />,
    },
  ] as const;
  const resultTotal = dashboardSummary.outcomeCount;
  const winPercent = resultTotal > 0 ? Math.round((dashboardSummary.wins / resultTotal) * 100) : 0;
  const drawPercent = resultTotal > 0 ? Math.round((dashboardSummary.draws / resultTotal) * 100) : 0;
  const lossPercent = resultTotal > 0 ? Math.max(0, 100 - winPercent - drawPercent) : 0;
  const focusProgress = Math.min(100, Math.max(0, Math.round((dashboardSummary.weeklyPuzzleSolved / 35) * 100)));
  const handleProfileCardUpdate = async (
    newFideId: string,
    newFidePlayer: {
      name: string;
      firstName: string;
      gender: "male" | "female";
      title?: string;
      standardRating?: number;
      rapidRating?: number;
      blitzRating?: number;
      worldRank?: number;
      nationalRank?: number;
      photo?: string;
      age?: number;
      birthYear?: number;
    } | null,
    newDisplayName?: string,
    newLichessToken?: string,
  ) => {
    if (!activeProfileId) return;

    const now = Date.now();
    const cleanedFideId = newFideId.trim().replace(/\D/g, "");
    const nextDisplayName = (newDisplayName ?? "").trim();
    const nextToken = (newLichessToken ?? "").trim();

    setProfiles((prev) =>
      prev.map((p) =>
        p.id === activeProfileId
          ? {
              ...p,
              fideId: cleanedFideId || undefined,
              displayName: nextDisplayName || undefined,
              lichessToken: nextToken || undefined,
              updatedAt: now,
            }
          : p,
      ),
    );

    if (!cleanedFideId) {
      setFidePlayer(null);
      return;
    }

    if (newFidePlayer) {
      setFidePlayer({ ...newFidePlayer });
    } else {
      setFidePlayer(null);
    }
  };

  const shouldLoadFideData = activeFideId.length > 0;
  const shouldBlockDashboard = shouldLoadFideData;
  const isDashboardFullyLoading =
    !!activeProfileId &&
    shouldBlockDashboard &&
    !isDashboardLoadGateTimedOut &&
    ((shouldLoadFideData && !hasLoadedFideData) || (shouldLoadFideData && isLoadingFideData));

  return (
    <Box style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
      {isDashboardFullyLoading ? (
        <Center style={{ minHeight: "70vh" }}>
          <Stack align="center" gap="xs">
            <Loader size="lg" type="dots" color="blue" />
            <Text size="sm" c="dimmed">
              {t("common.loading", { defaultValue: "Loading..." })}
            </Text>
          </Stack>
        </Center>
      ) : (
        <Stack p="md" pt="sm" gap="md" style={{ minHeight: "100%" }}>
          <Card
            withBorder
            radius="md"
            p="sm"
            style={{
              position: "sticky",
              top: 0,
              zIndex: 5,
              backdropFilter: "blur(10px)",
              background:
                "linear-gradient(140deg, color-mix(in srgb, var(--mantine-color-dark-8) 92%, var(--mantine-color-blue-9) 8%), color-mix(in srgb, var(--mantine-color-dark-8) 94%, var(--mantine-color-cyan-9) 6%))",
              borderColor: "color-mix(in srgb, var(--mantine-color-blue-8) 28%, var(--mantine-color-dark-4))",
            }}
          >
            <Group justify="space-between" align="center" wrap="wrap" gap="sm">
              <Group align="center" gap="xs" wrap="wrap">
                <Text size="sm" fw={600}>
                  {t("profiles.profile")}
                </Text>
                {topProfileOptions.map((p) => (
                  <Button
                    key={p.id}
                    size="xs"
                    radius="xl"
                    variant={p.id === activeProfileId ? "light" : "subtle"}
                    onClick={() => setActiveProfileId(p.id)}
                    styles={{
                      root: { paddingInline: 10, minHeight: 28 },
                    }}
                  >
                    {p.name}
                  </Button>
                ))}
                {otherProfileOptions.length > 0 && (
                  <Select
                    size="xs"
                    radius="xl"
                    w={170}
                    value={otherProfileOptions.some((p) => p.id === activeProfileId) ? activeProfileId : null}
                    onChange={(value) => {
                      if (value) setActiveProfileId(value);
                    }}
                    data={otherProfileOptions.map((p) => ({ value: p.id, label: p.name }))}
                    placeholder={t("common.more", { defaultValue: "More" })}
                    clearable={false}
                    styles={{
                      input: {
                        backgroundColor: "var(--mantine-color-dark-6)",
                        borderColor: "var(--mantine-color-dark-4)",
                      },
                    }}
                  />
                )}
              </Group>

              <Group gap="xs" wrap="wrap">
                <Button
                  size="xs"
                  radius="xl"
                  variant="default"
                  leftSection={<IconChess size={14} />}
                  onClick={PLAY_CHESS.onClick}
                >
                  {t("features.dashboard.cards.playChess.button")}
                </Button>
                <Button
                  size="xs"
                  radius="xl"
                  variant="light"
                  leftSection={<IconRefresh size={14} />}
                  loading={isProfileSyncing}
                  onClick={() => {
                    void syncActiveProfileInPlace();
                  }}
                >
                  {t("profiles.sync.active", { defaultValue: "Update active profile" })}
                </Button>
              </Group>
            </Group>
          </Card>

          <Box pos="relative">
            <LoadingOverlay
              visible={!!activeProfileId && shouldLoadFideData && isLoadingFideData}
              zIndex={4}
              overlayProps={{ blur: 2, opacity: 0.35, radius: "md" }}
              loaderProps={{ type: "dots", color: "blue" }}
            />
            <Stack gap="md">
              <Grid gap="md" align="stretch">
                <Grid.Col span={{ base: 12, md: 6, lg: 4, xl: 3 }}>
                  <WelcomeCard
                    isFirstOpen={isFirstOpen}
                    compact
                    playerFirstName={displayName || fidePlayer?.firstName || undefined}
                    playerGender={fidePlayer?.gender}
                    fideInfo={fideInfo}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 6, lg: 4, xl: 5 }}>
                  <UserProfileCard
                    name={user.name}
                    handle={user.handle}
                    title={fidePlayer?.title || getChessTitle(user.rating)}
                    ratingHistory={ratingHistory}
                    ratingSources={ratingSources}
                    customName={displayName}
                    platform={platform}
                    linkedAccounts={linkedOnlineAccounts}
                    onFideUpdate={handleProfileCardUpdate}
                    fidePlayer={fidePlayer}
                    currentFideId={activeProfile?.fideId || undefined}
                    currentLichessToken={lichessToken}
                    weekBlunderRate={qualityInsights.weekBlunderRate}
                    previousWeekBlunderRate={qualityInsights.previousWeekBlunderRate}
                    weekAccuracy={qualityInsights.weekAccuracy}
                    previousWeekAccuracy={qualityInsights.previousWeekAccuracy}
                    weekAcpl={qualityInsights.weekAcpl}
                    previousWeekAcpl={qualityInsights.previousWeekAcpl}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 12, lg: 4, xl: 4 }}>
                  <Card
                    withBorder
                    radius="md"
                    p="lg"
                    h="100%"
                    style={{
                      background:
                        "radial-gradient(120% 180% at 100% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 42%, transparent) 0%, transparent 55%), linear-gradient(160deg, color-mix(in srgb, var(--mantine-color-dark-7) 80%, var(--mantine-color-dark-5) 20%), var(--mantine-color-dark-7))",
                      borderColor: "color-mix(in srgb, var(--mantine-color-blue-8) 35%, var(--mantine-color-dark-4))",
                    }}
                  >
                    <Stack h="100%" justify="space-between" gap="md">
                      <Group justify="space-between" align="flex-start" wrap="nowrap">
                        <Stack gap={4}>
                          <Text size="xs" tt="uppercase" c="dimmed">
                            {t("features.dashboard.dailyGoals")}
                          </Text>
                          <Text fz={{ base: "lg", md: "xl" }} fw={800}>
                            {t("features.dashboard.suggestedForYou")}
                          </Text>
                          <Text size="sm" c="dimmed">
                            {t("features.dashboard.keepStreak")}
                          </Text>
                        </Stack>
                        <ThemeIcon size={42} radius="md" color="blue" variant="light">
                          <IconTargetArrow size={22} />
                        </ThemeIcon>
                      </Group>

                      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
                        <Stack gap={6}>
                          <Group justify="space-between" wrap="nowrap">
                            <Text size="xs" c="dimmed">
                              {t("features.dashboard.win")}
                            </Text>
                            <Text size="sm" fw={700}>
                              {winPercent}%
                            </Text>
                          </Group>
                          <Progress value={winPercent} color="teal" radius="xl" size="sm" />
                        </Stack>
                        <Stack gap={6}>
                          <Group justify="space-between" wrap="nowrap">
                            <Text size="xs" c="dimmed">
                              {t("chess.draw")}
                            </Text>
                            <Text size="sm" fw={700}>
                              {drawPercent}%
                            </Text>
                          </Group>
                          <Progress value={drawPercent} color="gray" radius="xl" size="sm" />
                        </Stack>
                        <Stack gap={6}>
                          <Group justify="space-between" wrap="nowrap">
                            <Text size="xs" c="dimmed">
                              {t("features.dashboard.loss")}
                            </Text>
                            <Text size="sm" fw={700}>
                              {lossPercent}%
                            </Text>
                          </Group>
                          <Progress value={lossPercent} color="red" radius="xl" size="sm" />
                        </Stack>
                      </SimpleGrid>

                      <Stack gap={6}>
                        <Group justify="space-between" wrap="nowrap">
                          <Text size="xs" c="dimmed">
                            {t("features.dashboard.startPuzzleStreak")}
                          </Text>
                          <Text size="xs" fw={700}>
                            {focusProgress}%
                          </Text>
                        </Group>
                        <Progress value={focusProgress} color="blue" radius="xl" size="md" />
                      </Stack>

                      <Group gap="xs" wrap="wrap">
                        <Button
                          size="xs"
                          variant="light"
                          color="blue"
                          onClick={() => {
                            createTab({
                              tab: { name: t("features.tabs.puzzle.title"), type: "puzzles" },
                              setTabs,
                              setActiveTab,
                            });
                            navigate({ to: "/puzzles" });
                          }}
                        >
                          {t("features.tabs.puzzle.button")}
                        </Button>
                      </Group>
                    </Stack>
                  </Card>
                </Grid.Col>
              </Grid>

              <SimpleGrid cols={{ base: 1, xs: 2, sm: 3, md: 4, lg: 4, xl: 7 }} spacing="sm">
                {kpiCards.map((item) => (
                  <Card
                    key={item.key}
                    withBorder
                    p="md"
                    radius="lg"
                    style={{
                      background:
                        "radial-gradient(115% 165% at 100% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 18%, transparent) 0%, transparent 60%), linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-7) 84%, var(--mantine-color-dark-5) 16%), var(--mantine-color-dark-7))",
                      borderColor: "color-mix(in srgb, var(--mantine-color-blue-8) 16%, var(--mantine-color-dark-4))",
                      minHeight: 104,
                    }}
                  >
                    <Group justify="space-between" align="flex-start" wrap="nowrap">
                      <Stack gap={3}>
                        <Text size="xs" c="dimmed">
                          {item.label}
                        </Text>
                        <Text fw={800} fz="xl">
                          {item.value}
                        </Text>
                        <Text size="xs" c="dimmed" style={{ whiteSpace: "pre-line" }}>
                          {item.hint}
                        </Text>
                      </Stack>
                      <ThemeIcon color={item.color} variant="light" radius="md" size={34}>
                        {item.icon}
                      </ThemeIcon>
                    </Group>
                  </Card>
                ))}
              </SimpleGrid>
            </Stack>
          </Box>

          <Grid>
            <Grid.Col span={12}>
              <GamesHistoryCard
                profileId={activeProfileId}
                selectedOpponentId={selectedOpponentId}
                activeTab={activeGamesTab}
                onTabChange={setActiveGamesTab}
                localGames={recentGames}
                gameHistoryLimit={gameHistoryLimit}
                onGameHistoryLimitChange={setGameHistoryLimit}
                onAnalyzeAll={handleAnalyzeAll}
                onDeleteLocalGame={async (gameId: string) => {
                  await deleteGameRecord(activeProfileId, gameId);
                  const updatedGames = await getRecentGames(activeProfileId, gameHistoryLimit);
                  const filteredGames = updatedGames.filter((g) => {
                    if (g.moves?.length >= 5) return true;
                    if (g.pgn) {
                      const movesSection = g.pgn.split(/\n\n/)[1] || g.pgn;
                      const moveCount = (movesSection.match(/\d+\./g)?.length ?? 0) * 2;
                      return moveCount >= 5;
                    }
                    return false;
                  });
                  setRecentGames(filteredGames);
                  window.dispatchEvent(new Event("dashboard:games-history:refresh"));
                }}
                chessComGames={chessComGames}
                lichessGames={lichessGames}
                profileUsernames={profileUsernames}
                chessComUsernames={chessComUsernames}
                lichessUsernames={lichessUsernames}
                isLoadingOnlineGames={isLoadingChessComGames || isLoadingLichessGames}
                eventFilterId={eventFilterId}
                onEventFilterChange={setEventFilterId}
                eventOptions={eventOptions}
                isLoadingEventOptions={isLoadingEventOptions}
                onEventSearchChange={setEventSearch}
                eventSearchValue={eventSearch}
                profileDbPath={activeProfileDbPath}
                onOpponentSelected={setSelectedOpponentName}
                timeControlCategory={timeControlCategory}
                onTimeControlCategoryChange={setTimeControlCategory}
                onAnalyzeLocalGame={(game) => {
                  const headers = createLocalGameHeaders(game);
                  const pgn = game.pgn || createPGNFromMoves(game.moves, game.result, game.initialFen);
                  const isUserWhite = game.white.type === "human";
                  const isUserBlack = game.black.type === "human";
                  const orientation = isUserWhite
                    ? "white"
                    : isUserBlack
                      ? "black"
                      : getOrientationFromFen(game.initialFen) || getOrientationFromPgn(pgn) || "white";
                  headers.orientation = orientation;
                  createTab({
                    tab: {
                      name: `${headers.white} - ${headers.black}`,
                      type: "analysis",
                    },
                    setTabs,
                    setActiveTab,
                    pgn,
                    headers,
                    initialAnalysisTab: "analysis",
                    initialAnalysisSubTab: "report",
                    initialNotationView: "report",
                  }).then((tabId) => {
                    // Store the gameId in sessionStorage so we can update it when analysis completes
                    if (tabId && typeof window !== "undefined") {
                      sessionStorage.setItem(`${tabId}_localGameId`, game.id);
                    }
                  });
                }}
                onAnalyzeChessComGame={(game, meta) => {
                  if (game.pgn) {
                    const headers = createChessComGameHeaders(game);
                    const accountUsername =
                      chessComUsernames.find(
                        (u) =>
                          u.toLowerCase() === game.white.username.toLowerCase() ||
                          u.toLowerCase() === game.black.username.toLowerCase(),
                      ) || game.white.username;
                    const orientation = meta.playerColor;
                    headers.orientation = orientation;
                    createTab({
                      tab: {
                        name: `${game.white.username} - ${game.black.username}`,
                        type: "analysis",
                      },
                      setTabs,
                      setActiveTab,
                      pgn: game.pgn,
                      headers,
                      initialAnalysisTab: "analysis",
                      initialAnalysisSubTab: "report",
                      initialNotationView: "report",
                    }).then((tabId) => {
                      // Store the game URL and username in sessionStorage so we can save the analyzed PGN when analysis completes
                      if (tabId && typeof window !== "undefined") {
                        sessionStorage.setItem(`${tabId}_chessComGameUrl`, game.url);
                        sessionStorage.setItem(`${tabId}_chessComUsername`, accountUsername);
                        const resolvedProfileId = meta?.profileId ?? activeProfileId ?? null;
                        const resolvedDbGameId =
                          meta?.profileDbGameId ??
                          (resolvedProfileId
                            ? profileDbIdByExternalKeyRef.current.get(`chesscom:${game.url}`)
                            : undefined);
                        if (resolvedProfileId) {
                          sessionStorage.setItem(`${tabId}_profileId`, resolvedProfileId);
                        }
                        if (resolvedProfileId && resolvedDbGameId) {
                          sessionStorage.setItem(`${tabId}_profileDbGameId`, resolvedDbGameId);
                        } else if (resolvedProfileId) {
                          // Fallback (no race): resolve internal Games.ID on demand.
                          invoke<string | null>("dashboard_resolve_profile_db_game_id", {
                            profileId: resolvedProfileId,
                            kind: "chesscom",
                            gameKey: game.url,
                          })
                            .then((id) => {
                              const v = (id ?? "").trim();
                              if (!v) return;
                              profileDbIdByExternalKeyRef.current.set(`chesscom:${game.url}`, v);
                              sessionStorage.setItem(`${tabId}_profileDbGameId`, v);
                            })
                            .catch(() => {
                              // ignore
                            });
                        }
                      }
                    });
                  }
                }}
                onAnalyzeLichessGame={(game, meta) => {
                  if (game.pgn) {
                    const headers = createLichessGameHeaders(game);
                    const gameWhiteName = game.players.white.user?.name || "";
                    const gameBlackName = game.players.black.user?.name || "";
                    const accountUsername =
                      lichessUsernames.find(
                        (u) =>
                          u.toLowerCase() === gameWhiteName.toLowerCase() ||
                          u.toLowerCase() === gameBlackName.toLowerCase(),
                      ) || gameWhiteName;
                    const orientation = meta.playerColor;
                    headers.orientation = orientation;
                    createTab({
                      tab: {
                        name: `${headers.white} - ${headers.black}`,
                        type: "analysis",
                      },
                      setTabs,
                      setActiveTab,
                      pgn: game.pgn,
                      headers,
                      initialAnalysisTab: "analysis",
                      initialAnalysisSubTab: "report",
                      initialNotationView: "report",
                    }).then((tabId) => {
                      // Store the game ID and username in sessionStorage so we can save the analyzed PGN when analysis completes
                      if (tabId && typeof window !== "undefined") {
                        sessionStorage.setItem(`${tabId}_lichessGameId`, game.id);
                        sessionStorage.setItem(`${tabId}_lichessUsername`, accountUsername);
                        const resolvedProfileId = meta?.profileId ?? activeProfileId ?? null;
                        const resolvedDbGameId =
                          meta?.profileDbGameId ??
                          (resolvedProfileId
                            ? profileDbIdByExternalKeyRef.current.get(`lichess:${game.id}`)
                            : undefined);
                        if (resolvedProfileId) {
                          sessionStorage.setItem(`${tabId}_profileId`, resolvedProfileId);
                        }
                        if (resolvedProfileId && resolvedDbGameId) {
                          sessionStorage.setItem(`${tabId}_profileDbGameId`, resolvedDbGameId);
                        } else if (resolvedProfileId) {
                          // Fallback (no race): resolve internal Games.ID on demand.
                          invoke<string | null>("dashboard_resolve_profile_db_game_id", {
                            profileId: resolvedProfileId,
                            kind: "lichess",
                            gameKey: game.id,
                          })
                            .then((id) => {
                              const v = (id ?? "").trim();
                              if (!v) return;
                              profileDbIdByExternalKeyRef.current.set(`lichess:${game.id}`, v);
                              sessionStorage.setItem(`${tabId}_profileDbGameId`, v);
                            })
                            .catch(() => {
                              // ignore
                            });
                        }
                      }
                    });
                  }
                }}
                onToggleFavoriteLocal={async (gameId: string) => {
                  const isFavorite = await isFavoriteGame(gameId, "local");
                  if (isFavorite) {
                    await removeFavoriteGame(gameId, "local");
                  } else {
                    await saveFavoriteGame(gameId, "local");
                  }
                  loadFavoriteGames();
                }}
                onToggleFavoriteChessCom={async (gameId: string) => {
                  const isFavorite = await isFavoriteGame(gameId, "chesscom");
                  if (isFavorite) {
                    await removeFavoriteGame(gameId, "chesscom");
                  } else {
                    await saveFavoriteGame(gameId, "chesscom");
                  }
                  loadFavoriteGames();
                }}
                onToggleFavoriteLichess={async (gameId: string) => {
                  const isFavorite = await isFavoriteGame(gameId, "lichess");
                  if (isFavorite) {
                    await removeFavoriteGame(gameId, "lichess");
                  } else {
                    await saveFavoriteGame(gameId, "lichess");
                  }
                  loadFavoriteGames();
                }}
                favoriteGames={favoriteGames}
              />
            </Grid.Col>
          </Grid>

          <Grid>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <PuzzleStatsCard
                stats={puzzleStats}
                onStartPuzzles={() => {
                  createTab({
                    tab: { name: t("features.tabs.puzzle.title"), type: "puzzles" },
                    setTabs,
                    setActiveTab,
                  });
                  navigate({ to: "/puzzles" });
                }}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <PuzzleVariantsCard />
            </Grid.Col>
          </Grid>

          <AnalyzeAllModal
            opened={analyzeAllModalOpened}
            onClose={() => {
              setAnalyzeAllModalOpened(false);
            }}
            engineOptions={localEngines.map((e) => ({ value: e.path, label: e.name }))}
            initialEnginePath={defaultEngine?.path ?? null}
            onAnalyze={async (config, onProgress, isCancelled) => {
              const selectedEngine = localEngines.find((e) => e.path === config.enginePath) ?? defaultEngine ?? null;
              if (!selectedEngine) {
                notifications.show({
                  title: t("features.dashboard.noEngineAvailable"),
                  message: t("features.dashboard.noEngineAvailableMessage"),
                  color: "red",
                });
                return;
              }

              const analyzeAllRunSpan = startPerfBaselineSpan({
                scope: "dashboard.analyze_all",
                label: "run",
                metadata: {
                  profileId: activeProfileId ?? "none",
                  target: analyzeAllGameType ?? "none",
                  analyzeMode: config.analyzeMode,
                  engine: selectedEngine.name,
                  timeMs: config.timeMs,
                },
              });
              let baselineStatus = "running";
              let baselineCandidateGames = 0;
              let baselineGamesToAnalyze = 0;

              let warnedMissingInternalId = false;
              let warnedStatsPersistFailed = false;

              // Create activeAnalysisIds set early so stop function can access it
              const activeAnalysisIds = new Set<string>();

              // Function to stop all active engines - defined early so it can be returned immediately
              const stopAllEngines = async () => {
                const stopPromises = Array.from(activeAnalysisIds).map((analysisId) =>
                  commands.stopEngine(selectedEngine.path, analysisId).catch(() => {
                    // Ignore errors when stopping
                  }),
                );
                await Promise.all(stopPromises);
                activeAnalysisIds.clear();
              };

              const analyzeMinMoves = Math.max(5, analyzeAllScopeFilters.minMoves ?? 0);
              const scopedRowsForRun = analyzeAllScopedRows.filter((row) => (row.moves ?? 0) >= analyzeMinMoves);
              const rowsForSelectedType = scopedRowsForRun.filter((row) =>
                analyzeAllGameType === "all" ? true : row.kind === analyzeAllGameType,
              );
              const analyzedByScopedRow = new Map<string, boolean>(
                rowsForSelectedType.map((row) => [`${row.kind}:${row.gameKey}`, isRowReadyForAnalyzeSkip(row)]),
              );

              // Build map external key -> internal profile DB game id (Games.ID), scoped to the same
              // filters used by the modal count whenever possible.
              const internalIdByExternalKey = new Map<string, string>();
              if (activeProfileId) {
                let idRows: GamesHistoryRow[] = scopedRowsForRun;
                if (idRows.length === 0) {
                  try {
                    const idLookupLimit = Math.max(5000, gameHistoryLimit);
                    const res = (await invoke<{ rows?: GamesHistoryRow[] }>("dashboard_get_games_history_rows", {
                      req: {
                        profileId: activeProfileId,
                        profileUsernames,
                        gameHistoryLimit: idLookupLimit,
                        page: 1,
                        pageSize: idLookupLimit,
                        eventFilterId,
                        selectedOpponentId,
                        opponentContains: analyzeAllScopeFilters.opponentContains,
                        timeControlCategory,
                        resultFilter: analyzeAllScopeFilters.resultFilter,
                        playerColor: analyzeAllScopeFilters.playerColor,
                        minMoves: analyzeAllScopeFilters.minMoves,
                        sortBy: "date",
                        sortDirection: "desc",
                      },
                    })) ?? { rows: [] };
                    idRows = (res.rows ?? []).filter((row) => (row.moves ?? 0) >= analyzeMinMoves);
                  } catch {
                    idRows = [];
                  }
                }

                for (const row of idRows) {
                  if (row.kind === "chesscom" || row.kind === "lichess") {
                    internalIdByExternalKey.set(`${row.kind}:${row.gameKey}`, row.analysisGameId);
                  }
                }
              }

              const resolveInternalId = async (
                kind: "chesscom" | "lichess",
                gameKey: string,
              ): Promise<string | null> => {
                if (!activeProfileId) return null;
                try {
                  const id = await invoke<string | null>("dashboard_resolve_profile_db_game_id", {
                    profileId: activeProfileId,
                    kind,
                    gameKey,
                  });
                  const v = (id ?? "").trim();
                  if (!v) return null;
                  internalIdByExternalKey.set(`${kind}:${gameKey}`, v);
                  return v;
                } catch {
                  return null;
                }
              };

              const hasEnoughMovesPgn = (pgn?: string | null) => hasEnoughMovesInPgn(pgn, 5);

              const hasEnoughMovesLocal = (g: GameRecord) => {
                if (g.moves && g.moves.length >= 5) return true;
                return hasEnoughMovesPgn(g.pgn);
              };

              const PLAY_VS_PC_EVENT_LOWER = "play vs pc";
              const localByKey = new Map(
                recentGames.filter((g) => hasEnoughMovesLocal(g)).map((g) => [g.id, g] as const),
              );
              const chessComByKey = new Map(
                chessComGames.filter((g) => hasEnoughMovesPgn(g.pgn)).map((g) => [g.url, g] as const),
              );
              const lichessByKey = new Map(
                lichessGames.filter((g) => hasEnoughMovesPgn(g.pgn)).map((g) => [g.id, g] as const),
              );
              const rowByKindKey = new Map(
                rowsForSelectedType.map((row) => [`${row.kind}:${row.gameKey}`, row] as const),
              );

              const allGames = rowsForSelectedType
                .filter((row) => {
                  const rowPgn = row.pgn?.trim() ?? "";
                  if (!rowPgn) return false;
                  if (row.kind === "chessbase") {
                    return (row.eventName?.trim() ?? "").toLowerCase() !== PLAY_VS_PC_EVENT_LOWER;
                  }
                  return true;
                })
                .map((row) => {
                  if (row.kind === "local") {
                    const local = localByKey.get(row.gameKey);
                    return local ? { type: "local" as const, game: local } : { type: "chessbase" as const, game: row };
                  }
                  if (row.kind === "chesscom") {
                    const chessCom = chessComByKey.get(row.gameKey);
                    return chessCom
                      ? { type: "chesscom" as const, game: chessCom }
                      : { type: "chessbase" as const, game: row };
                  }
                  if (row.kind === "lichess") {
                    const lichess = lichessByKey.get(row.gameKey);
                    return lichess
                      ? { type: "lichess" as const, game: lichess }
                      : { type: "chessbase" as const, game: row };
                  }
                  return { type: "chessbase" as const, game: row };
                });
              baselineCandidateGames = allGames.length;

              let analyzedGameIds = new Set<string>();
              if (config.analyzeMode === "unanalyzed") {
                const lookupIds = new Set<string>();
                for (const item of allGames) {
                  if (item.type === "local") {
                    lookupIds.add((item.game as GameRecord).id);
                  } else if (item.type === "chessbase") {
                    lookupIds.add(String((item.game as GamesHistoryRow).analysisGameId));
                  } else if (item.type === "chesscom") {
                    const internalId = internalIdByExternalKey.get(
                      `chesscom:${(item.game as ChessComGameWithEvent).url}`,
                    );
                    if (internalId) {
                      lookupIds.add(internalId);
                    }
                  } else {
                    const internalId = internalIdByExternalKey.get(
                      `lichess:${(item.game as (typeof lichessGames)[0]).id}`,
                    );
                    if (internalId) {
                      lookupIds.add(internalId);
                    }
                  }
                }

                try {
                  const bulk = await getAnalyzedGamesBulk(Array.from(lookupIds), activeProfileId ?? null);
                  analyzedGameIds = new Set(bulk.keys());
                } catch (e) {
                  notifications.show({
                    title: t("common.error"),
                    message: t("features.dashboard.analysisUnexpectedError", {
                      defaultValue: "Analyze all failed before starting. {{error}}",
                      error: String(e),
                    }),
                    color: "red",
                  });
                  baselineStatus = "precheck_failed";
                  await finishPerfBaselineSpan(analyzeAllRunSpan, {
                    status: baselineStatus,
                    candidateGames: baselineCandidateGames,
                  });
                  return;
                }
              }

              // Filter to only unanalyzed games if requested
              let gamesToAnalyze =
                config.analyzeMode === "unanalyzed"
                  ? allGames.filter((item) => {
                      if (item.type === "local") {
                        const gameRecord = item.game as GameRecord;
                        const scoped = analyzedByScopedRow.get(`local:${gameRecord.id}`);
                        if (scoped !== undefined) return !scoped;
                        // For "only unanalyzed", use analysis.db3 only (profile-aware).
                        const existsInDb = analyzedGameIds.has(String(gameRecord.id));
                        if (existsInDb) return false; // Already analyzed
                        return true;
                      } else if (item.type === "chesscom") {
                        const chessComGame = item.game as ChessComGameWithEvent;
                        const scoped = analyzedByScopedRow.get(`chesscom:${chessComGame.url}`);
                        if (scoped !== undefined) return !scoped;
                        // Check if this game has been analyzed
                        const internalId = internalIdByExternalKey.get(`chesscom:${chessComGame.url}`);
                        const existsInDb = internalId ? analyzedGameIds.has(internalId) : false;
                        if (existsInDb) return false; // Already analyzed
                        return true;
                      } else if (item.type === "chessbase") {
                        const row = item.game as GamesHistoryRow;
                        const scoped = analyzedByScopedRow.get(`chessbase:${row.gameKey}`);
                        if (scoped !== undefined) return !scoped;
                        const existsInDb = analyzedGameIds.has(String(row.analysisGameId));
                        if (existsInDb) return false;
                        return true;
                      } else {
                        // lichess
                        const lichessGame = item.game as (typeof lichessGames)[0];
                        const scoped = analyzedByScopedRow.get(`lichess:${lichessGame.id}`);
                        if (scoped !== undefined) return !scoped;
                        // Check if this game has been analyzed
                        const internalId = internalIdByExternalKey.get(`lichess:${lichessGame.id}`);
                        const existsInDb = internalId ? analyzedGameIds.has(internalId) : false;
                        if (existsInDb) return false; // Already analyzed
                        return true;
                      }
                    })
                  : allGames;

              if (config.analyzeMode === "unanalyzed" && gamesToAnalyze.length === 0) {
                const fallbackRows = rowsForSelectedType.filter((row) => {
                  if (isRowReadyForAnalyzeSkip(row)) return false;
                  const rowPgn = row.pgn?.trim() ?? "";
                  if (!rowPgn) return false;
                  if (row.kind === "chessbase") {
                    return (row.eventName?.trim() ?? "").toLowerCase() !== PLAY_VS_PC_EVENT_LOWER;
                  }
                  return true;
                });
                gamesToAnalyze = fallbackRows.map((row) => ({ type: "chessbase" as const, game: row }));
              }

              baselineGamesToAnalyze = gamesToAnalyze.length;
              await perfBaselinePoint({
                scope: "dashboard.analyze_all",
                label: "selection_ready",
                metadata: {
                  candidateGames: baselineCandidateGames,
                  gamesToAnalyze: baselineGamesToAnalyze,
                  analyzeMode: config.analyzeMode,
                },
              });

              if (gamesToAnalyze.length === 0) {
                notifications.show({
                  title: "No Games to Analyze",
                  message:
                    config.analyzeMode === "unanalyzed"
                      ? "No unanalyzed games available to analyze."
                      : "No games with PGN data available to analyze.",
                  color: "orange",
                });
                baselineStatus = "no_games";
                await finishPerfBaselineSpan(analyzeAllRunSpan, {
                  status: baselineStatus,
                  candidateGames: baselineCandidateGames,
                  gamesToAnalyze: baselineGamesToAnalyze,
                });
                return;
              }

              const goMode: GoMode = { t: "Time", c: config.timeMs };
              const engineSettings = (selectedEngine.settings ?? []).map((s) => ({
                ...s,
                value: s.value?.toString() ?? "",
              }));

              // Force Threads to 1 for each individual analysis, regardless of engine configuration
              const threadsSetting = engineSettings.find((s) => s.name.toLowerCase() === "threads");
              if (threadsSetting) {
                threadsSetting.value = "1";
              } else {
                // Add Threads setting if it doesn't exist
                engineSettings.push({ name: "Threads", value: "1" });
              }

              // Create directory for analyzed games
              let analyzedDir: string;
              try {
                const baseDir = await appDataDir();
                analyzedDir = await resolve(baseDir, "analyzed-games");
                await mkdir(analyzedDir, { recursive: true });
              } catch (e) {
                notifications.show({
                  title: t("common.error"),
                  message: t("features.dashboard.analysisUnexpectedError", {
                    defaultValue: "Analyze all failed before starting. {{error}}",
                    error: String(e),
                  }),
                  color: "red",
                });
                baselineStatus = "setup_failed";
                await finishPerfBaselineSpan(analyzeAllRunSpan, {
                  status: baselineStatus,
                  candidateGames: baselineCandidateGames,
                  gamesToAnalyze: baselineGamesToAnalyze,
                });
                return;
              }

              const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
              const folderName = `${analyzedDir}/${analyzeAllGameType}-analyzed-${timestamp}`;
              await mkdir(folderName, { recursive: true });

              notifications.show({
                title: t("features.dashboard.analysisStarted"),
                message: t("features.dashboard.analysisUsingEngine", {
                  defaultValue: "Analyzing {{count}} games using {{engine}} ({{timeMs}} ms).",
                  count: gamesToAnalyze.length,
                  engine: selectedEngine.name,
                  timeMs: config.timeMs,
                }),
                color: "blue",
              });

              let successCount = 0;
              let failCount = 0;
              let completedCount = 0;
              let pendingRefreshUpdates = 0;
              let cancellationNotified = false;
              let warnedBackendJobError = false;
              const backendJobErrors: string[] = [];
              let stopRequested = false;
              let currentRunId: string | null = null;
              let gamesHistoryRefreshTimer: ReturnType<typeof setTimeout> | null = null;

              const notifyCancellation = () => {
                if (cancellationNotified) return;
                cancellationNotified = true;
                notifications.show({
                  title: t("features.dashboard.analysisCancelled"),
                  message: `Analysis stopped. ${successCount} games analyzed successfully.`,
                  color: "yellow",
                });
              };

              const stopAllEnginesOnce = async () => {
                if (stopRequested) return;
                stopRequested = true;
                if (currentRunId) {
                  await invoke("dashboard_analyze_all_cancel", { runId: currentRunId }).catch(() => {
                    // best-effort
                  });
                }
                await stopAllEngines();
              };

              const emitGamesHistoryRefresh = (immediate = false) => {
                if (immediate) {
                  if (gamesHistoryRefreshTimer) {
                    clearTimeout(gamesHistoryRefreshTimer);
                    gamesHistoryRefreshTimer = null;
                  }
                  window.dispatchEvent(new Event("dashboard:games-history:refresh"));
                  return;
                }
                if (gamesHistoryRefreshTimer) {
                  clearTimeout(gamesHistoryRefreshTimer);
                }
                gamesHistoryRefreshTimer = setTimeout(() => {
                  window.dispatchEvent(new Event("dashboard:games-history:refresh"));
                  gamesHistoryRefreshTimer = null;
                }, 250);
              };

              const openingFenCache = new Map<string, boolean>();
              const isOpeningFen = async (fen: string): Promise<boolean> => {
                const cached = openingFenCache.get(fen);
                if (cached !== undefined) return cached;
                try {
                  const res = await commands.getOpeningFromFen(fen);
                  if (res.status === "ok" && !!res.data) {
                    openingFenCache.set(fen, true);
                    return true;
                  }
                } catch {
                  // ignore
                }
                try {
                  const resInfo = await commands.getOpeningInfoFromFen(fen);
                  if (resInfo.status === "ok" && !!resInfo.data) {
                    openingFenCache.set(fen, true);
                    return true;
                  }
                } catch {
                  // ignore
                }
                openingFenCache.set(fen, false);
                return false;
              };

              const collectOpeningFensFromMainline = async (root: TreeState["root"]): Promise<Set<string>> => {
                const out = new Set<string>();
                let current = root;
                while (current.children.length > 0) {
                  const next = current.children[0];
                  if (!next) break;
                  if (await isOpeningFen(next.fen)) {
                    out.add(next.fen);
                  }
                  current = next;
                }
                return out;
              };

              // Keep cancellation checks cheap: one watcher for the whole analyze-all run.
              const cancellationWatcher = setInterval(() => {
                if (!isCancelled()) return;
                void stopAllEnginesOnce();
              }, 120);

              // Process games in parallel batches
              const processGame = async (
                item: (typeof gamesToAnalyze)[0],
                index: number,
                providedAnalysis?: MoveAnalysis[] | null,
                preparedJob?: DashboardAnalyzeAllBackendJob | null,
              ): Promise<void> => {
                const gameType = item.type;
                const game = item.game;
                const analysisId = `analyze_all_${gameType}_${index}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
                activeAnalysisIds.add(analysisId);

                try {
                  let tree: TreeState;
                  let moves: string[];
                  let initialFen: string;
                  let gameHeaders: ReturnType<
                    typeof createLocalGameHeaders | typeof createChessComGameHeaders | typeof createLichessGameHeaders
                  >;
                  let inferredOrientation: "white" | "black" | undefined;

                  if (gameType === "local") {
                    // For local games, use PGN if available, otherwise reconstruct from moves
                    const gameRecord = game as GameRecord;
                    const pgn =
                      gameRecord.pgn || createPGNFromMoves(gameRecord.moves, gameRecord.result, gameRecord.initialFen);
                    tree = await parsePGN(pgn, gameRecord.initialFen);
                    const is960 = tree.headers?.variant === "Chess960";
                    moves = getMainLine(tree.root, is960);
                    initialFen = tree.headers?.fen || gameRecord.initialFen || DEFAULT_START_FEN;
                    gameHeaders = createLocalGameHeaders(gameRecord);
                    if (gameRecord.white.type === "human") {
                      inferredOrientation = "white";
                    } else if (gameRecord.black.type === "human") {
                      inferredOrientation = "black";
                    }
                  } else if (gameType === "chesscom") {
                    // For Chess.com games, parse PGN
                    const chessComGame = game as ChessComGameWithEvent;
                    const pgn = chessComGame.pgn;
                    if (!pgn) {
                      return;
                    }
                    tree = await parsePGN(pgn);
                    // Extract UCI moves from the main line using getMainLine
                    const is960 = tree.headers?.variant === "Chess960";
                    moves = getMainLine(tree.root, is960);
                    initialFen = tree.headers?.fen || DEFAULT_START_FEN;
                    gameHeaders = createChessComGameHeaders(chessComGame);
                    const whiteUsername = chessComGame.white.username.toLowerCase();
                    const blackUsername = chessComGame.black.username.toLowerCase();
                    const accountUsername =
                      chessComUsernames
                        .find((u) => u.toLowerCase() === whiteUsername || u.toLowerCase() === blackUsername)
                        ?.toLowerCase() ?? null;
                    if (accountUsername) {
                      inferredOrientation = whiteUsername === accountUsername ? "white" : "black";
                    }
                    if (!inferredOrientation) {
                      const row = rowByKindKey.get(`chesscom:${chessComGame.url}`);
                      if (row) {
                        inferredOrientation = row.color === "black" ? "black" : "white";
                      }
                    }
                  } else if (gameType === "chessbase") {
                    const row = game as GamesHistoryRow;
                    const rowInitialFen =
                      ((row as { initialFen?: string | null }).initialFen ?? "").trim() || undefined;
                    const preparedFen = preparedJob?.fen?.trim() || rowInitialFen || DEFAULT_START_FEN;
                    const preparedMoves = Array.isArray(preparedJob?.moves)
                      ? preparedJob.moves.map((m) => m.trim()).filter((m) => m.length > 0)
                      : [];

                    const pgnCandidates = [row.pgn ?? null, preparedJob?.pgn ?? null]
                      .map((p) => p?.trim() ?? "")
                      .filter((p, i, arr) => p.length > 0 && arr.indexOf(p) === i);

                    let parsedTree: TreeState | null = null;
                    let parsedMoves: string[] = [];
                    for (const pgnCandidate of pgnCandidates) {
                      try {
                        const candidateTree = await parsePGN(pgnCandidate, rowInitialFen);
                        const candidateIs960 = candidateTree.headers?.variant === "Chess960";
                        const candidateMoves = getMainLine(candidateTree.root, candidateIs960);
                        if (!parsedTree) {
                          parsedTree = candidateTree;
                          parsedMoves = candidateMoves;
                        }
                        if (preparedMoves.length > 0) {
                          const aligned =
                            candidateMoves.length === preparedMoves.length &&
                            candidateMoves.every((m, i) => m === preparedMoves[i]);
                          if (aligned) {
                            parsedTree = candidateTree;
                            parsedMoves = candidateMoves;
                            break;
                          }
                        } else if (candidateMoves.length > 0) {
                          parsedTree = candidateTree;
                          parsedMoves = candidateMoves;
                          break;
                        }
                      } catch {
                        // try next candidate
                      }
                    }

                    if (preparedMoves.length > 0) {
                      const parsedAligned =
                        parsedMoves.length === preparedMoves.length &&
                        parsedMoves.every((m, i) => m === preparedMoves[i]);
                      if (!parsedAligned) {
                        const rebuiltTree = buildTreeFromUciMoves(preparedFen, preparedMoves);
                        if (rebuiltTree) {
                          parsedTree = rebuiltTree;
                          parsedMoves = [...preparedMoves];
                        }
                      }
                    }
                    if (!parsedTree) {
                      return;
                    }

                    tree = parsedTree;
                    moves =
                      parsedMoves.length > 0
                        ? parsedMoves
                        : getMainLine(tree.root, tree.headers?.variant === "Chess960");
                    initialFen = tree.headers?.fen || preparedFen;
                    gameHeaders = {
                      id: 0,
                      event: tree.headers?.event || "ChessBase",
                      site: "ChessBase",
                      date: tree.headers?.date || "",
                      white: tree.headers?.white || "White",
                      black: tree.headers?.black || "Black",
                      result: (tree.headers?.result || "*") as any,
                      fen: initialFen,
                    } as ReturnType<typeof createLocalGameHeaders>;
                    inferredOrientation = row.color === "black" ? "black" : "white";
                  } else {
                    // Lichess games
                    const lichessGame = game as (typeof lichessGames)[0];
                    const pgn = lichessGame.pgn;
                    if (!pgn) {
                      return;
                    }
                    tree = await parsePGN(pgn);
                    // Extract UCI moves from the main line using getMainLine
                    const is960 = tree.headers?.variant === "Chess960";
                    moves = getMainLine(tree.root, is960);
                    initialFen = tree.headers?.fen || DEFAULT_START_FEN;
                    gameHeaders = createLichessGameHeaders(lichessGame);
                    const whiteUsername = (lichessGame.players.white.user?.name || "").toLowerCase();
                    const blackUsername = (lichessGame.players.black.user?.name || "").toLowerCase();
                    const accountUsername =
                      lichessUsernames
                        .find((u) => u.toLowerCase() === whiteUsername || u.toLowerCase() === blackUsername)
                        ?.toLowerCase() ?? null;
                    if (accountUsername) {
                      inferredOrientation = whiteUsername === accountUsername ? "white" : "black";
                    }
                    if (!inferredOrientation) {
                      const row = rowByKindKey.get(`lichess:${lichessGame.id}`);
                      if (row) {
                        inferredOrientation = row.color === "black" ? "black" : "white";
                      }
                    }
                  }

                  if (!inferredOrientation) {
                    const parsedOrientation = tree.headers?.orientation;
                    if (parsedOrientation === "white" || parsedOrientation === "black") {
                      inferredOrientation = parsedOrientation;
                    }
                  }
                  if (inferredOrientation) {
                    gameHeaders.orientation = inferredOrientation;
                  }

                  // Check if cancelled before starting analysis
                  if (isCancelled()) {
                    return;
                  }

                  let analysis: MoveAnalysis[];
                  if (providedAnalysis && providedAnalysis.length > 0) {
                    analysis = providedAnalysis;
                  } else {
                    const analysisPromise = commands.analyzeGame(
                      analysisId,
                      selectedEngine.path,
                      goMode,
                      {
                        annotateNovelties: false,
                        fen: initialFen,
                        referenceDb: null,
                        reversed: false,
                        moves,
                      },
                      engineSettings,
                    );

                    let analysisResult: Awaited<typeof analysisPromise>;
                    try {
                      analysisResult = await analysisPromise;
                    } catch (_error) {
                      // Analyze-all cancellation is handled by the shared watcher and stopAllEngines().
                      if (isCancelled()) {
                        return;
                      }
                      throw _error;
                    }

                    // Check again if cancelled after analysis
                    if (isCancelled()) {
                      return;
                    }

                    analysis = unwrap(analysisResult);
                  }

                  // Apply analysis using the same function used in individual analysis.
                  // Include opening-book scope so "Book" marks are generated consistently.
                  const openingFens = await collectOpeningFensFromMainline(tree.root);
                  addAnalysis(tree, analysis, { openingFens });

                  // Update tree headers with gameHeaders to ensure names are included
                  tree.headers = {
                    ...tree.headers,
                    ...gameHeaders,
                    fen: tree.headers.fen || gameHeaders.fen, // Preserve FEN from parsed PGN
                  };

                  try {
                    const orientation = tree.headers.orientation;
                    const humanColor = orientation === "white" || orientation === "black" ? orientation : null;
                    const effectiveBookProfileId =
                      gameType === "local"
                        ? ((game as GameRecord).profileId ?? activeProfileId ?? null)
                        : (activeProfileId ?? null);
                    const bookReview = await detectProfileBookReview({
                      profileId: effectiveBookProfileId,
                      initialFen,
                      moves,
                      humanColor,
                    });
                    const bookErrors = bookReview.errors;
                    const bookUnknowns = bookReview.unknowns;
                    const variantBookPlies = bookReview.matchedPlies;
                    if (import.meta.env.DEV) {
                      console.debug("[analyze-all] variants book check", {
                        gameType,
                        index,
                        orientation,
                        humanColor,
                        effectiveBookProfileId,
                        errors: bookErrors.length,
                        unknowns: bookUnknowns.length,
                        matches: variantBookPlies.length,
                        first: bookErrors[0] ?? null,
                      });
                    }
                    clearBookErrorAnnotations(tree.root);
                    applyProfileBookPriorityToMainline(tree.root, {
                      matchedPlies: variantBookPlies,
                      errors: bookErrors.map((item) => ({
                        ply: item.ply,
                        expectedMove: item.expectedMove,
                        expectedMoves: item.expectedMoves,
                        playedMove: item.playedMove,
                      })),
                      unknowns: bookUnknowns.map((item) => ({
                        ply: item.ply,
                        expectedMove: item.expectedMove,
                        expectedMoves: item.expectedMoves,
                        playedMove: item.playedMove,
                      })),
                    });
                  } catch {
                    // Keep analyze-all resilient if variants-book detection fails.
                  }

                  // Check if cancelled before saving
                  if (isCancelled()) {
                    return;
                  }

                  // Generate PGN with analysis
                  let analyzedPgn = getPGN(tree.root, {
                    headers: tree.headers,
                    comments: true,
                    extraMarkups: true,
                    glyphs: true,
                    variations: true,
                  });

                  // Validate and fix PGN before saving
                  if (!analyzedPgn || analyzedPgn.trim().length === 0) {
                    return;
                  }

                  // Ensure PGN has a result (required for valid PGN)
                  const hasResult =
                    /\[Result\s+"[^"]+"\]/.test(analyzedPgn) || /\s+(1-0|0-1|1\/2-1\/2|\*)\s*$/.test(analyzedPgn);
                  if (!hasResult && tree.headers?.result) {
                    analyzedPgn = `${analyzedPgn.trim()} ${tree.headers.result}`;
                  } else if (!hasResult) {
                    analyzedPgn = `${analyzedPgn.trim()} *`;
                  }

                  // Only save if analysis was not cancelled
                  if (!isCancelled()) {
                    // Save analyzed PGN to file
                    const fileName = `${gameHeaders.white}-${gameHeaders.black}-${index + 1}`.replace(
                      /[<>:"/\\|?*]/g,
                      "_",
                    );
                    const filePath = await resolve(folderName, `${fileName}.pgn`);

                    await writeTextFile(filePath, analyzedPgn);

                    // Calculate stats from the analyzed game
                    const reportStats = getGameStats(tree.root);

                    // Update the game object with the analyzed PGN and stats
                    if (gameType === "local") {
                      const gameRecord = game as GameRecord;

                      // Determine which color the user played
                      const isUserWhite = gameRecord.white.type === "human";
                      const userColor = isUserWhite ? "white" : "black";
                      const calculatedStats = buildStatsPayloadForBackend(reportStats, userColor, tree);

                      // Update the game record with analyzed PGN and stats
                      if (calculatedStats) {
                        await updateGameRecord(gameRecord.id, { pgn: analyzedPgn, stats: calculatedStats });
                      } else {
                        await updateGameRecord(gameRecord.id, { pgn: analyzedPgn });
                      }
                      // Also save to analyzed games database for consistency
                      await saveAnalyzedGame(gameRecord.id, analyzedPgn, gameRecord.profileId ?? null);
                    } else if (gameType === "chesscom") {
                      const chessComGame = game as ChessComGameWithEvent;
                      chessComGame.pgn = analyzedPgn;
                      // Persist using profile DB Games.ID (required for dashboard joins)
                      let internalId = internalIdByExternalKey.get(`chesscom:${chessComGame.url}`) ?? null;
                      if (activeProfileId && !internalId) {
                        internalId = await resolveInternalId("chesscom", chessComGame.url);
                        if (!internalId && !warnedMissingInternalId) {
                          warnedMissingInternalId = true;
                          notifications.show({
                            title: t("common.warning", { defaultValue: "Warning" }),
                            message: t("features.dashboard.analysisInternalIdMissing", {
                              defaultValue:
                                "Could not resolve profile DB game id for some games. Stats by phase may be missing for those games.",
                            }),
                            color: "yellow",
                          });
                        }
                      }

                      const gameIdToSave = internalId ?? chessComGame.url;
                      await saveAnalyzedGame(gameIdToSave, analyzedPgn, activeProfileId ?? null);

                      if (activeProfileId && internalId) {
                        const n = Number.parseInt(internalId, 10);
                        if (Number.isFinite(n)) {
                          try {
                            await saveProfileGameAnalysisStats({
                              profileId: activeProfileId,
                              gameId: n,
                              initialFen,
                              moves,
                              analysis,
                            });
                          } catch {
                            if (!warnedStatsPersistFailed) {
                              warnedStatsPersistFailed = true;
                              notifications.show({
                                title: t("common.warning", { defaultValue: "Warning" }),
                                message: t("features.dashboard.analysisPhaseStatsSaveFailed", {
                                  defaultValue:
                                    "Failed to save phase stats for some games. The Stats tab may not show phase data yet.",
                                }),
                                color: "yellow",
                              });
                            }
                          }
                        }
                      }

                      // Calculate and save stats
                      const whiteUsername = chessComGame.white.username.toLowerCase();
                      const blackUsername = chessComGame.black.username.toLowerCase();
                      const accountUsername =
                        chessComUsernames
                          .find((u) => u.toLowerCase() === whiteUsername || u.toLowerCase() === blackUsername)
                          ?.toLowerCase() || whiteUsername;

                      const isUserWhite = whiteUsername === accountUsername;
                      const userColor = isUserWhite ? "white" : "black";

                      const stats = buildStatsPayloadForBackend(reportStats, userColor, tree);
                      if (stats) {
                        await saveGameStats(gameIdToSave, stats, activeProfileId ?? null);
                      }

                      // Update the games array to trigger re-render and stats recalculation
                      setChessComGames((prev) => {
                        const updated = [...prev];
                        const index = updated.findIndex((g) => g.url === chessComGame.url);
                        if (index >= 0) {
                          updated[index] = { ...updated[index], ...chessComGame };
                        }
                        return updated;
                      });
                    } else if (gameType === "chessbase") {
                      const row = game as GamesHistoryRow;
                      const gameIdToSave = activeProfileId
                        ? String(row.analysisGameId)
                        : `chessbase:${row.analysisGameId}`;
                      await saveAnalyzedGame(gameIdToSave, analyzedPgn, activeProfileId ?? null);

                      if (activeProfileId) {
                        const n = Number.parseInt(String(row.analysisGameId), 10);
                        if (Number.isFinite(n)) {
                          try {
                            await saveProfileGameAnalysisStats({
                              profileId: activeProfileId,
                              gameId: n,
                              initialFen,
                              moves,
                              analysis,
                            });
                          } catch {
                            if (!warnedStatsPersistFailed) {
                              warnedStatsPersistFailed = true;
                              notifications.show({
                                title: t("common.warning", { defaultValue: "Warning" }),
                                message: t("features.dashboard.analysisPhaseStatsSaveFailed", {
                                  defaultValue:
                                    "Failed to save phase stats for some games. The Stats tab may not show phase data yet.",
                                }),
                                color: "yellow",
                              });
                            }
                          }
                        }
                      }

                      const userColor = row.color === "black" ? "black" : "white";

                      const stats = buildStatsPayloadForBackend(reportStats, userColor, tree);
                      if (stats) {
                        await saveGameStats(gameIdToSave, stats, activeProfileId ?? null);
                      }
                    } else {
                      // lichess
                      const lichessGame = game as (typeof lichessGames)[0];
                      lichessGame.pgn = analyzedPgn;
                      // Persist using profile DB Games.ID (required for dashboard joins)
                      let internalId = internalIdByExternalKey.get(`lichess:${lichessGame.id}`) ?? null;
                      if (activeProfileId && !internalId) {
                        internalId = await resolveInternalId("lichess", lichessGame.id);
                        if (!internalId && !warnedMissingInternalId) {
                          warnedMissingInternalId = true;
                          notifications.show({
                            title: t("common.warning", { defaultValue: "Warning" }),
                            message: t("features.dashboard.analysisInternalIdMissing", {
                              defaultValue:
                                "Could not resolve profile DB game id for some games. Stats by phase may be missing for those games.",
                            }),
                            color: "yellow",
                          });
                        }
                      }

                      const gameIdToSave = internalId ?? lichessGame.id;
                      await saveAnalyzedGame(gameIdToSave, analyzedPgn, activeProfileId ?? null);

                      if (activeProfileId && internalId) {
                        const n = Number.parseInt(internalId, 10);
                        if (Number.isFinite(n)) {
                          try {
                            await saveProfileGameAnalysisStats({
                              profileId: activeProfileId,
                              gameId: n,
                              initialFen,
                              moves,
                              analysis,
                            });
                          } catch {
                            if (!warnedStatsPersistFailed) {
                              warnedStatsPersistFailed = true;
                              notifications.show({
                                title: t("common.warning", { defaultValue: "Warning" }),
                                message: t("features.dashboard.analysisPhaseStatsSaveFailed", {
                                  defaultValue:
                                    "Failed to save phase stats for some games. The Stats tab may not show phase data yet.",
                                }),
                                color: "yellow",
                              });
                            }
                          }
                        }
                      }

                      // Calculate and save stats
                      const whiteUsername = (lichessGame.players.white.user?.name || "").toLowerCase();
                      const blackUsername = (lichessGame.players.black.user?.name || "").toLowerCase();
                      const accountUsername =
                        lichessUsernames
                          .find((u) => u.toLowerCase() === whiteUsername || u.toLowerCase() === blackUsername)
                          ?.toLowerCase() || whiteUsername;

                      const isUserWhite = whiteUsername === accountUsername;
                      const userColor = isUserWhite ? "white" : "black";

                      const stats = buildStatsPayloadForBackend(reportStats, userColor, tree);
                      if (stats) {
                        await saveGameStats(gameIdToSave, stats, activeProfileId ?? null);
                      }

                      // Update the games array to trigger re-render and stats recalculation
                      setLichessGames((prev) => {
                        const updated = [...prev];
                        const index = updated.findIndex((g) => g.id === lichessGame.id);
                        if (index >= 0) {
                          updated[index] = { ...lichessGame };
                        }
                        return updated;
                      });
                    }

                    successCount++;
                    pendingRefreshUpdates++;
                    if (pendingRefreshUpdates >= 10) {
                      emitGamesHistoryRefresh();
                      pendingRefreshUpdates = 0;
                    }
                  }
                } catch (_error) {
                  failCount++;
                  if (failCount === 1) {
                    notifications.show({
                      title: t("common.error"),
                      message: t("features.dashboard.analysisEngineError", {
                        defaultValue: "Engine error while analyzing. Engine: {{engine}}.",
                        engine: selectedEngine.name,
                      }),
                      color: "red",
                    });
                  }
                } finally {
                  activeAnalysisIds.delete(analysisId);
                  completedCount++;

                  // Update progress
                  onProgress(completedCount, gamesToAnalyze.length);

                  // Update notifications less frequently
                  if (completedCount % 10 === 0 || completedCount === gamesToAnalyze.length) {
                    emitGamesHistoryRefresh();
                    notifications.show({
                      title: t("features.dashboard.analysisProgress"),
                      message: `Analyzed ${completedCount}/${gamesToAnalyze.length} games (${successCount} success, ${failCount} failed)`,
                      color: "blue",
                    });
                  }
                  if (completedCount % 50 === 0 || completedCount === gamesToAnalyze.length) {
                    void perfBaselinePoint({
                      scope: "dashboard.analyze_all",
                      label: "progress_checkpoint",
                      metadata: {
                        completed: completedCount,
                        total: gamesToAnalyze.length,
                        success: successCount,
                        failed: failCount,
                      },
                    });
                  }
                }
              };

              const runId = `dashboard_analyze_all_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
              currentRunId = runId;
              const errorLogPath = await resolve(folderName, `analyze-all-errors-${runId}.log`);
              const flushErrorLog = async () => {
                if (backendJobErrors.length === 0) return;
                try {
                  await writeTextFile(errorLogPath, backendJobErrors.join("\n"));
                } catch {
                  // best-effort
                }
              };
              const jobsForBackend: DashboardAnalyzeAllBackendJob[] = [];
              for (let index = 0; index < gamesToAnalyze.length; index++) {
                const item = gamesToAnalyze[index];
                if (item.type === "local") {
                  const gameRecord = item.game as GameRecord;
                  const pgn =
                    gameRecord.pgn || createPGNFromMoves(gameRecord.moves, gameRecord.result, gameRecord.initialFen);
                  jobsForBackend.push({
                    jobId: String(index),
                    fen: gameRecord.initialFen || DEFAULT_START_FEN,
                    moves:
                      Array.isArray(gameRecord.moves) && gameRecord.moves.length > 0 ? [...gameRecord.moves] : null,
                    pgn: pgn || null,
                  });
                  continue;
                }
                if (item.type === "chesscom") {
                  const gameRecord = item.game as ChessComGameWithEvent;
                  jobsForBackend.push({
                    jobId: String(index),
                    fen: gameRecord.initial_setup || gameRecord.fen || null,
                    moves: null,
                    pgn: gameRecord.pgn ?? null,
                  });
                  continue;
                }
                if (item.type === "chessbase") {
                  const row = item.game as GamesHistoryRow;
                  let rowInitialFen = (row as { initialFen?: string | null }).initialFen ?? null;
                  const resolvedPgn = row.pgn ?? null;
                  let resolvedMoves: string[] | null = null;
                  // For profile DB rows (including imported chess.com/lichess), analyze-all must
                  // rely on local payload (PGN/blob-decoded moves) and avoid external fetches.
                  if (activeProfileId) {
                    const gameId = Number.parseInt(String(row.analysisGameId), 10);
                    if (Number.isFinite(gameId)) {
                      try {
                        const decoded = await invoke<{ initialFen: string; moves: string[] } | null>(
                          "dashboard_decode_profile_game_blob_moves",
                          {
                            profileId: activeProfileId,
                            gameId,
                          },
                        );
                        if (decoded && Array.isArray(decoded.moves) && decoded.moves.length > 0) {
                          resolvedMoves = decoded.moves;
                          if (!rowInitialFen && decoded.initialFen) {
                            rowInitialFen = decoded.initialFen;
                          }
                        }
                      } catch {
                        // best-effort fallback
                      }
                    }
                  }
                  jobsForBackend.push({
                    jobId: String(index),
                    fen: rowInitialFen,
                    moves: resolvedMoves,
                    pgn: resolvedPgn,
                  });
                  continue;
                }
                const gameRecord = item.game as (typeof lichessGames)[0];
                jobsForBackend.push({
                  jobId: String(index),
                  fen: gameRecord.lastFen || null,
                  moves: null,
                  pgn: gameRecord.pgn ?? null,
                });
              }

              const jobsById = new Map(
                jobsForBackend.map((job, index) => [
                  job.jobId,
                  { item: gamesToAnalyze[index], index, preparedJob: job },
                ]),
              );
              let unlistenResultEvent: (() => void) | null = null;
              const pendingHandlers = new Set<Promise<void>>();

              const waitPendingHandlers = async () => {
                if (pendingHandlers.size === 0) return;
                await Promise.allSettled(Array.from(pendingHandlers));
              };

              try {
                unlistenResultEvent = await listen<DashboardAnalyzeAllResultPayload>(
                  "dashboard_analyze_all_result",
                  (event) => {
                    const payload = event.payload;
                    if (!payload || payload.runId !== runId) return;

                    const job = jobsById.get(payload.jobId);
                    if (!job) return;

                    const handled = (async () => {
                      if (!payload.success || !payload.analysis || payload.analysis.length === 0) {
                        if (payload.error) {
                          backendJobErrors.push(
                            `[${new Date().toISOString()}] run=${runId} job=${payload.jobId} cancelled=${payload.cancelled} error=${payload.error}`,
                          );
                          await flushErrorLog();
                        }
                        if (!payload.cancelled && payload.error && !warnedBackendJobError) {
                          warnedBackendJobError = true;
                          notifications.show({
                            title: t("common.error", { defaultValue: "Error" }),
                            message: payload.error,
                            color: "red",
                          });
                        }
                        failCount++;
                        completedCount++;
                        onProgress(completedCount, gamesToAnalyze.length);
                        if (completedCount % 10 === 0 || completedCount === gamesToAnalyze.length) {
                          emitGamesHistoryRefresh();
                          notifications.show({
                            title: t("features.dashboard.analysisProgress"),
                            message: `Analyzed ${completedCount}/${gamesToAnalyze.length} games (${successCount} success, ${failCount} failed)`,
                            color: "blue",
                          });
                        }
                        return;
                      }
                      await processGame(job.item, job.index, payload.analysis, job.preparedJob);
                    })()
                      .catch(() => {
                        // progress is already counted by processGame / fallback path.
                      })
                      .finally(() => {
                        pendingHandlers.delete(handled);
                      });
                    pendingHandlers.add(handled);
                  },
                );

                await invoke("dashboard_analyze_all_run", {
                  request: {
                    runId,
                    engine: selectedEngine.path,
                    goMode,
                    uciOptions: engineSettings,
                    jobs: jobsForBackend,
                  },
                });

                await waitPendingHandlers();

                if (!isCancelled()) {
                  // Final progress update
                  onProgress(gamesToAnalyze.length, gamesToAnalyze.length);

                  // Refresh games to update stats
                  if (analyzeAllGameType === "local" || analyzeAllGameType === "all") {
                    const updatedGames = await getRecentGames(activeProfileId, gameHistoryLimit);
                    const filteredGames = updatedGames.filter((g) => {
                      if (g.moves?.length >= 5) return true;
                      if (g.pgn) {
                        const movesSection = g.pgn.split(/\n\n/)[1] || g.pgn;
                        const moveCount = (movesSection.match(/\d+\./g)?.length ?? 0) * 2;
                        return moveCount >= 5;
                      }
                      return false;
                    });
                    setRecentGames(filteredGames);
                  }
                  if (analyzeAllGameType === "chesscom" || analyzeAllGameType === "all") {
                    // Trigger refresh for Chess.com games
                    window.dispatchEvent(new Event("chesscom:games:updated"));
                  }
                  if (analyzeAllGameType === "lichess" || analyzeAllGameType === "all") {
                    // Trigger refresh for Lichess games
                    window.dispatchEvent(new Event("lichess:games:updated"));
                  }
                  emitGamesHistoryRefresh(true);

                  notifications.show({
                    title: t("features.dashboard.analysisComplete"),
                    message: `Analyzed ${successCount} games successfully. Files saved to: ${folderName}`,
                    color: "green",
                  });
                  if (backendJobErrors.length > 0) {
                    await flushErrorLog();
                  }
                  baselineStatus = "completed";
                } else {
                  notifyCancellation();
                  baselineStatus = "cancelled";
                }
              } catch (error) {
                backendJobErrors.push(`[${new Date().toISOString()}] run=${runId} fatal=${String(error)}`);
                await flushErrorLog();
                baselineStatus = "failed";
                throw error;
              } finally {
                clearInterval(cancellationWatcher);
                if (gamesHistoryRefreshTimer) {
                  clearTimeout(gamesHistoryRefreshTimer);
                  gamesHistoryRefreshTimer = null;
                }
                currentRunId = null;
                if (unlistenResultEvent) {
                  await unlistenResultEvent();
                }
                await finishPerfBaselineSpan(analyzeAllRunSpan, {
                  status: baselineStatus,
                  candidateGames: baselineCandidateGames,
                  gamesToAnalyze: baselineGamesToAnalyze,
                  completed: completedCount,
                  success: successCount,
                  failed: failCount,
                  cancelled: isCancelled(),
                });
              }

              // Return stop function for immediate cancellation
              return { stop: stopAllEnginesOnce };
            }}
            gameCount={
              analyzeAllCounts && analyzeAllGameType && analyzeAllCounts.type === analyzeAllGameType
                ? analyzeAllCounts.total
                : 0
            }
            unanalyzedGameCount={
              analyzeAllCounts && analyzeAllGameType && analyzeAllCounts.type === analyzeAllGameType
                ? analyzeAllCounts.unanalyzed
                : 0
            }
            missingBalancedStatsCount={analyzeAllMissingBalancedStatsCount}
            onBackfillMissingStats={handleBackfillMissingBalancedStats}
          />
        </Stack>
      )}
    </Box>
  );
}
