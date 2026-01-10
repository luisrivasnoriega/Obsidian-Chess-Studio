import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import TournamentCard from "../../drawers/TournamentCard";

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

vi.mock("@/utils/db", () => ({
  getTournamentGames: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/utils/format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/format")>();
  return {
    ...actual,
    parseDate: vi.fn(),
  };
});

vi.mock("@/utils/tabs", () => ({
  createTab: vi.fn(),
}));

vi.mock("zustand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zustand")>();
  return {
    ...actual,
    createStore: actual.createStore,
    useStore: () => ({}),
  };
});

describe("TournamentCard", () => {
  test("renders without crashing", () => {
    const tournament = { id: 1, name: "Test Tournament" };
    render(<TournamentCard tournament={tournament} file="/test.db" />);
    expect(document.body).toBeTruthy();
  });
});

