import type { Chess } from "chessops";
import { INITIAL_BOARD_FEN } from "chessops/fen";
import { parseSan } from "chessops/san";
import { useAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { commands, getPuzzleBatch, type PuzzleDatabaseInfo, type Token } from "@/bindings";
import { puzzleRatingRangeAtom, puzzleUnsolvedOnlyDbAtom, selectedPuzzleDbAtom } from "@/state/atoms";
import { getPgnHeaders, uciNormalize } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { logger } from "@/utils/logger";
import { getAttemptedPgnPuzzleCount, isPgnPuzzleAttempted, isPgnPuzzleSolved } from "@/utils/pgnPuzzleProgress";
import { getPuzzleDatabases, type Puzzle } from "@/utils/puzzles";
import { unwrap } from "@/utils/unwrap";

type CachedPuzzle = {
  puzzle?: Puzzle;
  tokens: Token[];
  rating: number;
  index: number;
  sideToMove: "w" | "b" | null;
};

type PuzzleSideToMove = "any" | "white" | "black";

type PuzzleCacheEntry = {
  generated: {
    minRating: number;
    maxRating: number;
    random: boolean;
    sideToMove: PuzzleSideToMove;
    unsolvedOnly: boolean;
    counter: number;
    puzzle_indexes: number[];
  };
  minRating: number;
  maxRating: number;
  puzzles: CachedPuzzle[];
};

type LoadedRatingRange = {
  dbRange: [number, number] | null;
  effectiveRange: [number, number] | null;
};

const PuzzleDbFromPgnCache = new Map<string, PuzzleCacheEntry>();
const PgnPuzzleMetaCache = new Map<string, { isPuzzleVariants: boolean }>();
const _DB3_PREFETCH_BATCH_SIZE = 80;
const DB3_PREFETCH_MIN_BUFFER = 30;
const DB3_PREFETCH_TARGET_SIZE = 120;
const DB3_PREFETCH_CRITICAL_BUFFER = 1;
const DB3_PREFETCH_BUCKET = 100;
const DB3_PREFETCH_EXPANSION = 80;

type Db3Puzzle = Omit<Puzzle, "moves" | "completion"> & { moves: string };

type Db3PrefetchEntry = {
  queue: Puzzle[];
  refillPromise: Promise<void> | null;
};

const Db3PrefetchCache = new Map<string, Db3PrefetchEntry>();

function normalizeFilterListForKey(values?: string[]): string[] {
  if (!values || values.length === 0) return [];
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))].sort((a, b) => a.localeCompare(b));
}

function toDb3Puzzle(dbPuzzle: Db3Puzzle): Puzzle {
  return {
    ...dbPuzzle,
    moves: dbPuzzle.moves.split(" "),
    completion: "incomplete",
  };
}

function normalizeRangeForPrefetch(range: [number, number], dbRange: [number, number] | null): [number, number] {
  let [min, max] = range;
  min = Math.max(0, min - DB3_PREFETCH_EXPANSION);
  max = max + DB3_PREFETCH_EXPANSION;

  if (dbRange) {
    min = Math.max(min, dbRange[0]);
    max = Math.min(max, dbRange[1]);
  }

  min = Math.floor(min / DB3_PREFETCH_BUCKET) * DB3_PREFETCH_BUCKET;
  max = Math.ceil(max / DB3_PREFETCH_BUCKET) * DB3_PREFETCH_BUCKET;
  if (max < min) max = min;

  if (dbRange) {
    min = Math.max(min, dbRange[0]);
    max = Math.min(max, dbRange[1]);
    if (max < min) max = min;
  }

  return [min, max];
}

function createDb3PrefetchKey(
  db: string,
  random: boolean,
  themes: string[],
  openingTags: string[],
  sideToMove: PuzzleSideToMove,
): string {
  return [db, random ? "rand" : "ordered", themes.join("|"), openingTags.join("|"), sideToMove].join("::");
}

