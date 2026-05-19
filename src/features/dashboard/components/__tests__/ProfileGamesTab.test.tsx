import { beforeAll, describe, expect, test, vi } from "vitest";
import { ProfileGamesTab } from "../../components/ProfileGamesTab";
import { act, render, waitFor } from "./test-utils";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "dashboard_search_profile_opponents") return [];
    if (cmd === "dashboard_get_games_history_rows") return { rows: [], totalCount: 0 };
    if (cmd === "dashboard_get_analyze_all_counts_bulk") {
      return {
        all: { total: 0, analyzed: 0, unanalyzed: 0 },
        local: { total: 0, analyzed: 0, unanalyzed: 0 },
        chesscom: { total: 0, analyzed: 0, unanalyzed: 0 },
        lichess: { total: 0, analyzed: 0, unanalyzed: 0 },
        chessbase: { total: 0, analyzed: 0, unanalyzed: 0 },
      };
    }
    return null;
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
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
    mocks.invoke.mockClear();
    render(
      <ProfileGamesTab
        profileId={"p1"}
        selectedOpponentId={null}
        gameHistoryLimit={100}
        localGames={[]}
        chessComGames={[]}
        lichessGames={[]}
        profileUsernames={profileUsernames}
        onAnalyzeLocalGame={mockOnAnalyzeLocalGame}
        onAnalyzeChessComGame={mockOnAnalyzeChessComGame}
        onAnalyzeLichessGame={mockOnAnalyzeLichessGame}
        isLoadingOnline={false}
        eventFilterId={null}
        onEventFilterChange={() => {}}
        eventOptions={[]}
        isLoadingEventOptions={false}
        onEventSearchChange={() => {}}
        eventSearchValue=""
        profileDbPath={null}
        onOpponentSelected={() => {}}
        timeControlCategory={null}
        onTimeControlCategoryChange={() => {}}
      />,
    );
    expect(document.body).toBeTruthy();
  });

  test("refetches games history when the dashboard refresh event fires", async () => {
    mocks.invoke.mockClear();
    render(
      <ProfileGamesTab
        profileId={"p1"}
        selectedOpponentId={null}
        gameHistoryLimit={100}
        localGames={[]}
        chessComGames={[]}
        lichessGames={[]}
        profileUsernames={profileUsernames}
        onAnalyzeLocalGame={mockOnAnalyzeLocalGame}
        onAnalyzeChessComGame={mockOnAnalyzeChessComGame}
        onAnalyzeLichessGame={mockOnAnalyzeLichessGame}
        isLoadingOnline={false}
        eventFilterId={null}
        onEventFilterChange={() => {}}
        eventOptions={[]}
        isLoadingEventOptions={false}
        onEventSearchChange={() => {}}
        eventSearchValue=""
        profileDbPath={null}
        onOpponentSelected={() => {}}
        timeControlCategory={null}
        onTimeControlCategoryChange={() => {}}
      />,
    );

    await waitFor(() => {
      expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "dashboard_get_games_history_rows")).toHaveLength(1);
    });

    act(() => {
      window.dispatchEvent(new Event("dashboard:games-history:refresh"));
    });

    await waitFor(() => {
      expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "dashboard_get_games_history_rows")).toHaveLength(2);
    });
  });
});
