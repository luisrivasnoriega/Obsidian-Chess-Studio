import { parseUci } from "chessops";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import equal from "fast-deep-equal";
import { useAtomValue, useSetAtom } from "jotai";
import { startTransition, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { type BestMoves, type EngineOptions, events, type GoMode } from "@/bindings";
import { TreeStateContext } from "@/components/TreeStateContext";
import {
  activeTabAtom,
  boardInteractionActiveAtom,
  currentThreatAtom,
  engineMovesFamily,
  engineProgressFamily,
  loadableEnginesAtom,
  tabEngineSettingsFamily,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { getBestMoves as chessdbGetBestMoves } from "@/utils/chessdb/api";
import { positionFromFen, swapMove } from "@/utils/chessops";
import { buildEngineVariationCacheKey } from "@/utils/engineCacheKey";
import { type Engine, killEngine, type LocalEngine, getBestMoves as localGetBestMoves } from "@/utils/engines";
import { getBestMoves as lichessGetBestMoves } from "@/utils/lichess/api";
import { useThrottledEffect } from "@/utils/misc";

const ENGINE_VARIATION_CACHE_LIMIT = 96;
const ENGINE_VARIATION_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const ENGINE_VARIATION_MAX_LINES = 6;
const ENGINE_VARIATION_MAX_PV_PLIES = 24;

function normalizeBestLines(lines: BestMoves[]): BestMoves[] {
  return lines.slice(0, ENGINE_VARIATION_MAX_LINES).map((line) => ({
    ...line,
    // Long PVs can grow very large in memory. Keep enough context for UI while capping payload size.
    uciMoves: line.uciMoves.slice(0, ENGINE_VARIATION_MAX_PV_PLIES),
    sanMoves: line.sanMoves.slice(0, ENGINE_VARIATION_MAX_PV_PLIES),
  }));
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function bestLinesEqual(a: BestMoves[], b: BestMoves[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.nodes !== y.nodes ||
      x.depth !== y.depth ||
      x.multipv !== y.multipv ||
      x.nps !== y.nps ||
      x.score.value.type !== y.score.value.type ||
      x.score.value.value !== y.score.value.value
    ) {
      return false;
    }
    const xWdl = x.score.wdl;
    const yWdl = y.score.wdl;
    if (xWdl === null || yWdl === null) {
      if (xWdl !== yWdl) return false;
    } else if (xWdl[0] !== yWdl[0] || xWdl[1] !== yWdl[1] || xWdl[2] !== yWdl[2]) {
      return false;
    }

    if (!arraysEqual(x.uciMoves, y.uciMoves) || !arraysEqual(x.sanMoves, y.sanMoves)) {
      return false;
    }
  }
  return true;
}

function estimateBestLineBytes(lines: BestMoves[]): number {
  // Approximate memory usage to keep the cache bounded by payload size.
  let bytes = 0;
  for (const line of lines) {
    bytes += 80; // numeric fields + object overhead approximation
    bytes += line.uciMoves.reduce((sum, move) => sum + move.length * 2, 0);
    bytes += line.sanMoves.reduce((sum, move) => sum + move.length * 2, 0);
  }
  return bytes;
}

function estimateCacheBytes(cache: Map<string, BestMoves[]>): number {
  let total = 0;
  for (const [key, value] of cache) {
    total += key.length * 2;
    total += estimateBestLineBytes(value);
  }
  return total;
}

function upsertEngineVariationCache(
  prev: Map<string, BestMoves[]>,
  key: string,
  value: BestMoves[],
  deleteKeys: string[] = [],
): Map<string, BestMoves[]> {
  const normalizedValue = normalizeBestLines(value);

  let next = prev;
  let changed = false;

  for (const k of deleteKeys) {
    if (!next.has(k)) continue;
    if (!changed) {
      next = new Map(next);
      changed = true;
    }
    next.delete(k);
  }

  const existing = next.get(key);
  if (existing !== undefined && bestLinesEqual(existing, normalizedValue)) {
    if (!changed) {
      return prev;
    }
  } else {
    if (!changed) {
      next = new Map(next);
      changed = true;
    }
    if (next.has(key)) {
      next.delete(key);
    }
    next.set(key, normalizedValue);
  }

  if (!changed) {
    return prev;
  }

  while (next.size > ENGINE_VARIATION_CACHE_LIMIT) {
    const oldestKey = next.keys().next().value;
    if (oldestKey === undefined) break;
    next.delete(oldestKey);
  }

  let totalBytes = estimateCacheBytes(next);
  while (totalBytes > ENGINE_VARIATION_CACHE_MAX_BYTES && next.size > 1) {
    const oldestKey = next.keys().next().value;
    if (oldestKey === undefined) break;
    next.delete(oldestKey);
    totalBytes = estimateCacheBytes(next);
  }

  return next;
}

function EvalListener() {
  const loadableEngines = useAtomValue(loadableEnginesAtom);
  const threat = useAtomValue(currentThreatAtom);
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("EvalListener must be used within a TreeStateProvider");
  }

  const is960 = useStore(store, (s) => s.headers.variant === "Chess960");
  const fen = useStore(store, (s) => s.root.fen);

  const moves = useStore(
    store,
    useShallow((s) => getVariationLine(s.root, s.position, is960)),
  );

  const { finalFen, isGameOver } = useMemo(() => {
    const [pos] = positionFromFen(fen);
    if (!pos) return { finalFen: null as string | null, isGameOver: false };

    for (const uci of moves) {
      const move = parseUci(uci);
      if (!move) break;
      pos.play(move);
    }

    return {
      finalFen: makeFen(pos.toSetup()),
      isGameOver: pos.isEnd(),
    };
  }, [fen, moves]);

  const { searchingFen, searchingMoves } = useMemo(
    () =>
      match(threat as boolean)
        .with(true, () => ({
          searchingFen: swapMove(finalFen || INITIAL_FEN),
          searchingMoves: [],
        }))
        .with(false, () => ({
          searchingFen: fen,
          searchingMoves: moves,
        }))
        .exhaustive(),
    [fen, moves, threat, finalFen],
  );

  if (loadableEngines.state === "hasData") {
    return loadableEngines?.data?.map((e) => (
      <EngineListener
        key={e.name}
        engine={e}
        isGameOver={isGameOver}
        finalFen={finalFen || ""}
        searchingFen={searchingFen}
        searchingMoves={searchingMoves}
        fen={fen}
        moves={moves}
        threat={threat}
        chess960={is960}
      />
    ));
  }

  return null;
}

function EngineListener({
  engine,
  isGameOver,
  finalFen,
  searchingFen,
  searchingMoves,
  fen,
  moves,
  threat,
  chess960,
}: {
  engine: Engine;
  isGameOver: boolean;
  finalFen: string;
  searchingFen: string;
  searchingMoves: string[];
  fen: string;
  moves: string[];
  threat: boolean;
  chess960: boolean;
}) {
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("EngineListener must be used within a TreeStateProvider");
  }

  const setScore = useStore(store, (s) => s.setScore);
  const activeTab = useAtomValue(activeTabAtom);
  const activeTabKey = activeTab ?? "";
  const boardInteractionActive = useAtomValue(boardInteractionActiveAtom);
  const setProgress = useSetAtom(engineProgressFamily({ engine: engine.name, tab: activeTabKey }));
  const setEngineVariation = useSetAtom(engineMovesFamily({ engine: engine.name, tab: activeTabKey }));
  const settings = useAtomValue(
    tabEngineSettingsFamily({
      engineName: engine.name,
      defaultSettings: engine.settings ?? undefined,
      defaultGo: engine.go ?? undefined,
      tab: activeTabKey,
    }),
  );
  const throttleMs = 100;
  const searchingMovesKey = useMemo(() => searchingMoves.join(","), [searchingMoves]);
  const searchingVariationCacheKey = useMemo(
    () => buildEngineVariationCacheKey(searchingFen, searchingMoves),
    [searchingFen, searchingMoves],
  );
  const currentVariationCacheKey = useMemo(() => buildEngineVariationCacheKey(fen, moves), [fen, moves]);
  const threatVariationCacheKey = useMemo(
    () => (finalFen ? buildEngineVariationCacheKey(swapMove(finalFen), []) : null),
    [finalFen],
  );
  const settingsKey = useMemo(() => JSON.stringify(settings.settings), [settings.settings]);
  const pendingRef = useRef<{
    ev: BestMoves[];
    progress: number;
  } | null>(null);
  const timerRef = useRef<number | null>(null);
  const boardInteractionActiveRef = useRef(boardInteractionActive);

  const flushPending = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    startTransition(() => {
      setEngineVariation((prev) => {
        const staleKeys: string[] = [];
        if (threat) {
          staleKeys.push(currentVariationCacheKey);
        } else if (threatVariationCacheKey) {
          staleKeys.push(threatVariationCacheKey);
        }
        return upsertEngineVariationCache(prev, searchingVariationCacheKey, pending.ev, staleKeys);
      });
      setProgress(pending.progress);
      setScore(pending.ev[0].score);
    });
  }, [
    currentVariationCacheKey,
    searchingVariationCacheKey,
    setEngineVariation,
    setProgress,
    setScore,
    threat,
    threatVariationCacheKey,
  ]);

  const queueEngineUpdate = useCallback(
    (ev: BestMoves[], progress: number) => {
      pendingRef.current = { ev, progress };
      if (boardInteractionActiveRef.current) {
        if (timerRef.current != null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        return;
      }
      if (timerRef.current == null) {
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          flushPending();
        }, throttleMs);
      }
    },
    [flushPending],
  );

  useEffect(() => {
    boardInteractionActiveRef.current = boardInteractionActive;
    if (!boardInteractionActive && pendingRef.current) {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      flushPending();
    }
  }, [boardInteractionActive, flushPending]);

  useEffect(() => {
    return () => {
      if (engine.type === "local" && activeTab) {
        // Prevent stale background engines from previous analysis tabs or unmounted boards.
        void killEngine(engine, activeTab).catch(() => {
          // Ignore best-effort cleanup failures.
        });
      }
    };
  }, [activeTab, engine]);

  useEffect(() => {
    if (!settings.enabled) return;

    // Skip if this is the variants-builder-backend tab (used during build variants)
    if (activeTab?.includes("variants-builder")) {
      return;
    }

    const unlisten = events.bestMovesPayload.listen(({ payload }) => {
      const ev = payload.bestLines;
      if (
        payload.engine === engine.name &&
        payload.tab === activeTab &&
        payload.fen === searchingFen &&
        equal(payload.moves, searchingMoves) &&
        settings.enabled &&
        !isGameOver &&
        // Skip events from variants-builder-backend tab
        payload.tab !== "variants-builder-backend"
      ) {
        // Throttle UI updates to keep analysis smooth (avoid dozens of renders/sec)
        queueEngineUpdate(ev, payload.progress);
      }
    });
    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = null;
      void unlisten
        .then((f) => f())
        .catch(() => {
          // Ignore unlisten errors (e.g. already removed)
        });
    };
  }, [activeTab, settings.enabled, isGameOver, searchingFen, engine.name, queueEngineUpdate, searchingMoves]);

  const getBestMoves = useMemo(
    () =>
      match(engine.type)
        .with(
          "local",
          () => (fen: string, goMode: GoMode, options: EngineOptions) =>
            localGetBestMoves(engine as LocalEngine, fen, goMode, options),
        )
        .with("chessdb", () => chessdbGetBestMoves)
        .with("lichess", () => lichessGetBestMoves)
        .exhaustive(),
    [engine.type, engine],
  );

  useThrottledEffect(
    () => {
      if (!activeTab) return;

      // Skip if this is the variants-builder-backend tab (used during build variants)
      if (activeTab.includes("variants-builder")) {
        if (engine.type === "local") {
          killEngine(engine, activeTab);
        }
        return;
      }

      if (settings.enabled) {
        if (isGameOver) {
          if (engine.type === "local") {
            killEngine(engine, activeTab);
          }
        } else {
          const options =
            settings.settings?.map((s) => ({
              name: s.name,
              value: s.value?.toString() || "",
            })) ?? [];
          if (chess960 && !options.find((o) => o.name === "UCI_Chess960")) {
            options.push({ name: "UCI_Chess960", value: "true" });
          }
          getBestMoves(activeTab, settings.go, {
            moves: searchingMoves,
            fen: searchingFen,
            extraOptions: options,
          }).then((moves) => {
            if (moves) {
              const [progress, bestMoves] = moves;
              queueEngineUpdate(bestMoves, progress);
            }
          });
        }
      } else {
        if (engine.type === "local") {
          killEngine(engine, activeTab);
        }
      }
    },
    50,
    [
      settings.enabled,
      settingsKey,
      settings.go,
      searchingFen,
      searchingMovesKey,
      chess960,
      isGameOver,
      activeTab,
      getBestMoves,
      engine,
      searchingVariationCacheKey,
      queueEngineUpdate,
    ],
  );
  return null;
}

export default EvalListener;