function normalizeSideToMoveForBackend(sideToMove: PuzzleSideToMove): "white" | "black" | null {
  if (sideToMove === "white" || sideToMove === "black") {
    return sideToMove;
  }
  return null;
}

function getFenSideToMove(fen: string | undefined): "w" | "b" | null {
  if (!fen) return null;
  const side = fen.trim().split(/\s+/)[1];
  return side === "w" || side === "b" ? side : null;
}

function removeDb3PrefetchEntries(dbPath: string) {
  const prefix = `${dbPath}::`;
  const keys = [...Db3PrefetchCache.keys()].filter((key) => key.startsWith(prefix));
  keys.forEach((key) => {
    Db3PrefetchCache.delete(key);
  });
}

async function getPgnPuzzleMeta(dbPath: string): Promise<{ isPuzzleVariants: boolean }> {
  const cached = PgnPuzzleMetaCache.get(dbPath);
  if (cached) {
    return cached;
  }
  if (!dbPath.toLowerCase().endsWith(".pgn")) {
    const plain = { isPuzzleVariants: false };
    PgnPuzzleMetaCache.set(dbPath, plain);
    return plain;
  }

  try {
    const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
    const metadataPath = dbPath.replace(/\.pgn$/i, ".info");
    if (!(await exists(metadataPath))) {
      const plain = { isPuzzleVariants: false };
      PgnPuzzleMetaCache.set(dbPath, plain);
      return plain;
    }
    const raw = await readTextFile(metadataPath);
    const metadata = JSON.parse(raw) as { type?: string; tags?: unknown };
    const tags = Array.isArray(metadata.tags)
      ? metadata.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    const value = { isPuzzleVariants: metadata.type === "puzzle" && tags.includes("puzzle-variants") };
    PgnPuzzleMetaCache.set(dbPath, value);
    return value;
  } catch {
    const plain = { isPuzzleVariants: false };
    PgnPuzzleMetaCache.set(dbPath, plain);
    return plain;
  }
}

