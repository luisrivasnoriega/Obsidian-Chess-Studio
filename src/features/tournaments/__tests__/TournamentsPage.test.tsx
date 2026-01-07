import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import TournamentsPage from "../TournamentsPage";

// -----------------------------
// Mocks
// -----------------------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

vi.mock("jotai", () => ({
  useAtom: () => [[], vi.fn()],
  useAtomValue: () => [],
}));

vi.mock("@mantine/modals", () => ({
  modals: {
    open: vi.fn(),
    closeAll: vi.fn(),
  },
}));

// ResizeObserver polyfill
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
});

// -----------------------------
// Tests
// -----------------------------

describe("TournamentsPage", () => {
  test("renders without crashing", () => {
    render(<TournamentsPage />);
    // Basic smoke test - component should render
    expect(document.body).toBeTruthy();
  });
});

