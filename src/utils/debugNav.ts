import { appLogDir } from "@tauri-apps/api/path";
import { logger } from "@/utils/logger";

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isDebugNavEnabled(): boolean {
  if (typeof window === "undefined") return false;
  // Make debugging frictionless during local dev runs.
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (import.meta.env?.DEV) return true;
  } catch {}
  try {
    if (new URLSearchParams(window.location.search).has("debugNav")) return true;
  } catch {}
  try {
    return localStorage.getItem("obsidian.debugNav") === "1";
  } catch {
    return false;
  }
}

export function debugNavLog(...args: unknown[]): void {
  if (!isDebugNavEnabled()) return;
  try {
    // eslint-disable-next-line no-console
    console.log("[debugNav]", ...args);
  } catch {}

  try {
    void logger.info(`[debugNav] ${args.map(formatValue).join(" ")}`);
  } catch {}
}

export async function debugNavLogPaths(): Promise<void> {
  if (!isDebugNavEnabled()) return;
  try {
    const dir = await appLogDir();
    debugNavLog("appLogDir:", dir);
  } catch (e) {
    debugNavLog("appLogDir error:", e);
  }
}
