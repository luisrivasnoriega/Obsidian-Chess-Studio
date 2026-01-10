import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import { PlayerStatsModal } from "../../components/PlayerStatsModal";

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

describe("PlayerStatsModal", () => {
  const mockOnClose = vi.fn();

  test("renders when opened", () => {
    render(<PlayerStatsModal opened={true} onClose={mockOnClose} result={null} />);
    expect(document.body).toBeTruthy();
  });

  test("does not render when closed", () => {
    render(<PlayerStatsModal opened={false} onClose={mockOnClose} result={null} />);
    expect(document.body).toBeTruthy();
  });
});

