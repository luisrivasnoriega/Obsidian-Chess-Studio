import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import { CreateTournamentForm } from "../../components/CreateTournamentForm";

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

describe("CreateTournamentForm", () => {
  const mockOnSubmit = vi.fn();
  const mockOnCancel = vi.fn();

  test("renders without crashing", () => {
    render(<CreateTournamentForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    expect(document.body).toBeTruthy();
  });
});

