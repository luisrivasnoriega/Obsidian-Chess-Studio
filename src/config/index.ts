import { version } from "../../package.json";
import type { VersionCheckConfig } from "../services/version-checker";

export const IS_DEV = import.meta.env.DEV;
export const MEMORY_TELEMETRY_STORAGE_KEY = "debug.memoryTelemetry";
export const MEMORY_TELEMETRY_QUERY_KEY = "debugMemory";
export const MEMORY_TELEMETRY_SAMPLE_INTERVAL_MS = 10_000;

export const VERSION_CHECK_CONFIG: VersionCheckConfig = {
  versionUrl: "https://api.github.com/repos/luisrivasnoriega/Obsidian-Chess-Studio/releases/latest",
  currentVersion: version,
  timeout: 15_000,
  skipInDev: true,
};

export const VERSION_CHECK_SETTINGS = {
  checkIntervalHours: 24,
  startupDelayMs: 5_000,
  useModalNotification: true,
  enabledByDefault: true,
} as const;

export function getCurrentVersion(): string {
  return VERSION_CHECK_CONFIG.currentVersion;
}

export function getVersionCheckConfig(): VersionCheckConfig {
  return {
    ...VERSION_CHECK_CONFIG,
    currentVersion: getCurrentVersion(),
    skipInDev: IS_DEV,
  };
}

export function isMemoryTelemetryEnabled(): boolean {
  if (IS_DEV) {
    return true;
  }

  if (typeof window === "undefined") {
    return false;
  }

  try {
    const queryValue = new URLSearchParams(window.location.search).get(MEMORY_TELEMETRY_QUERY_KEY);
    if (queryValue === "1" || queryValue?.toLowerCase() === "true") {
      return true;
    }

    const stored = localStorage.getItem(MEMORY_TELEMETRY_STORAGE_KEY);
    return stored === "1" || stored?.toLowerCase() === "true";
  } catch {
    return false;
  }
}
