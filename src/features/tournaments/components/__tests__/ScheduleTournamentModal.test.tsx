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
  const mockTemplate = {
    id: "test-id",
    accountName: "test-account",
    name: "Test Tournament",
    description: "Test Description",
    clockTime: 5,
    clockIncrement: 3,
    minutes: 30,
    variant: "standard",
    rated: true,
    position: "",
    berserkable: true,
    streakable: true,
    hasChat: true,
    password: "",
    teamBattleByTeam: "",
    teamRestriction: "",
    conditions: {
      minRating: {
        enabled: false,
        rating: 0,
      },
      maxRating: {
        enabled: false,
        rating: 0,
      },
      nbRatedGame: {
        enabled: false,
        nb: 0,
      },
    },
    createdAt: Date.now(),
  };

  test("renders when opened", () => {
    render(
      <ScheduleTournamentModal
        opened={true}
        onClose={mockOnClose}
        template={mockTemplate}
        lichessToken={null}
      />
    );
    expect(document.body).toBeTruthy();
  });
});

