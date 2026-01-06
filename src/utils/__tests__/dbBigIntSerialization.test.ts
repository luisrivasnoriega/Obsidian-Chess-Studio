import { describe, expect, test, vi, beforeEach } from "vitest";

// We mock the bindings layer so we can observe the payload passed to Tauri commands
const mockCommands = vi.hoisted(() => ({
  getGames: vi.fn(),
  searchPosition: vi.fn(),
}));

vi.mock("@/bindings", () => ({
  commands: mockCommands,
}));

import { query_games, searchPosition } from "@/utils/db";

describe("db invoke payloads (BigInt-safe serialization)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("query_games: should never pass a JS BigInt in game_details_limit", async () => {
    mockCommands.getGames.mockResolvedValue({
      status: "ok",
      data: { data: [], count: 0 },
    });

    // Force a bigint through via `as any` to simulate real-world callers / bindings mismatch.
    await query_games("db3", {
      options: { skipCount: true, sort: "id", direction: "desc" },
      game_details_limit: BigInt(10),
    } as any);

    const [, payload] = mockCommands.getGames.mock.calls[0];
    expect(payload.game_details_limit).toBe("10");
    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  test("searchPosition: should send game_details_limit as string (JSON-safe)", async () => {
    mockCommands.searchPosition.mockResolvedValue({
      status: "ok",
      data: [[], []],
    });

    await searchPosition(
      {
        path: "db3",
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        type: "exact",
        gameDetailsLimit: 10,
      } as any,
      "analysis",
    );

    const [, payload] = mockCommands.searchPosition.mock.calls[0];
    expect(payload.game_details_limit).toBe("10");
    expect(typeof payload.game_details_limit).toBe("string");
    expect(() => JSON.stringify(payload)).not.toThrow();
  });
});


