type PgnPuzzleProgressStore = Record<string, Record<string, true>>;
type PgnPuzzleFirstAttemptResult = "correct" | "incorrect";
type PgnPuzzleFirstAttemptStore = Record<string, Record<string, PgnPuzzleFirstAttemptResult>>;
type PgnPuzzlePathStore = Record<string, unknown>;

export const PGN_PUZZLE_PROGRESS_UPDATED_EVENT = "pgn-puzzles:progress-updated";

const STORAGE_KEY = "obsidian-chess-studio.puzzle.pgnProgress";
const ATTEMPTED_STORAGE_KEY = "obsidian-chess-studio.puzzle.pgnAttempted";
const FIRST_ATTEMPT_STORAGE_KEY = "obsidian-chess-studio.puzzle.pgnFirstAttempt";

function normalizePathKey(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  const collapsed = trimmed.replace(/\/{2,}/g, "/");
  // Windows paths are case-insensitive.
  if (/^[A-Za-z]:\//.test(collapsed)) {
    return collapsed.toLowerCase();
  }
  return collapsed;
}

function getMatchingPathKeys(store: PgnPuzzlePathStore, pgnPath: string): string[] {
  const normalized = normalizePathKey(pgnPath);
  const keys = Object.keys(store);
  return keys.filter((key) => normalizePathKey(key) === normalized);
}

function resolveWritePathKey(store: PgnPuzzlePathStore, pgnPath: string): string {
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

function getMergedFirstAttemptResults(
  store: PgnPuzzleFirstAttemptStore,
  pgnPath: string,
): Record<string, PgnPuzzleFirstAttemptResult> {
  const merged: Record<string, PgnPuzzleFirstAttemptResult> = {};
  const keys = getMatchingPathKeys(store, pgnPath);
  for (const key of keys) {
    const results = store[key];
    if (!results || typeof results !== "object") continue;
    for (const [puzzleKey, result] of Object.entries(results)) {
      if (result === "correct" || result === "incorrect") {
        merged[puzzleKey] = result;
      }
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

function readFirstAttemptStore(): PgnPuzzleFirstAttemptStore {
  try {
    const raw = localStorage.getItem(FIRST_ATTEMPT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as PgnPuzzleFirstAttemptStore;
  } catch {
    return {};
  }
}

function writeFirstAttemptStore(store: PgnPuzzleFirstAttemptStore) {
  try {
    const raw = JSON.stringify(store);
    localStorage.setItem(FIRST_ATTEMPT_STORAGE_KEY, raw);
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

function isPgnPuzzleAttemptedInStore(store: PgnPuzzleProgressStore, pgnPath: string, puzzleIndex: number): boolean {
  const attempted = getMergedPuzzleFlags(store, pgnPath);
  return !!attempted[String(puzzleIndex)];
}

function recordFirstAttemptResult(pgnPath: string, puzzleIndex: number, result: PgnPuzzleFirstAttemptResult): boolean {
  const store = readFirstAttemptStore();
  const fileKey = resolveWritePathKey(store, pgnPath);
  const puzzleKey = String(puzzleIndex);
  const results = store[fileKey] ?? {};
  if (results[puzzleKey]) return false;
  results[puzzleKey] = result;
  store[fileKey] = results;
  writeFirstAttemptStore(store);
  return true;
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

export function recordPgnPuzzleIncorrect(pgnPath: string, puzzleIndex: number): void {
  if (!pgnPath) return;
  if (!Number.isFinite(puzzleIndex)) return;

  const firstAttemptChanged = recordFirstAttemptResult(pgnPath, puzzleIndex, "incorrect");
  recordPgnPuzzleAttempted(pgnPath, puzzleIndex);
  if (firstAttemptChanged) {
    emitProgressUpdated();
  }
}

export function recordPgnPuzzleSolved(pgnPath: string, puzzleIndex: number): void {
  if (!pgnPath) return;
  if (!Number.isFinite(puzzleIndex)) return;

  const attemptedBeforeSolve = isPgnPuzzleAttemptedInStore(readAttemptedStore(), pgnPath, puzzleIndex);
  const firstAttemptResult = attemptedBeforeSolve ? "incorrect" : "correct";
  const firstAttemptChanged = recordFirstAttemptResult(pgnPath, puzzleIndex, firstAttemptResult);

  // Solved implies attempted, but accuracy is locked by the first attempt above.
  recordPgnPuzzleAttempted(pgnPath, puzzleIndex);

  const store = readStore();
  const fileKey = resolveWritePathKey(store, pgnPath);
  const puzzleKey = String(puzzleIndex);

  const solved = store[fileKey] ?? {};
  if (solved[puzzleKey]) {
    if (firstAttemptChanged) {
      emitProgressUpdated();
    }
    return;
  }
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

export function getFirstAttemptPgnPuzzleStats(pgnPath: string): { attempted: number; correct: number } {
  const firstAttemptStore = readFirstAttemptStore();
  const firstAttemptResults = getMergedFirstAttemptResults(firstAttemptStore, pgnPath);
  const attempted = getMergedPuzzleFlags(readAttemptedStore(), pgnPath);
  const solved = getMergedPuzzleFlags(readStore(), pgnPath);

  for (const puzzleKey of Object.keys(attempted)) {
    if (!firstAttemptResults[puzzleKey]) {
      firstAttemptResults[puzzleKey] = solved[puzzleKey] ? "correct" : "incorrect";
    }
  }

  const firstAttemptEntries = Object.entries(firstAttemptResults);
  const attemptedKeys = Object.keys(attempted);
  return {
    attempted: Math.max(attemptedKeys.length, firstAttemptEntries.length),
    correct: firstAttemptEntries.filter(([, result]) => result === "correct").length,
  };
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
  const firstAttemptStore = readFirstAttemptStore();
  let changed = 0;

  for (const path of uniquePaths) {
    const solvedKeys = getMatchingPathKeys(solvedStore, path);
    const attemptedKeys = getMatchingPathKeys(attemptedStore, path);
    const firstAttemptKeys = getMatchingPathKeys(firstAttemptStore, path);
    const hadSolved = solvedKeys.length > 0;
    const hadAttempted = attemptedKeys.length > 0;
    const hadFirstAttempt = firstAttemptKeys.length > 0;
    if (!hadSolved && !hadAttempted && !hadFirstAttempt) continue;

    for (const key of solvedKeys) {
      delete solvedStore[key];
    }
    for (const key of attemptedKeys) {
      delete attemptedStore[key];
    }
    for (const key of firstAttemptKeys) {
      delete firstAttemptStore[key];
    }
    changed += 1;
  }

  if (changed === 0) return 0;
  writeStore(solvedStore);
  writeAttemptedStore(attemptedStore);
  writeFirstAttemptStore(firstAttemptStore);
  emitProgressUpdated();
  return changed;
}
