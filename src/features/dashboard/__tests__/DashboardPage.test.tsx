import { beforeAll, describe, expect, test, vi } from "vitest";
import DashboardPage from "../DashboardPage";
import { act, render } from "./test-utils";

// -----------------------------
// Mocks
// -----------------------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

// Note: jotai is already mocked in test-utils.tsx
// We rely on that mock, but ensure it returns stable references

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

vi.mock("@mantine/modals", () => ({
  modals: {
    open: vi.fn(),
    closeAll: vi.fn(),
  },
}));

vi.mock("@mantine/notifications", () => ({
  notifications: {
    show: vi.fn(),
  },
}));

vi.mock("@/bindings", () => ({
  commands: {
    getPlayersGameInfo: vi.fn(),
  },
}));

// DashboardPage is a large, effect-heavy page. For unit tests we stub its
// dashboard-only children to avoid Mantine/JSDOM ref loops and native side effects.
vi.mock("../components/WelcomeCard", () => ({
  WelcomeCard: () => <div data-testid="WelcomeCard" />,
}));
vi.mock("../components/UserProfileCard", () => ({
  UserProfileCard: () => <div data-testid="UserProfileCard" />,
}));
vi.mock("../components/QuickActionsGrid", () => ({
  QuickActionsGrid: () => <div data-testid="QuickActionsGrid" />,
}));
vi.mock("../components/GamesHistoryCard", () => ({
  GamesHistoryCard: () => <div data-testid="GamesHistoryCard" />,
}));
vi.mock("../components/PuzzleStatsCard", () => ({
  PuzzleStatsCard: () => <div data-testid="PuzzleStatsCard" />,
}));
vi.mock("../components/PuzzleVariantsCard", () => ({
  PuzzleVariantsCard: () => <div data-testid="PuzzleVariantsCard" />,
}));
vi.mock("../components/PlayerStatsModal", () => ({
  PlayerStatsModal: () => <div data-testid="PlayerStatsModal" />,
}));
vi.mock("../components/AnalyzeAllModal", () => ({
  AnalyzeAllModal: () => <div data-testid="AnalyzeAllModal" />,
}));

vi.mock("@/utils/gameRecords", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/gameRecords")>();
  return {
    ...actual,
    getRecentGames: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@/utils/favoriteGames", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/favoriteGames")>();
  return {
    ...actual,
    getAllFavoriteGames: vi.fn().mockResolvedValue([]),
    isFavoriteGame: vi.fn().mockResolvedValue(false),
    saveFavoriteGame: vi.fn().mockResolvedValue(undefined),
    removeFavoriteGame: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/utils/lichess/api", () => ({
  getLichessAccount: vi.fn().mockResolvedValue(null),
  downloadLichess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/chess.com/api", () => ({
  getChessComAccount: vi.fn().mockResolvedValue(null),
  downloadChessCom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/fide", () => ({
  fetchFidePlayer: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/utils/puzzleStreak", () => ({
  getPuzzleStats: vi.fn().mockResolvedValue({ history: [], streak: 0 }),
}));

vi.mock("@/utils/analyzedGames", () => ({
  getAllAnalyzedGames: vi.fn().mockResolvedValue([]),
  saveAnalyzedGame: vi.fn().mockResolvedValue(undefined),
  saveGameStats: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/profileGameSync", () => ({
  getAccountSyncStateFromProfileDb: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/utils/db", () => ({
  query_games: vi.fn().mockResolvedValue({ games: [], count: 0 }),
}));

vi.mock("@/utils/profileDb", () => ({
  getProfileDbPath: vi.fn().mockResolvedValue("/test/db/path"),
}));

vi.mock("@/utils/accountPgnPaths", () => ({
  getAccountPgnPath: vi.fn().mockResolvedValue("/test/pgn/path"),
}));

vi.mock("@/utils/accountKeys", () => ({
  getAccountKey: vi.fn().mockReturnValue("test-key"),
}));

vi.mock("@/utils/pgnAccountTags", () => ({
  rewritePgnAccountTags: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn().mockResolvedValue("/test/app/data"),
  resolve: vi.fn().mockResolvedValue("/test/resolved/path"),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  BaseDirectory: {
    AppData: "AppData",
  },
}));

vi.mock("@/bindings", () => ({
  commands: {
    getPlayersGameInfo: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    convertPgn: vi.fn().mockResolvedValue({ status: "ok" }),
  },
}));

// ResizeObserver polyfill
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
});

// -----------------------------
// Tests
// -----------------------------

describe("DashboardPage", () => {
  test("renders without crashing", async () => {
    // Use fake timers to control setTimeout calls in the component
    vi.useFakeTimers();

    try {
      let container: HTMLElement;

      // Wrap render in act() to handle async state updates
      await act(async () => {
        const result = render(<DashboardPage />);
        container = result.container;

        // Fast-forward through any setTimeout calls (e.g., the 50ms delay in loadGamesFromProfileDatabase)
        await vi.advanceTimersByTimeAsync(100);
      });

      // Basic smoke test - component should render
      expect(container!).toBeTruthy();
      expect(document.body).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
