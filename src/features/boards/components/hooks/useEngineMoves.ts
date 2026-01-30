import { notifications } from "@mantine/notifications";
import { parseUci } from "chessops";
import { useAtomValue } from "jotai";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { commands, events } from "@/bindings";
import { TreeStateContext } from "@/components/TreeStateContext";
import { activeTabAtom, currentGameStateAtom, currentPlayersAtom } from "@/state/atoms";
import { getMainLine } from "@/utils/chess";
import type { positionFromFen } from "@/utils/chessops";
import type { TreeNode } from "@/utils/treeReducer";
import { treeIteratorMainLine } from "@/utils/treeReducer";
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
  // Skip duplicate payloads: once we've applied a move for (tab, fen, moves.length), ignore further events for same key
  const lastAppliedPayloadKeyRef = useRef<string | null>(null);
  // Force re-request after error by incrementing this counter
  const [_retryCounter, setRetryCounter] = useState(0);

  // Use refs for times to avoid triggering effect on time updates
  const whiteTimeRef = useRef(whiteTime);
  const blackTimeRef = useRef(blackTime);
  useEffect(() => {
    whiteTimeRef.current = whiteTime;
    blackTimeRef.current = blackTime;
  }, [whiteTime, blackTime]);

  const moves = useMemo(() => getMainLine(root, headers.variant === "Chess960"), [root, headers.variant]);
  const mainLine = useMemo(() => Array.from(treeIteratorMainLine(root)), [root]);
  const _lastNode = useMemo(() => mainLine[mainLine.length - 1].node, [mainLine]);

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
        const tabKey = activeTab + currentTurn;

        // Create a unique key for this request to prevent duplicate calls
        // Include engine path to ensure uniqueness per engine instance
        const requestKey = `${tabKey}-${engine.path}-${root.fen}-${moves.join(",")}`;

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
        lastAppliedPayloadKeyRef.current = null;

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
        // Otherwise use the engine's default go mode
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
            : player.go;

        const baseOptions = (engine.settings || [])
          .filter((s) => s.name !== "MultiPV" && s.name !== "WeightsFile")
          .map((s) => ({ ...s, value: s.value?.toString() ?? "" }));

        const runRequest = async () => {
          let extraOptions = [...baseOptions];
          if (engine.name.startsWith("Leela Chess Zero")) {
            let weightsPath =
              player.type === "engine" && "lc0NetworkPath" in player
                ? player.lc0NetworkPath
                : undefined;
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
          .then((res: any) => {
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

            // Fallback: if backend returns a final result immediately (e.g. cached) apply it without waiting for the event.
            if (res.data && res.data[0] === 100 && !pos.isEnd() && gameState === "playing") {
              const [, bestLines] = res.data;
              const bestUci = bestLines?.[0]?.uciMoves?.[0];
              if (bestUci) {
                engineRequestRef.current = null;
                engineRequestDetailsRef.current = null;
                appendMove({
                  payload: parseUci(bestUci)!,
                  clock: (pos.turn === "white" ? whiteTimeRef.current : blackTimeRef.current) ?? undefined,
                });
              }
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

        // Return cleanup function to cancel timeout if effect re-runs or component unmounts
        return () => {
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          // Only clear refs if this specific request is still active
          if (engineRequestRef.current === requestKey) {
            engineRequestRef.current = null;
            engineRequestDetailsRef.current = null;
          }
        };
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
    appendMove,
    t,
    players.black,
    players.white?.timeControl?.seconds,
    players.white,
    _retryCounter,
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

    const flush = () => {
      if (!pending) return;
      const payload = pending;
      pending = null;

      // Skip duplicate payloads: backend can emit 99.99/100 many times; process each (tab,fen,moves) once
      const payloadKey = `${payload.tab}|${payload.fen}|${payload.moves.length}`;
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
        // Only apply when payload is for the current position (same main-line length).
        // Prevents applying twice when we get repeated 100/99.99 events.
        const currentMoves = getMainLine(root, headers.variant === "Chess960");
        if (payload.moves.length !== currentMoves.length) {
          return;
        }

        const hasActiveRequest = !!engineRequestRef.current;
        const payloadMatchesFen = payload.fen === root.fen;
        if (!hasActiveRequest && !payloadMatchesFen) {
          return;
        }
        if (engineRequestDetailsRef.current) {
          const requestDetails = engineRequestDetailsRef.current;
          if (requestDetails.fen !== root.fen || requestDetails.tab !== payload.tab) {
            return;
          }
        }

        const bestUci = payload.bestLines?.[0]?.uciMoves?.[0];
        if (!bestUci) {
          return;
        }
        const parsed = parseUci(bestUci);
        if (!parsed) {
          return;
        }

        // Verify move is legal (handles normal moves, castling, en passant, drops)
        if (!pos.isLegal(parsed)) {
          engineRequestRef.current = null;
          engineRequestDetailsRef.current = null;
          setRetryCounter((prev) => prev + 1);
          return;
        }

        // Clear refs BEFORE applying move to prevent race conditions and duplicate moves
        const _currentRequestKey = engineRequestRef.current;
        engineRequestRef.current = null;
        engineRequestDetailsRef.current = null;

        try {
          appendMove({
            payload: parsed,
            clock: (pos.turn === "white" ? whiteTimeRef.current : blackTimeRef.current) ?? undefined,
          });
          // Only mark as applied after success so duplicate events are skipped; if appendMove throws we can retry
          lastAppliedPayloadKeyRef.current = payloadKey;
        } catch (_error) {
          // Clear refs on error to allow retry; do NOT set lastAppliedPayloadKeyRef so we can process this payload again
          engineRequestRef.current = null;
          engineRequestDetailsRef.current = null;
          setRetryCounter((prev) => prev + 1);
        }
      } else if (payload.progress >= 99.99 && tabEndsWithTurn) {
        // Only clear the engine request ref if it matches this payload
        // This prevents clearing requests for different positions/turns
        if (
          engineRequestDetailsRef.current?.tab === payload.tab &&
          engineRequestDetailsRef.current?.fen === payload.fen
        ) {
          engineRequestRef.current = null;
          engineRequestDetailsRef.current = null;
        }
      }
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
          flush();
          return;
        }
        pending = payload;
        if (timer == null) {
          timer = window.setTimeout(() => {
            timer = null;
            if (isMounted) {
              flush();
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
  }, [gameState, headers.result, activeTab, appendMove, pos, players, root.fen, t]);
}
