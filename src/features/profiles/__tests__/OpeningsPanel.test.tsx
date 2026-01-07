import React from "react";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "./test-utils";
import userEvent from "@testing-library/user-event";
import OpeningsPanel from "../components/PersonalCardPanels/OpeningsPanel";
import type { PlayerGameInfo } from "@/bindings";

// -----------------------------
// Polyfills / globals
// -----------------------------
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
// Stable shared state for Jotai mocks
// -----------------------------
const mockTabs = [{ type: "profiles", value: "profiles-tab" }];
const mockSetTabs = vi.fn();
const mockSetActiveTab = vi.fn();

// -----------------------------
// Mocks
// -----------------------------

// i18n
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
  initReactI18next: {
    type: "languageDetector",
    init: vi.fn(),
  },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Atoms: make identity checks reliable
vi.mock("@/state/atoms", () => ({
  tabsAtom: Symbol("tabsAtom"),
  activeTabAtom: Symbol("activeTabAtom"),
}));

// Jotai
vi.mock("jotai", async () => {
  const atoms = await import("@/state/atoms");
  return {
    useAtom: (atom: any) => {
      if (atom === atoms.tabsAtom) return [mockTabs, mockSetTabs] as const;
      if (atom === atoms.activeTabAtom) return ["profiles-tab", mockSetActiveTab] as const;
      return [null, vi.fn()] as const;
    },
  };
});

// Sidebar mock: also exposes profileId/isLoading for assertions
vi.mock("../components/PersonalCardPanels/PlayerSidebarCard", () => ({
  __esModule: true,
  default: ({
    onPlatformChange,
    onTimeControlChange,
    onOpponentEloChange,
    onDateRangeChange,
    profileId,
    isLoading,
  }: any) => (
    <div data-testid="sidebar">
      <div data-testid="sidebar-profileId">{profileId ?? ""}</div>
      <div data-testid="sidebar-loading">{String(!!isLoading)}</div>

      <button onClick={() => onPlatformChange?.("Lichess")}>Change Platform</button>
      <button onClick={() => onTimeControlChange?.("blitz")}>Change Time Control</button>
      <button onClick={() => onOpponentEloChange?.("1200")}>Change Opponent Elo</button>
      <button onClick={() => onDateRangeChange?.(null)}>Change Date Range</button>
    </div>
  ),
  normalizePlatform: (site: string | null | undefined) => {
    const s = (site ?? "").toLowerCase();
    if (s.includes("chess")) return "Chess.com";
    if (s.includes("lichess")) return "Lichess";
    return null;
  },
}));

vi.mock("../components/PersonalCardPanels/ResultsChart", () => ({
  __esModule: true,
  default: () => <div data-testid="results-chart" />,
}));

