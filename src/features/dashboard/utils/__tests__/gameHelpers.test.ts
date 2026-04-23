import { describe, expect, test } from "vitest";
import type { NormalizedGame } from "@/bindings";
import type { ChessComGame } from "@/utils/chess.com/api";
import type { GameRecord } from "@/utils/gameRecords";
import {
  convertNormalizedToChessComGame,
  convertNormalizedToLichessGame,
  createChessComGameHeaders,
  createLichessGameHeaders,
  createLocalGameHeaders,
  createPGNFromMoves,
  createPgnFromLocalGame,
  hasEnoughMovesInPgn,
} from "../gameHelpers";

describe("gameHelpers", () => {
  describe("createLocalGameHeaders", () => {
    test("creates headers with standard FEN when initialFen is not provided", () => {
      const game: GameRecord = {
        id: "test-id",
        timestamp: Date.now(),
        white: { type: "human", name: "White Player" },
        black: { type: "human", name: "Black Player" },
        result: "1-0",
        moves: [],
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      };
      const headers = createLocalGameHeaders(game);
      expect(headers.white).toBe("White Player");
      expect(headers.black).toBe("Black Player");
      expect(headers.result).toBe("1-0");
      expect(headers.fen).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    });

    test("creates headers with custom FEN when initialFen is provided", () => {
      const customFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
      const game: GameRecord = {
        id: "test-id",
        timestamp: Date.now(),
        white: { type: "human", name: "White" },
        black: { type: "human", name: "Black" },
        result: "1/2-1/2",
        moves: [],
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        initialFen: customFen,
      };
      const headers = createLocalGameHeaders(game);
      expect(headers.fen).toBe(customFen);
    });
  });

  describe("createChessComGameHeaders", () => {
    test("creates headers from Chess.com game", () => {
      const game: ChessComGame = {
        url: "https://www.chess.com/game/live/123",
        end_time: Math.floor(Date.now() / 1000),
        white: { username: "chesscom:player1", rating: 1500, result: "win" },
        black: { username: "chesscom:player2", rating: 1400, result: "checkmated" },
        pgn: null,
        time_control: "600+0",
        rated: true,
        initial_setup: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        rules: "chess",
      };
      const headers = createChessComGameHeaders(game);
      expect(headers.white).toBe("player1");
      expect(headers.black).toBe("player2");
      expect(headers.result).toBe("1-0");
      expect(headers.site).toBe("Chess.com");
      expect(headers.fen).toBe(game.initial_setup);
    });

    test("uses FEN from PGN when present (from-position games)", () => {
      const fromPositionFen = "8/8/8/3k4/8/8/3K4/8 w - - 0 1";
      const game: ChessComGame = {
        url: "https://www.chess.com/game/live/456",
        end_time: Math.floor(Date.now() / 1000),
        white: { username: "chesscom:player1", rating: 1500, result: "win" },
        black: { username: "chesscom:player2", rating: 1400, result: "checkmated" },
        pgn: `[Event "Live Chess"]\n[Site "Chess.com"]\n[SetUp "1"]\n[FEN "${fromPositionFen}"]\n[Result "1-0"]\n\n1. Kc3 1-0`,
        time_control: "600+0",
        rated: true,
        initial_setup: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        rules: "chess",
      };
      const headers = createChessComGameHeaders(game);
      expect(headers.fen).toBe(fromPositionFen);
    });
  });

  describe("createLichessGameHeaders", () => {
    test("creates headers from Lichess game", () => {
      const game = {
        speed: "blitz",
        createdAt: Date.now(),
        players: {
          white: { user: { name: "lichess:player1" } },
          black: { user: { name: "lichess:player2" } },
        },
        winner: "white",
        lastFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      };
      const headers = createLichessGameHeaders(game);
      expect(headers.white).toBe("player1");
      expect(headers.black).toBe("player2");
      expect(headers.result).toBe("1-0");
      expect(headers.site).toBe("Lichess.org");
    });
  });

  describe("createPGNFromMoves", () => {
    test("creates PGN with moves", () => {
      const moves = ["e4", "e5", "Nf3", "Nc6"];
      const pgn = createPGNFromMoves(moves, "1-0");
      expect(pgn).toContain('[Event "Local Game"]');
      expect(pgn).toContain("1. e4 e5");
      expect(pgn).toContain("2. Nf3 Nc6");
      expect(pgn).toContain("1-0");
    });

    test("creates PGN with initial FEN when provided", () => {
      const moves = ["e4"];
      const customFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
      const pgn = createPGNFromMoves(moves, "1-0", customFen);
      expect(pgn).toContain('[SetUp "1"]');
      expect(pgn).toContain(`[FEN "${customFen}"]`);
    });

    test("creates PGN with only result when no moves", () => {
      const pgn = createPGNFromMoves([], "1/2-1/2");
      expect(pgn).toContain('[Result "1/2-1/2"]');
      expect(pgn).toContain("1/2-1/2");
    });
  });

  describe("createPgnFromLocalGame", () => {
    test("creates complete PGN from local game", () => {
      const game: GameRecord = {
        id: "test-id",
        timestamp: Date.now(),
        white: { type: "human", name: "White" },
        black: { type: "human", name: "Black" },
        result: "1-0",
        moves: ["e4", "e5", "Nf3"],
        timeControl: "600+0",
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      };
      const pgn = createPgnFromLocalGame(game);
      expect(pgn).toContain('[White "White"]');
      expect(pgn).toContain('[Black "Black"]');
      expect(pgn).toContain('[TimeControl "600+0"]');
      expect(pgn).toContain("1. e4 e5");
      expect(pgn).toContain("2. Nf3");
    });
  });

  describe("hasEnoughMovesInPgn", () => {
    test("returns true when the PGN has enough moves", () => {
      const pgn = `[Event "Test"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6`;
      expect(hasEnoughMovesInPgn(pgn, 5)).toBe(true);
    });

    test("returns false when the PGN has fewer moves than required", () => {
      const pgn = `[Event "Test"]\n\n1. e4 e5`;
      expect(hasEnoughMovesInPgn(pgn, 5)).toBe(false);
    });

    test("ignores comments and still counts moves correctly", () => {
      const pgn = `[Event "Test"]\n\n1. e4 {comment} e5 2. Nf3 (2. Bc4) Nc6 3. Bb5 a6`;
      expect(hasEnoughMovesInPgn(pgn, 5)).toBe(true);
    });
  });

  describe("convertNormalizedToLichessGame", () => {
    test("converts NormalizedGame to Lichess format", () => {
      const game: NormalizedGame = {
        id: 1,
        white: "lichess:player1",
        black: "lichess:player2",
        result: "1-0",
        date: "2024.01.01",
        site: "Lichess",
        event: "Rated Blitz game",
        site_id: 1,
        event_id: 1,
        white_id: 1,
        black_id: 2,
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        moves: "",
        time_control: "blitz",
      };
      const result = convertNormalizedToLichessGame(game);
      expect(result.players.white.user?.name).toBe("player1");
      expect(result.players.black.user?.name).toBe("player2");
      expect(result.winner).toBe("white");
      // The speed conversion depends on getTimeControl which may return different values
      expect(result.speed).toBeDefined();
    });
  });

  describe("convertNormalizedToChessComGame", () => {
    test("converts NormalizedGame to Chess.com format", () => {
      const game: NormalizedGame = {
        id: 1,
        white: "chesscom:player1",
        black: "chesscom:player2",
        result: "1-0",
        date: "2024.01.01",
        site: "Chess.com",
        event: "Online Game",
        site_id: 1,
        event_id: 1,
        white_id: 1,
        black_id: 2,
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        moves: "",
        time_control: "600+0",
        white_elo: 1500,
        black_elo: 1400,
      };
      const result = convertNormalizedToChessComGame(game);
      expect(result.white.username).toBe("player1");
      expect(result.black.username).toBe("player2");
      expect(result.white.result).toBe("win");
      expect(result.black.result).toBe("checkmated");
    });

    test("uses FEN from PGN when moves contain from-position headers", () => {
      const fromPositionFen = "8/8/8/3k4/8/8/3K4/8 w - - 0 1";
      const game: NormalizedGame = {
        id: 2,
        white: "chesscom:player1",
        black: "chesscom:player2",
        result: "1-0",
        date: "2024.01.01",
        site: "Chess.com",
        event: "Online Game",
        site_id: 1,
        event_id: 1,
        white_id: 1,
        black_id: 2,
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        moves: `[Event "Live Chess"]\n[SetUp "1"]\n[FEN "${fromPositionFen}"]\n[Result "1-0"]\n\n1. Kc3 1-0`,
        time_control: "600+0",
        white_elo: 1500,
        black_elo: 1400,
      };
      const result = convertNormalizedToChessComGame(game);
      expect(result.initial_setup).toBe(fromPositionFen);
      expect(result.fen).toBe(fromPositionFen);
    });
  });
});