function takePuzzleInRange(entry: Db3PrefetchEntry, minRating: number, maxRating: number): Puzzle | null {
  if (entry.queue.length === 0) return null;

  const exactIndex = entry.queue.findIndex((puzzle) => puzzle.rating >= minRating && puzzle.rating <= maxRating);
  if (exactIndex >= 0) {
    const [selected] = entry.queue.splice(exactIndex, 1);
    return selected ?? null;
  }

  // Fallback: consume the closest puzzle to target rating instead of stalling.
  // This keeps the session fluid even if adaptive range moved slightly.
  const target = (minRating + maxRating) / 2;
  let bestIndex = 0;
  let bestDistance = Math.abs(entry.queue[0].rating - target);
  for (let i = 1; i < entry.queue.length; i += 1) {
    const distance = Math.abs(entry.queue[i].rating - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  const [selected] = entry.queue.splice(bestIndex, 1);
  return selected ?? null;
}

export const usePuzzleDatabase = () => {
  const [puzzleDbs, setPuzzleDbs] = useState<PuzzleDatabaseInfo[]>([]);
  const [isLoadingPuzzleDbs, setIsLoadingPuzzleDbs] = useState(true);
  const [selectedDb, setSelectedDb] = useAtom(selectedPuzzleDbAtom);
  const [puzzleUnsolvedOnlyDb] = useAtom(puzzleUnsolvedOnlyDbAtom);
  const [ratingRange, setRatingRange] = useAtom(puzzleRatingRangeAtom);
  const [dbRatingRange, setDbRatingRange] = useState<[number, number] | null>(null);

  // Load puzzle databases
  useEffect(() => {
    let cancelled = false;

    const loadDatabases = (forceRefresh = false) => {
      setIsLoadingPuzzleDbs(true);
      getPuzzleDatabases(forceRefresh)
        .then((databases) => {
          if (cancelled) return;
          setPuzzleDbs(databases);
          setSelectedDb((current) => {
            if (current && !databases.some((db) => db.path === current)) {
              return null;
            }
            return current;
          });
        })
        .catch((error) => {
          if (cancelled) return;
          logger.error("Failed to load puzzle databases:", error);
          setPuzzleDbs([]);
        })
        .finally(() => {
          if (!cancelled) {
            setIsLoadingPuzzleDbs(false);
          }
        });
    };

    loadDatabases();

    const onPuzzlesUpdated = () => loadDatabases(true);
    window.addEventListener("puzzles:updated", onPuzzlesUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener("puzzles:updated", onPuzzlesUpdated);
    };
  }, [setSelectedDb]);

  // Migrate legacy values where `selectedDb` was stored as a filename (e.g. "puzzles.db3")
  // into the full absolute path expected by the Rust commands.
  useEffect(() => {
    if (!selectedDb) return;
    if (!selectedDb.endsWith(".db3")) return;

    const looksLikePath = selectedDb.includes("/") || selectedDb.includes("\\") || selectedDb.includes(":");
    if (looksLikePath) return;

    (async () => {
      try {
        const { appDataDir, resolve } = await import("@tauri-apps/api/path");
        const fullPath = await resolve(await appDataDir(), "puzzles", selectedDb);
        setSelectedDb(fullPath);
      } catch (e) {
        logger.error("Failed to migrate selected puzzle db path:", e);
      }
    })();
  }, [selectedDb, setSelectedDb]);

  const loadDb3RatingRange = useCallback(async (dbPath: string): Promise<[number, number] | null> => {
    const result = await commands.getPuzzleRatingRange(dbPath);
    if (result.status === "ok") {
      return result.data;
    }

    return null;
  }, []);

  const calculateRatingBounds = useCallback((puzzles: { rating: number }[]) => {
    let minRating = Infinity;
    let maxRating = -Infinity;

    for (const p of puzzles) {
      minRating = Math.min(minRating, p.rating);
      maxRating = Math.max(maxRating, p.rating);
    }

    return { minRating, maxRating };
  }, []);

  const loadPgnRatingRange = useCallback(
    async (dbPath: string): Promise<LoadedRatingRange> => {
      const count = unwrap(await commands.countPgnGames(dbPath));

      if (count > 0) {
        const games = unwrap(await commands.readGames(dbPath, 0, count - 1));
        const puzzles = await Promise.all(
          games.map(async (game, i) => {
            const tokens = unwrap(await commands.lexPgn(game));
            const headers = getPgnHeaders(tokens);
            const rating = headers.white_elo || 1500;
            return {
              rating,
              index: i,
              tokens,
              sideToMove: getFenSideToMove(headers.fen),
            };
          }),
        );

        const { minRating, maxRating } = calculateRatingBounds(puzzles);
        PuzzleDbFromPgnCache.set(dbPath, {
          generated: {
            minRating: 0,
            maxRating: 0,
            random: false,
            sideToMove: "any",
            unsolvedOnly: false,
            counter: 0,
            puzzle_indexes: [],
          },
          minRating,
          maxRating,
          puzzles,
        });

        if (puzzles.length > 0) {
          return {
            dbRange: [minRating, maxRating],
            effectiveRange: [minRating, maxRating],
          };
        }

        return {
          dbRange: null,
          effectiveRange: [1500, 1500],
        };
      }

      return {
        dbRange: null,
        effectiveRange: [600, 2800],
      };
    },
    [calculateRatingBounds],
  );

  const loadRatingRange = useCallback(
    async (dbPath: string): Promise<LoadedRatingRange> => {
      try {
        // First verify the file exists before attempting to load rating range.
        // `selectedDb` is stored as an absolute path (`PuzzleDatabaseInfo.path`).
        if (dbPath.endsWith(".db3")) {
          const { exists } = await import("@tauri-apps/plugin-fs");
          const fileExists = await exists(dbPath);
          if (!fileExists) {
            return {
              dbRange: null,
              effectiveRange: [600, 2800],
            };
          }

          const range = await loadDb3RatingRange(dbPath);
          return {
            dbRange: range,
            effectiveRange: range,
          };
        } else if (dbPath.endsWith(".pgn")) {
          return await loadPgnRatingRange(dbPath);
        }

        return {
          dbRange: null,
          effectiveRange: null,
        };
      } catch (error) {
        // Silently handle "file not found" or "file is empty" errors
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (!errorMsg.includes("does not exist") && !errorMsg.includes("is empty")) {
          logger.error("Failed to load puzzle rating range:", error);
        }
        return {
          dbRange: null,
          effectiveRange: [600, 2800],
        };
      }
    },
    [loadDb3RatingRange, loadPgnRatingRange],
  );

  // Load rating range when database is selected
  useEffect(() => {
    if (!selectedDb) {
      setDbRatingRange(null);
      return;
    }

    let cancelled = false;
    setDbRatingRange(null);

    void loadRatingRange(selectedDb).then(({ dbRange, effectiveRange }) => {
      if (cancelled) return;
      setDbRatingRange(dbRange);
      if (effectiveRange) {
        setRatingRange(effectiveRange);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selectedDb, loadRatingRange, setRatingRange]);

  const generatePuzzleFromPgn = async (
    db: string,
    minRating: number,
    maxRating: number,
    random: boolean,
    sideToMove: PuzzleSideToMove,
  ): Promise<Puzzle | null> => {
    let localPuzzleDb = PuzzleDbFromPgnCache.get(db);
    if (!localPuzzleDb) {
      await loadPgnRatingRange(db);
      localPuzzleDb = PuzzleDbFromPgnCache.get(db);
    }
    if (!localPuzzleDb) {
      throw new Error("Puzzle database not found in cache");
    }

    const { isPuzzleVariants } = await getPgnPuzzleMeta(db);

    // Check if this is a puzzle variants file and if we should filter unsolved puzzles
    let shouldFilterUnattempted = false;
    const unsolvedOnly = puzzleUnsolvedOnlyDb === db;

    if (isPuzzleVariants && random) {
      try {
        // Check if not 100% attempted (for puzzle variants we don't want repeats until all are attempted)
        const totalPuzzles = unwrap(await commands.countPgnGames(db));
        const attemptedCount = getAttemptedPgnPuzzleCount(db);
        shouldFilterUnattempted = attemptedCount < totalPuzzles;
      } catch (_error) {
        // Continue with normal logic if metadata check fails
      }
    }

    if (
      localPuzzleDb.generated.minRating !== minRating ||
      localPuzzleDb.generated.maxRating !== maxRating ||
      localPuzzleDb.generated.random !== random ||
      localPuzzleDb.generated.sideToMove !== sideToMove ||
      localPuzzleDb.generated.unsolvedOnly !== unsolvedOnly ||
      localPuzzleDb.generated.counter >= localPuzzleDb.generated.puzzle_indexes.length
    ) {
      // UI filter is the player's side. Puzzle auto-plays first move, so player side
      // must match the opposite side of the initial FEN.
      const normalizedSide = sideToMove === "white" ? "b" : sideToMove === "black" ? "w" : null;
      let puzzle_indexes = localPuzzleDb.puzzles
        .map((p, i) => {
          const inRange = isPuzzleVariants ? true : p.rating >= minRating && p.rating <= maxRating;
          const sideMatches = normalizedSide ? p.sideToMove === normalizedSide : true;
          return inRange && sideMatches ? i : -1;
        })
        .filter((i) => i !== -1);

      // If puzzle variants and random mode and not 100% complete, filter out solved puzzles
      if (isPuzzleVariants && random && shouldFilterUnattempted) {
        puzzle_indexes = puzzle_indexes.filter((idx) => !isPgnPuzzleAttempted(db, idx));
      }
      if (unsolvedOnly) {
        puzzle_indexes = puzzle_indexes.filter((idx) => !isPgnPuzzleSolved(db, idx));
      }

      // For random selection (inOrder=false), we want "random but no repeats" until exhausted.
      // Shuffle the candidate list once, then walk through it with `counter`.
      if (random && puzzle_indexes.length > 1) {
        for (let i = puzzle_indexes.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [puzzle_indexes[i], puzzle_indexes[j]] = [puzzle_indexes[j], puzzle_indexes[i]];
        }
      }

      localPuzzleDb.generated = {
        minRating,
        maxRating,
        random,
        sideToMove,
        unsolvedOnly,
        counter: 0,
        puzzle_indexes,
      };
    }

    const { puzzle_indexes } = localPuzzleDb.generated;
    if (!puzzle_indexes.length) return null;

    // Select next index:
    // - If random=true: walk shuffled list to avoid repeats.
    // - If random=false: walk list in order (existing behavior).
    let attempts = 0;
    while (attempts < puzzle_indexes.length) {
      const idx = puzzle_indexes[localPuzzleDb.generated.counter % puzzle_indexes.length];
      localPuzzleDb.generated.counter += 1;

      // If this is a puzzle-variants file and we are filtering unattempted, skip entries that
      // became attempted since the list was generated.
      if (isPuzzleVariants && random && shouldFilterUnattempted && isPgnPuzzleAttempted(db, idx)) {
        attempts += 1;
        continue;
      }
      if (unsolvedOnly && isPgnPuzzleSolved(db, idx)) {
        attempts += 1;
        continue;
      }

      const selectedGame = localPuzzleDb.puzzles[idx];
      if (!selectedGame) return null;

      if (!selectedGame.puzzle) {
        selectedGame.puzzle = await createPuzzleFromGame(selectedGame);
      }

      // IMPORTANT: return a fresh puzzle object so session completion mutations do not leak into the cache.
      return {
        ...selectedGame.puzzle,
        moves: [...selectedGame.puzzle.moves],
        completion: "incomplete",
        source: { type: "pgn", path: db, index: selectedGame.index },
      };
    }

    return null;
  };

  const createPuzzleFromGame = async (selectedGame: CachedPuzzle): Promise<Puzzle> => {
    const headers = getPgnHeaders(selectedGame.tokens);
    const puzzleFen = headers.fen.trim() || INITIAL_BOARD_FEN;
    const [pos, error] = positionFromFen(puzzleFen);
    const isChess960 = headers.variant === "Chess960";

    if (error) {
      logger.error("createPuzzleFromGame: error parsing positionFromFen", error);
      throw new Error("Failed to parse position");
    }

    const normalizePuzzleSan = (san: string) => {
      // Keep SAN intact as much as possible.
      // Some sources may use 0-0 / o-o style castling, so normalize those.
      return san
        .replace(/0-0-0/gi, "O-O-O")
        .replace(/0-0/gi, "O-O")
        .replace(/o-o-o/gi, "O-O-O")
        .replace(/o-o/gi, "O-O");
    };

    const tryParseSanWithFallbacks = (pos: Chess, san: string) => {
      // 1) Try as-is (this correctly handles pawn moves like "bxc6")
      const direct = parseSan(pos, san);
      if (direct) return direct;

      // 2) If some PGNs contain lowercase piece letters (e.g. "nxf7"),
      // try uppercasing only the first character as a fallback.
      // This is safe because we only do it when the direct parse fails.
      const first = san[0];
      if (first && first >= "a" && first <= "z") {
        const uppercased = first.toUpperCase() + san.slice(1);
        return parseSan(pos, uppercased);
      }

      return null;
    };

    const parsedMoves = selectedGame.tokens
      .filter((t) => t.type === "San")
      .map((t) => t.value)
      .map(normalizePuzzleSan)
      .map((san) => {
        if (pos) {
          const move = tryParseSanWithFallbacks(pos, san);
          const uciMove = move ? uciNormalize(pos, move, isChess960) : null;
          if (move) {
            pos.play(move);
          }
          return uciMove;
        }
        return null;
      });

    const moves = parsedMoves.filter((move) => move !== null);

    if (parsedMoves.length !== moves.length) {
      logger.error("Some moves could not be parsed from SAN to UCI. This needs to be fixed.", {
        selectedGame,
        parsedMoves,
        moves,
      });
    }

    return {
      fen: puzzleFen,
      moves,
      rating: selectedGame.rating,
      rating_deviation: 0,
      popularity: 0,
      nb_plays: 0,
      completion: "incomplete",
    };
  };

  const refillDb3Prefetch = useCallback(
    async (
      key: string,
      db: string,
      minRating: number,
      maxRating: number,
      random: boolean,
      themes: string[],
      openingTags: string[],
      sideToMove: PuzzleSideToMove,
      targetSize: number,
    ) => {
      let entry = Db3PrefetchCache.get(key);
      if (!entry) {
        entry = { queue: [], refillPromise: null };
        Db3PrefetchCache.set(key, entry);
      }

      if (entry.refillPromise) {
        await entry.refillPromise;
        return;
      }

      entry.refillPromise = (async () => {
        const needed = Math.max(0, targetSize - entry.queue.length);
        if (needed === 0) return;

        const result = await getPuzzleBatch(
          db,
          minRating,
          maxRating,
          random,
          themes.length > 0 ? themes : null,
          openingTags.length > 0 ? openingTags : null,
          normalizeSideToMoveForBackend(sideToMove),
          needed,
        );

        if (result.status === "error") {
          if (entry.queue.length === 0) {
            throw new Error(result.error);
          }
          return;
        }

        const batch = result.data as Db3Puzzle[];
        if (batch.length === 0) return;
        entry.queue.push(...batch.map(toDb3Puzzle));
      })().finally(() => {
        const cacheEntry = Db3PrefetchCache.get(key);
        if (cacheEntry) {
          cacheEntry.refillPromise = null;
        }
      });

      await entry.refillPromise;
    },
    [],
  );

  const generatePuzzle = async (
    db: string,
    currentRange: [number, number],
    inOrder: boolean,
    themes?: string[],
    openingTags?: string[],
    sideToMove: PuzzleSideToMove = "any",
  ): Promise<Puzzle> => {
    const dbInfo = puzzleDbs.find((p) => p.path === db);
    if (!dbInfo && !db.toLowerCase().endsWith(".pgn")) {
      throw new Error("Database not found");
    }
    if (dbInfo?.path.endsWith(".db3")) {
      const normalizedThemes = normalizeFilterListForKey(themes);
      const normalizedOpeningTags = normalizeFilterListForKey(openingTags);
      const normalizedSideToMove = sideToMove;
      const random = !inOrder;
      const [prefetchMin, prefetchMax] = normalizeRangeForPrefetch(currentRange, dbRatingRange);
      const prefetchKey = createDb3PrefetchKey(
        db,
        random,
        normalizedThemes,
        normalizedOpeningTags,
        normalizedSideToMove,
      );

      let entry = Db3PrefetchCache.get(prefetchKey);
      let puzzle = entry ? takePuzzleInRange(entry, currentRange[0], currentRange[1]) : null;

      // Fast path: if we already have puzzles in queue, return immediately and keep refill async.
      if (puzzle) {
        const queueAfterPop = entry?.queue.length ?? 0;
        if (entry && queueAfterPop <= DB3_PREFETCH_CRITICAL_BUFFER && !entry.refillPromise) {
          void refillDb3Prefetch(
            prefetchKey,
            db,
            prefetchMin,
            prefetchMax,
            random,
            normalizedThemes,
            normalizedOpeningTags,
            normalizedSideToMove,
            DB3_PREFETCH_TARGET_SIZE,
          );
        } else if (entry && queueAfterPop <= DB3_PREFETCH_MIN_BUFFER && !entry.refillPromise) {
          void refillDb3Prefetch(
            prefetchKey,
            db,
            prefetchMin,
            prefetchMax,
            random,
            normalizedThemes,
            normalizedOpeningTags,
            normalizedSideToMove,
            DB3_PREFETCH_TARGET_SIZE,
          );
        }
        return puzzle;
      }

      // Slow path: queue is empty or has no puzzle in exact requested range; wait for refill once.
      await refillDb3Prefetch(
        prefetchKey,
        db,
        prefetchMin,
        prefetchMax,
        random,
        normalizedThemes,
        normalizedOpeningTags,
        normalizedSideToMove,
        DB3_PREFETCH_TARGET_SIZE,
      );

      entry = Db3PrefetchCache.get(prefetchKey);
      puzzle = entry ? takePuzzleInRange(entry, currentRange[0], currentRange[1]) : null;

      if (!puzzle) {
        await refillDb3Prefetch(
          prefetchKey,
          db,
          prefetchMin,
          prefetchMax,
          random,
          normalizedThemes,
          normalizedOpeningTags,
          normalizedSideToMove,
          DB3_PREFETCH_TARGET_SIZE * 2,
        );

        const retriedEntry = Db3PrefetchCache.get(prefetchKey);
        puzzle = retriedEntry ? takePuzzleInRange(retriedEntry, currentRange[0], currentRange[1]) : null;
      }

      if (!puzzle) {
        const exactResult = await commands.getPuzzle(
          db,
          currentRange[0],
          currentRange[1],
          random,
          normalizedThemes.length > 0 ? normalizedThemes : null,
          normalizedOpeningTags.length > 0 ? normalizedOpeningTags : null,
          normalizeSideToMoveForBackend(normalizedSideToMove),
        );
        if (exactResult.status === "error") {
          throw new Error(exactResult.error);
        }
        puzzle = toDb3Puzzle(exactResult.data as Db3Puzzle);
      }

      const latestEntry = Db3PrefetchCache.get(prefetchKey);
      if (latestEntry && latestEntry.queue.length <= DB3_PREFETCH_CRITICAL_BUFFER) {
        void refillDb3Prefetch(
          prefetchKey,
          db,
          prefetchMin,
          prefetchMax,
          random,
          normalizedThemes,
          normalizedOpeningTags,
          normalizedSideToMove,
          DB3_PREFETCH_TARGET_SIZE,
        );
      } else if (latestEntry && latestEntry.queue.length <= DB3_PREFETCH_MIN_BUFFER) {
        void refillDb3Prefetch(
          prefetchKey,
          db,
          prefetchMin,
          prefetchMax,
          random,
          normalizedThemes,
          normalizedOpeningTags,
          normalizedSideToMove,
          DB3_PREFETCH_TARGET_SIZE,
        );
      }
      return puzzle;
    } else {
      const dbPuzzle = await generatePuzzleFromPgn(db, currentRange[0], currentRange[1], !inOrder, sideToMove);
      if (!dbPuzzle) {
        throw new Error("Unable to generate a puzzle from local file within the requested range");
      }
      return dbPuzzle;
    }
  };

  const clearPuzzleCache = (dbPath: string) => {
    removeDb3PrefetchEntries(dbPath);
    PgnPuzzleMetaCache.delete(dbPath);
    const cachedDb = PuzzleDbFromPgnCache.get(dbPath);
    if (cachedDb) {
      cachedDb.generated = {
        minRating: 0,
        maxRating: 0,
        random: false,
        sideToMove: "any",
        unsolvedOnly: false,
        counter: 0,
        puzzle_indexes: [],
      };
      cachedDb.puzzles.forEach((p) => {
        if (p.puzzle) {
          p.puzzle.completion = "incomplete";
        }
      });
    }
  };

  const minRating = dbRatingRange?.[0] ?? ratingRange?.[0] ?? 600;
  const maxRating = dbRatingRange?.[1] ?? ratingRange?.[1] ?? 2800;

  return {
    puzzleDbs,
    setPuzzleDbs,
    selectedDb,
    setSelectedDb,
    ratingRange,
    setRatingRange,
    dbRatingRange,
    isLoadingPuzzleDbs,
    minRating,
    maxRating,
    generatePuzzle,
    clearPuzzleCache,
  };
};