vi.mock("../components/PersonalCardPanels/PanelLoadGate", () => ({
  PanelLoadGate: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Backend bindings
vi.mock("@/bindings", () => ({
  commands: {
    getOpeningFromName: vi.fn(async () => ({ status: "ok", data: "1. e4 c5" })),
  },
}));

// PGN parsing
vi.mock("@/utils/chess", () => ({
  parsePGN: vi.fn(async () => ({ root: { children: [] }, headers: { white: "White", black: "Black" } })),
}));

// Tabs
vi.mock("@/utils/tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/tabs")>();
  return {
    ...actual,
    createTab: vi.fn(async () => "new-tab-id"),
  };
});

// Tree helpers
vi.mock("@/utils/treeReducer", () => ({
  defaultTree: () => ({ headers: { white: "White", black: "Black" } }),
  countMainPly: () => 5,
}));

// Player stats commands
vi.mock("@/bindings/playerStats", () => ({
  playerStatsCommands: {
    calculatePlayerEloBuckets: vi.fn(async () => ({
      status: "ok",
      data: [{ value: "1200", label: "1200-1399" }],
    })),
    calculatePlayerOpeningsStats: vi.fn(async (_ssd: any, _filters: any, isWhite: boolean) => ({
      status: "ok",
      data: isWhite
        ? [
            { name: "Sicilian Defense", games: 2, won: 1, draw: 1, lost: 0 }, // score 0.75
            { name: "Italian Game", games: 1, won: 1, draw: 0, lost: 0 }, // score 1.00
          ]
        : [
            { name: "French Defense", games: 1, won: 0, draw: 0, lost: 1 },
            { name: "Caro-Kann Defense", games: 1, won: 1, draw: 0, lost: 0 },
          ],
    })),
  },
}));

// -----------------------------
// Test data
// -----------------------------
const mockInfo: PlayerGameInfo = {
  site_stats_data: [
    {
      site: "Lichess",
      player: "testplayer",
      data: [
        {
          date: "2024-01-01",
          is_player_white: true,
          player_elo: 1500,
          opponent_elo: 1400,
          result: "Won",
          time_control: "blitz",
          opening: "Sicilian Defense",
        },
        {
          date: "2024-01-02",
          is_player_white: false,
          player_elo: 1520,
          opponent_elo: 1450,
          result: "Lost",
          time_control: "rapid",
          opening: "French Defense",
        },
      ],
    } as any,
  ],
};

function findByTextContent(text: string) {
  return screen.findByText((_, el) => {
    if (!el) return false;
    const hasText = (el.textContent ?? "").includes(text);
    if (!hasText) return false;
    // Avoid matching a parent element when a child already matches.
    return Array.from(el.children).every((child) => !((child.textContent ?? "").includes(text)));
  });
}

function findByTextContentNormalized(text: string) {
  const needle = text.replace(/\s/g, "");
  return screen.findByText((_, el) => {
    if (!el) return false;
    const normalized = (el.textContent ?? "").replace(/\s/g, "");
    const hasText = normalized.includes(needle);
    if (!hasText) return false;
    return Array.from(el.children).every((child) => !(((child.textContent ?? "").replace(/\s/g, "")).includes(needle)));
  });
}

// -----------------------------
// Per-test setup
// -----------------------------
beforeEach(async () => {
  vi.clearAllMocks();
  vi.useRealTimers();

  // Important: restore default implementations every test, because some tests override them.
  const { playerStatsCommands } = await import("@/bindings/playerStats");

  vi.mocked(playerStatsCommands.calculatePlayerEloBuckets).mockImplementation(async () => ({
    status: "ok",
    data: [{ value: "1200", label: "1200-1399" }],
  }) as any);

  vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats).mockImplementation(
    async (_ssd: any, _filters: any, isWhite: boolean) =>
      ({
        status: "ok",
        data: isWhite
          ? [
              { name: "Sicilian Defense", games: 2, won: 1, draw: 1, lost: 0 },
              { name: "Italian Game", games: 1, won: 1, draw: 0, lost: 0 },
            ]
          : [
              { name: "French Defense", games: 1, won: 0, draw: 0, lost: 1 },
              { name: "Caro-Kann Defense", games: 1, won: 1, draw: 0, lost: 0 },
            ],
      }) as any,
  );
});

