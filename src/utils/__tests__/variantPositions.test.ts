import { beforeEach, describe, expect, test, vi } from "vitest";
import { getVariantPosition, upsertVariantPosition } from "@/utils/variantPositions";

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

describe("variantPositions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getVariantPosition", () => {
    test("should return null when result is null", async () => {
      vi.mocked(invoke).mockResolvedValue(null);
      const result = await getVariantPosition("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "engine1");
      expect(result).toBeNull();
    });

    test("should handle bigint ms value", async () => {
      const mockResult = {
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        engine: "engine1",
        recommended_move: "e2e4",
        ms: BigInt(1000),
      };
      vi.mocked(invoke).mockResolvedValue(mockResult);
      const result = await getVariantPosition("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "engine1");
      expect(result).toEqual({
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        engine: "engine1",
        recommended_move: "e2e4",
        ms: 1000,
      });
    });

    test("should handle number ms value", async () => {
      const mockResult = {
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        engine: "engine1",
        recommended_move: "e2e4",
        ms: 2000,
      };
      vi.mocked(invoke).mockResolvedValue(mockResult);
      const result = await getVariantPosition("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "engine1");
      expect(result).toEqual({
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        engine: "engine1",
        recommended_move: "e2e4",
        ms: 2000,
      });
    });

    test("should handle string ms value", async () => {
      const mockResult = {
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        engine: "engine1",
        recommended_move: "e2e4",
        ms: "3000",
      };
      vi.mocked(invoke).mockResolvedValue(mockResult);
      const result = await getVariantPosition("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "engine1");
      expect(result).toEqual({
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        engine: "engine1",
        recommended_move: "e2e4",
        ms: 3000,
      });
    });

    test("should handle object ms value with value property", async () => {
      const mockResult = {
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        engine: "engine1",
        recommended_move: "e2e4",
        ms: { value: "4000" },
      };
      vi.mocked(invoke).mockResolvedValue(mockResult);
      const result = await getVariantPosition("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "engine1");
      expect(result).toEqual({
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        engine: "engine1",
        recommended_move: "e2e4",
        ms: 4000,
      });
    });

    test("should handle recommendedMove camelCase", async () => {
      const mockResult = {
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        engine: "engine1",
        recommendedMove: "e2e4",
        ms: 1000,
      };
      vi.mocked(invoke).mockResolvedValue(mockResult);
      const result = await getVariantPosition("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "engine1");
      expect(result?.recommended_move).toBe("e2e4");
    });
  });

  describe("upsertVariantPosition", () => {
    test("should call invoke with correct parameters using number", async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);
      await upsertVariantPosition("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "engine1", "e2e4", 1000);
      expect(invoke).toHaveBeenCalledWith("upsert_variant_position", {
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        engine: "engine1",
        recommendedMove: "e2e4",
        ms: 1000, // Should be number, not BigInt
      });
    });

    test("should handle large number values", async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);
      const largeMs = 2147483647; // Max safe integer for i32, but i64 can handle much more
      await upsertVariantPosition(
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "engine1",
        "e2e4",
        largeMs,
      );
      expect(invoke).toHaveBeenCalledWith("upsert_variant_position", {
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        engine: "engine1",
        recommendedMove: "e2e4",
        ms: largeMs,
      });
    });

    test("should not pass BigInt to avoid serialization error", async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);
      const ms = 1000;
      await upsertVariantPosition("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "engine1", "e2e4", ms);
      const callArgs = vi.mocked(invoke).mock.calls[0];
      const msValue = (callArgs[1] as any).ms;
      // Verify it's a number, not BigInt
      expect(typeof msValue).toBe("number");
      expect(msValue).not.toBeInstanceOf(BigInt);
      expect(msValue).toBe(1000);
    });
  });

  describe("integration scenarios from buildVariants", () => {
    test("should handle the exact scenario from pickEngineMoveUci - cached move", async () => {
      // Simulate the scenario where we get a cached move and need to upsert it
      const trimmedFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
      const engineKey = "/path/to/engine";
      const cachedMove = "e2e4";
      const _cachedMs = 800; // This is a number from getVariantPosition

      // First, mock getVariantPosition returning a cached result
      vi.mocked(invoke).mockResolvedValueOnce({
        fen: trimmedFen,
        engine: engineKey,
        recommended_move: cachedMove,
        ms: 800, // Returned as number
      });

      // Then mock the upsert call
      vi.mocked(invoke).mockResolvedValueOnce(undefined);

      // Simulate the flow
      const cached = await getVariantPosition(trimmedFen, engineKey);
      expect(cached).not.toBeNull();
      expect(cached?.ms).toBe(800);
      expect(typeof cached?.ms).toBe("number");

      if (cached) {
        await upsertVariantPosition(trimmedFen, engineKey, cached.recommended_move, cached.ms);
        // Verify the upsert was called with a number, not BigInt
        const upsertCall = vi.mocked(invoke).mock.calls.find((call) => call[0] === "upsert_variant_position");
        expect(upsertCall).toBeDefined();
        const msValue = (upsertCall?.[1] as any).ms;
        expect(typeof msValue).toBe("number");
        expect(msValue).toBe(800);
      }
    });

    test("should handle the exact scenario from pickEngineMoveUci - new engine move", async () => {
      // Simulate the scenario where we get a new move from engine and need to upsert it
      const trimmedFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
      const engineKey = "/path/to/engine";
      const primary = "e2e4";
      const requestedMs = 800; // This comes from treeBuilderEngineMs state

      vi.mocked(invoke).mockResolvedValue(undefined);

      await upsertVariantPosition(trimmedFen, engineKey, primary, requestedMs);

      // Verify it was called with number, not BigInt
      const callArgs = vi.mocked(invoke).mock.calls[0];
      expect(callArgs[0]).toBe("upsert_variant_position");
      const params = callArgs[1] as any;
      expect(params.ms).toBe(800);
      expect(typeof params.ms).toBe("number");
      expect(params.ms).not.toBeInstanceOf(BigInt);
    });
  });
});
