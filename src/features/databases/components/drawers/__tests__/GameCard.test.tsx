import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import GameCard from "../../drawers/GameCard";

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

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtom: () => [[], vi.fn()],
    useSetAtom: () => vi.fn(),
  };
});

vi.mock("@/hooks/useResponsiveLayout", () => ({
  useResponsiveLayout: () => ({ layout: { databases: { density: "normal" } } }),
}));

vi.mock("@/components/CollapsibleGameInfo", () => ({
  default: () => <div>CollapsibleGameInfo</div>,
}));

vi.mock("@/components/TreeStateContext", () => ({
  TreeStateProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../drawers/GamePreview", () => ({
  default: () => <div>GamePreview</div>,
}));

describe("GameCard", () => {
  test("renders without crashing", () => {
    const game = {
      id: 1,
      white: "Player1",
      black: "Player2",
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
    };
    render(<GameCard game={game} file="/test.db" mutate={vi.fn()} />);
    expect(document.body).toBeTruthy();
  });
});

