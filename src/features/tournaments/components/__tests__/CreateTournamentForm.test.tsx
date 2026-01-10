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
  test("renders without crashing", () => {
    render(<CreateTournamentForm lichessToken={null} accountName={null} />);
    expect(document.body).toBeTruthy();
  });
});

