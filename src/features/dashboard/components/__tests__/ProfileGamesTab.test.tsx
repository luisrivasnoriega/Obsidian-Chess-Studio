import { beforeAll, describe, expect, test, vi } from "vitest";
import { ProfileGamesTab } from "../../components/ProfileGamesTab";
import { render } from "./test-utils";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "dashboard_search_profile_opponents") return [];
    if (cmd === "dashboard_get_games_history_rows") return { rows: [], totalCount: 0 };
    return null;
  }),
}));

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
});
