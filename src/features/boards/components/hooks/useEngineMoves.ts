import { notifications } from "@mantine/notifications";
import { parseUci } from "chessops";
import { useAtomValue } from "jotai";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { type BestMoves, commands, events, pickHumanStrategicMove } from "@/bindings";
import { TreeStateContext } from "@/components/TreeStateContext";
import { activeTabAtom, currentGameStateAtom, currentPlayersAtom } from "@/state/atoms";
import { getMainLine } from "@/utils/chess";
import type { positionFromFen } from "@/utils/chessops";
import { buildEngineVariationCacheKey } from "@/utils/engineCacheKey";
import type { TreeNode } from "@/utils/treeReducer";

function movesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function useEngineMoves(
  root: TreeNode,
  headers: { variant?: string; result?: string },
  pos: ReturnType<typeof positionFromFen>[0],
  whiteTime: number | null,
  blackTime: number | null,
) {
  const { t } = useTranslation();
  const activeTab = useAtomValue(activeTabAtom);
  const gameState = useAtomValue(currentGameStateAtom);
  const players = useAtomValue(currentPlayersAtom);
  const store = useContext(TreeStateContext)!;
  const appendMove = useStore(store, (s) => s.appendMove);

  const engineRequestRef = useRef<string | null>(null);
  const engineRequestDetailsRef = useRef<{
    tab: string;
    engineTurn: "white" | "black";
    fen: string;
    moves: string[];
  } | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip duplicate payloads: once we've applied a move for (tab, fen, moves), ignore further events for same key
  const lastAppliedPayloadKeyRef = useRef<string | null>(null);
  // Ensure each request can apply at most one move.
  const appliedRequestKeyRef = useRef<string | null>(null);
  // Force re-request after error by incrementing this counter
  const [_retryCounter, setRetryCounter] = useState(0);

  // Use refs for times to avoid triggering effect on time updates
  const whiteTimeRef = useRef(whiteTime);
  const blackTimeRef = useRef(blackTime);
  useEffect(() => {
    whiteTimeRef.current = whiteTime;
    blackTimeRef.current = blackTime;
  }, [whiteTime, blackTime]);

  const rootRef = useRef(root);
  const posRef = useRef(pos);
  const headersRef = useRef(headers);
  const gameStateRef = useRef(gameState);
  useEffect(() => {
    rootRef.current = root;
    posRef.current = pos;
    headersRef.current = headers;
    gameStateRef.current = gameState;
  }, [root, pos, headers, gameState]);

  const moves = useMemo(() => getMainLine(root, headers.variant === "Chess960"), [root, headers.variant]);
  const buildPayloadKey = useCallback(
    (tab: string, fen: string, moves: string[]) => `${tab}|${buildEngineVariationCacheKey(fen, moves)}`,
    [],
  );

  const chooseEngineMoveUci = useCallback(
    async (params: {
      fen: string;
      moves: string[];
      bestLines: BestMoves[];
      engineProfile: "default" | "strategicHuman";
    }): Promise<string | null> => {
      const fallback = params.bestLines?.[0]?.uciMoves?.[0] ?? null;
      if (params.engineProfile !== "strategicHuman" || !fallback) {
        return fallback;
      }

      try {
        const selection = await pickHumanStrategicMove({
          fen: params.fen,
          moves: params.moves,
          candidates: params.bestLines,
          config: {
            // Strategic-human profile: allow slightly wider practical concessions,
            // but stay inside engine safety rails.
            maxEngineDropCp: 65,
            maxAbsoluteDisadvantageCp: 65,
            lastResortDisadvantageCp: 80,
            minStrategicScore: 0.4,
            highConvictionThreshold: 0.78,
          },
        });

        if (selection.status === "ok" && selection.data?.selectedUci) {
          return selection.data.selectedUci;
        }
      } catch (_e) {
        // Fallback to engine top move if strategic selector fails.
      }

      return fallback;
    },
    [],
  );

  const tryApplyEngineMove = useCallback(
    async (params: {
      requestKey: string;
      tab: string;
      fen: string;
      moves: string[];
      bestLines: BestMoves[];
      engineProfile: "default" | "strategicHuman";
      payloadKey?: string;
    }): Promise<boolean> => {
      if (engineRequestRef.current !== params.requestKey) return false;
      if (appliedRequestKeyRef.current === params.requestKey) return false;
      if (gameStateRef.current !== "playing" || headersRef.current.result !== "*") return false;

      const requestDetails = engineRequestDetailsRef.current;
      if (!requestDetails) return false;
      if (requestDetails.tab !== params.tab || requestDetails.fen !== params.fen) return false;
      if (!movesEqual(requestDetails.moves, params.moves)) return false;

      const currentMoves = getMainLine(rootRef.current, headersRef.current.variant === "Chess960");
      if (!movesEqual(currentMoves, params.moves)) return false;

      const currentPos = posRef.current;
      if (!currentPos || currentPos.isEnd()) return false;

      const bestUci = await chooseEngineMoveUci({
        fen: params.fen,
        moves: params.moves,
        bestLines: params.bestLines ?? [],
        engineProfile: params.engineProfile,
      });
      if (!bestUci) return false;

      const parsed = parseUci(bestUci);
      if (!parsed) return false;
      if (!currentPos.isLegal(parsed)) return false;

      appliedRequestKeyRef.current = params.requestKey;
      engineRequestRef.current = null;
      engineRequestDetailsRef.current = null;

      try {
        appendMove({
          payload: parsed,
          clock: (currentPos.turn === "white" ? whiteTimeRef.current : blackTimeRef.current) ?? undefined,
        });
        lastAppliedPayloadKeyRef.current = params.payloadKey ?? buildPayloadKey(params.tab, params.fen, params.moves);
        return true;
      } catch {
        appliedRequestKeyRef.current = null;
        engineRequestRef.current = null;
        engineRequestDetailsRef.current = null;
        setRetryCounter((prev) => prev + 1);
        return false;
      }
    },
    [appendMove, buildPayloadKey, chooseEngineMoveUci],
  );

  // Request engine moves when it's the engine's turn
  // Use separate effect for position/turn changes vs time updates
  useEffect(() => {
    // Early return if game is not playing - don't make any requests
    if (gameState !== "playing" || headers.result !== "*") {
      // Clear all refs and timeouts when game ends
      if (engineRequestRef.current) {
        engineRequestRef.current = null;
        engineRequestDetailsRef.current = null;
      }
      // Clear any pending timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      return;
    }

    // Only proceed if we have a valid position
    if (!pos) {
      return;
    }

    // Only request engine moves when game is actively playing
    if (pos && gameState === "playing" && headers.result === "*") {
      const currentTurn = pos.turn;
      const player = currentTurn === "white" ? players.white : players.black;

      if (player.type === "engine" && player.engine) {
        const engine = player.engine;
        const engineProfile = player.engineProfile ?? "default";
        const tabKey = activeTab + currentTurn;

        // Create a unique key for this request to prevent duplicate calls
        // Include engine path to ensure uniqueness per engine instance
        const requestKey = `${tabKey}-${engine.path}-${buildEngineVariationCacheKey(root.fen, moves)}`;

        // Skip if we're already processing this exact request
        if (engineRequestRef.current === requestKey) {
          return;
        }

        // Also check if we have a pending request for a different position/turn
        // If so, clear it first to avoid conflicts
        if (engineRequestRef.current && engineRequestRef.current !== requestKey) {
          // Clear the old request - it's for a different position
          engineRequestRef.current = null;
          engineRequestDetailsRef.current = null;
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
        }

        // Mark this request as in progress BEFORE making the call
        // This prevents multiple calls from creating duplicate engines
        engineRequestRef.current = requestKey;
        engineRequestDetailsRef.current = {
          tab: tabKey,
          engineTurn: currentTurn,
          fen: root.fen,
          moves: moves,
        };
        appliedRequestKeyRef.current = null;

        // Calculate time for engine - use actual remaining time or fallback to timeControl seconds
        // Use refs to get current time values without triggering effect on time updates
        const engineTime =
          currentTurn === "white"
            ? (whiteTimeRef.current ?? player.timeControl?.seconds ?? 0)
            : (blackTimeRef.current ?? player.timeControl?.seconds ?? 0);
        const opponentTime =
          currentTurn === "white"
            ? (blackTimeRef.current ?? players.black?.timeControl?.seconds ?? 0)
            : (whiteTimeRef.current ?? players.white?.timeControl?.seconds ?? 0);

        // Only use PlayersTime if we have valid time values and timeControl is set
        // Otherwise use Lc0 nodes limit (default 1) when engine is Lc0, else engine's go mode
        const goMode =
          player.timeControl && engineTime > 0 && opponentTime >= 0
            ? {
                t: "PlayersTime" as const,
                c: {
                  white: currentTurn === "white" ? engineTime : opponentTime,
                  black: currentTurn === "white" ? opponentTime : engineTime,
                  winc: player.timeControl.increment ?? 0,
                  binc: player.timeControl.increment ?? 0,
                },
              }
            : engine.name.startsWith("Leela Chess Zero") && player.type === "engine" && "lc0Nodes" in player
              ? { t: "Nodes" as const, c: Math.max(1, Math.floor(player.lc0Nodes ?? 1)) }
              : player.go;

        const baseOptions = (engine.settings || [])
          .filter((s) => s.name !== "MultiPV" && s.name !== "WeightsFile")
          .map((s) => ({ ...s, value: s.value?.toString() ?? "" }));

        const runRequest = async () => {
          let extraOptions = [...baseOptions];
          if (engineProfile === "strategicHuman") {
            extraOptions = [...extraOptions, { name: "MultiPV", value: "4" }];
          }
          if (engine.name.startsWith("Leela Chess Zero")) {
            let weightsPath =
              player.type === "engine" && "lc0NetworkPath" in player ? player.lc0NetworkPath : undefined;
            if (!weightsPath) {
              const r = await commands.listLc0Networks();
              if (r.status === "ok" && r.data?.length) weightsPath = r.data[0].path;
            }
            if (weightsPath) {
              extraOptions = [...extraOptions, { name: "WeightsFile", value: weightsPath }];
            }
          }
          return commands.getBestMoves(currentTurn, engine.path, tabKey, goMode, {
            fen: root.fen,
            moves: moves,
            extraOptions,
          });
        };

        const requestPromise = runRequest();

        const isLc0 = engine.name.startsWith("Leela Chess Zero");
        const timeoutMs = isLc0 ? 5_000 : 60_000;
        timeoutRef.current = setTimeout(() => {
          if (engineRequestRef.current === requestKey) {
            engineRequestRef.current = null;
            engineRequestDetailsRef.current = null;
            setRetryCounter((prev) => prev + 1);
          }
          timeoutRef.current = null;
        }, timeoutMs);

        requestPromise
          .then(async (res: any) => {
            // Clear timeout if promise resolves
            if (timeoutRef.current) {
              clearTimeout(timeoutRef.current);
              timeoutRef.current = null;
            }

            // Check if game is still playing before processing response
            if (gameState !== "playing" || headers.result !== "*") {
              return;
            }

            // Check if this request is still active (not superseded by another request)
            if (engineRequestRef.current !== requestKey) {
              return;
            }

            // IMPORTANT: tauri-specta commands resolve to Result; errors do NOT necessarily throw.
            // If we don't handle the error branch here, `engineRequestRef` can get stuck and the engine will never move.
            if (res.status === "error") {
              engineRequestRef.current = null;
              engineRequestDetailsRef.current = null;
              notifications.show({
                title: t("common.error", "Error"),
                message: typeof res.error === "string" ? res.error : t("errors.unknownError"),
                color: "red",
              });
              return;
            }

            // Fallback: if backend returns a final result immediately (e.g. cached),
            // apply only when request and position still match exactly.
            if (res.data && res.data[0] === 100) {
              const [, bestLines] = res.data;
              const payloadKey = buildPayloadKey(tabKey, root.fen, moves);
              if (lastAppliedPayloadKeyRef.current === payloadKey) return;
              await tryApplyEngineMove({
                requestKey,
                tab: tabKey,
                fen: root.fen,
                moves,
                bestLines: bestLines ?? [],
                engineProfile,
                payloadKey,
              });
            }
          })
          .catch((e) => {
            // Clear timeout if promise rejects
            if (timeoutRef.current) {
              clearTimeout(timeoutRef.current);
              timeoutRef.current = null;
            }

            // Only show error if request is still active and game is still playing
            if (engineRequestRef.current === requestKey && gameState === "playing" && headers.result === "*") {
              engineRequestRef.current = null;
              engineRequestDetailsRef.current = null;
              notifications.show({
                title: t("common.error", "Error"),
                message: e instanceof Error ? e.message : t("errors.unknownError"),
                color: "red",
              });
            }
          });
      } else {
        // Clear ref if it's not an engine turn
        engineRequestRef.current = null;
        engineRequestDetailsRef.current = null;
      }
    }

    // Always return cleanup function to cancel any pending timeouts
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
    // Depend on position/turn changes and key identifiers, but not time updates.
    // _retryCounter: when timeout fires we increment it so this effect re-runs and sends a new request.
  }, [
    gameState,
    pos,
    players.white.type,
    players.black.type,
    headers.result,
    activeTab,
    root.fen,
    moves,
    t,
    players.black,
    players.white?.timeControl?.seconds,
    players.white,
    buildPayloadKey,
    tryApplyEngineMove,
  ]);

  // Listen for engine move responses
  // Throttle best-moves event processing to avoid stutter while dragging/moving pieces.
  // We only need the latest payload at ~10fps (~100ms intervals).
  useEffect(() => {
    // Early return if game is not playing - don't set up listener
    if (gameState !== "playing" || headers.result !== "*") {
      // Clear any pending requests when game ends
      engineRequestRef.current = null;
      engineRequestDetailsRef.current = null;
      return;
    }

    const throttleMs = 100;
    let pending: (typeof events.bestMovesPayload extends any ? any : any) | null = null;
    let timer: number | null = null;
    let unlistenFn: (() => void) | null = null;
    let flushing = false;

    const flushOnce = async () => {
      if (!pending) return;
      const payload = pending;
      pending = null;

      // Skip duplicate payloads: backend can emit 99.99/100 many times; process each (tab,fen,moves) once
      const payloadKey = buildPayloadKey(payload.tab, payload.fen, payload.moves ?? []);
      if (lastAppliedPayloadKeyRef.current === payloadKey) {
        return;
      }

      // Only process moves when game is actively playing
      if (gameState !== "playing" || headers.result !== "*" || !activeTab || !pos) {
        return;
      }

      const expectedTab = activeTab + pos.turn;
      const currentPlayer = players[pos.turn];
      const isEngineTurn = currentPlayer?.type === "engine";
      const currentEngineProfile =
        currentPlayer?.type === "engine" ? (currentPlayer.engineProfile ?? "default") : "default";

      // More flexible tab matching: check if payload.tab ends with current turn
      // This handles cases where the tab ID might have changed but the game is still active
      const tabEndsWithTurn = payload.tab.endsWith(pos.turn);
      const tabMatchesExactly = payload.tab === expectedTab;
      const tabMatches = tabMatchesExactly || tabEndsWithTurn;

      // Backend emits 99.99 for PlayersTime/Infinite from Info; only 100 when engine sends "bestmove".
      // Lc0 sometimes never sends "bestmove" in some positions, so treat 99.99 with best lines as final.
      const progressFinal = payload.progress >= 99.99;
      const shouldApplyMove =
        progressFinal &&
        tabMatches &&
        payload.engine === pos.turn &&
        isEngineTurn &&
        !pos.isEnd() &&
        headers.result === "*" &&
        (payload.bestLines?.length ?? 0) > 0;

      if (shouldApplyMove) {
        const requestKey = engineRequestRef.current;
        if (!requestKey) return;
        await tryApplyEngineMove({
          requestKey,
          tab: payload.tab,
          fen: payload.fen,
          moves: payload.moves ?? [],
          bestLines: payload.bestLines ?? [],
          engineProfile: currentEngineProfile,
          payloadKey,
        });
      }
    };

    const requestFlush = () => {
      if (flushing) return;
      flushing = true;
      void (async () => {
        try {
          while (isMounted && pending) {
            await flushOnce();
          }
        } finally {
          flushing = false;
          // If a new payload arrived after we left the loop, process it.
          if (isMounted && pending) {
            requestFlush();
          }
        }
      })();
    };

    let isMounted = true;

    // Set up the listener
    events.bestMovesPayload
      .listen(({ payload }) => {
        if (!isMounted) return;
        // Progress 100 or 99.99 (PlayersTime) = final: flush immediately so we never overwrite it
        if (payload.progress >= 99.99) {
          if (timer != null) {
            window.clearTimeout(timer);
            timer = null;
          }
          pending = payload;
          requestFlush();
          return;
        }
        pending = payload;
        if (timer == null) {
          timer = window.setTimeout(() => {
            timer = null;
            if (isMounted) {
              requestFlush();
            }
          }, throttleMs);
        }
      })
      .then((unlisten) => {
        if (isMounted) {
          unlistenFn = unlisten;
        } else {
          // Component unmounted while listener was being set up, clean up immediately
          try {
            unlisten();
          } catch (_e) {
            // Ignore errors if callback was already cleaned up
          }
        }
      })
      .catch(() => {
        notifications.show({
          title: t("common.error"),
          message: t("errors.failedToInitializeListener"),
          color: "red",
        });
      });

    return () => {
      isMounted = false;
      pending = null;
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
      // Clean up the listener immediately if we have it
      if (unlistenFn) {
        try {
          unlistenFn();
        } catch (_e) {
          // Ignore errors if callback was already cleaned up
        }
        unlistenFn = null;
      }
    };
  }, [gameState, headers.result, activeTab, pos, players, t, buildPayloadKey, tryApplyEngineMove]);
}
