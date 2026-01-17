import { describe, expect, test } from "vitest";
import { calculateOnlineRating } from "../calculateOnlineRating";

describe("calculateOnlineRating", () => {
  test("returns 0 when no session provided", () => {
    expect(calculateOnlineRating(null)).toBe(0);
    expect(calculateOnlineRating(undefined)).toBe(0);
  });

  test("returns 0 when Lichess account has no valid ratings (less than 10 games)", () => {
    const session = {
      lichess: {
        account: {
          perfs: {
            bullet: { rating: 1500, games: 5 },
            blitz: { rating: 1600, games: 8 },
          },
        },
      },
    };
    expect(calculateOnlineRating(session)).toBe(0);
  });

  test("calculates average from Lichess ratings with >= 10 games", () => {
    const session = {
      lichess: {
        account: {
          perfs: {
            bullet: { rating: 1500, games: 15 },
            blitz: { rating: 1600, games: 20 },
            rapid: { rating: 1700, games: 12 },
          },
        },
      },
    };
    const result = calculateOnlineRating(session);
    expect(result).toBe(Math.round((1500 + 1600 + 1700) / 3));
  });

  test("calculates average from Chess.com ratings with >= 10 games", () => {
    const session = {
      chessCom: {
        stats: {
          chess_bullet: {
            last: { rating: 1500 },
            record: { win: 5, loss: 5, draw: 0 },
          },
          chess_blitz: {
            last: { rating: 1600 },
            record: { win: 6, loss: 4, draw: 0 },
          },
          chess_rapid: {
            last: { rating: 1700 },
            record: { win: 5, loss: 5, draw: 0 },
          },
        },
      },
    };
    const result = calculateOnlineRating(session);
    expect(result).toBe(Math.round((1500 + 1600 + 1700) / 3));
  });

  test("filters out Chess.com ratings with less than 10 games", () => {
    const session = {
      chessCom: {
        stats: {
          chess_bullet: {
            last: { rating: 1500 },
            record: { win: 3, loss: 2, draw: 0 },
          },
          chess_blitz: {
            last: { rating: 1600 },
            record: { win: 6, loss: 4, draw: 0 },
          },
        },
      },
    };
    const result = calculateOnlineRating(session);
    expect(result).toBe(1600);
  });

  test("handles missing perfs in Lichess account", () => {
    const session = {
      lichess: {
        account: {
          perfs: {},
        },
      },
    };
    expect(calculateOnlineRating(session)).toBe(0);
  });

  test("handles missing stats in Chess.com account", () => {
    const session = {
      chessCom: {
        stats: {},
      },
    };
    expect(calculateOnlineRating(session)).toBe(0);
  });
});
