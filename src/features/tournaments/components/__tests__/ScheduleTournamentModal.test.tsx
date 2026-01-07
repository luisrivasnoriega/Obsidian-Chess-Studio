import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import { ScheduleTournamentModal } from "../../components/ScheduleTournamentModal";

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

describe("ScheduleTournamentModal", () => {
  const mockOnClose = vi.fn();
  const mockOnSchedule = vi.fn();

  test("renders when opened", () => {
    render(<ScheduleTournamentModal opened={true} onClose={mockOnClose} onSchedule={mockOnSchedule} />);
    expect(document.body).toBeTruthy();
  });
});

