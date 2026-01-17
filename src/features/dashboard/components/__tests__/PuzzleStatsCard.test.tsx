import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { PuzzleStatsCard } from "../../components/PuzzleStatsCard";
import { render, screen } from "./test-utils";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

vi.mock("@/components/ChartSizeGuard", () => ({
  ChartSizeGuard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("PuzzleStatsCard", () => {
  const mockOnStartPuzzles = vi.fn();

  const stats = {
    currentStreak: 5,
    target: 10,
    history: [
      { day: "Mon", solved: 3 },
      { day: "Tue", solved: 5 },
      { day: "Wed", solved: 2 },
    ],
  };

  test("renders puzzle stats", () => {
    render(<PuzzleStatsCard stats={stats} onStartPuzzles={mockOnStartPuzzles} />);
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  test("calls onStartPuzzles when button is clicked", async () => {
    const user = userEvent.setup();
    render(<PuzzleStatsCard stats={stats} onStartPuzzles={mockOnStartPuzzles} />);
    const button = screen.getByRole("button");
    await user.click(button);
    expect(mockOnStartPuzzles).toHaveBeenCalled();
  });

  test("renders with empty history", () => {
    const emptyStats = {
      currentStreak: 0,
      target: 10,
      history: [],
    };
    render(<PuzzleStatsCard stats={emptyStats} onStartPuzzles={mockOnStartPuzzles} />);
    expect(document.body).toBeTruthy();
  });
});
