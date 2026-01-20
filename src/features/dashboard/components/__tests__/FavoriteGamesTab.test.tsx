import { beforeAll, describe, expect, test, vi } from "vitest";
import { FavoriteGamesTab } from "../../components/FavoriteGamesTab";
import { render } from "./test-utils";

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
  const mockOnAnalyzeLocalGame = vi.fn();
  const mockOnAnalyzeChessComGame = vi.fn();
  const mockOnAnalyzeLichessGame = vi.fn();
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
        chessComUsernames={[]}
        lichessUsernames={[]}
        onAnalyzeLocalGame={mockOnAnalyzeLocalGame}
        onAnalyzeChessComGame={mockOnAnalyzeChessComGame}
        onAnalyzeLichessGame={mockOnAnalyzeLichessGame}
        onToggleFavoriteLocal={mockOnToggleFavoriteLocal}
        onToggleFavoriteChessCom={mockOnToggleFavoriteChessCom}
        onToggleFavoriteLichess={mockOnToggleFavoriteLichess}
      />,
    );
    expect(document.body).toBeTruthy();
  });
});
