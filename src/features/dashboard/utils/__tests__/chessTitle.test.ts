import { describe, expect, test } from "vitest";
import { getChessTitle } from "../chessTitle";

describe("getChessTitle", () => {
  test("returns correct title for various rating ranges", () => {
    expect(getChessTitle(2200)).toBe("Strong Master");
    expect(getChessTitle(2100)).toBe("Strong Master");
    expect(getChessTitle(2000)).toBe("Club Master");
    expect(getChessTitle(1900)).toBe("Strong Expert");
    expect(getChessTitle(1800)).toBe("Expert");
    expect(getChessTitle(1700)).toBe("Club Expert");
    expect(getChessTitle(1600)).toBe("Strong Advanced Player");
    expect(getChessTitle(1500)).toBe("Advanced Player");
    expect(getChessTitle(1400)).toBe("Skilled Competitor");
    expect(getChessTitle(1300)).toBe("Competitive Club Player");
    expect(getChessTitle(1200)).toBe("Strong Club Player");
    expect(getChessTitle(1100)).toBe("Club Player");
    expect(getChessTitle(1000)).toBe("Entry-Level Club Player");
    expect(getChessTitle(900)).toBe("Strong Amateur");
    expect(getChessTitle(800)).toBe("Amateur");
    expect(getChessTitle(700)).toBe("Early Amateur");
    expect(getChessTitle(600)).toBe("Advanced Novice");
    expect(getChessTitle(500)).toBe("Novice");
    expect(getChessTitle(400)).toBe("Solid Beginner");
    expect(getChessTitle(300)).toBe("Beginner");
    expect(getChessTitle(200)).toBe("Early Learner");
    expect(getChessTitle(100)).toBe("Brand New");
    expect(getChessTitle(50)).toBe("Brand New");
    expect(getChessTitle(0)).toBe("Brand New");
  });

  test("handles boundary values correctly", () => {
    expect(getChessTitle(2099)).toBe("Club Master");
    expect(getChessTitle(2100)).toBe("Strong Master");
    expect(getChessTitle(1999)).toBe("Strong Expert");
    expect(getChessTitle(2000)).toBe("Club Master");
  });
});

