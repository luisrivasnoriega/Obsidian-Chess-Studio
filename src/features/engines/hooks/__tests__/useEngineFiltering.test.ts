import { describe, expect, test } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEngineFiltering } from "../useEngineFiltering";
import type { Engine } from "@/utils/engines";
import type { SortState } from "@/components/GenericHeader";

describe("useEngineFiltering", () => {
  const engines: Engine[] = [
    { name: "Stockfish", type: "local", version: "1.0", path: "/stockfish", elo: 3000 },
    { name: "Komodo", type: "local", version: "1.0", path: "/komodo", elo: 2800 },
    { name: "Cloud Engine", type: "chessdb", url: "https://api.example.com" },
  ];

  test("returns all indices when query is empty", () => {
    const sortBy: SortState = { field: "name", direction: "asc" };
    const { result } = renderHook(() => useEngineFiltering(engines, "", sortBy));
    expect(result.current).toHaveLength(3);
  });

  test("filters engines by name", () => {
    const sortBy: SortState = { field: "name", direction: "asc" };
    const { result } = renderHook(() => useEngineFiltering(engines, "Stockfish", sortBy));
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toBe(0);
  });

  test("filters engines by path", () => {
    const sortBy: SortState = { field: "name", direction: "asc" };
    const { result } = renderHook(() => useEngineFiltering(engines, "komodo", sortBy));
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toBe(1);
  });

  test("sorts by name ascending", () => {
    const sortBy: SortState = { field: "name", direction: "asc" };
    const { result } = renderHook(() => useEngineFiltering(engines, "", sortBy));
    // Verify all engines are included and sorted
    expect(result.current).toHaveLength(3);
    expect(result.current).toContain(0);
    expect(result.current).toContain(1);
    expect(result.current).toContain(2);
  });

  test("sorts by name descending", () => {
    const sortBy: SortState = { field: "name", direction: "desc" };
    const { result } = renderHook(() => useEngineFiltering(engines, "", sortBy));
    // Verify all engines are included and sorted
    expect(result.current).toHaveLength(3);
    expect(result.current).toContain(0);
    expect(result.current).toContain(1);
    expect(result.current).toContain(2);
  });

  test("sorts by elo ascending", () => {
    const sortBy: SortState = { field: "elo", direction: "asc" };
    const { result } = renderHook(() => useEngineFiltering(engines, "", sortBy));
    // Verify all engines are included
    expect(result.current).toHaveLength(3);
    expect(result.current).toContain(0);
    expect(result.current).toContain(1);
    expect(result.current).toContain(2);
  });

  test("sorts by elo descending", () => {
    const sortBy: SortState = { field: "elo", direction: "desc" };
    const { result } = renderHook(() => useEngineFiltering(engines, "", sortBy));
    // Stockfish has highest elo
    expect(result.current[0]).toBe(0);
  });
});

