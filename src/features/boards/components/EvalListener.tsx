import { parseUci } from "chessops";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import equal from "fast-deep-equal";
import { useAtomValue, useSetAtom } from "jotai";
import { startTransition, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { type EngineOptions, events, type GoMode } from "@/bindings";
import { TreeStateContext } from "@/components/TreeStateContext";
import {
  activeTabAtom,
  currentThreatAtom,
  engineMovesFamily,
  engineProgressFamily,
  loadableEnginesAtom,
  tabEngineSettingsFamily,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { getBestMoves as chessdbGetBestMoves } from "@/utils/chessdb/api";
import { positionFromFen, swapMove } from "@/utils/chessops";
import { type Engine, killEngine, type LocalEngine, getBestMoves as localGetBestMoves } from "@/utils/engines";
import { getBestMoves as lichessGetBestMoves } from "@/utils/lichess/api";
import { useThrottledEffect } from "@/utils/misc";

const ENGINE_VARIATION_CACHE_LIMIT = 160;

function upsertEngineVariationCache<T>(
  prev: Map<string, T>,
  key: string,
  value: T,
  deleteKeys: string[] = [],
): Map<string, T> {
  const next = new Map(prev);
  for (const k of deleteKeys) {
    next.delete(k);
  }
  // Refresh insertion order for existing keys to behave like a tiny LRU.
  if (next.has(key)) {
    next.delete(key);
  }
  next.set(key, value);

  while (next.size > ENGINE_VARIATION_CACHE_LIMIT) {
    const oldestKey = next.keys().next().value;
    if (oldestKey === undefined) break;
    next.delete(oldestKey);
  }
  return next;
}

function EvalListener() {
  const loadableEngines = useAtomValue(loadableEnginesAtom);
  const threat = useAtomValue(currentThreatAtom);
  const store = useContext(TreeStateContext)!;
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
  const store = useContext(TreeStateContext)!;
  const setScore = useStore(store, (s) => s.setScore);
  const activeTab = useAtomValue(activeTabAtom);
  const setProgress = useSetAtom(engineProgressFamily({ engine: engine.name, tab: activeTab! }));
  const setEngineVariation = useSetAtom(engineMovesFamily({ engine: engine.name, tab: activeTab! }));
  const settings = useAtomValue(
    tabEngineSettingsFamily({
      engineName: engine.name,
      defaultSettings: engine.settings ?? undefined,
      defaultGo: engine.go ?? undefined,
      tab: activeTab!,
    }),
  );
  const throttleMs = 100;
  const searchingMovesKey = useMemo(() => searchingMoves.join(","), [searchingMoves]);
  const movesKey = useMemo(() => moves.join(","), [moves]);
  const settingsKey = useMemo(() => JSON.stringify(settings.settings), [settings.settings]);
  const pendingRef = useRef<{
    ev: typeof settings extends any ? any : any;
    progress: number;
  } | null>(null);
  const timerRef = useRef<number | null>(null);

  const flushPending = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    startTransition(() => {
      setEngineVariation((prev) => {
        const staleKeys: string[] = [];
        if (threat) {
          staleKeys.push(`${fen}:${movesKey}`);
        } else if (finalFen) {
          staleKeys.push(`${swapMove(finalFen)}:`);
        }
        return upsertEngineVariationCache(prev, `${searchingFen}:${searchingMovesKey}`, pending.ev, staleKeys);
      });
      setProgress(pending.progress);
      setScore(pending.ev[0].score);
    });
  }, [fen, finalFen, movesKey, searchingFen, searchingMovesKey, setEngineVariation, setProgress, setScore, threat]);

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
        pendingRef.current = { ev, progress: payload.progress };
        if (timerRef.current == null) {
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            flushPending();
          }, throttleMs);
        }
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
  }, [activeTab, settings.enabled, isGameOver, searchingFen, engine.name, flushPending, searchingMoves]);

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
      // Skip if this is the variants-builder-backend tab (used during build variants)
      if (activeTab?.includes("variants-builder")) {
        if (engine.type === "local") {
          killEngine(engine, activeTab);
        }
        return;
      }

      if (settings.enabled) {
        if (isGameOver) {
          if (engine.type === "local") {
            killEngine(engine, activeTab!);
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
          getBestMoves(activeTab!, settings.go, {
            moves: searchingMoves,
            fen: searchingFen,
            extraOptions: options,
          }).then((moves) => {
            if (moves) {
              const [progress, bestMoves] = moves;
              setEngineVariation((prev) => {
                return upsertEngineVariationCache(prev, `${searchingFen}:${searchingMoves.join(",")}`, bestMoves);
              });
              setProgress(progress);
            }
          });
        }
      } else {
        if (engine.type === "local") {
          killEngine(engine, activeTab!);
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
      setEngineVariation,
      setProgress,
      engine,
    ],
  );
  return null;
}

export default EvalListener;
