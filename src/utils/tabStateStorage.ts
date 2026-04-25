import { invoke } from "@tauri-apps/api/core";
import type { StateStorage } from "zustand/middleware";
import { logger } from "@/utils/logger";

const tabStateMemory = new Map<string, string>();
const pendingWrites = new Map<string, string>();
const pendingWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingReads = new Map<string, Promise<string | null>>();
const readAttempted = new Set<string>();
const lastPersisted = new Map<string, string>();
const removedTabIds = new Set<string>();

const TAB_STATE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const TAB_STATE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const TAB_STATE_WRITE_DEBOUNCE_MS = 350;

let tabStateMemoryBytes = 0;

function estimateBytes(value: string): number {
  // JS strings are UTF-16 internally (approx. 2 bytes per code unit).
  return value.length * 2;
}

function removeMemoryState(tabId: string) {
  const existing = tabStateMemory.get(tabId);
  if (existing !== undefined) {
    tabStateMemoryBytes = Math.max(0, tabStateMemoryBytes - estimateBytes(existing));
  }
  tabStateMemory.delete(tabId);
}

function evictMemoryUntilWithinLimit() {
  while (tabStateMemoryBytes > TAB_STATE_MAX_TOTAL_BYTES && tabStateMemory.size > 0) {
    const oldestKey = tabStateMemory.keys().next().value as string | undefined;
    if (!oldestKey) break;
    removeMemoryState(oldestKey);
    logger.warn("Evicted tab state from memory cache", { tabId: oldestKey });
  }
}

function setMemoryState(tabId: string, value: string): boolean {
  const bytes = estimateBytes(value);
  if (bytes > TAB_STATE_MAX_ENTRY_BYTES) {
    removeMemoryState(tabId);
    logger.warn("Tab state is too large for in-memory cache; snapshot kept only in backend storage", {
      tabId,
      bytes,
      maxBytes: TAB_STATE_MAX_ENTRY_BYTES,
    });
    return false;
  }

  removeMemoryState(tabId);
  tabStateMemory.set(tabId, value);
  tabStateMemoryBytes += bytes;
  evictMemoryUntilWithinLimit();
  return true;
}

function getMemoryState(tabId: string): string | null {
  const value = tabStateMemory.get(tabId);
  if (value === undefined) return null;
  // Refresh insertion order for simple LRU behavior.
  tabStateMemory.delete(tabId);
  tabStateMemory.set(tabId, value);
  return value;
}

function readLegacySessionState(tabId: string): string | null {
  if (typeof window === "undefined") return null;

  try {
    const value = sessionStorage.getItem(tabId);
    if (value === null) {
      return null;
    }

    // Migrate old sessionStorage snapshots out of WebView memory.
    sessionStorage.removeItem(tabId);
    return value;
  } catch {
    return null;
  }
}

async function loadTabStateFromBackend(tabId: string): Promise<string | null> {
  if (removedTabIds.has(tabId)) {
    return null;
  }

  const inFlight = pendingReads.get(tabId);
  if (inFlight) {
    return inFlight;
  }

  const loadPromise = (async () => {
    if (removedTabIds.has(tabId)) {
      return null;
    }

    const legacyValue = readLegacySessionState(tabId);
    if (legacyValue !== null) {
      if (removedTabIds.has(tabId)) {
        return null;
      }
      setMemoryState(tabId, legacyValue);
      lastPersisted.set(tabId, legacyValue);
      void persistTabStateToBackend(tabId, legacyValue);
      return legacyValue;
    }

    try {
      const value = await invoke<string | null>("tab_state_read", { tabId });
      if (value !== null && !removedTabIds.has(tabId)) {
        setMemoryState(tabId, value);
        lastPersisted.set(tabId, value);
      }
      return removedTabIds.has(tabId) ? null : value;
    } catch (error) {
      logger.warn("Failed to load tab state from backend", { tabId, error });
      return null;
    } finally {
      pendingReads.delete(tabId);
    }
  })();

  pendingReads.set(tabId, loadPromise);
  return loadPromise;
}

async function persistTabStateToBackend(tabId: string, value: string): Promise<void> {
  if (removedTabIds.has(tabId)) {
    return;
  }

  try {
    await invoke("tab_state_write", { tabId, value });
    if (!removedTabIds.has(tabId)) {
      lastPersisted.set(tabId, value);
    }
  } catch (error) {
    logger.warn("Failed to persist tab state in backend", { tabId, error });
  }
}

async function removeTabStateFromBackend(tabId: string): Promise<void> {
  try {
    await invoke("tab_state_remove", { tabId });
  } catch (error) {
    logger.warn("Failed to remove tab state from backend", { tabId, error });
  }
}

function clearPendingWrite(tabId: string) {
  const timer = pendingWriteTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
  }
  pendingWriteTimers.delete(tabId);
  pendingWrites.delete(tabId);
}

async function flushPendingWrite(tabId: string): Promise<void> {
  pendingWriteTimers.delete(tabId);
  const value = pendingWrites.get(tabId);
  if (value === undefined) {
    return;
  }
  pendingWrites.delete(tabId);

  if (lastPersisted.get(tabId) === value) {
    return;
  }

  await persistTabStateToBackend(tabId, value);
}

function queueWrite(tabId: string, value: string, debounceMs: number) {
  removedTabIds.delete(tabId);
  setMemoryState(tabId, value);
  readAttempted.add(tabId);

  if (lastPersisted.get(tabId) === value) {
    clearPendingWrite(tabId);
    return;
  }

  pendingWrites.set(tabId, value);

  const currentTimer = pendingWriteTimers.get(tabId);
  if (currentTimer) {
    clearTimeout(currentTimer);
    pendingWriteTimers.delete(tabId);
  }

  if (debounceMs <= 0) {
    void flushPendingWrite(tabId);
    return;
  }

  const timer = setTimeout(() => {
    void flushPendingWrite(tabId);
  }, debounceMs);
  pendingWriteTimers.set(tabId, timer);
}

