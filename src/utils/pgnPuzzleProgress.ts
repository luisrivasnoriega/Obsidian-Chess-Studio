type PgnPuzzleProgressStore = Record<string, Record<string, true>>;

export const PGN_PUZZLE_PROGRESS_UPDATED_EVENT = "pgn-puzzles:progress-updated";

const STORAGE_KEY = "obsidian-chess-studio.puzzle.pgnProgress";
const ATTEMPTED_STORAGE_KEY = "obsidian-chess-studio.puzzle.pgnAttempted";

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

export function recordPgnPuzzleAttempted(pgnPath: string, puzzleIndex: number): void {
  if (!pgnPath) return;
  if (!Number.isFinite(puzzleIndex)) return;

  const store = readAttemptedStore();
  const fileKey = pgnPath;
  const puzzleKey = String(puzzleIndex);

  const attempted = store[fileKey] ?? {};
  if (attempted[puzzleKey]) return;
  attempted[puzzleKey] = true;
  store[fileKey] = attempted;

  writeAttemptedStore(store);

  try {
    window.dispatchEvent(new Event(PGN_PUZZLE_PROGRESS_UPDATED_EVENT));
  } catch {
    // noop (non-browser env)
  }
}

export function recordPgnPuzzleSolved(pgnPath: string, puzzleIndex: number): void {
  if (!pgnPath) return;
  if (!Number.isFinite(puzzleIndex)) return;

  // Solved implies attempted.
  recordPgnPuzzleAttempted(pgnPath, puzzleIndex);

  const store = readStore();
  const fileKey = pgnPath;
  const puzzleKey = String(puzzleIndex);

  const solved = store[fileKey] ?? {};
  if (solved[puzzleKey]) return;
  solved[puzzleKey] = true;
  store[fileKey] = solved;

  writeStore(store);

  try {
    window.dispatchEvent(new Event(PGN_PUZZLE_PROGRESS_UPDATED_EVENT));
  } catch {
    // noop (non-browser env)
  }
}

export function getSolvedPgnPuzzleCount(pgnPath: string): number {
  const store = readStore();
  const solved = store[pgnPath];
  if (!solved || typeof solved !== "object") return 0;
  return Object.keys(solved).length;
}

export function getSolvedPgnPuzzleIndexes(pgnPath: string): number[] {
  const store = readStore();
  const solved = store[pgnPath];
  if (!solved || typeof solved !== "object") return [];
  return Object.keys(solved)
    .map((key) => Number.parseInt(key, 10))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

export function isPgnPuzzleSolved(pgnPath: string, puzzleIndex: number): boolean {
  const store = readStore();
  const solved = store[pgnPath];
  if (!solved || typeof solved !== "object") return false;
  return !!solved[String(puzzleIndex)];
}

export function getAttemptedPgnPuzzleCount(pgnPath: string): number {
  const store = readAttemptedStore();
  const attempted = store[pgnPath];
  if (!attempted || typeof attempted !== "object") return 0;
  return Object.keys(attempted).length;
}

export function isPgnPuzzleAttempted(pgnPath: string, puzzleIndex: number): boolean {
  const store = readAttemptedStore();
  const attempted = store[pgnPath];
  if (!attempted || typeof attempted !== "object") return false;
  return !!attempted[String(puzzleIndex)];
}
