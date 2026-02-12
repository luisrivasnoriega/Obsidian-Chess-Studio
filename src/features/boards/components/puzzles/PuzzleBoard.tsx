import { Box } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { type Move, type NormalMove, parseSquare, parseUci } from "chessops";
import { chessgroundDests, chessgroundMove } from "chessops/compat";
import equal from "fast-deep-equal";
import { useAtomValue, useSetAtom } from "jotai";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { Chessground } from "@/components/Chessground";
import { TreeStateContext } from "@/components/TreeStateContext";
import PromotionModal from "@/features/boards/components/PromotionModal";
import { blindfoldAtom, showCoordinatesAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybindings";
import { blindfold, chessboard } from "@/styles/Chessboard.css";
import { uciNormalize } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { recordPgnPuzzleAttempted, recordPgnPuzzleSolved } from "@/utils/pgnPuzzleProgress";
import { recordPuzzleSolved } from "@/utils/puzzleStreak";
import type { Completion, Puzzle } from "@/utils/puzzles";
import { getNodeAtPath, treeIteratorMainLine } from "@/utils/treeReducer";

function PuzzleBoard({
  puzzles,
  currentPuzzle,
  changeCompletion,
  generatePuzzle,
  db,
  jumpToNext,
}: {
  puzzles: Puzzle[];
  currentPuzzle: number;
  changeCompletion: (completion: Completion) => void;
  generatePuzzle: (db: string) => void;
  db: string | null;
  jumpToNext: "off" | "success" | "success-and-failure";
}) {
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("PuzzleBoard must be used within a TreeStateContext provider");
  }
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const makeMove = useStore(store, (s) => s.makeMove);
  const makeMoves = useStore(store, (s) => s.makeMoves);
  const reset = useStore(store, (s) => s.reset);
  const setFen = useStore(store, (s) => s.setFen);

  const currentNode = useMemo(() => getNodeAtPath(root, position), [root, position]);

  const puzzle = puzzles[currentPuzzle] ?? null;
  const [_hasMistake, setHasMistake] = useState(false);
  const prevPuzzleIndexRef = useRef(currentPuzzle);
  const isProcessingMoveRef = useRef(false);

  // Reset tree when puzzle changes
  useEffect(() => {
    if (prevPuzzleIndexRef.current !== currentPuzzle && puzzle) {
      reset();
      // Ensure we start the next puzzle from a clean tree state (no leftover moves)
      setFen(puzzle.fen);
      if (puzzle.moves.length % 2 === 0 && puzzle.moves.length > 0) {
        const firstMove = parseUci(puzzle.moves[0]);
        if (firstMove) {
          makeMove({ payload: firstMove, mainline: true });
        }
      }
      setHasMistake(false);
      setPendingMove(null);
      isProcessingMoveRef.current = false;
      prevPuzzleIndexRef.current = currentPuzzle;
    }
  }, [currentPuzzle, makeMove, puzzle, reset, setFen]);

  const [pos] = useMemo(() => positionFromFen(currentNode.fen), [currentNode.fen]);

  const initialFen = puzzle?.fen || currentNode.fen;
  const [initialPos] = useMemo(() => positionFromFen(initialFen), [initialFen]);

  const currentMove = useMemo(() => {
    if (!puzzle || !initialPos) return 0;

    const treeIter = treeIteratorMainLine(root);
    treeIter.next();
    let moveIndex = 0;
    const iterPos = initialPos.clone();
    for (const { node } of treeIter) {
      if (!node.move || moveIndex >= puzzle.moves.length) break;
      const normalizedMove = uciNormalize(iterPos, node.move, false);
      const normalizedPuzzleMove = puzzle.moves[moveIndex];
      if (normalizedMove !== normalizedPuzzleMove) break;
      iterPos.play(node.move);
      moveIndex++;
    }
    return moveIndex;
  }, [initialPos, puzzle, root]);

  const expectedMainlinePath = useMemo(() => Array(currentMove).fill(0), [currentMove]);
  const turn = pos?.turn || "white";
  const orientation = useMemo(() => {
    // Keep board orientation stable for the entire puzzle (including "View solution").
    // If the puzzle starts with the system move already applied (even number of moves),
    // orient to the player's side-to-move after that first move.
    if (!puzzle || !initialPos) return "white";

    const startPos = initialPos.clone();
    if (puzzle.moves.length % 2 === 0 && puzzle.moves.length > 0) {
      const firstMove = parseUci(puzzle.moves[0]);
      if (firstMove) startPos.play(firstMove);
    }

    return startPos.turn;
  }, [initialPos, puzzle]);

  const [pendingMove, setPendingMove] = useState<NormalMove | null>(null);
  const [boardRenderKey, setBoardRenderKey] = useState(0);

  const dests = useMemo(() => (pos ? chessgroundDests(pos) : new Map()), [pos]);
  const showCoordinates = useAtomValue(showCoordinatesAtom);
  const isBlindfold = useAtomValue(blindfoldAtom);
  const setBlindfold = useSetAtom(blindfoldAtom);
  const keyMap = useAtomValue(keyMapAtom);

  useHotkeys([[keyMap.BLINDFOLD.keys, () => setBlindfold((v) => !v)]]);

  function checkMove(move: Move) {
    // Prevent multiple rapid moves from bugging the puzzle
    if (isProcessingMoveRef.current) {
      return;
    }

    if (!pos) return;
    if (!puzzle) return;

    isProcessingMoveRef.current = true;
    try {
      const newPos = pos.clone();
      const uci = uciNormalize(pos, move, false);
      newPos.play(move);

      const expectedMove = puzzle.moves[currentMove];

      if (expectedMove === uci || newPos.isCheckmate()) {
        if (currentMove === puzzle.moves.length - 1) {
          // Puzzles are "one attempt": if you ever got it wrong, it stays incorrect.
          // So we only mark as correct if it was never marked incorrect before.
          if (puzzle.completion === "incomplete") {
            changeCompletion("correct");
            recordPuzzleSolved();
            if (puzzle.source?.type === "pgn") {
              recordPgnPuzzleSolved(puzzle.source.path, puzzle.source.index);
            }
          }
          setHasMistake(false);

          if (db && (jumpToNext === "success" || jumpToNext === "success-and-failure")) {
            // Reset tree before generating next puzzle to avoid visual glitches
            reset();
            generatePuzzle(db);
            return;
          }
        }

        const newMoves = puzzle.moves.slice(currentMove, currentMove + 2);
        makeMoves({
          payload: newMoves,
          mainline: true,
          changeHeaders: false,
        });
        return;
      }

      // Incorrect move:
      // - mark completion as incorrect (only once)
      // - snap back to initial puzzle position and allow retry
      if (puzzle.completion === "incomplete") {
        changeCompletion("incorrect");
      }
      setHasMistake(true);
      setPendingMove(null);
      if (puzzle.source?.type === "pgn") {
        recordPgnPuzzleAttempted(puzzle.source.path, puzzle.source.index);
      }

      // If configured, jump to next puzzle on failure
      if (db && jumpToNext === "success-and-failure") {
        reset();
        generatePuzzle(db);
        return;
      }

      // Otherwise, revert back to initial puzzle position for retry
      reset();
      setFen(puzzle.fen);
      if (puzzle.moves.length % 2 === 0 && puzzle.moves.length > 0) {
        const firstMove = parseUci(puzzle.moves[0]);
        if (firstMove) {
          makeMove({ payload: firstMove, mainline: true });
        }
      }
      // Force Chessground remount so the dragged piece snaps back immediately.
      setBoardRenderKey((k) => k + 1);
    } finally {
      isProcessingMoveRef.current = false;
    }
  }

  const parentRef = useRef<HTMLDivElement | null>(null);
  const [parentSize, setParentSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;

    let rafId = 0;

    const measure = (width: number, height: number) => {
      const w = Math.floor(width);
      const h = Math.floor(height);
      setParentSize((current) => (current.width === w && current.height === h ? current : { width: w, height: h }));
    };

    const rect = el.getBoundingClientRect();
    measure(rect.width, rect.height);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => measure(width, height));
    });

    observer.observe(el);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  const maxBoardSize = Math.min(parentSize.width || Infinity, parentSize.height || Infinity);

  return (
    <Box w="100%" h="100%" ref={parentRef} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Box
        className={`${chessboard} ${isBlindfold ? blindfold : ""}`}
        style={{
          maxWidth: maxBoardSize,
          maxHeight: maxBoardSize,
        }}
      >
        <PromotionModal
          pendingMove={pendingMove}
          cancelMove={() => setPendingMove(null)}
          confirmMove={(p) => {
            if (pendingMove) {
              checkMove({ ...pendingMove, promotion: p });
              setPendingMove(null);
            }
          }}
          turn={turn}
          orientation={orientation}
        />
        <Chessground
          key={boardRenderKey}
          animation={{
            enabled: true,
          }}
          coordinates={showCoordinates !== "none"}
          coordinatesOnSquares={showCoordinates === "all"}
          orientation={orientation}
          movable={{
            free: false,
            color: puzzle && equal(position, expectedMainlinePath) ? turn : undefined,
            dests,
            events: {
              after: (orig, dest) => {
                // Prevent multiple rapid move submissions
                if (isProcessingMoveRef.current) return;

                const from = parseSquare(orig);
                const to = parseSquare(dest);
                // IMPORTANT: `parseSquare("a1")` returns 0, which is falsy.
                if (from == null || to == null) return;
                const move: NormalMove = { from, to };
                if (
                  pos &&
                  pos.board.get(from)?.role === "pawn" &&
                  ((dest[1] === "8" && turn === "white") || (dest[1] === "1" && turn === "black"))
                ) {
                  setPendingMove(move);
                } else {
                  checkMove(move);
                }
              },
            },
          }}
          lastMove={currentNode.move ? chessgroundMove(currentNode.move) : undefined}
          turnColor={turn}
          fen={currentNode.fen}
          check={pos?.isCheck()}
        />
      </Box>
    </Box>
  );
}

export default PuzzleBoard;