// -----------------------------
// Tests
// -----------------------------
describe("OpeningsPanel", () => {
  test("renders sidebar and openings rows", async () => {
    render(<OpeningsPanel playerName="Test Player" info={mockInfo} />);

    expect(screen.getByTestId("sidebar")).toBeInTheDocument();

    expect(await findByTextContent("Sicilian Defense")).toBeInTheDocument();
    expect(await findByTextContent("French Defense")).toBeInTheDocument();
  });

  test("renders sort selector", async () => {
    render(<OpeningsPanel playerName="Test Player" info={mockInfo} />);

    // Mantine Select may render multiple instances (label and dropdown), so use getAllBy
    const sortLabels = await screen.findAllByText("Sort");
    expect(sortLabels.length).toBeGreaterThan(0);
    
    // Also verify the input exists by label (may be multiple, so use getAllByLabelText)
    const sortInputs = await screen.findAllByLabelText("Sort");
    expect(sortInputs.length).toBeGreaterThan(0);
  });

  test("displays no data message when backend returns no openings", async () => {
    const { playerStatsCommands } = await import("@/bindings/playerStats");

    vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats).mockImplementation(async () => ({
      status: "ok",
      data: [],
    }) as any);

    render(<OpeningsPanel playerName="Test Player" info={mockInfo} />);

    expect(await screen.findByText(/no data/i)).toBeInTheDocument();
  });

  test("platform filter change triggers openings stats recompute with platform filter", async () => {
    const user = userEvent.setup();
    const { playerStatsCommands } = await import("@/bindings/playerStats");

    render(<OpeningsPanel playerName="Test Player" info={mockInfo} />);

    // Wait for initial render
    await findByTextContent("Sicilian Defense");

    await user.click(screen.getByText("Change Platform"));

    await waitFor(() => {
      expect(vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats)).toHaveBeenCalled();
    });

    const lastCall = vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats).mock.calls.at(-1);
    const filters = lastCall?.[1];
    expect(filters?.platform).toBe("Lichess");
  });

  test("time control filter change triggers openings stats recompute with time_control filter", async () => {
    const user = userEvent.setup();
    const { playerStatsCommands } = await import("@/bindings/playerStats");

    render(<OpeningsPanel playerName="Test Player" info={mockInfo} />);

    await findByTextContent("Sicilian Defense");

    await user.click(screen.getByText("Change Time Control"));

    await waitFor(() => {
      expect(vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats)).toHaveBeenCalled();
    });

    const lastCall = vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats).mock.calls.at(-1);
    const filters = lastCall?.[1];
    // The component normalizes "blitz" to "Blitz" via convertTimeControlFilterToBackend
    expect(filters?.time_control).toBe("Blitz");
  });

  test("opponent elo change triggers openings stats recompute with opponent_elo_bucket filter", async () => {
    const user = userEvent.setup();
    const { playerStatsCommands } = await import("@/bindings/playerStats");

    render(<OpeningsPanel playerName="Test Player" info={mockInfo} />);

    await findByTextContent("Sicilian Defense");

    await user.click(screen.getByText("Change Opponent Elo"));

    await waitFor(() => {
      expect(vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats)).toHaveBeenCalled();
    });

    const lastCall = vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats).mock.calls.at(-1);
    const filters = lastCall?.[1];
    expect(filters?.opponent_elo_bucket).toBe("1200");
  });

  test("date range change triggers openings stats recompute with date_range filter", async () => {
    const user = userEvent.setup();
    const { playerStatsCommands } = await import("@/bindings/playerStats");

    render(<OpeningsPanel playerName="Test Player" info={mockInfo} />);

    await findByTextContent("Sicilian Defense");

    await user.click(screen.getByText("Change Date Range"));

    await waitFor(() => {
      expect(vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats)).toHaveBeenCalled();
    });

    const lastCall = vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats).mock.calls.at(-1);
    const filters = lastCall?.[1];
    expect(filters?.date_range).toBeNull();
  });

  test("sort: default is games_desc, switching to score_desc changes order (white column)", async () => {
    const user = userEvent.setup();
    render(<OpeningsPanel playerName="Test Player" info={mockInfo} />);

    const sic = await findByTextContent("Sicilian Defense");
    const ita = await findByTextContent("Italian Game");

    // Default games_desc => Sicilian (2 games) should appear before Italian (1 game)
    expect(sic.compareDocumentPosition(ita) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Change sort to "Score (high to low)" => Italian score 1.0 should come before Sicilian 0.75
    // Use getAllByLabelText and click the first one to avoid ambiguity
    const sortSelects = await screen.findAllByLabelText("Sort");
    await user.click(sortSelects[0]);
    await user.click(await screen.findByText("Score (high to low)"));

    const sic2 = await findByTextContent("Sicilian Defense");
    const ita2 = await findByTextContent("Italian Game");

    expect(ita2.compareDocumentPosition(sic2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("opens analysis tab when opening name is clicked and does blink on /profiles", async () => {
    Object.defineProperty(window, "location", {
      value: { pathname: "/profiles" },
      writable: true,
    });

    const { commands } = await import("@/bindings");
    const { createTab } = await import("@/utils/tabs");
    const { parsePGN } = await import("@/utils/chess");

    render(<OpeningsPanel playerName="Test Player" info={mockInfo} />);

    // Wait for the row to render using real timers (RTL findBy* relies on timers).
    const opening = await findByTextContent("Sicilian Defense");

    // Use userEvent with real timers to allow async operations to complete
    const user = userEvent.setup();
    await user.click(opening);

    // Wait for all async operations to complete
    await waitFor(() => {
      expect(vi.mocked(commands.getOpeningFromName)).toHaveBeenCalledWith("Sicilian Defense");
      expect(vi.mocked(parsePGN)).toHaveBeenCalled();
      expect(vi.mocked(createTab)).toHaveBeenCalled();
    });

    // Wait for the first setActiveTab call (activates new tab)
    await waitFor(() => {
      expect(mockSetActiveTab).toHaveBeenCalledWith("new-tab-id");
    });

    // Wait for the setTimeout callback to execute (50ms delay) using real timers
    // The setTimeout was scheduled with real timers, so we need to wait for it
    await waitFor(
      () => {
        expect(mockSetActiveTab).toHaveBeenCalledWith("profiles-tab");
      },
      { timeout: 200 }
    );
  });

  test("opens analysis tab when opening name is clicked and does not blink when not on /profiles", async () => {
    const user = userEvent.setup();

    Object.defineProperty(window, "location", {
      value: { pathname: "/analysis" },
      writable: true,
    });

    render(<OpeningsPanel playerName="Test Player" info={mockInfo} />);

    const opening = await findByTextContent("Sicilian Defense");
    await user.click(opening);

    await waitFor(() => {
      expect(mockSetActiveTab).toHaveBeenCalledWith("new-tab-id");
    });

    // Wait a bit to ensure setTimeout doesn't execute (it shouldn't when not on /profiles)
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should not navigate back to profiles tab in this case
    expect(mockSetActiveTab).not.toHaveBeenCalledWith("profiles-tab");
  });

  test("displays opening percentage correctly (Sicilian 2/3 => 66.67%)", async () => {
    render(<OpeningsPanel playerName="Test Player" info={mockInfo} />);

    await findByTextContent("Sicilian Defense");
    // Mantine may render the "%" as a separate text node, so match by normalized textContent.
    expect(await findByTextContentNormalized("66.67%")).toBeInTheDocument();
  });

  test("handles empty site_stats_data (queries disabled) and shows No data", async () => {
    const { playerStatsCommands } = await import("@/bindings/playerStats");

    const emptyInfo: PlayerGameInfo = { site_stats_data: [] };
    render(<OpeningsPanel playerName="Test Player" info={emptyInfo} />);

    expect(await screen.findByText(/no data/i)).toBeInTheDocument();

    // Queries are disabled when games=0
    expect(vi.mocked(playerStatsCommands.calculatePlayerEloBuckets)).not.toHaveBeenCalled();
    expect(vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats)).not.toHaveBeenCalled();
  });

  test("passes profileId and isLoading props to sidebar (smoke)", async () => {
    render(<OpeningsPanel playerName="Test Player" info={mockInfo} profileId="profile-123" isLoading />);

    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-profileId")).toHaveTextContent("profile-123");
    expect(screen.getByTestId("sidebar-loading")).toHaveTextContent("true");
  });

  test("date range state can be changed to null via sidebar callback (coverage)", async () => {
    // This test explicitly covers the setter path; OpeningsPanel initializes NinetyDays by default.
    const user = userEvent.setup();
    const { playerStatsCommands } = await import("@/bindings/playerStats");
    render(<OpeningsPanel playerName="Test Player" info={mockInfo} />);

    // Wait for the initial queries to run (we don't need the UI rows for this test).
    await waitFor(() => {
      expect(vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats)).toHaveBeenCalled();
    });
    const beforeCalls = vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats).mock.calls.length;

    await user.click(screen.getByText("Change Date Range"));

    await waitFor(() => {
      expect(vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats).mock.calls.length).toBeGreaterThan(beforeCalls);
    });

    const last = vi.mocked(playerStatsCommands.calculatePlayerOpeningsStats).mock.calls.at(-1);
    const filters = last?.[1];
    expect(filters?.date_range).toBeNull();
  });
});
