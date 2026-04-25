import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { type BestMoves, commands, events } from "@/bindings";
import {
  IS_DEV,
  isMemoryTelemetryEnabled,
  MEMORY_TELEMETRY_SAMPLE_INTERVAL_MS,
  MEMORY_TELEMETRY_STORAGE_KEY,
} from "@/config";
import {
  activeTabAtom,
  bestMovesFamily,
  engineMovesFamily,
  engineProgressFamily,
  tabEngineSettingsFamily,
  tabsAtom,
} from "@/state/atoms";
import { logger } from "@/utils/logger";
import { getTabStateStorageDiagnostics, releaseTabStateMemoryCache } from "@/utils/tabStateStorage";

type Unlisten = () => void;

type BrowserPerformanceMemory = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function toMb(bytes: number): number {
  return round1(bytes / (1024 * 1024));
}

function bigintToNumber(value: bigint | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function estimateBestMovesBytes(lines: BestMoves[]): number {
  let total = 0;
  for (const line of lines) {
    total += 80;
    total += line.uciMoves.reduce((sum, move) => sum + move.length * 2, 0);
    total += line.sanMoves.reduce((sum, move) => sum + move.length * 2, 0);
  }
  return total;
}

function estimateEngineVariationCacheBytes(cache: Map<string, BestMoves[]>): number {
  let total = 0;
  for (const [key, value] of cache) {
    total += key.length * 2;
    total += estimateBestMovesBytes(value);
  }
  return total;
}

const MEMORY_PRESSURE_RSS_MB = 3_500;
const MEMORY_PRESSURE_JS_HEAP_MB = 1_200;
const MEMORY_PRESSURE_ENGINE_VARIATION_MB = 256;
const MEMORY_PRESSURE_TAB_STATE_MB = 96;
const MEMORY_PRESSURE_RSS_DELTA_MB = 256;
const MEMORY_PRESSURE_COMPACTION_COOLDOWN_MS = 60_000;
const ENGINE_VARIATION_PRESSURE_MAX_ENTRIES = 24;
const ENGINE_VARIATION_PRESSURE_MAX_BYTES = 768 * 1024;

function compactEngineVariationCacheForPressure(cache: Map<string, BestMoves[]>): {
  compacted: Map<string, BestMoves[]>;
  removedEntries: number;
  removedBytes: number;
  afterBytes: number;
} {
  const beforeSize = cache.size;
  const beforeBytes = estimateEngineVariationCacheBytes(cache);
  if (beforeSize <= ENGINE_VARIATION_PRESSURE_MAX_ENTRIES && beforeBytes <= ENGINE_VARIATION_PRESSURE_MAX_BYTES) {
    return {
      compacted: cache,
      removedEntries: 0,
      removedBytes: 0,
      afterBytes: beforeBytes,
    };
  }

  const next = new Map(cache);

  while (next.size > ENGINE_VARIATION_PRESSURE_MAX_ENTRIES) {
    const oldestKey = next.keys().next().value;
    if (oldestKey === undefined) break;
    next.delete(oldestKey);
  }

  let currentBytes = estimateEngineVariationCacheBytes(next);
  while (currentBytes > ENGINE_VARIATION_PRESSURE_MAX_BYTES && next.size > 1) {
    const oldestKey = next.keys().next().value;
    if (oldestKey === undefined) break;
    next.delete(oldestKey);
    currentBytes = estimateEngineVariationCacheBytes(next);
  }

  return {
    compacted: next,
    removedEntries: Math.max(0, beforeSize - next.size),
    removedBytes: Math.max(0, beforeBytes - currentBytes),
    afterBytes: currentBytes,
  };
}

function readHeapMemoryMb(): {
  usedMb: number;
  totalMb: number;
  limitMb: number;
} | null {
  if (typeof performance === "undefined") {
    return null;
  }

  const perf = performance as Performance & { memory?: BrowserPerformanceMemory };
  if (!perf.memory) {
    return null;
  }

  return {
    usedMb: toMb(perf.memory.usedJSHeapSize),
    totalMb: toMb(perf.memory.totalJSHeapSize),
    limitMb: toMb(perf.memory.jsHeapSizeLimit),
  };
}

export function EventMonitor() {
  const store = useStore();
  const tabs = useAtomValue(tabsAtom);
  const activeTab = useAtomValue(activeTabAtom);
  const openTabIds = useMemo(() => tabs.map((tab) => tab.value), [tabs]);
  const telemetryEnabled = useMemo(() => isMemoryTelemetryEnabled(), []);
  const previousSnapshotRef = useRef<{
    processRssMb: number | null;
    jsHeapUsedMb: number | null;
    engineVariationMb: number;
    tabStateMemoryMb: number;
  } | null>(null);
  const totalSystemMemoryMbRef = useRef<number | null>(null);
  const lastCompactionAtRef = useRef(0);
  const compactionInFlightRef = useRef(false);

  useEffect(() => {
    if (!IS_DEV) return;

    let active = true;
    let bestMovesUnlisten: Unlisten | null = null;
    let reportProgressUnlisten: Unlisten | null = null;
    let databaseProgressUnlisten: Unlisten | null = null;
    let downloadProgressUnlisten: Unlisten | null = null;

    events.bestMovesPayload
      .listen(({ payload }) => {
        logger.debug("EventMonitor bestMovesPayload", {
          engine: payload.engine,
          tab: payload.tab,
          progress: payload.progress,
          bestLinesCount: payload.bestLines.length,
          fenPrefix: payload.fen ? `${payload.fen.slice(0, 50)}...` : "",
          movesCount: payload.moves.length,
          lastMove: payload.moves[payload.moves.length - 1] ?? null,
        });
      })
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        bestMovesUnlisten = unlisten;
      })
      .catch((error) => {
        logger.warn("EventMonitor bestMovesPayload listener failed", error);
      });

    events.reportProgress
      .listen(({ payload }) => {
        logger.debug("EventMonitor reportProgress", {
          id: payload.id,
          progress: payload.progress,
          finished: payload.finished,
        });
      })
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        reportProgressUnlisten = unlisten;
      })
      .catch((error) => {
        logger.warn("EventMonitor reportProgress listener failed", error);
      });

    events.databaseProgress
      .listen(({ payload }) => {
        logger.debug("EventMonitor databaseProgress", {
          id: payload.id,
          progress: payload.progress,
        });
      })
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        databaseProgressUnlisten = unlisten;
      })
      .catch((error) => {
        logger.warn("EventMonitor databaseProgress listener failed", error);
      });

    events.downloadProgress
      .listen(({ payload }) => {
        logger.debug("EventMonitor downloadProgress", {
          id: payload.id,
          progress: payload.progress,
          finished: payload.finished,
        });
      })
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        downloadProgressUnlisten = unlisten;
      })
      .catch((error) => {
        logger.warn("EventMonitor downloadProgress listener failed", error);
      });

    return () => {
      active = false;
      bestMovesUnlisten?.();
      reportProgressUnlisten?.();
      databaseProgressUnlisten?.();
      downloadProgressUnlisten?.();
    };
  }, []);

  const compactRuntimeCaches = useCallback(
    async (reason: string): Promise<boolean> => {
      if (compactionInFlightRef.current) {
        return false;
      }
      const now = Date.now();
      if (now - lastCompactionAtRef.current < MEMORY_PRESSURE_COMPACTION_COOLDOWN_MS) {
        return false;
      }

      compactionInFlightRef.current = true;
      lastCompactionAtRef.current = now;

      try {
        const openTabsSet = new Set(openTabIds);
        if (activeTab) {
          openTabsSet.add(activeTab);
        }

        const staleTabs = new Set<string>();
        let removedEngineMoveMaps = 0;
        let compactedEngineMoveMaps = 0;
        let reclaimedEngineVariationBytes = 0;
        let removedEngineVariationEntries = 0;

        for (const param of Array.from(engineMovesFamily.getParams())) {
          if (!openTabsSet.has(param.tab)) {
            staleTabs.add(param.tab);
            const cache = store.get(engineMovesFamily(param));
            removedEngineMoveMaps += 1;
            removedEngineVariationEntries += cache.size;
            reclaimedEngineVariationBytes += estimateEngineVariationCacheBytes(cache);
            engineMovesFamily.remove(param);
            continue;
          }

          const cache = store.get(engineMovesFamily(param));
          const compacted = compactEngineVariationCacheForPressure(cache);
          if (compacted.removedEntries <= 0) {
            continue;
          }

          compactedEngineMoveMaps += 1;
          removedEngineVariationEntries += compacted.removedEntries;
          reclaimedEngineVariationBytes += compacted.removedBytes;
          store.set(engineMovesFamily(param), compacted.compacted);
        }

        let removedEngineProgressAtoms = 0;
        for (const param of Array.from(engineProgressFamily.getParams())) {
          if (openTabsSet.has(param.tab)) {
            continue;
          }
          staleTabs.add(param.tab);
          engineProgressFamily.remove(param);
          removedEngineProgressAtoms += 1;
        }

        let removedTabEngineSettingsAtoms = 0;
        for (const param of Array.from(tabEngineSettingsFamily.getParams())) {
          if (openTabsSet.has(param.tab)) {
            continue;
          }
          staleTabs.add(param.tab);
          tabEngineSettingsFamily.remove(param);
          removedTabEngineSettingsAtoms += 1;
        }

        const bestMovesParams = Array.from(bestMovesFamily.getParams());
        for (const param of bestMovesParams) {
          bestMovesFamily.remove(param);
        }

        const staleTabIds = Array.from(staleTabs);
        if (staleTabIds.length > 0) {
          await Promise.allSettled(staleTabIds.map((tabId) => commands.killEngines(tabId)));
        }

        const tabStateRelease = await releaseTabStateMemoryCache(Array.from(openTabsSet));

        logger.warn("EventMonitor memoryPressureCompaction", {
          reason,
          staleTabs: staleTabIds,
          removedEngineMoveMaps,
          compactedEngineMoveMaps,
          removedEngineVariationEntries,
          reclaimedEngineVariationMb: toMb(reclaimedEngineVariationBytes),
          removedEngineProgressAtoms,
          removedTabEngineSettingsAtoms,
          clearedBestMovesAtoms: bestMovesParams.length,
          tabStateReleasedEntries: tabStateRelease.releasedEntries,
          tabStateReleasedMb: toMb(tabStateRelease.releasedBytes),
          tabStateFlushedWrites: tabStateRelease.flushedWrites,
          tabStateRemainingEntries: tabStateRelease.remainingEntries,
          tabStateRemainingMb: toMb(tabStateRelease.remainingBytes),
        });

        return true;
      } catch (error) {
        logger.warn("EventMonitor memoryPressureCompaction failed", { reason, error });
        return false;
      } finally {
        compactionInFlightRef.current = false;
      }
    },
    [activeTab, openTabIds, store],
  );

  const sampleMemoryUsage = useCallback(async () => {
    const processRssMb = bigintToNumber(await commands.processMemoryRssMb().catch(() => null));
    const heap = readHeapMemoryMb();

    const engineMoveParams = Array.from(engineMovesFamily.getParams());
    let engineVariationEntries = 0;
    let engineVariationBytes = 0;
    for (const param of engineMoveParams) {
      const cache = store.get(engineMovesFamily(param));
      engineVariationEntries += cache.size;
      engineVariationBytes += estimateEngineVariationCacheBytes(cache);
    }

    const engineVariationMb = toMb(engineVariationBytes);
    const tabState = getTabStateStorageDiagnostics();
    const tabStateMemoryMb = toMb(tabState.memoryBytes);

    const previous = previousSnapshotRef.current;
    const deltaProcessRssMb =
      previous && processRssMb !== null && previous.processRssMb !== null
        ? round1(processRssMb - previous.processRssMb)
        : null;
    const deltaJsHeapUsedMb =
      previous && heap?.usedMb !== undefined && previous.jsHeapUsedMb !== null
        ? round1(heap.usedMb - previous.jsHeapUsedMb)
        : null;
    const deltaEngineVariationMb = previous ? round1(engineVariationMb - previous.engineVariationMb) : null;
    const deltaTabStateMemoryMb = previous ? round1(tabStateMemoryMb - previous.tabStateMemoryMb) : null;

    previousSnapshotRef.current = {
      processRssMb,
      jsHeapUsedMb: heap?.usedMb ?? null,
      engineVariationMb,
      tabStateMemoryMb,
    };

    const processRssPctOfSystem =
      processRssMb !== null && totalSystemMemoryMbRef.current
        ? round1((processRssMb / totalSystemMemoryMbRef.current) * 100)
        : null;

    const payload = {
      sampleAt: new Date().toISOString(),
      activeTab,
      tabsCount: tabs.length,
      processRssMb,
      processRssPctOfSystem,
      systemMemoryMb: totalSystemMemoryMbRef.current,
      jsHeapUsedMb: heap?.usedMb ?? null,
      jsHeapTotalMb: heap?.totalMb ?? null,
      jsHeapLimitMb: heap?.limitMb ?? null,
      engineVariationMaps: engineMoveParams.length,
      engineVariationEntries,
      engineVariationApproxMb: engineVariationMb,
      engineProgressAtoms: Array.from(engineProgressFamily.getParams()).length,
      tabEngineSettingsAtoms: Array.from(tabEngineSettingsFamily.getParams()).length,
      bestMovesAtoms: Array.from(bestMovesFamily.getParams()).length,
      tabStateCacheEntries: tabState.memoryEntries,
      tabStateCacheMb: tabStateMemoryMb,
      tabStatePendingWrites: tabState.pendingWrites,
      tabStatePendingReads: tabState.pendingReads,
      tabStatePendingWriteTimers: tabState.pendingWriteTimers,
      tabStateReadAttempted: tabState.readAttempted,
      tabStateLastPersistedEntries: tabState.lastPersistedEntries,
      tabStateRemovedIds: tabState.removedTabIds,
      deltaProcessRssMb,
      deltaJsHeapUsedMb,
      deltaEngineVariationMb,
      deltaTabStateMemoryMb,
      memoryPressure:
        (processRssMb !== null && processRssMb >= MEMORY_PRESSURE_RSS_MB) ||
        (heap?.usedMb !== undefined && heap.usedMb >= MEMORY_PRESSURE_JS_HEAP_MB) ||
        engineVariationMb >= MEMORY_PRESSURE_ENGINE_VARIATION_MB ||
        tabStateMemoryMb >= MEMORY_PRESSURE_TAB_STATE_MB ||
        (deltaProcessRssMb !== null && deltaProcessRssMb >= MEMORY_PRESSURE_RSS_DELTA_MB),
    };

    const memoryPressure = payload.memoryPressure;

    if (memoryPressure) {
      const reasons: string[] = [];
      if (processRssMb !== null && processRssMb >= MEMORY_PRESSURE_RSS_MB) {
        reasons.push(`process_rss_mb>=${MEMORY_PRESSURE_RSS_MB}`);
      }
      if (heap?.usedMb !== undefined && heap.usedMb >= MEMORY_PRESSURE_JS_HEAP_MB) {
        reasons.push(`js_heap_used_mb>=${MEMORY_PRESSURE_JS_HEAP_MB}`);
      }
      if (engineVariationMb >= MEMORY_PRESSURE_ENGINE_VARIATION_MB) {
        reasons.push(`engine_variation_mb>=${MEMORY_PRESSURE_ENGINE_VARIATION_MB}`);
      }
      if (tabStateMemoryMb >= MEMORY_PRESSURE_TAB_STATE_MB) {
        reasons.push(`tab_state_mb>=${MEMORY_PRESSURE_TAB_STATE_MB}`);
      }
      if (deltaProcessRssMb !== null && deltaProcessRssMb >= MEMORY_PRESSURE_RSS_DELTA_MB) {
        reasons.push(`delta_process_rss_mb>=${MEMORY_PRESSURE_RSS_DELTA_MB}`);
      }
      await compactRuntimeCaches(reasons.join(","));
    }

    const shouldWarn =
      (processRssMb !== null && processRssMb >= 3_000) ||
      (deltaProcessRssMb !== null && deltaProcessRssMb >= 256) ||
      engineVariationMb >= 512 ||
      tabStateMemoryMb >= 256;

    if (shouldWarn) {
      logger.warn("EventMonitor memoryTelemetry", payload);
    } else {
      logger.debug("EventMonitor memoryTelemetry", payload);
    }
  }, [activeTab, compactRuntimeCaches, store, tabs.length]);

  useEffect(() => {
    if (!telemetryEnabled) {
      return;
    }

    logger.info("EventMonitor memory telemetry enabled", {
      storageKey: MEMORY_TELEMETRY_STORAGE_KEY,
      sampleIntervalMs: MEMORY_TELEMETRY_SAMPLE_INTERVAL_MS,
    });

    let cancelled = false;

    commands
      .memorySize()
      .then((value) => {
        if (cancelled) return;
        totalSystemMemoryMbRef.current = bigintToNumber(value);
      })
      .catch(() => {
        totalSystemMemoryMbRef.current = null;
      });

    const sample = () => {
      if (cancelled) return;
      void sampleMemoryUsage();
    };

    sample();
    const intervalId = window.setInterval(sample, MEMORY_TELEMETRY_SAMPLE_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [sampleMemoryUsage, telemetryEnabled]);

  return null;
}
