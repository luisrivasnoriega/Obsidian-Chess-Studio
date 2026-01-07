import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import { PgnSourceInput } from "../../components/PgnSourceInput";

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

describe("PgnSourceInput", () => {
  const mockSetPgnTarget = vi.fn();

  test("renders without crashing", () => {
    const pgnTarget = { type: "pgn" as const, target: "" };
    render(<PgnSourceInput pgnTarget={pgnTarget} setPgnTarget={mockSetPgnTarget} />);
    expect(document.body).toBeTruthy();
  });
});

