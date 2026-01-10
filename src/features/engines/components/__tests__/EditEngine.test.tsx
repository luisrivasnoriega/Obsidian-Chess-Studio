import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import EditEngine from "../../components/EditEngine";

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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

describe("EditEngine", () => {
  test("renders when opened", () => {
    const engine = {
      name: "Stockfish",
      type: "local" as const,
      version: "1.0",
      path: "/stockfish",
      elo: 3000,
    };
    render(<EditEngine initialEngine={engine} />);
    expect(document.body).toBeTruthy();
  });
});

