import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import { FavoriteGamesTab } from "../../components/FavoriteGamesTab";

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

describe("FavoriteGamesTab", () => {
  const mockOnAnalyzeLocal = vi.fn();
  const mockOnAnalyzeChessCom = vi.fn();
  const mockOnAnalyzeLichess = vi.fn();
  const mockOnToggleFavoriteLocal = vi.fn();
  const mockOnToggleFavoriteChessCom = vi.fn();
  const mockOnToggleFavoriteLichess = vi.fn();

  test("renders without crashing", () => {
    render(
      <FavoriteGamesTab
        favoriteGames={[]}
        localGames={[]}
        chessComGames={[]}
        lichessGames={[]}
        onAnalyzeLocal={mockOnAnalyzeLocal}
        onAnalyzeChessCom={mockOnAnalyzeChessCom}
        onAnalyzeLichess={mockOnAnalyzeLichess}
        onToggleFavoriteLocal={mockOnToggleFavoriteLocal}
        onToggleFavoriteChessCom={mockOnToggleFavoriteChessCom}
        onToggleFavoriteLichess={mockOnToggleFavoriteLichess}
        limit={10}
      />
    );
    expect(document.body).toBeTruthy();
  });
});

