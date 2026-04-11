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
  const store = useContext(TreeStateContext)!;
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
    if (puzzle.moves.length % 2 === 0) {
      makeMove({ payload: parseUci(puzzle.moves[0])! });
    }
  };

  const changeCompletion = (completion: Completion) => {
    setPuzzles((puzzles) => {
      const puzzle = puzzles[currentPuzzle];
      puzzle.completion = completion;

      // Update player rating using Elo system
      if (puzzle.rating) {
        const newRating = updateElo(playerRating, puzzle.rating, completion === "correct");
        setPlayerRating(newRating);
      }

      return [...puzzles];
    });
  };

  const addPuzzle = (puzzle: Puzzle) => {
    setPuzzles((puzzles) => {
      return [...puzzles, puzzle];
    });
    setCurrentPuzzle(puzzles.length);
    setPuzzle(puzzle);
  };

  const clearSession = () => {
    setPuzzles([]);
  };

  const selectPuzzle = (index: number) => {
    setCurrentPuzzle(index);
    setPuzzle(puzzles[index]);
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
