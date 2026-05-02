type PgnPuzzleProgressStore = Record<string, Record<string, true>>;

export const PGN_PUZZLE_PROGRESS_UPDATED_EVENT = "pgn-puzzles:progress-updated";

const STORAGE_KEY = "obsidian-chess-studio.puzzle.pgnProgress";
const ATTEMPTED_STORAGE_KEY = "obsidian-chess-studio.puzzle.pgnAttempted";

function normalizePathKey(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  const collapsed = trimmed.replace(/\/{2,}/g, "/");
  // Windows paths are case-insensitive.
  if (/^[A-Za-z]:\//.test(collapsed)) {
    return collapsed.toLowerCase();
  }
  return collapsed;
}

function getMatchingPathKeys(store: PgnPuzzleProgressStore, pgnPath: string): string[] {
  const normalized = normalizePathKey(pgnPath);
  const keys = Object.keys(store);
  return keys.filter((key) => normalizePathKey(key) === normalized);
}

function resolveWritePathKey(store: PgnPuzzleProgressStore, pgnPath: string): string {
  const exact = store[pgnPath];
  if (exact && typeof exact === "object") return pgnPath;
  const matching = getMatchingPathKeys(store, pgnPath);
  if (matching.length > 0) return matching[0];
  return normalizePathKey(pgnPath);
}

function getMergedPuzzleFlags(store: PgnPuzzleProgressStore, pgnPath: string): Record<string, true> {
  const merged: Record<string, true> = {};
  const keys = getMatchingPathKeys(store, pgnPath);
  for (const key of keys) {
    const flags = store[key];
    if (!flags || typeof flags !== "object") continue;
    for (const puzzleKey of Object.keys(flags)) {
      merged[puzzleKey] = true;
    }
  }
  return merged;
}

function readStore(): PgnPuzzleProgressStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as PgnPuzzleProgressStore;
  } catch {
    return {};
  }
}

function writeStore(store: PgnPuzzleProgressStore) {
  try {
    const raw = JSON.stringify(store);
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // ignore write errors (e.g., quota)
  }
}

function readAttemptedStore(): PgnPuzzleProgressStore {
  try {
    const raw = localStorage.getItem(ATTEMPTED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as PgnPuzzleProgressStore;
  } catch {
    return {};
  }
}

function writeAttemptedStore(store: PgnPuzzleProgressStore) {
  try {
    const raw = JSON.stringify(store);
    localStorage.setItem(ATTEMPTED_STORAGE_KEY, raw);
  } catch {
    // ignore write errors (e.g., quota)
  }
}

function emitProgressUpdated(): void {
  try {
    window.dispatchEvent(new Event(PGN_PUZZLE_PROGRESS_UPDATED_EVENT));
  } catch {
    // noop (non-browser env)
  }
}

export function recordPgnPuzzleAttempted(pgnPath: string, puzzleIndex: number): void {
  if (!pgnPath) return;
  if (!Number.isFinite(puzzleIndex)) return;

  const store = readAttemptedStore();
  const fileKey = resolveWritePathKey(store, pgnPath);
  const puzzleKey = String(puzzleIndex);

  const attempted = store[fileKey] ?? {};
  if (attempted[puzzleKey]) return;
  attempted[puzzleKey] = true;
  store[fileKey] = attempted;

  writeAttemptedStore(store);
  emitProgressUpdated();
}

export function recordPgnPuzzleSolved(pgnPath: string, puzzleIndex: number): void {
  if (!pgnPath) return;
  if (!Number.isFinite(puzzleIndex)) return;

  // Solved implies attempted.
  recordPgnPuzzleAttempted(pgnPath, puzzleIndex);

  const store = readStore();
  const fileKey = resolveWritePathKey(store, pgnPath);
  const puzzleKey = String(puzzleIndex);

  const solved = store[fileKey] ?? {};
  if (solved[puzzleKey]) return;
  solved[puzzleKey] = true;
  store[fileKey] = solved;

  writeStore(store);
  emitProgressUpdated();
}

export function getSolvedPgnPuzzleCount(pgnPath: string): number {
  const store = readStore();
  const solved = getMergedPuzzleFlags(store, pgnPath);
  return Object.keys(solved).length;
}

export function getSolvedPgnPuzzleIndexes(pgnPath: string): number[] {
  const store = readStore();
  const solved = getMergedPuzzleFlags(store, pgnPath);
  return Object.keys(solved)
    .map((key) => Number.parseInt(key, 10))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

export function isPgnPuzzleSolved(pgnPath: string, puzzleIndex: number): boolean {
  const store = readStore();
  const solved = getMergedPuzzleFlags(store, pgnPath);
  return !!solved[String(puzzleIndex)];
}

export function getAttemptedPgnPuzzleCount(pgnPath: string): number {
  const store = readAttemptedStore();
  const attempted = getMergedPuzzleFlags(store, pgnPath);
  return Object.keys(attempted).length;
}

export function isPgnPuzzleAttempted(pgnPath: string, puzzleIndex: number): boolean {
  const store = readAttemptedStore();
  const attempted = getMergedPuzzleFlags(store, pgnPath);
  return !!attempted[String(puzzleIndex)];
}

export function resetPgnPuzzleProgressForPaths(pgnPaths: string[]): number {
  const uniquePaths = Array.from(new Set(pgnPaths.map((path) => path.trim()).filter((path) => path.length > 0)));
  if (uniquePaths.length === 0) return 0;

  const solvedStore = readStore();
  const attemptedStore = readAttemptedStore();
  let changed = 0;

  for (const path of uniquePaths) {
    const solvedKeys = getMatchingPathKeys(solvedStore, path);
    const attemptedKeys = getMatchingPathKeys(attemptedStore, path);
    const hadSolved = solvedKeys.length > 0;
    const hadAttempted = attemptedKeys.length > 0;
    if (!hadSolved && !hadAttempted) continue;

    for (const key of solvedKeys) {
      delete solvedStore[key];
    }
    for (const key of attemptedKeys) {
      delete attemptedStore[key];
    }
    changed += 1;
  }

  if (changed === 0) return 0;
  writeStore(solvedStore);
  writeAttemptedStore(attemptedStore);
  emitProgressUpdated();
  return changed;
}