export function setTabState(tabId: string, value: string): boolean {
  queueWrite(tabId, value, 0);
  return true;
}

function setTabStateDebounced(tabId: string, value: string): void {
  queueWrite(tabId, value, TAB_STATE_WRITE_DEBOUNCE_MS);
}

export function getTabState(tabId: string): string | null {
  if (removedTabIds.has(tabId)) {
    return null;
  }

  const pending = pendingWrites.get(tabId);
  if (pending !== undefined) return pending;

  const inMemory = getMemoryState(tabId);
  if (inMemory !== null) return inMemory;

  const legacy = readLegacySessionState(tabId);
  if (legacy !== null) {
    queueWrite(tabId, legacy, TAB_STATE_WRITE_DEBOUNCE_MS);
    return legacy;
  }

  if (!readAttempted.has(tabId)) {
    readAttempted.add(tabId);
    void loadTabStateFromBackend(tabId);
  }

  return null;
}

export async function getTabStateAsync(tabId: string): Promise<string | null> {
  if (removedTabIds.has(tabId)) {
    return null;
  }

  const pending = pendingWrites.get(tabId);
  if (pending !== undefined) return pending;

  const inMemory = getMemoryState(tabId);
  if (inMemory !== null) return inMemory;

  const legacy = readLegacySessionState(tabId);
  if (legacy !== null) {
    queueWrite(tabId, legacy, TAB_STATE_WRITE_DEBOUNCE_MS);
    return legacy;
  }

  readAttempted.add(tabId);
  return loadTabStateFromBackend(tabId);
}

export function removeTabState(tabId: string) {
  removedTabIds.add(tabId);
  clearPendingWrite(tabId);
  removeMemoryState(tabId);
  lastPersisted.delete(tabId);
  readAttempted.delete(tabId);

  if (typeof window !== "undefined") {
    try {
      sessionStorage.removeItem(tabId);
    } catch {
      // Ignore migration cleanup errors.
    }
  }

  void removeTabStateFromBackend(tabId);
}

export async function clearAllTabStates() {
  tabStateMemory.clear();
  pendingWrites.clear();
  pendingReads.clear();
  pendingWriteTimers.forEach((timer) => {
    clearTimeout(timer);
  });
  pendingWriteTimers.clear();
  readAttempted.clear();
  lastPersisted.clear();
  removedTabIds.clear();
  tabStateMemoryBytes = 0;

  try {
    await invoke("tab_state_clear_all");
  } catch (error) {
    logger.warn("Failed to clear backend tab states", { error });
  }
}

export type TabStateStorageDiagnostics = {
  memoryEntries: number;
  memoryBytes: number;
  pendingWrites: number;
  pendingReads: number;
  pendingWriteTimers: number;
  readAttempted: number;
  lastPersistedEntries: number;
  removedTabIds: number;
};

export type TabStateMemoryReleaseReport = {
  releasedEntries: number;
  releasedBytes: number;
  flushedWrites: number;
  remainingEntries: number;
  remainingBytes: number;
};

export async function releaseTabStateMemoryCache(keepTabIds: string[] = []): Promise<TabStateMemoryReleaseReport> {
  const keepSet = new Set(keepTabIds.filter((tabId) => tabId.length > 0));
  let flushedWrites = 0;

  const pendingWriteKeys = Array.from(pendingWrites.keys());
  for (const tabId of pendingWriteKeys) {
    if (keepSet.has(tabId) || removedTabIds.has(tabId)) {
      continue;
    }
    const timer = pendingWriteTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      pendingWriteTimers.delete(tabId);
    }
    await flushPendingWrite(tabId);
    flushedWrites += 1;
  }

  let releasedEntries = 0;
  let releasedBytes = 0;
  const memoryEntries = Array.from(tabStateMemory.entries());
  for (const [tabId, value] of memoryEntries) {
    if (keepSet.has(tabId)) {
      continue;
    }
    releasedEntries += 1;
    releasedBytes += estimateBytes(value);
    removeMemoryState(tabId);
    readAttempted.delete(tabId);
  }

  return {
    releasedEntries,
    releasedBytes,
    flushedWrites,
    remainingEntries: tabStateMemory.size,
    remainingBytes: tabStateMemoryBytes,
  };
}

export function getTabStateStorageDiagnostics(): TabStateStorageDiagnostics {
  return {
    memoryEntries: tabStateMemory.size,
    memoryBytes: tabStateMemoryBytes,
    pendingWrites: pendingWrites.size,
    pendingReads: pendingReads.size,
    pendingWriteTimers: pendingWriteTimers.size,
    readAttempted: readAttempted.size,
    lastPersistedEntries: lastPersisted.size,
    removedTabIds: removedTabIds.size,
  };
}

export const tabStateStorage = {
  getItem: (key: string) => getTabState(key),
  setItem: (key: string, value: string) => {
    setTabState(key, value);
  },
  removeItem: (key: string) => {
    removeTabState(key);
  },
};

export const tabStatePersistStorage: StateStorage<Promise<void>> = {
  getItem: (key: string) => {
    const immediate = getTabState(key);
    if (immediate !== null) {
      return immediate;
    }
    return getTabStateAsync(key);
  },
  setItem: async (key: string, value: string) => {
    setTabStateDebounced(key, value);
  },
  removeItem: async (key: string) => {
    removeTabState(key);
  },
};
