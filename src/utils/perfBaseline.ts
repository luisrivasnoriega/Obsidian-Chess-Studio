import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/utils/logger";

type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

export type PerfBaselineSample = {
  scope: string;
  label: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  jsHeapStartMb: number | null;
  jsHeapEndMb: number | null;
  jsHeapDeltaMb: number | null;
  rssStartMb: number | null;
  rssEndMb: number | null;
  rssDeltaMb: number | null;
  metadata?: Record<string, JsonLike>;
};

export type PerfBaselineSpan = {
  scope: string;
  label: string;
  startedAtMs: number;
  jsHeapStartMb: number | null;
  rssStartPromise: Promise<number | null>;
  metadata?: Record<string, JsonLike>;
};

const MAX_BASELINE_SAMPLES = 512;
const baselineSamples: PerfBaselineSample[] = [];

function readJsHeapMb(): number | null {
  if (typeof performance === "undefined") return null;
  const perfWithMemory = performance as Performance & {
    memory?: {
      usedJSHeapSize?: number;
    };
  };
  const used = perfWithMemory.memory?.usedJSHeapSize;
  if (typeof used !== "number" || !Number.isFinite(used) || used <= 0) return null;
  return used / (1024 * 1024);
}

async function readProcessRssMb(): Promise<number | null> {
  try {
    const rss = await invoke<number | null>("process_memory_rss_mb");
    if (typeof rss !== "number" || !Number.isFinite(rss) || rss <= 0) return null;
    return rss;
  } catch {
    return null;
  }
}

function toFixedOrNull(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(2));
}

function pushBaselineSample(sample: PerfBaselineSample): void {
  baselineSamples.push(sample);
  if (baselineSamples.length > MAX_BASELINE_SAMPLES) {
    baselineSamples.shift();
  }

  if (typeof window !== "undefined") {
    (
      window as typeof window & {
        __ocsPerfBaselineSamples?: PerfBaselineSample[];
      }
    ).__ocsPerfBaselineSamples = [...baselineSamples];
  }
}

export function startPerfBaselineSpan(args: {
  scope: string;
  label: string;
  metadata?: Record<string, JsonLike>;
}): PerfBaselineSpan {
  return {
    scope: args.scope,
    label: args.label,
    startedAtMs: performance.now(),
    jsHeapStartMb: readJsHeapMb(),
    rssStartPromise: readProcessRssMb(),
    metadata: args.metadata,
  };
}

export async function finishPerfBaselineSpan(
  span: PerfBaselineSpan,
  metadata?: Record<string, JsonLike>,
): Promise<PerfBaselineSample> {
  const endedAtMs = performance.now();
  const jsHeapEndMb = readJsHeapMb();
  const rssStartMb = await span.rssStartPromise;
  const rssEndMb = await readProcessRssMb();

  const mergedMetadata =
    span.metadata || metadata
      ? {
          ...(span.metadata ?? {}),
          ...(metadata ?? {}),
        }
      : undefined;

  const sample: PerfBaselineSample = {
    scope: span.scope,
    label: span.label,
    startedAtMs: Number(span.startedAtMs.toFixed(2)),
    endedAtMs: Number(endedAtMs.toFixed(2)),
    durationMs: Number((endedAtMs - span.startedAtMs).toFixed(2)),
    jsHeapStartMb: toFixedOrNull(span.jsHeapStartMb),
    jsHeapEndMb: toFixedOrNull(jsHeapEndMb),
    jsHeapDeltaMb: toFixedOrNull(
      span.jsHeapStartMb !== null && jsHeapEndMb !== null ? jsHeapEndMb - span.jsHeapStartMb : null,
    ),
    rssStartMb: toFixedOrNull(rssStartMb),
    rssEndMb: toFixedOrNull(rssEndMb),
    rssDeltaMb: toFixedOrNull(rssStartMb !== null && rssEndMb !== null ? rssEndMb - rssStartMb : null),
    metadata: mergedMetadata,
  };

  pushBaselineSample(sample);
  void logger.info("[perf-baseline]", sample);
  return sample;
}

export async function perfBaselinePoint(args: {
  scope: string;
  label: string;
  metadata?: Record<string, JsonLike>;
}): Promise<PerfBaselineSample> {
  const span = startPerfBaselineSpan(args);
  return finishPerfBaselineSpan(span);
}

export function getPerfBaselineSamples(): PerfBaselineSample[] {
  return [...baselineSamples];
}
