import { Box, Button, Divider, Group, Modal, Paper, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconArrowLeft,
  IconArrowsExchange,
  IconEraser,
  IconFlag,
  IconPlus,
  IconRepeat,
  IconZoomCheck,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { INITIAL_FEN } from "chessops/fen";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mosaic } from "react-mosaic-component";
import { useStore } from "zustand";
import { commands, type Outcome } from "@/bindings";
import Clock from "@/components/Clock";
import GameInfo from "@/components/GameInfo";
import { TreeStateContext } from "@/components/TreeStateContext";
import {
  activeProfileIdAtom,
  activeTabAtom,
  currentGameStateAtom,
  currentPlayersAtom,
  enginesAtom,
  profilesAtom,
  selectedPuzzleDbAtom,
  tabsAtom,
} from "@/state/atoms";
import { getMainLine, getOpening, getPGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import type { LocalEngine } from "@/utils/engines";
import { openFile } from "@/utils/files";
import { type GameRecord, saveGameRecord } from "@/utils/gameRecords";
import { createTab } from "@/utils/tabs";
import type { GameHeaders, TreeNode } from "@/utils/treeReducer";
import { createFullLayout, DEFAULT_MOSAIC_LAYOUT } from "../constants";
import { type PostGameReviewResult, runPostGameAutoReview } from "../utils/postGameReview";
import BoardGame, { useClockTimer } from "./BoardGame";
import { GameTimeProvider, useGameTime } from "./GameTimeContext";
import { useEngineMoves } from "./hooks/useEngineMoves";
import ResponsiveBoard from "./ResponsiveBoard";

function formatPgnDateUtc(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}`;
}

function formatPgnTimeUtc(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function getMainlineLastNode(root: TreeNode): TreeNode {
  let node = root;
  while (node.children.length > 0) {
    node = node.children[0];
  }
  return node;
}

function PlayVsEngineBoardContent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const profiles = useAtomValue(profilesAtom);
  const engines = useAtomValue(enginesAtom);
  const activeTab = useAtomValue(activeTabAtom);
  const [, setActiveTab] = useAtom(activeTabAtom);
  const [gameState, setGameState] = useAtom(currentGameStateAtom);
  const [players] = useAtom(currentPlayersAtom);
  const [tabs, setTabs] = useAtom(tabsAtom);
  const setSelectedPuzzleDb = useSetAtom(selectedPuzzleDbAtom);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [postGameReview, setPostGameReview] = useState<PostGameReviewResult | null>(null);
  const [isPostGameReviewRunning, setIsPostGameReviewRunning] = useState(false);
  const [postGameReviewOpened, setPostGameReviewOpened] = useState(false);
  const setupLayout = useMemo(() => createFullLayout(), []);

  // Ensure a play tab exists when mounting, using the same createTab flow as the Sidebar
  // (Sidebar uses openTabAndNavigate({ tab: { name, type: "play" }, route: "/play" }))
  useEffect(() => {
    const hasPlayTab = tabs.some((tab) => tab.type === "play");
    if (hasPlayTab) return;
    void createTab({
      tab: { name: t("features.tabs.playBoard.title"), type: "play" },
      setTabs,
      setActiveTab,
    });
    requestAnimationFrame(() => {
      try {
        navigate({ to: "/play" });
      } catch {
        // ignore
      }
    });
  }, [tabs, setTabs, setActiveTab, navigate, t]);

  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const headers = useStore(store, (s) => s.headers);
  const setHeaders = useStore(store, (s) => s.setHeaders);
  const setFen = useStore(store, (s) => s.setFen);
  const setResult = useStore(store, (s) => s.setResult);
  const clearShapes = useStore(store, (s) => s.clearShapes);

  const { whiteTime, blackTime, setWhiteTime, setBlackTime } = useGameTime();

  // Initialize times from players only at the very start of a game (no moves yet).
  // Never overwrite clock state mid-game, so the clock cannot "reset" while playing.
  useEffect(() => {
    if (gameState === "playing" && whiteTime === null && blackTime === null && root.children.length === 0) {
      if (players.white.timeControl) {
        setWhiteTime(players.white.timeControl.seconds);
      }
      if (players.black.timeControl) {
        setBlackTime(players.black.timeControl.seconds);
      }
    }
  }, [
    gameState,
    players.white.timeControl,
    players.black.timeControl,
    whiteTime,
    blackTime,
    root.children.length,
    setWhiteTime,
    setBlackTime,
  ]);

  const lastNode = useMemo(() => getMainlineLastNode(root), [root]);
  const [pos] = useMemo(() => positionFromFen(lastNode.fen), [lastNode.fen]);

  // Use clock timer to update times when game is playing
  useClockTimer(gameState, pos, whiteTime, blackTime, setWhiteTime, setBlackTime, players, setGameState, setResult);

  // PGN + opening (right panel). Defer heavy PGN generation to avoid stutter.
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

  // Calculate opening dynamically based on current position
  const [openingLabel, setOpeningLabel] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    getOpening(deferredRoot, position).then((v) => {
      if (cancelled) return;
      // If we found an opening, update it
      if (v && v !== "") {
        setOpeningLabel(v);
      }
      // If no opening found, keep the last one we found (don't clear it)
      // This ensures the opening label persists even when moving to positions
      // that don't have a named opening in the database
    });
    return () => {
      cancelled = true;
    };
  }, [deferredRoot, position]);

  // Engine logic
  useEngineMoves(
    root,
    { variant: headers.variant ?? undefined, result: headers.result ?? undefined },
    pos,
    whiteTime,
    blackTime,
  );

  const movable = useMemo(() => {
    if (players.white.type === "human" && players.black.type === "human") return "turn";
    if (players.white.type === "human") return "white";
    if (players.black.type === "human") return "black";
    return "turn";
  }, [players]);

  // Centralized, idempotent game finalization. Multiple end paths (time, resign, back, etc.)
  // must persist the game exactly once under the active profile at the moment of ending.
  const gameInstanceIdRef = useRef<string>(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const finalizedInstanceIdRef = useRef<string | null>(null);
  const isFinalizingRef = useRef(false);
  const profileIdAtGameStartRef = useRef<string | null>(activeProfileId ?? null);
  const profileIdAtGameEndRef = useRef<string | null>(null);
  const startTimestampRef = useRef<number>(Date.now());
  const startDateRef = useRef<string>(formatPgnDateUtc(new Date()));
  const startTimeRef = useRef<string>(formatPgnTimeUtc(new Date()));
  const prevMoveCountRef = useRef<number>(root.children.length);
  const postGameReviewInstanceIdRef = useRef<string | null>(null);

  useEffect(() => {
    const moveCount = root.children.length;
    const prev = prevMoveCountRef.current;

    // Reset idempotency guards only when a *new* game is actually created (tree cleared).
    // Some end paths (e.g. New game) flip gameState before the tree is cleared; if we reset
    // too early, multiple end handlers can save the same finished game.
    const didClearTree = moveCount === 0 && prev > 0;
    const initialMountEmpty = prev === 0 && moveCount === 0 && finalizedInstanceIdRef.current === null;

    if (didClearTree || initialMountEmpty) {
      gameInstanceIdRef.current = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      finalizedInstanceIdRef.current = null;
      isFinalizingRef.current = false;
      profileIdAtGameStartRef.current = activeProfileId ?? null;
      profileIdAtGameEndRef.current = null;
      postGameReviewInstanceIdRef.current = null;
      setPostGameReview(null);
      setIsPostGameReviewRunning(false);
      setPostGameReviewOpened(false);

      const ts = Date.now();
      startTimestampRef.current = ts;
      const d = new Date(ts);
      startDateRef.current = headers.date?.trim() || formatPgnDateUtc(d);
      startTimeRef.current = headers.time?.trim() || formatPgnTimeUtc(d);
    }

    prevMoveCountRef.current = moveCount;
  }, [activeProfileId, headers.date, headers.time, root.children.length]);

  const inferAbortResult = useCallback((): Outcome => {
    const humanColor =
      players.white.type === "human" ? "white" : players.black.type === "human" ? "black" : (pos?.turn ?? "white");
    return humanColor === "white" ? "0-1" : "1-0";
  }, [players, pos?.turn]);

  const resolveHumanColorForReview = useCallback(
    (headersSnapshot: GameHeaders): "white" | "black" | null => {
      if (players.white.type === "human" && players.black.type !== "human") return "white";
      if (players.black.type === "human" && players.white.type !== "human") return "black";

      const activeProfile =
        profiles.find((profile) => profile.id === activeProfileId) ??
        profiles.find((profile) => profile.id === profileIdAtGameEndRef.current) ??
        null;
      const profileName = (activeProfile?.displayName ?? activeProfile?.name ?? "").trim().toLowerCase();
      if (!profileName) return null;

      if ((headersSnapshot.white ?? "").trim().toLowerCase() === profileName) return "white";
      if ((headersSnapshot.black ?? "").trim().toLowerCase() === profileName) return "black";
      return null;
    },
    [activeProfileId, players.black.type, players.white.type, profiles],
  );

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

  const runAutoPostGameReview = useCallback(
    async (result: Outcome, instanceId: string) => {
      if (postGameReviewInstanceIdRef.current === instanceId) return;
      postGameReviewInstanceIdRef.current = instanceId;

      const activeProfile =
        profiles.find((profile) => profile.id === (profileIdAtGameEndRef.current ?? activeProfileId)) ??
        profiles.find((profile) => profile.id === profileIdAtGameStartRef.current) ??
        null;
      const profileName = (activeProfile?.displayName ?? activeProfile?.name ?? "").trim() || null;

      const rootSnapshot = structuredClone(root);
      const headersSnapshot: GameHeaders = {
        ...structuredClone(headers),
        result,
      };

      const localEngines = engines.filter((engine): engine is LocalEngine => engine.type === "local");

      setPostGameReviewOpened(true);
      setIsPostGameReviewRunning(true);

      try {
        const review = await runPostGameAutoReview({
          root: rootSnapshot,
          headers: headersSnapshot,
          humanColor: resolveHumanColorForReview(headersSnapshot),
          profileId: activeProfile?.id ?? activeProfileId ?? null,
          profileName,
          engines: localEngines,
          mode: "local",
          minEngineMsPerMove: 1000,
        });

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
      } catch {
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
      } finally {
        setIsPostGameReviewRunning(false);
      }
    },
    [activeProfileId, engines, headers, profiles, resolveHumanColorForReview, root, t],
  );

  const persistGameOnce = useCallback(
    async (result: Outcome) => {
      if (root.children.length === 0) return;

      const profileIdSnapshot =
        profileIdAtGameEndRef.current ?? activeProfileId ?? profileIdAtGameStartRef.current ?? null;
      if (!profileIdSnapshot) return;

      const initialFen = headers.fen || INITIAL_FEN;
      const lastNode = getMainlineLastNode(root);
      const uciMoves = getMainLine(root, headers.variant === "Chess960");

      const resolveProfileName = (profileId?: string | null): string | null => {
        const pid = (profileId ?? "").trim();
        if (!pid) return null;
        const p = profiles.find((x) => x.id === pid);
        const name = (p?.displayName ?? p?.name ?? "").trim();
        return name || null;
      };

      const profileName = resolveProfileName(profileIdSnapshot) ?? "";
      const profileNameLower = profileName.trim().toLowerCase();
      const headerWhiteLower = (headers.white ?? "").trim().toLowerCase();
      const headerBlackLower = (headers.black ?? "").trim().toLowerCase();

      // Determine which side is the human player. This must reflect the real colors played,
      // not board orientation (users can flip the board mid-game).
      let humanSide: "white" | "black" | null = null;
      if (players.white.type === "human" && players.black.type !== "human") humanSide = "white";
      else if (players.black.type === "human" && players.white.type !== "human") humanSide = "black";
      else if (profileNameLower && headerWhiteLower === profileNameLower) humanSide = "white";
      else if (profileNameLower && headerBlackLower === profileNameLower) humanSide = "black";
      else if (headers.orientation === "white" || headers.orientation === "black") humanSide = headers.orientation;
      else humanSide = "white";

      const engineNameFallback = (s?: string | null) => (s ?? "").trim() || "?";
      const engineWhiteName = engineNameFallback(
        players.white.type === "engine" ? players.white.engine?.name : headers.white,
      );
      const engineBlackName = engineNameFallback(
        players.black.type === "engine" ? players.black.engine?.name : headers.black,
      );

      const whiteNameFromSettings =
        humanSide === "white" ? profileName || headers.white?.trim() || "?" : engineWhiteName;
      const blackNameFromSettings =
        humanSide === "black" ? profileName || headers.black?.trim() || "?" : engineBlackName;

      // Build time control string for both stored record and PGN headers.
      let timeControlStr: string | null = null;
      if (headers.time_control) {
        timeControlStr = headers.time_control;
      } else if (headers.white_time_control || headers.black_time_control) {
        timeControlStr = `${headers.white_time_control || ""},${headers.black_time_control || ""}`;
      }

      // Tag saved games as "local" so the dashboard can filter/group them consistently.
      const headersForSave: GameHeaders = {
        ...headers,
        site: "local",
        result,
        date: (headers.date ?? startDateRef.current) || startDateRef.current,
        time: (headers.time ?? startTimeRef.current) || startTimeRef.current,
        time_control: headers.time_control ?? timeControlStr,
        white: whiteNameFromSettings,
        black: blackNameFromSettings,
      };

      const gamePgn = getPGN(root, {
        headers: headersForSave,
        comments: true,
        extraMarkups: true,
        glyphs: true,
        variations: true,
      });

      const record: GameRecord = {
        id: gameInstanceIdRef.current,
        profileId: profileIdSnapshot,
        white: {
          type: humanSide === "white" ? "human" : "engine",
          name: whiteNameFromSettings,
          engine:
            humanSide === "white"
              ? undefined
              : players.white.type === "engine"
                ? players.white.engine?.path
                : players.black.type === "engine"
                  ? players.black.engine?.path
                  : undefined,
        },
        black: {
          type: humanSide === "black" ? "human" : "engine",
          name: blackNameFromSettings,
          engine:
            humanSide === "black"
              ? undefined
              : players.black.type === "engine"
                ? players.black.engine?.path
                : players.white.type === "engine"
                  ? players.white.engine?.path
                  : undefined,
        },
        result,
        timeControl: timeControlStr ?? undefined,
        timestamp: startTimestampRef.current,
        moves: uciMoves,
        variant: headers.variant ?? undefined,
        fen: lastNode.fen,
        initialFen: initialFen !== INITIAL_FEN ? initialFen : undefined,
        pgn: gamePgn,
      };

      const dedupeKey = `${lastNode.fen}-${uciMoves.length}-${result}-${headersForSave.date ?? ""}-${headersForSave.time ?? ""}`;
      await saveGameRecord(record, dedupeKey);
    },
    [activeProfileId, headers, players, profiles, root],
  );

  const finalizeGame = useCallback(
    async (opts: {
      reason: "board" | "time" | "resign" | "abandon" | "newGame" | "again" | "back";
      forcedResult?: Outcome;
    }) => {
      if (root.children.length === 0) return;

      const instanceId = gameInstanceIdRef.current;
      if (finalizedInstanceIdRef.current === instanceId || isFinalizingRef.current) return;

      // Claim synchronously to prevent races across effects + button handlers.
      finalizedInstanceIdRef.current = instanceId;
      isFinalizingRef.current = true;
      if (!profileIdAtGameEndRef.current) {
        profileIdAtGameEndRef.current = activeProfileId ?? profileIdAtGameStartRef.current ?? null;
      }

      const result =
        opts.forcedResult ?? (headers.result && headers.result !== "*" ? headers.result : inferAbortResult());
      const shouldRunPostGameReview =
        !!(headers.result && headers.result !== "*") || opts.reason === "resign" || opts.reason === "time";

      try {
        await persistGameOnce(result);
        if (result !== "*" && shouldRunPostGameReview) {
          void runAutoPostGameReview(result, instanceId);
        }
      } catch {
        // If persistence fails, allow a later end path to retry.
        finalizedInstanceIdRef.current = null;
        notifications.show({
          title: t("common.error"),
          message: t("errors.failedToSaveGame"),
          color: "red",
        });
      } finally {
        isFinalizingRef.current = false;
      }
    },
    [
      activeProfileId,
      headers.result,
      inferAbortResult,
      persistGameOnce,
      root.children.length,
      runAutoPostGameReview,
      t,
    ],
  );

  // Save exactly once when the game result is first produced. This must not re-fire
  // just because the user leaves and re-enters the board view with the same finished game.
  const prevResultRef = useRef<Outcome>(headers.result ?? "*");
  useEffect(() => {
    const prev = prevResultRef.current ?? "*";
    const next = headers.result ?? "*";
    prevResultRef.current = next;

    if (root.children.length === 0) return;
    if (prev !== "*" || next === "*") return;

    void finalizeGame({ reason: "board", forcedResult: next });
  }, [finalizeGame, headers.result, root.children.length]);

  const handleNewGame = async () => {
    if (root.children.length > 0) {
      await finalizeGame({
        reason: "newGame",
        forcedResult: headers.result && headers.result !== "*" ? headers.result : inferAbortResult(),
      });
    }

    // Clear times
    setWhiteTime(null);
    setBlackTime(null);
    // Clear any pending engine requests by resetting headers result
    setHeaders({
      ...headers,
      result: "*",
    });
    // Reset game state to settingUp - this should trigger the BoardGame component to show
    setGameState("settingUp");
  };

  const handleAgain = async () => {
    if (root.children.length > 0) {
      await finalizeGame({
        reason: "again",
        forcedResult: headers.result && headers.result !== "*" ? headers.result : inferAbortResult(),
      });
    }

    // Get the initial FEN from headers.fen (this should be the starting position)
    // If headers.fen is not set or is the same as current position, use INITIAL_FEN
    // When a game starts, headers.fen is set to the starting FEN
    const initialFen = headers.fen || INITIAL_FEN;

    // Reset board to initial position
    setFen(initialFen);

    // Reset times with the same time controls
    if (players.white.timeControl) {
      setWhiteTime(players.white.timeControl.seconds);
    } else {
      setWhiteTime(null);
    }

    if (players.black.timeControl) {
      setBlackTime(players.black.timeControl.seconds);
    } else {
      setBlackTime(null);
    }

    // Clear result and update headers with initial FEN
    setHeaders({
      ...headers,
      fen: initialFen,
      result: "*",
    });

    // Set game state to playing to start the new game
    setGameState("playing");
  };

  const changeToAnalysisMode = () => {
    setTabs((prev) => prev.map((tab) => (tab.value === activeTab ? { ...tab, type: "analysis" } : tab)));
  };

  const flipBoard = () => {
    const current = (headers.orientation ?? "white") as "white" | "black";
    setHeaders({
      ...headers,
      fen: root.fen, // Preserve current position
      orientation: current === "black" ? "white" : "black",
    });
  };

  const resign = async () => {
    if (gameState !== "playing") return;

    const humanColor =
      players.white.type === "human" ? "white" : players.black.type === "human" ? "black" : (pos?.turn ?? "white");

    const result: Outcome = humanColor === "white" ? "0-1" : "1-0";

    // Set result in headers so useEngineMoves stops requesting moves
    setHeaders({
      ...headers,
      fen: root.fen, // Preserve current position
      result,
    });

    setGameState("gameOver");

    // Save the game with resignation result
    await finalizeGame({ reason: "resign", forcedResult: result });
  };

  const handleBack = useCallback(async () => {
    // 1. Finalize the game exactly once before leaving the board.
    if (root.children.length > 0) {
      await finalizeGame({
        reason: "back",
        forcedResult: headers.result && headers.result !== "*" ? headers.result : inferAbortResult(),
      });
    }

    // 2. Close the tab
    if (activeTab) {
      // Kill engines for this tab
      try {
        await commands.killEngines(activeTab);
      } catch {}

      // Remove the tab and update active tab
      const index = tabs.findIndex((tab) => tab.value === activeTab);
      if (index !== -1) {
        const newTabs = tabs.filter((tab) => tab.value !== activeTab);
        setTabs(newTabs);

        // Set active tab to another tab if available
        if (newTabs.length > 0) {
          if (index === tabs.length - 1) {
            // If we closed the last tab, select the previous one
            setActiveTab(newTabs[index - 1]?.value || newTabs[0].value);
          } else {
            // Otherwise, select the next tab (or same index if available)
            setActiveTab(newTabs[index]?.value || newTabs[0].value);
          }
        } else {
          // No tabs left, set active tab to null
          setActiveTab(null);
        }
      }
    }

    // 3. Navigate to dashboard
    navigate({ to: "/" });
  }, [
    root.children.length,
    headers.result,
    activeTab,
    tabs,
    setTabs,
    setActiveTab,
    navigate,
    finalizeGame,
    inferAbortResult,
  ]);

  if (gameState === "settingUp") {
    return (
      <Box style={{ width: "100%", height: "100%", minHeight: 0, minWidth: 0, position: "relative" }}>
        <Mosaic<"left" | "topRight" | "bottomRight">
          renderTile={(id) => setupLayout[id]}
          initialValue={DEFAULT_MOSAIC_LAYOUT}
        />
        <BoardGame />
      </Box>
    );
  }

  // Prioritize board space on medium desktop resolutions (e.g. 1440x900)
  // by shrinking side panels before the board starts clipping.
  const sidePanelWidth = "clamp(220px, 18vw, 340px)";

  // Fallback: invalid/unknown position.
  if (!pos) {
    return (
      <Box style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Text>{t("common.loading")}</Text>
      </Box>
    );
  }

  return (
    <Box style={{ width: "100%", height: "100%", minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <Box
        style={{
          flex: 1,
          minHeight: 0,
          padding: "1rem",
          boxSizing: "border-box",
          display: "grid",
          gridTemplateColumns: `${sidePanelWidth} minmax(0, 1fr) ${sidePanelWidth}`,
          gridTemplateRows: "1fr",
          gap: "1rem",
          overflow: "hidden",
        }}
      >
        {/* Left panel */}
        <Paper withBorder shadow="sm" p="md" style={{ minHeight: 0, overflow: "hidden" }}>
          <Stack gap="sm" style={{ height: "100%", minHeight: 0 }}>
            <Group justify="space-between" align="center">
              <Text fw={700}>{t("common.gameInfo")}</Text>
              <Button variant="subtle" size="sm" onClick={handleBack} leftSection={<IconArrowLeft size={16} />}>
                {t("common.back")}
              </Button>
            </Group>

            {/* Clocks - Always show when game is playing or gameOver */}
            {(gameState === "playing" || gameState === "gameOver") && (
              <>
                <Text fw={600} size="sm">
                  {t("common.clocks")}
                </Text>
                <Stack gap="xs">
                  <Clock
                    color="white"
                    turn={pos?.turn ?? "white"}
                    whiteTime={whiteTime ?? undefined}
                    blackTime={blackTime ?? undefined}
                  />
                  <Clock
                    color="black"
                    turn={pos?.turn ?? "black"}
                    whiteTime={whiteTime ?? undefined}
                    blackTime={blackTime ?? undefined}
                  />
                </Stack>
                <Divider />
              </>
            )}

            <Box style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
              <GameInfo headers={headers} />
            </Box>
          </Stack>
        </Paper>

        {/* Center board */}
        <Box
          style={{
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            padding: "0.5rem",
            width: "100%",
            height: "100%",
          }}
        >
          <Box
            style={{
              height: "100%",
              width: "auto",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              maxHeight: "100%",
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
              whiteTime={undefined}
              blackTime={undefined}
              topBar={false}
              currentTabType="play"
              gameState={gameState}
              // Optional: allow Board-level hotkeys/orientation handling
              toggleOrientation={flipBoard}
              hideClockSpaces={true}
              hideEvalBar={true}
              hideFooterControls={true}
            />
          </Box>
        </Box>

        {/* Right panel */}
        <Paper withBorder shadow="sm" p="md" style={{ minHeight: 0, overflow: "hidden" }}>
          <Stack gap="sm" style={{ height: "100%", minHeight: 0 }}>
            <Text fw={700}>{t("common.gamePanel")}</Text>

            <Text fw={600} size="sm">
              {t("common.controls")}
            </Text>

            {(gameState === "playing" || gameState === "gameOver") && (
              <Stack gap="xs">
                <Group grow>
                  <Button onClick={handleNewGame} leftSection={<IconPlus size={16} />}>
                    {t("keybindings.newGame")}
                  </Button>
                  <Button variant="default" onClick={handleAgain} leftSection={<IconRepeat size={16} />}>
                    {t("common.again")}
                  </Button>
                </Group>

                <Group grow>
                  <Button variant="default" onClick={changeToAnalysisMode} leftSection={<IconZoomCheck size={16} />}>
                    {t("common.analyze")}
                  </Button>
                  <Button variant="default" onClick={flipBoard} leftSection={<IconArrowsExchange size={16} />}>
                    {t("common.flip")}
                  </Button>
                </Group>

                <Group grow>
                  <Button
                    color="red"
                    onClick={resign}
                    disabled={gameState !== "playing"}
                    leftSection={<IconFlag size={16} />}
                  >
                    {t("common.resign")}
                  </Button>
                  <Button variant="default" onClick={clearShapes} leftSection={<IconEraser size={16} />}>
                    {t("keybindings.clearShapes")}
                  </Button>
                </Group>
              </Stack>
            )}

            <Divider />

            <Text fw={600} size="sm">
              {t("common.opening")}
            </Text>
            <Text size="sm" c="dimmed">
              {openingLabel === "Empty Board"
                ? t("chess.opening.emptyBoard")
                : openingLabel === "Starting Position"
                  ? t("chess.opening.startingPosition")
                  : openingLabel || "-"}
            </Text>

            <Divider />

            <Text fw={600} size="sm">
              {t("common.pgn")}
            </Text>

            <Box style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
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
            </Box>
          </Stack>
        </Paper>
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

export default function PlayVsEngineBoard() {
  return (
    <GameTimeProvider>
      <PlayVsEngineBoardContent />
    </GameTimeProvider>
  );
}
