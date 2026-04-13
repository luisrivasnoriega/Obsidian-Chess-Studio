import {
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconArrowsExchange,
  IconEraser,
  IconFlag,
  IconMaximize,
  IconMinimize,
  IconPlayerPlay,
  IconRotate,
  IconWorld,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { parseUci } from "chessops";
import { INITIAL_FEN } from "chessops/fen";
import { useAtomValue, useSetAtom } from "jotai";
import { type ReactNode, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import Clock from "@/components/Clock";
import GameInfo from "@/components/GameInfo";
import ShowMaterial from "@/components/ShowMaterial";
import { TreeStateContext, TreeStateProvider } from "@/components/TreeStateContext";
import { GameTimeProvider, useGameTime } from "@/features/boards/components/GameTimeContext";
import ResponsiveBoard from "@/features/boards/components/ResponsiveBoard";
import { type PostGameReviewResult, runPostGameAutoReview } from "@/features/boards/utils/postGameReview";
import {
  activeProfileIdAtom,
  activeTabAtom,
  enginesAtom,
  profilesAtom,
  selectedPuzzleDbAtom,
  sessionsAtom,
  tabsAtom,
} from "@/state/atoms";
import { getMainLine, getMaterialDiff, getOpening, getPGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { env } from "@/utils/detectEnvironment";
import type { LocalEngine } from "@/utils/engines";
import { openFile } from "@/utils/files";
import { createTab } from "@/utils/tabs";
import type { GameHeaders, TreeNode } from "@/utils/treeReducer";

const MIN_BOARD_SEEK_ESTIMATED_MINUTES = 8;
type LocalGameState = "settingUp" | "playing" | "gameOver";

type LichessFindHumanGameResponse = {
  gameId: string;
  fullId?: string | null;
  color?: "white" | "black" | null;
  source?: string | null;
  raw: string;
};

type LichessAiChallengeResponse = {
  id: string;
  fullId?: string | null;
  color?: "white" | "black" | null;
  raw: string;
};

type LichessBoardGameSnapshot = {
  gameId: string;
  initialFen?: string | null;
  whiteName?: string | null;
  blackName?: string | null;
  moves: string[];
  status: string;
  winner?: "white" | "black" | null;
  turn?: "white" | "black" | null;
  wtime?: number | null;
  btime?: number | null;
  raw: string;
};

type GeneratedPuzzlesInlineAlertProps = {
  visible: boolean;
  review: PostGameReviewResult | null;
  onOpen: () => void;
  t: ReturnType<typeof useTranslation>["t"];
};

type LichessClocksMaterialProps = {
  showClocks: boolean;
  turn: "white" | "black" | null;
  whiteTime: number | null;
  blackTime: number | null;
  materialAdvantageContent: ReactNode;
  t: ReturnType<typeof useTranslation>["t"];
};

type LichessOpeningPgnProps = {
  openingText: string;
  pgn: string;
  t: ReturnType<typeof useTranslation>["t"];
};

function GeneratedPuzzlesInlineAlert({ visible, review, onOpen, t }: GeneratedPuzzlesInlineAlertProps) {
  if (!visible) return null;

  return (
    <Alert color="teal">
      <Stack gap="xs">
        <Text size="sm">
          {t("features.postGameReview.completedMessage", {
            puzzles: review?.puzzlesGenerated ?? 0,
            mistakes: (review?.mistakeCount ?? 0) + (review?.blunderCount ?? 0) + (review?.dubiousCount ?? 0),
          })}
        </Text>
        <Button size="xs" variant="light" onClick={onOpen}>
          {t("features.postGameReview.openPuzzles")}
        </Button>
      </Stack>
    </Alert>
  );
}

function LichessClocksMaterial({
  showClocks,
  turn,
  whiteTime,
  blackTime,
  materialAdvantageContent,
  t,
}: LichessClocksMaterialProps) {
  const whiteClockTurn = turn ?? "white";
  const blackClockTurn = turn ?? "black";
  return (
    <>
      {showClocks && (
        <>
          <Text fw={600} size="sm">
            {t("common.clocks")}
          </Text>
          <Stack gap="xs">
            <Clock
              color="white"
              turn={whiteClockTurn}
              whiteTime={whiteTime ?? undefined}
              blackTime={blackTime ?? undefined}
            />
            <Clock
              color="black"
              turn={blackClockTurn}
              whiteTime={whiteTime ?? undefined}
              blackTime={blackTime ?? undefined}
            />
          </Stack>
          <Divider />
        </>
      )}

      <Text fw={600} size="sm">
        {t("features.tournaments.play.materialTitle")}
      </Text>
      {materialAdvantageContent}
    </>
  );
}

function LichessOpeningPgn({ openingText, pgn, t }: LichessOpeningPgnProps) {
  return (
    <>
      <Text fw={600} size="sm">
        {t("common.opening")}
      </Text>
      <Text size="sm" c="dimmed">
        {openingText}
      </Text>

      <Divider />

      <Text fw={600} size="sm">
        {t("common.pgn")}
      </Text>
      <Box
        component="pre"
        style={{
          margin: 0,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontSize: "0.8rem",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {pgn}
      </Box>
    </>
  );
}

function normalizeInitialFen(input: string | null | undefined): string {
  if (!input || input.trim() === "" || input.trim() === "startpos") return INITIAL_FEN;
  return input.trim();
}

function getMainlineLastNode(root: TreeNode): TreeNode {
  let node = root;
  while (node.children.length > 0) {
    node = node.children[0];
  }
  return node;
}

function mapLichessStatusToOutcome(status: string, winner?: string | null): GameHeaders["result"] {
  if (winner === "white") return "1-0";
  if (winner === "black") return "0-1";

  const drawStatuses = new Set([
    "draw",
    "stalemate",
    "aborted",
    "outoftime",
    "timeout",
    "insufficientMaterialClaim",
    "variantEnd",
  ]);

  if (drawStatuses.has(status)) return "1/2-1/2";
  return "*";
}

function PlayVsLichessBoardContent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const profiles = useAtomValue(profilesAtom);
  const sessions = useAtomValue(sessionsAtom);
  const engines = useAtomValue(enginesAtom);
  const setTabs = useSetAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const setSelectedPuzzleDb = useSetAtom(selectedPuzzleDbAtom);
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [activeProfileId, profiles],
  );
  const sessionToken = useMemo(() => {
    const normalizedProfileName = (activeProfile?.name ?? "").trim().toLowerCase();
    const byNewest = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const match =
      byNewest.find((session) => {
        if (!session.lichess?.accessToken?.trim()) return false;
        if (activeProfileId && session.profileId === activeProfileId) return true;
        return (
          normalizedProfileName.length > 0 && (session.player ?? "").trim().toLowerCase() === normalizedProfileName
        );
      }) ?? null;
    return match?.lichess?.accessToken?.trim() ?? "";
  }, [activeProfile?.name, activeProfileId, sessions]);
  const storedToken = (activeProfile?.lichessToken ?? "").trim() || sessionToken;

  const [tokenInput, setTokenInput] = useState(storedToken);
  const [showConnectionSettings, setShowConnectionSettings] = useState(false);
  const [clockLimitMinutes, setClockLimitMinutes] = useState<number>(10);
  const [clockIncrementSeconds, setClockIncrementSeconds] = useState<number>(0);
  const [playMode, setPlayMode] = useState<"human" | "bot">("human");
  const [aiLevel, setAiLevel] = useState<number>(3);
  const [botColor, setBotColor] = useState<"random" | "white" | "black">("random");
  const [ratedMode, setRatedMode] = useState<"casual" | "rated">("rated");
  const [allowPremove, setAllowPremove] = useState(true);
  const [gameState, setGameState] = useState<LocalGameState>("settingUp");
  const [gameId, setGameId] = useState<string | null>(null);
  const [playerColor, setPlayerColor] = useState<"white" | "black" | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<string>("created");
  const [isStarting, setIsStarting] = useState(false);
  const [isSendingMove, setIsSendingMove] = useState(false);
  const [isGameMode, setIsGameMode] = useState(false);
  const [openingLabel, setOpeningLabel] = useState("");
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [postGameReview, setPostGameReview] = useState<PostGameReviewResult | null>(null);
  const [isPostGameReviewRunning, setIsPostGameReviewRunning] = useState(false);
  const [postGameReviewOpened, setPostGameReviewOpened] = useState(false);
  const [pendingAutoGameMode, setPendingAutoGameMode] = useState(false);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const gameModeRef = useRef<HTMLDivElement | null>(null);
  const remoteMoveCountRef = useRef<number>(0);
  const pendingMoveRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const postGameReviewedIdRef = useRef<string | null>(null);

  const token = tokenInput.trim();
  const hasStoredProfileToken = storedToken.length > 0;
  const resolvedHumanColor = playerColor;
  const normalizedClockLimitMinutes = Math.max(0, Math.floor(Number(clockLimitMinutes) || 0));
  const normalizedClockIncrementSeconds = Math.max(0, Math.floor(Number(clockIncrementSeconds) || 0));
  const normalizedAiLevel = Math.min(8, Math.max(1, Math.floor(Number(aiLevel) || 1)));
  const estimatedTimeControlMinutes = normalizedClockLimitMinutes + (40 * normalizedClockIncrementSeconds) / 60;
  const hasValidBoardSeekTimeControl = estimatedTimeControlMinutes >= MIN_BOARD_SEEK_ESTIMATED_MINUTES;
  const isCompactLayout = useMediaQuery("(max-width: 1400px)");
  const sidePanelWidth = "clamp(180px, 15vw, 300px)";
  const gameModeSidePanelWidth = "clamp(320px, 24vw, 420px)";

  useEffect(() => {
    if (gameState !== "settingUp") return;
    if (!activeProfile) return;
    setTokenInput(storedToken);
    setShowConnectionSettings(storedToken.length === 0);
  }, [activeProfile, gameState, storedToken]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setIsGameMode(false);
      }
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);

  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const headers = useStore(store, (s) => s.headers);
  const setHeaders = useStore(store, (s) => s.setHeaders);
  const setFen = useStore(store, (s) => s.setFen);
  const appendMove = useStore(store, (s) => s.appendMove);
  const clearShapes = useStore(store, (s) => s.clearShapes);

  const rootRef = useRef(root);
  const headersRef = useRef(headers);
  useEffect(() => {
    rootRef.current = root;
  }, [root]);
  useEffect(() => {
    headersRef.current = headers;
  }, [headers]);

  const { whiteTime, blackTime, setWhiteTime, setBlackTime } = useGameTime();

  const lastNode = useMemo(() => getMainlineLastNode(root), [root]);
  const [pos] = useMemo(() => positionFromFen(lastNode.fen), [lastNode.fen]);
  const materialDiff = useMemo(() => getMaterialDiff(lastNode.fen), [lastNode.fen]);
  const materialLeader = materialDiff
    ? materialDiff.diff > 0
      ? "white"
      : materialDiff.diff < 0
        ? "black"
        : null
    : null;

  const localMoves = useMemo(() => getMainLine(root, headers.variant === "Chess960"), [root, headers.variant]);
  const deferredRoot = useDeferredValue(root);
  const deferredHeaders = useDeferredValue(headers);
  const pgn = useMemo(() => {
    try {
      return getPGN(deferredRoot, {
        headers: deferredHeaders,
        comments: true,
        extraMarkups: true,
        glyphs: true,
        variations: true,
      });
    } catch {
      return "";
    }
  }, [deferredHeaders, deferredRoot]);

  useEffect(() => {
    let cancelled = false;
    getOpening(deferredRoot, position).then((value) => {
      if (cancelled) return;
      if (value && value !== "") {
        setOpeningLabel(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [deferredRoot, position]);

  const setNativeFullscreen = useCallback(async (next: boolean): Promise<boolean> => {
    if (!env.isDesktop()) return false;
    try {
      const webviewWindow = getCurrentWebviewWindow();
      await webviewWindow.setFullscreen(next);
      return true;
    } catch {
      return false;
    }
  }, []);

  const exitGameMode = useCallback(async () => {
    setIsGameMode(false);

    const exitedNativeFullscreen = await setNativeFullscreen(false);
    if (exitedNativeFullscreen) return;

    if (typeof document !== "undefined" && document.fullscreenElement && document.exitFullscreen) {
      try {
        await document.exitFullscreen();
      } catch {
        // noop
      }
    }
  }, [setNativeFullscreen]);

  const enterGameMode = useCallback(
    async (options?: { requestFullscreen?: boolean }) => {
      const requestFullscreen = options?.requestFullscreen ?? true;
      setIsGameMode(true);
      if (!requestFullscreen) return;

      const enteredNativeFullscreen = await setNativeFullscreen(true);
      if (enteredNativeFullscreen) return;

      if (typeof document === "undefined") return;
      const el = gameModeRef.current;
      if (!el || !el.requestFullscreen) return;

      if (document.fullscreenElement !== el) {
        try {
          await el.requestFullscreen();
        } catch {
          // noop: keep focused layout even if fullscreen API is blocked
        }
      }
    },
    [setNativeFullscreen],
  );

  const toggleGameMode = useCallback(() => {
    if (isGameMode) {
      void exitGameMode();
      return;
    }
    void enterGameMode();
  }, [enterGameMode, exitGameMode, isGameMode]);

  const resetToSetup = useCallback(() => {
    void exitGameMode();
    setGameState("settingUp");
    setGameId(null);
    setPlayerColor(null);
    setRemoteStatus("created");
    setIsSendingMove(false);
    setLastSyncError(null);
    setPostGameReview(null);
    setIsPostGameReviewRunning(false);
    setPostGameReviewOpened(false);
    setPendingAutoGameMode(false);
    postGameReviewedIdRef.current = null;
    remoteMoveCountRef.current = 0;
    pendingMoveRef.current = null;

    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    setWhiteTime(null);
    setBlackTime(null);
    setFen(INITIAL_FEN);

    const current = headersRef.current;
    setHeaders({
      ...current,
      event: t("features.tournaments.play.eventName"),
      site: "https://lichess.org",
      result: "*",
      fen: INITIAL_FEN,
    });
  }, [exitGameMode, setBlackTime, setFen, setHeaders, setWhiteTime, t]);

  const syncSnapshot = useCallback(
    async (targetGameId: string) => {
      const snapshot = await invoke<LichessBoardGameSnapshot>("lichess_get_board_game_state", {
        token,
        gameId: targetGameId,
      });

      setRemoteStatus(snapshot.status);
      setLastSyncError(null);

      const normalizedFen = normalizeInitialFen(snapshot.initialFen);
      const currentRoot = rootRef.current;
      const currentHeaders = headersRef.current;

      if (snapshot.initialFen && currentRoot.children.length === 0 && currentRoot.fen !== normalizedFen) {
        setFen(normalizedFen);
      }

      const movesInTree = getMainLine(currentRoot, currentHeaders.variant === "Chess960");
      if (snapshot.moves.length > movesInTree.length) {
        for (const move of snapshot.moves.slice(movesInTree.length)) {
          const parsed = parseUci(move);
          if (parsed) {
            appendMove({ payload: parsed });
          }
        }
      }

      remoteMoveCountRef.current = Math.max(remoteMoveCountRef.current, snapshot.moves.length);

      const nextOutcome = mapLichessStatusToOutcome(snapshot.status, snapshot.winner);
      const nextHeaders: GameHeaders = {
        ...currentHeaders,
        event: currentHeaders.event || t("features.tournaments.play.eventName"),
        site: "https://lichess.org",
        white: snapshot.whiteName ?? currentHeaders.white,
        black: snapshot.blackName ?? currentHeaders.black,
        result: nextOutcome,
      };

      if (
        nextHeaders.white !== currentHeaders.white ||
        nextHeaders.black !== currentHeaders.black ||
        nextHeaders.result !== currentHeaders.result ||
        nextHeaders.site !== currentHeaders.site ||
        nextHeaders.event !== currentHeaders.event
      ) {
        setHeaders(nextHeaders);
      }

      if (typeof snapshot.wtime === "number") {
        setWhiteTime(snapshot.wtime);
      }
      if (typeof snapshot.btime === "number") {
        setBlackTime(snapshot.btime);
      }

      if (snapshot.status !== "started" && snapshot.status !== "created") {
        setGameState("gameOver");
      }
    },
    [appendMove, setBlackTime, setFen, setHeaders, setWhiteTime, t, token],
  );

  const startOnlineGame = useCallback(async () => {
    if (!token) {
      notifications.show({
        title: t("common.error"),
        message: t("features.tournaments.play.missingToken"),
        color: "red",
      });
      return;
    }
    if (playMode === "human" && !hasValidBoardSeekTimeControl) {
      notifications.show({
        title: t("common.error"),
        message: t("features.tournaments.play.invalidTimeControl", {
          min: MIN_BOARD_SEEK_ESTIMATED_MINUTES,
          estimated: estimatedTimeControlMinutes.toFixed(1),
        }),
        color: "red",
      });
      return;
    }

    setIsStarting(true);
    setLastSyncError(null);
    setPendingAutoGameMode(false);

    try {
      let startedGameId: string;
      let resolvedColor: "white" | "black" | null;
      let whiteName: string;
      let blackName: string;

      if (playMode === "human") {
        const response = await invoke<LichessFindHumanGameResponse>("lichess_find_human_game", {
          input: {
            token,
            timeMinutes: normalizedClockLimitMinutes,
            incrementSeconds: normalizedClockIncrementSeconds,
            color: "random",
            rated: ratedMode === "rated",
            timeoutSeconds: 180,
          },
        });

        startedGameId = response.gameId;
        resolvedColor = response.color === "white" || response.color === "black" ? response.color : null;
        const meName = activeProfile?.name ?? t("features.tournaments.play.me");
        const waitingOpponent = t("features.tournaments.play.waitingOpponent");
        whiteName = resolvedColor === "white" ? meName : waitingOpponent;
        blackName = resolvedColor === "black" ? meName : waitingOpponent;
      } else {
        const response = await invoke<LichessAiChallengeResponse>("lichess_challenge_ai", {
          input: {
            token,
            level: normalizedAiLevel,
            clockLimitSeconds: Math.max(0, normalizedClockLimitMinutes * 60),
            clockIncrementSeconds: normalizedClockIncrementSeconds,
            color: botColor,
            variant: "standard",
          },
        });

        startedGameId = response.id;
        resolvedColor = response.color === "white" || response.color === "black" ? response.color : null;
        const meName = activeProfile?.name ?? t("features.tournaments.play.me");
        const aiName = t("features.tournaments.play.aiName", { level: normalizedAiLevel });
        whiteName = resolvedColor === "white" ? meName : aiName;
        blackName = resolvedColor === "black" ? meName : aiName;
      }

      setPlayerColor(resolvedColor);
      setGameId(startedGameId);
      setGameState("playing");
      setRemoteStatus("started");
      setPostGameReview(null);
      setIsPostGameReviewRunning(false);
      setPostGameReviewOpened(false);
      postGameReviewedIdRef.current = null;
      remoteMoveCountRef.current = 0;
      pendingMoveRef.current = null;

      setFen(INITIAL_FEN);
      setWhiteTime(Math.round(normalizedClockLimitMinutes * 60_000));
      setBlackTime(Math.round(normalizedClockLimitMinutes * 60_000));

      setHeaders({
        ...headersRef.current,
        event: t("features.tournaments.play.eventName"),
        site: "https://lichess.org",
        white: whiteName,
        black: blackName,
        orientation: resolvedColor ?? "white",
        result: "*",
        fen: INITIAL_FEN,
      });

      await syncSnapshot(startedGameId);
      setPendingAutoGameMode(true);
    } catch (error) {
      const rawMessage =
        typeof error === "string"
          ? error
          : error instanceof Error && error.message
            ? error.message
            : t("features.tournaments.play.startFailed");
      const lowerMessage = rawMessage.toLowerCase();
      const message = lowerMessage.includes("invalid time control")
        ? t("features.tournaments.play.invalidTimeControl", {
            min: MIN_BOARD_SEEK_ESTIMATED_MINUTES,
            estimated: estimatedTimeControlMinutes.toFixed(1),
          })
        : lowerMessage.includes("matchmaking timeout")
          ? t("features.tournaments.play.matchmakingTimeout")
          : rawMessage;
      notifications.show({
        title: t("common.error"),
        message,
        color: "red",
      });
      setPendingAutoGameMode(false);
      setGameState("settingUp");
    } finally {
      setIsStarting(false);
    }
  }, [
    activeProfile?.name,
    botColor,
    estimatedTimeControlMinutes,
    hasValidBoardSeekTimeControl,
    normalizedClockIncrementSeconds,
    normalizedClockLimitMinutes,
    normalizedAiLevel,
    playMode,
    ratedMode,
    setBlackTime,
    setFen,
    setHeaders,
    setWhiteTime,
    syncSnapshot,
    t,
    token,
  ]);

  useEffect(() => {
    if (!pendingAutoGameMode) return;
    if (gameState !== "playing" || !gameId) {
      setPendingAutoGameMode(false);
      return;
    }

    let cancelled = false;
    let rafId = 0;

    const tryEnter = () => {
      if (cancelled) return;

      const boardEl = boardRef.current;
      const boardRect = boardEl?.getBoundingClientRect();
      const boardReady = !!boardRect && boardRect.width > 0 && boardRect.height > 0;

      if (!boardReady) {
        rafId = requestAnimationFrame(tryEnter);
        return;
      }

      void enterGameMode({ requestFullscreen: true }).finally(() => {
        if (!cancelled) {
          setPendingAutoGameMode(false);
        }
      });
    };

    rafId = requestAnimationFrame(tryEnter);

    return () => {
      cancelled = true;
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [enterGameMode, gameId, gameState, pendingAutoGameMode]);

  useEffect(() => {
    if (gameState !== "playing" || !gameId || !token) return;

    let cancelled = false;
    const run = async () => {
      if (cancelled) return;

      try {
        await syncSnapshot(gameId);
      } catch {
        if (!cancelled) {
          setLastSyncError(t("features.tournaments.play.syncError"));
        }
      } finally {
        if (!cancelled) {
          pollTimerRef.current = setTimeout(run, 1500);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [gameId, gameState, syncSnapshot, t, token]);

  useEffect(() => {
    if (gameState !== "playing" || !gameId || !token || !resolvedHumanColor || !pos) return;
    if (pos.turn === resolvedHumanColor) return;

    const remoteCount = remoteMoveCountRef.current;
    if (localMoves.length <= remoteCount) return;

    const moveToSend = localMoves[remoteCount];
    if (!moveToSend) return;
    if (pendingMoveRef.current === moveToSend) return;

    pendingMoveRef.current = moveToSend;
    setIsSendingMove(true);

    invoke("lichess_make_board_move", {
      token,
      gameId,
      moveUci: moveToSend,
      offeringDraw: false,
    })
      .then(() => {
        remoteMoveCountRef.current += 1;
        setLastSyncError(null);
      })
      .catch(() => {
        notifications.show({
          title: t("common.error"),
          message: t("features.tournaments.play.moveFailed"),
          color: "red",
        });
      })
      .finally(() => {
        pendingMoveRef.current = null;
        setIsSendingMove(false);
      });
  }, [gameId, gameState, localMoves, pos, resolvedHumanColor, t, token]);

  const flipBoard = useCallback(() => {
    const currentHeaders = headersRef.current;
    const current = (currentHeaders.orientation ?? "white") as "white" | "black";
    setHeaders({
      ...currentHeaders,
      orientation: current === "white" ? "black" : "white",
      fen: rootRef.current.fen,
    });
  }, [setHeaders]);

  const resignGame = useCallback(async () => {
    if (!gameId || !token || gameState !== "playing") return;

    try {
      await invoke("lichess_resign_board_game", { token, gameId });
      await syncSnapshot(gameId);
    } catch {
      notifications.show({
        title: t("common.error"),
        message: t("features.tournaments.play.resignFailed"),
        color: "red",
      });
    }
  }, [gameId, gameState, syncSnapshot, t, token]);

  const openGeneratedPuzzles = useCallback(async () => {
    if (!postGameReview?.puzzleFilePath) return;

    setSelectedPuzzleDb(postGameReview.puzzleFilePath);
    await createTab({
      tab: { name: t("features.tabs.puzzle.title"), type: "puzzles" },
      setTabs,
      setActiveTab,
    });
    navigate({ to: "/puzzles" });
  }, [navigate, postGameReview?.puzzleFilePath, setActiveTab, setSelectedPuzzleDb, setTabs, t]);

  const openVariantsTarget = useCallback(async () => {
    if (postGameReview?.variantsBookPath) {
      await openFile(postGameReview.variantsBookPath, setTabs as any, setActiveTab as any);
      navigate({ to: "/analysis" });
      return;
    }
    navigate({ to: "/variants" });
  }, [navigate, postGameReview?.variantsBookPath, setActiveTab, setTabs]);

  useEffect(() => {
    if (gameState !== "gameOver" || !gameId) return;
    if (!headers.result || headers.result === "*") return;
    if (postGameReviewedIdRef.current === gameId) return;
    postGameReviewedIdRef.current = gameId;

    const rootSnapshot = structuredClone(root);
    const headersSnapshot = structuredClone(headers);
    const localEngines = engines.filter((engine): engine is LocalEngine => engine.type === "local");
    const profileDisplay = (activeProfile?.displayName ?? activeProfile?.name ?? "").trim().toLowerCase();
    const inferredHumanColor: "white" | "black" | null =
      resolvedHumanColor ??
      (profileDisplay && (headersSnapshot.white ?? "").trim().toLowerCase() === profileDisplay
        ? "white"
        : profileDisplay && (headersSnapshot.black ?? "").trim().toLowerCase() === profileDisplay
          ? "black"
          : headersSnapshot.orientation === "white" || headersSnapshot.orientation === "black"
            ? headersSnapshot.orientation
            : null);

    setPostGameReviewOpened(true);
    setIsPostGameReviewRunning(true);

    void runPostGameAutoReview({
      root: rootSnapshot,
      headers: headersSnapshot,
      humanColor: inferredHumanColor,
      profileId: activeProfileId ?? null,
      profileName: (activeProfile?.displayName ?? activeProfile?.name ?? "").trim() || null,
      engines: localEngines,
      mode: "lichess",
      minEngineMsPerMove: 1000,
    })
      .then((review) => {
        setPostGameReview(review);
        const shouldOpenVariants = review.openVariantsAfterReview;

        if (review.status === "skipped" && review.reason === "no_engine") {
          notifications.show({
            title: t("features.postGameReview.title"),
            message: t("features.postGameReview.noEngine"),
            color: "yellow",
          });
          if (shouldOpenVariants) {
            notifications.show({
              title: t("features.postGameReview.title"),
              message: t("features.postGameReview.openVariantsHint"),
              color: "blue",
            });
          }
          return;
        }

        if (review.status === "error") {
          notifications.show({
            title: t("common.error"),
            message: t("features.postGameReview.failed"),
            color: "red",
          });
          return;
        }

        if (review.puzzleFilePath) {
          try {
            window.dispatchEvent(new Event("puzzles:updated"));
          } catch {
            // ignore
          }
        }

        notifications.show({
          title: t("features.postGameReview.completed"),
          message: t("features.postGameReview.completedMessage", {
            puzzles: review.puzzlesGenerated,
            mistakes: review.mistakeCount + review.blunderCount + review.dubiousCount,
          }),
          color: "green",
        });

        if (shouldOpenVariants) {
          notifications.show({
            title: t("features.postGameReview.title"),
            message: t("features.postGameReview.openVariantsHint"),
            color: "blue",
          });
        }
      })
      .catch(() => {
        setPostGameReview({
          status: "error",
          reason: "analysis_failed",
          error: "review_failed",
          engineName: null,
          engineMsPerMove: 1000,
          dubiousCount: 0,
          mistakeCount: 0,
          blunderCount: 0,
          variantDeviationDetected: false,
          variantDeviationPly: null,
          newLineAdded: false,
          variantsBookPath: null,
          variantsBookName: null,
          addedVariantLine: null,
          openVariantsAfterReview: false,
          puzzlesGenerated: 0,
          puzzleFilePath: null,
        });
      })
      .finally(() => {
        setIsPostGameReviewRunning(false);
      });
  }, [
    activeProfile?.displayName,
    activeProfile?.name,
    activeProfileId,
    engines,
    gameId,
    gameState,
    headers,
    headers.result,
    resolvedHumanColor,
    root,
    t,
  ]);

  if (gameState === "settingUp") {
    return (
      <Paper withBorder shadow="sm" p="md">
        <Stack gap="md">
          <Group gap="xs">
            <IconWorld size={18} />
            <Text fw={700}>{t("features.tournaments.play.title")}</Text>
          </Group>

          <Group justify="space-between" align="center">
            <Text size="sm" c="dimmed">
              {hasStoredProfileToken
                ? t("features.tournaments.play.tokenConfigured")
                : t("features.tournaments.play.tokenNotConfigured")}
            </Text>
            <Button variant="subtle" size="xs" onClick={() => setShowConnectionSettings((prev) => !prev)}>
              {showConnectionSettings
                ? t("features.tournaments.play.hideConnectionSettings")
                : hasStoredProfileToken
                  ? t("features.tournaments.play.editConnectionSettings")
                  : t("features.tournaments.play.showConnectionSettings")}
            </Button>
          </Group>

          {showConnectionSettings && (
            <TextInput
              label={t("features.tournaments.play.tokenLabel")}
              placeholder={t("features.tournaments.play.tokenPlaceholder")}
              value={tokenInput}
              onChange={(event) => setTokenInput(event.currentTarget.value)}
            />
          )}

          <Group grow>
            <NumberInput
              label={t("features.tournaments.play.clockLimit")}
              min={0}
              max={180}
              value={clockLimitMinutes}
              onChange={(value) => setClockLimitMinutes(Math.max(0, Math.floor(Number(value) || 0)))}
            />
            <NumberInput
              label={t("features.tournaments.play.clockIncrement")}
              min={0}
              max={180}
              value={clockIncrementSeconds}
              onChange={(value) => setClockIncrementSeconds(Math.max(0, Number(value) || 0))}
            />
          </Group>

          <SegmentedControl
            data={[
              { value: "human", label: t("features.tournaments.play.modeHuman") },
              { value: "bot", label: t("features.tournaments.play.modeBot") },
            ]}
            value={playMode}
            onChange={(value) => setPlayMode(value as "human" | "bot")}
          />

          {playMode === "bot" && (
            <Stack gap="xs">
              <NumberInput
                label={t("features.tournaments.play.aiLevel")}
                min={1}
                max={8}
                value={aiLevel}
                onChange={(value) => setAiLevel(Math.min(8, Math.max(1, Number(value) || 1)))}
              />
              <Text size="sm" fw={500}>
                {t("features.tournaments.play.botColor")}
              </Text>
              <SegmentedControl
                data={[
                  { value: "random", label: t("chess.random") },
                  { value: "white", label: t("chess.white") },
                  { value: "black", label: t("chess.black") },
                ]}
                value={botColor}
                onChange={(value) => setBotColor(value as "random" | "white" | "black")}
              />
            </Stack>
          )}

          {playMode === "human" && (
            <SegmentedControl
              data={[
                { value: "rated", label: t("features.tournaments.play.rated") },
                { value: "casual", label: t("features.tournaments.play.casual") },
              ]}
              value={ratedMode}
              onChange={(value) => setRatedMode(value as "casual" | "rated")}
            />
          )}

          <Switch
            label={t("features.tournaments.play.enablePremove")}
            checked={allowPremove}
            onChange={(event) => setAllowPremove(event.currentTarget.checked)}
          />

          <Button leftSection={<IconPlayerPlay size={16} />} loading={isStarting} onClick={startOnlineGame}>
            {playMode === "human" ? t("features.tournaments.play.startHuman") : t("features.tournaments.play.startBot")}
          </Button>
        </Stack>
      </Paper>
    );
  }

  const movable = gameState === "playing" && resolvedHumanColor ? resolvedHumanColor : "none";
  const materialAdvantageContent =
    materialDiff && materialLeader ? (
      <Group justify="space-between" align="center" wrap="nowrap">
        <Text size="sm">
          {t("features.tournaments.play.materialAdvantage", {
            color: t(`chess.${materialLeader}`),
            points: Math.abs(materialDiff.diff),
          })}
        </Text>
        <ShowMaterial diff={materialDiff.diff} pieces={materialDiff.pieces} color={materialLeader} />
      </Group>
    ) : (
      <Text size="sm" c="dimmed">
        {t("features.tournaments.play.materialEven")}
      </Text>
    );
  const openingText =
    openingLabel === "Empty Board"
      ? t("chess.opening.emptyBoard")
      : openingLabel === "Starting Position"
        ? t("chess.opening.startingPosition")
        : openingLabel || "-";
  const showInlinePuzzlesAlert =
    postGameReview?.status === "ok" &&
    !!postGameReview.puzzleFilePath &&
    postGameReview.puzzlesGenerated > 0 &&
    !isPostGameReviewRunning;

  return (
    <Box
      ref={gameModeRef}
      style={{
        width: isGameMode ? "100vw" : "100%",
        height: isGameMode ? "100dvh" : "max(640px, calc(100vh - 230px))",
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        position: isGameMode ? "fixed" : "relative",
        inset: isGameMode ? 0 : undefined,
        zIndex: isGameMode ? 9999 : undefined,
        background: isGameMode ? "var(--mantine-color-dark-9)" : undefined,
      }}
    >
      {isGameMode && (
        <Paper
          withBorder
          shadow="sm"
          p="sm"
          style={{
            position: "absolute",
            top: "0.5rem",
            left: "0.5rem",
            right: `calc(${gameModeSidePanelWidth} + 1.5rem)`,
            zIndex: 30,
          }}
        >
          <Group justify="space-between" align="center" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
              <Badge variant="light">{remoteStatus}</Badge>
              {gameId && (
                <Text size="sm" c="dimmed">
                  {t("features.tournaments.play.gameId", { id: gameId })}
                </Text>
              )}
            </Group>

            <Group gap="xs">
              <Button variant="default" onClick={flipBoard} leftSection={<IconArrowsExchange size={16} />}>
                {t("common.flip")}
              </Button>
              <Button
                color="red"
                onClick={resignGame}
                disabled={gameState !== "playing"}
                leftSection={<IconFlag size={16} />}
              >
                {t("common.resign")}
              </Button>
              <Button variant="default" onClick={toggleGameMode} leftSection={<IconMinimize size={16} />}>
                {t("features.tournaments.play.exitGameMode")}
              </Button>
            </Group>
          </Group>
        </Paper>
      )}

      <Box
        style={{
          flex: 1,
          minHeight: 0,
          padding: isGameMode ? "0.5rem" : "1rem",
          boxSizing: "border-box",
          display: "grid",
          gridTemplateColumns: isGameMode
            ? `minmax(0, 1fr) ${gameModeSidePanelWidth}`
            : isCompactLayout
              ? "minmax(0, 1fr)"
              : `${sidePanelWidth} minmax(0, 1fr) ${sidePanelWidth}`,
          gridTemplateRows: isGameMode ? "1fr" : isCompactLayout ? "auto minmax(520px, 1fr) auto" : "1fr",
          gap: "1rem",
          overflow: isGameMode ? "hidden" : isCompactLayout ? "auto" : "hidden",
        }}
      >
        {!isGameMode && (
          <Paper withBorder shadow="sm" p="md" style={{ minHeight: 0, overflow: "hidden" }}>
            <Stack gap="sm" style={{ height: "100%", minHeight: 0 }}>
              <Group justify="space-between" align="center">
                <Text fw={700}>{t("common.gameInfo")}</Text>
                <Badge variant="light">{remoteStatus}</Badge>
              </Group>

              <LichessClocksMaterial
                showClocks={gameState === "playing" || gameState === "gameOver"}
                turn={pos?.turn ?? null}
                whiteTime={whiteTime}
                blackTime={blackTime}
                materialAdvantageContent={materialAdvantageContent}
                t={t}
              />
              <Divider />

              {lastSyncError && (
                <Alert color="yellow" mb="xs">
                  {lastSyncError}
                </Alert>
              )}

              <Box style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
                <GameInfo headers={headers} />
              </Box>
            </Stack>
          </Paper>
        )}

        <Box
          style={{
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            padding: isGameMode ? "0" : "0.5rem",
            width: "100%",
            height: "100%",
            paddingTop: isGameMode ? "4.5rem" : undefined,
          }}
        >
          <Box
            style={{
              height: "100%",
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              maxHeight: "100%",
              maxWidth: isGameMode
                ? "min(100%, calc(100dvh - 96px))"
                : isCompactLayout
                  ? "min(100%, 86vh)"
                  : "min(100%, 78vh)",
              aspectRatio: "1",
            }}
          >
            <ResponsiveBoard
              dirty={false}
              editingMode={false}
              toggleEditingMode={() => undefined}
              viewOnly={gameState !== "playing"}
              disableVariations
              boardRef={boardRef}
              canTakeBack={false}
              movable={movable}
              topBar={false}
              currentTabType="play"
              gameState={gameState}
              toggleOrientation={flipBoard}
              hideClockSpaces={true}
              hideEvalBar={true}
              hideFooterControls={true}
              allowPremove={allowPremove}
            />
          </Box>
        </Box>

        {isGameMode && (
          <Paper withBorder shadow="sm" p="md" style={{ minHeight: 0, overflow: "hidden" }}>
            <Stack gap="sm" style={{ height: "100%", minHeight: 0 }}>
              <Group justify="space-between" align="center">
                <Text fw={700}>{t("common.gamePanel")}</Text>
                <Badge variant="light">{remoteStatus}</Badge>
              </Group>

              <LichessClocksMaterial
                showClocks={gameState === "playing" || gameState === "gameOver"}
                turn={pos?.turn ?? null}
                whiteTime={whiteTime}
                blackTime={blackTime}
                materialAdvantageContent={materialAdvantageContent}
                t={t}
              />

              {lastSyncError && (
                <Alert color="yellow" mb="xs">
                  {lastSyncError}
                </Alert>
              )}

              {isSendingMove && (
                <Text size="sm" c="dimmed">
                  {t("features.tournaments.play.sendingMove")}
                </Text>
              )}

              <GeneratedPuzzlesInlineAlert
                visible={showInlinePuzzlesAlert}
                review={postGameReview}
                onOpen={() => {
                  void openGeneratedPuzzles();
                }}
                t={t}
              />

              {gameId && (
                <Text size="sm" c="dimmed">
                  {t("features.tournaments.play.gameId", { id: gameId })}
                </Text>
              )}

              <Divider />

              <Box style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
                <Stack gap="sm">
                  <Text fw={600} size="sm">
                    {t("common.gameInfo")}
                  </Text>
                  <GameInfo headers={headers} />

                  <Divider />
                  <LichessOpeningPgn openingText={openingText} pgn={pgn} t={t} />
                </Stack>
              </Box>
            </Stack>
          </Paper>
        )}

        {!isGameMode && (
          <Paper withBorder shadow="sm" p="md" style={{ minHeight: 0, overflow: "hidden" }}>
            <Stack gap="sm" style={{ height: "100%", minHeight: 0 }}>
              <Text fw={700}>{t("common.gamePanel")}</Text>

              <Text fw={600} size="sm">
                {t("common.controls")}
              </Text>

              <Stack gap="xs">
                <Switch
                  label={t("features.tournaments.play.enablePremove")}
                  checked={allowPremove}
                  onChange={(event) => setAllowPremove(event.currentTarget.checked)}
                />

                <Group grow>
                  <Button variant="default" onClick={resetToSetup} leftSection={<IconRotate size={16} />}>
                    {t("features.tournaments.play.newGame")}
                  </Button>
                  <Button variant="default" onClick={flipBoard} leftSection={<IconArrowsExchange size={16} />}>
                    {t("common.flip")}
                  </Button>
                </Group>

                <Group grow>
                  <Button
                    color="red"
                    onClick={resignGame}
                    disabled={gameState !== "playing"}
                    leftSection={<IconFlag size={16} />}
                  >
                    {t("common.resign")}
                  </Button>
                  <Button variant="default" onClick={clearShapes} leftSection={<IconEraser size={16} />}>
                    {t("keybindings.clearShapes")}
                  </Button>
                </Group>

                <Button variant="default" onClick={toggleGameMode} leftSection={<IconMaximize size={16} />}>
                  {t("features.tournaments.play.enterGameMode")}
                </Button>
              </Stack>

              {isSendingMove && (
                <Text size="sm" c="dimmed">
                  {t("features.tournaments.play.sendingMove")}
                </Text>
              )}

              <GeneratedPuzzlesInlineAlert
                visible={showInlinePuzzlesAlert}
                review={postGameReview}
                onOpen={() => {
                  void openGeneratedPuzzles();
                }}
                t={t}
              />

              {gameId && (
                <Text size="sm" c="dimmed">
                  {t("features.tournaments.play.gameId", { id: gameId })}
                </Text>
              )}

              <Divider />

              <Box style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
                <LichessOpeningPgn openingText={openingText} pgn={pgn} t={t} />
              </Box>
            </Stack>
          </Paper>
        )}
      </Box>

      <Modal
        opened={postGameReviewOpened}
        onClose={() => {
          if (!isPostGameReviewRunning) {
            setPostGameReviewOpened(false);
          }
        }}
        closeOnClickOutside={!isPostGameReviewRunning}
        closeOnEscape={!isPostGameReviewRunning}
        withCloseButton={!isPostGameReviewRunning}
        title={t("features.postGameReview.title")}
      >
        <Stack gap="sm">
          {isPostGameReviewRunning && (
            <Text size="sm" c="dimmed">
              {t("features.postGameReview.running")}
            </Text>
          )}

          {!isPostGameReviewRunning && postGameReview?.status === "ok" && (
            <>
              <Text size="sm" c="dimmed">
                {t("features.postGameReview.engineInfo", {
                  engine: postGameReview.engineName ?? "-",
                  ms: postGameReview.engineMsPerMove,
                })}
              </Text>
              <Text size="sm">{t("features.postGameReview.dubiousCount", { count: postGameReview.dubiousCount })}</Text>
              <Text size="sm">{t("features.postGameReview.mistakeCount", { count: postGameReview.mistakeCount })}</Text>
              <Text size="sm">{t("features.postGameReview.blunderCount", { count: postGameReview.blunderCount })}</Text>
              <Text size="sm">
                {t("features.postGameReview.puzzleCount", { count: postGameReview.puzzlesGenerated })}
              </Text>
              {postGameReview.variantDeviationDetected && (
                <Text size="sm">{t("features.postGameReview.variantDeviationDetected")}</Text>
              )}
              {postGameReview.newLineAdded && <Text size="sm">{t("features.postGameReview.newLineAdded")}</Text>}
              {postGameReview.variantsBookName && (
                <Text size="sm">
                  {t("features.postGameReview.affectedBook", { book: postGameReview.variantsBookName })}
                </Text>
              )}
              {postGameReview.addedVariantLine && (
                <Text size="sm">
                  {t("features.postGameReview.addedLine", { line: postGameReview.addedVariantLine })}
                </Text>
              )}
              {postGameReview.openVariantsAfterReview && (
                <Text size="sm">{t("features.postGameReview.openVariantsHint")}</Text>
              )}

              <Group grow>
                <Button
                  onClick={() => {
                    void openGeneratedPuzzles();
                  }}
                  disabled={!postGameReview.puzzleFilePath}
                >
                  {postGameReview.puzzleFilePath
                    ? t("features.postGameReview.openPuzzles")
                    : t("features.postGameReview.noPuzzles")}
                </Button>
                <Button variant="default" onClick={() => setPostGameReviewOpened(false)}>
                  {t("features.postGameReview.continuePlaying")}
                </Button>
              </Group>
              {postGameReview.openVariantsAfterReview && (
                <Button variant="default" onClick={() => void openVariantsTarget()}>
                  {postGameReview.variantsBookPath
                    ? t("features.postGameReview.openAffectedBook")
                    : t("features.postGameReview.openVariants")}
                </Button>
              )}
            </>
          )}

          {!isPostGameReviewRunning && postGameReview?.status === "skipped" && (
            <Stack gap="xs">
              <Text size="sm" c="dimmed">
                {postGameReview.reason === "no_engine"
                  ? t("features.postGameReview.noEngine")
                  : t("features.postGameReview.noMoves")}
              </Text>
              {postGameReview.variantDeviationDetected && (
                <Text size="sm">{t("features.postGameReview.variantDeviationDetected")}</Text>
              )}
              {postGameReview.variantsBookName && (
                <Text size="sm">
                  {t("features.postGameReview.affectedBook", { book: postGameReview.variantsBookName })}
                </Text>
              )}
              {postGameReview.addedVariantLine && (
                <Text size="sm">
                  {t("features.postGameReview.addedLine", { line: postGameReview.addedVariantLine })}
                </Text>
              )}
              {postGameReview.openVariantsAfterReview && (
                <Button variant="default" onClick={() => void openVariantsTarget()}>
                  {postGameReview.variantsBookPath
                    ? t("features.postGameReview.openAffectedBook")
                    : t("features.postGameReview.openVariants")}
                </Button>
              )}
            </Stack>
          )}

          {!isPostGameReviewRunning && postGameReview?.status === "error" && (
            <Text size="sm" c="red">
              {t("features.postGameReview.failed")}
            </Text>
          )}
        </Stack>
      </Modal>
    </Box>
  );
}

export default function PlayVsLichessBoard() {
  return (
    <TreeStateProvider id="lichess-play-board">
      <GameTimeProvider>
        <PlayVsLichessBoardContent />
      </GameTimeProvider>
    </TreeStateProvider>
  );
}
