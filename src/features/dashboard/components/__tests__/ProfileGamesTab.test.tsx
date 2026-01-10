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
  const mockOnAnalyzeLocalGame = vi.fn();
  const mockOnAnalyzeChessComGame = vi.fn();
  const mockOnAnalyzeLichessGame = vi.fn();
  const profileUsernames = ["player1", "player2"];

  test("renders without crashing", () => {
    render(
      <ProfileGamesTab
        localGames={[]}
        chessComGames={[]}
        lichessGames={[]}
        profileUsernames={profileUsernames}
        onAnalyzeLocalGame={mockOnAnalyzeLocalGame}
        onAnalyzeChessComGame={mockOnAnalyzeChessComGame}
        onAnalyzeLichessGame={mockOnAnalyzeLichessGame}
        isLoadingOnline={false}
      />
    );
    expect(document.body).toBeTruthy();
  });
});

