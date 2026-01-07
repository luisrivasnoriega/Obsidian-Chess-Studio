import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import { ProfileGamesTab } from "../../components/ProfileGamesTab";

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

describe("ProfileGamesTab", () => {
  const mockOnAnalyze = vi.fn();
  const profileUsernames = ["player1", "player2"];

  test("renders without crashing", () => {
    render(
      <ProfileGamesTab
        localGames={[]}
        chessComGames={[]}
        lichessGames={[]}
        profileUsernames={profileUsernames}
        onAnalyze={mockOnAnalyze}
        limit={10}
        isLoading={false}
      />
    );
    expect(document.body).toBeTruthy();
  });
});

