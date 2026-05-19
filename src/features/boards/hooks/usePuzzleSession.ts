import { useSessionStorage } from "@mantine/hooks";
import { parseUci } from "chessops";
import { useAtom } from "jotai";
import { useContext, useEffect } from "react";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/TreeStateContext";
import { currentPuzzleAtom, puzzlePlayerRatingAtom } from "@/state/atoms";
import type { Completion, Puzzle } from "@/utils/puzzles";
import { updateElo } from "@/utils/puzzles";

export const usePuzzleSession = (id: string) => {
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("TreeStateContext not found");
  }
  const setFen = useStore(store, (s) => s.setFen);
  const makeMove = useStore(store, (s) => s.makeMove);

  const [puzzles, setPuzzles] = useSessionStorage<Puzzle[]>({
    key: `${id}-puzzles`,
    defaultValue: [],
  });
  const [currentPuzzle, setCurrentPuzzle] = useAtom(currentPuzzleAtom);
  const [playerRating, setPlayerRating] = useAtom(puzzlePlayerRatingAtom);

  useEffect(() => {
    if (!Number.isFinite(playerRating)) {
      setPlayerRating(1500);
    }
  }, [playerRating, setPlayerRating]);

  const setPuzzle = (puzzle: { fen: string; moves: string[] }) => {
    setFen(puzzle.fen);
    if (puzzle.moves.length % 2 === 0 && puzzle.moves[0]) {
      const firstMove = parseUci(puzzle.moves[0]);
      if (firstMove) {
        makeMove({ payload: firstMove });
      }
    }
  };

  const changeCompletion = (completion: Completion, options?: { affectRating?: boolean }) => {
    const affectRating = options?.affectRating ?? true;
    setPuzzles((puzzles) => {
      const puzzle = puzzles[currentPuzzle];
      if (!puzzle) return puzzles;

      const updatedPuzzle = { ...puzzle, completion };
      const nextPuzzles = puzzles.map((item, index) => (index === currentPuzzle ? updatedPuzzle : item));

      // Update player rating using Elo system
      if (affectRating && updatedPuzzle.rating) {
        const newRating = updateElo(playerRating, updatedPuzzle.rating, completion === "correct");
        setPlayerRating(newRating);
      }

      return nextPuzzles;
    });
  };

  const addPuzzle = (puzzle: Puzzle) => {
    setPuzzles((currentPuzzles) => {
      const nextPuzzles = [...currentPuzzles, puzzle];
      setCurrentPuzzle(nextPuzzles.length - 1);
      return nextPuzzles;
    });
    setPuzzle(puzzle);
  };

  const clearSession = () => {
    setPuzzles([]);
  };

  const selectPuzzle = (index: number) => {
    const selectedPuzzle = puzzles[index];
    if (!selectedPuzzle) return;
    setCurrentPuzzle(index);
    setPuzzle(selectedPuzzle);
  };

  return {
    puzzles,
    currentPuzzle,
    setCurrentPuzzle,
    setPuzzle,
    changeCompletion,
    addPuzzle,
    clearSession,
    selectPuzzle,
  };
};
