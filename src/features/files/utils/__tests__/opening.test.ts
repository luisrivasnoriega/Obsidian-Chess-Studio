import { describe, expect, test } from "vitest";
import { buildFromTree, getStats, getCardForReview, type Position } from "../opening";
import { createEmptyCard } from "ts-fsrs";
import type { TreeNode } from "@/utils/treeReducer";

describe("opening utils", () => {
  describe("getStats", () => {
    test("calculates stats correctly", () => {
      const positions: Position[] = [
        { fen: "fen1", answer: "e4", card: createEmptyCard() },
        { fen: "fen2", answer: "d4", card: { ...createEmptyCard(), reps: 1, due: new Date(Date.now() - 1000) } },
        { fen: "fen3", answer: "Nf3", card: { ...createEmptyCard(), reps: 2, due: new Date(Date.now() + 1000000) } },
      ];

      const stats = getStats(positions);
      expect(stats.total).toBe(3);
      expect(stats.unseen).toBe(1);
      expect(stats.due).toBe(1);
      expect(stats.practiced).toBe(1);
    });

    test("handles empty positions", () => {
      const stats = getStats([]);
      expect(stats.total).toBe(0);
      expect(stats.unseen).toBe(0);
      expect(stats.due).toBe(0);
      expect(stats.practiced).toBe(0);
      expect(stats.nextDue).toBeNull();
    });
  });

  describe("getCardForReview", () => {
    test("returns null when no positions", () => {
      expect(getCardForReview([])).toBeNull();
    });

    test("returns due card when available", () => {
      const now = new Date();
      const positions: Position[] = [
        { fen: "fen1", answer: "e4", card: { ...createEmptyCard(), due: new Date(now.getTime() - 1000) } },
        { fen: "fen2", answer: "d4", card: { ...createEmptyCard(), due: new Date(now.getTime() + 1000000) } },
      ];

      const card = getCardForReview(positions);
      expect(card).toBeTruthy();
      expect(card?.fen).toBe("fen1");
    });

    test("returns random card when random option is true", () => {
      const positions: Position[] = [
        { fen: "fen1", answer: "e4", card: createEmptyCard() },
        { fen: "fen2", answer: "d4", card: createEmptyCard() },
      ];

      const card = getCardForReview(positions, { random: true });
      expect(card).toBeTruthy();
      expect(positions).toContain(card);
    });
  });
});

