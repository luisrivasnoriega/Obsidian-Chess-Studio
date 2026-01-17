import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "./test-utils";
import userEvent from "@testing-library/user-event";

import PawnStructuresPanel from "../components/PersonalCardPanels/PawnStructuresPanel";
import { DateRange } from "@/features/profiles/components/PersonalCardPanels/DateRangeTabs";

import { notifications } from "@mantine/notifications";
import { commands } from "@/bindings";
import { playerStatsCommands } from "@/bindings/playerStats";
import { query_players } from "@/utils/db";
import { getProfileDbPath } from "@/utils/profileDb";
import { createTab } from "@/utils/tabs";
import { parsePGN } from "@/utils/chess";

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
  
  // Setup clipboard API
  if (!globalThis.navigator.clipboard) {
    globalThis.navigator.clipboard = {
      writeText: vi.fn().mockResolvedValue(undefined),
    } as any;
  }
});

afterEach(() => {
  vi.useRealTimers();
});

// -----------------------------
// Controllable test state
// -----------------------------
type TestSession = {
  profileId: string;
  player: string;
  lichess?: { username: string; accessToken?: string };
  chessCom?: { username: string };
};

let mockSessions: TestSession[] = [];
let mockActiveTab = "tab-1";

const mockSetTabs = vi.fn();
const mockSetActiveTab = vi.fn((next: any) => {
  mockActiveTab = typeof next === "function" ? next(mockActiveTab) : next;
});

// -----------------------------
// Mocks
// -----------------------------

// ✅ react-i18next partial mock with initReactI18next
vi.mock("react-i18next", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
    }),
    Trans: ({ children }: any) => children,
    initReactI18next: actual?.initReactI18next ?? { type: "3rdParty", init: vi.fn() },
  };
});

// Icons -> stable for tests
vi.mock("@tabler/icons-react", () => ({
  IconCopy: (props: any) => <svg data-testid="icon-copy" {...props} />,
  IconSearch: (props: any) => <svg data-testid="icon-search" {...props} />,
}));

// Notifications
vi.mock("@mantine/notifications", () => ({
  notifications: {
    show: vi.fn(),
  },
}));

// Router
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

// Atoms module (identifiable atoms)
vi.mock("@/state/atoms", () => ({
  tabsAtom: Symbol("tabsAtom"),
  activeTabAtom: Symbol("activeTabAtom"),
  sessionsAtom: Symbol("sessionsAtom"),
}));

// Jotai
vi.mock("jotai", async () => {
  const atoms = await import("@/state/atoms");
  return {
    useAtomValue: (atom: any) => {
      if (atom === atoms.sessionsAtom) return mockSessions;
      return undefined;
    },
    useAtom: (atom: any) => {
      if (atom === atoms.tabsAtom) return [[], mockSetTabs] as const;
      if (atom === atoms.activeTabAtom) return [mockActiveTab, mockSetActiveTab] as const;
      return [undefined, vi.fn()] as const;
    },
  };
});

// Sidebar (control panel to drive state changes)
vi.mock("@/features/profiles/components/PersonalCardPanels/PlayerSidebarCard", () => ({
  __esModule: true,
  default: (props: any) => (
    <div data-testid="sidebar">
      <div data-testid="sidebar-loading">{props.isLoading ? "loading" : "ready"}</div>
      <div data-testid="sidebar-sites">{props.model?.elo?.length ?? 0}</div>
      <div data-testid="sidebar-opponent-options">
        {(props.opponentEloOptions ?? []).map((o: any) => o.value).join(",")}
      </div>

      {/* Controls to change filters */}
      <button onClick={() => props.onPlatformChange("all")}>platform-all</button>
      <button onClick={() => props.onPlatformChange("Lichess")}>platform-lichess</button>
      <button onClick={() => props.onPlatformChange("Chess.com")}>platform-chess</button>

      <button onClick={() => props.onTimeControlChange("any")}>tc-any</button>
      <button onClick={() => props.onTimeControlChange("blitz")}>tc-blitz</button>
      <button onClick={() => props.onTimeControlChange("bullet")}>tc-bullet</button>

      <button onClick={() => props.onDateRangeChange(null)}>dr-all</button>
      <button onClick={() => props.onDateRangeChange(DateRange.SevenDays)}>dr-7</button>
      <button onClick={() => props.onDateRangeChange(DateRange.OneYear)}>dr-1y</button>

      <button onClick={() => props.onOpponentEloChange("1400")}>opp-1400</button>
      <button onClick={() => props.onOpponentEloChange("all")}>opp-all</button>
    </div>
  ),
}));

vi.mock("@/bindings/playerStats", () => ({
  playerStatsCommands: {
    calculatePlayerSidebarModel: vi.fn(async (siteStatsData: any[]) => {
      const sites = siteStatsData ?? [];
      return {
        status: "ok",
        data: {
          has_data: sites.length > 0,
          style: { label: "playerStyle.mixedStyle", description: "playerStyle.mixedStyleDescription", color: "gray" },
          elo: sites.map((site: any) => ({
            platform: site.site,
            rows: [{ label: site.site, bullet: "-", blitz: "-", rapid: "-" }],
          })),
        },
      };
    }),
    mergePlayerSiteStats: vi.fn(async (siteStatsDataList: any[]) => ({
      status: "ok",
      data: siteStatsDataList ?? [],
    })),
  },
}));

// Chessground
vi.mock("@/components/Chessground", () => ({
  Chessground: ({ fen, orientation }: any) => <div data-testid="board">{orientation}:{fen}</div>,
}));

// Load gate -> render children
vi.mock("@/features/profiles/components/PersonalCardPanels/PanelLoadGate", () => ({
  PanelLoadGate: ({ children }: any) => <div data-testid="loadgate">{children}</div>,
}));

// Backend bindings
vi.mock("@/bindings", () => ({
  commands: {
    getPlayersGameInfo: vi.fn(),
    computePawnStructures: vi.fn(),
    getGame: vi.fn(),
  },
}));

// Helpers
vi.mock("@/utils/profileDb", () => ({
  getProfileDbPath: vi.fn(),
}));
vi.mock("@/utils/db", () => ({
  query_players: vi.fn(),
  query_games: vi.fn(),
}));
vi.mock("@/utils/accountKeys", () => ({
  getAccountKey: vi.fn((type: string, username: string) => `${type}:${username}`),
}));
vi.mock("@/utils/timeControl", () => ({
  getTimeControl: (_site: string, tc: string) => {
    const s = (tc ?? "").toLowerCase();
    if (s.includes("bullet")) return "bullet";
    if (s.includes("blitz")) return "blitz";
    if (s.includes("rapid")) return "rapid";
    return "classical";
  },
}));
vi.mock("@/utils/unwrap", () => ({
  unwrap: (r: any) => (r?.status === "ok" ? r.data : null),
}));

// Tabs + PGN parsing
vi.mock("@/utils/tabs", () => ({
  createTab: vi.fn(async () => undefined),
}));
vi.mock("@/utils/chess", () => ({
  parsePGN: vi.fn(),
}));

// -----------------------------
// Typed mocked helpers
// -----------------------------
const mockedNotifications = vi.mocked(notifications);
const mockedCommands = vi.mocked(commands);
const mockedQueryPlayers = vi.mocked(query_players);
const mockedGetProfileDbPath = vi.mocked(getProfileDbPath);
const mockedCreateTab = vi.mocked(createTab);
const mockedParsePGN = vi.mocked(parsePGN);
const mockedPlayerStatsCommands = vi.mocked(playerStatsCommands);

// -----------------------------
// Per-test setup
// -----------------------------
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;
let consoleWarnSpy: ReturnType<typeof vi.spyOn> | null = null;
let clipboardWriteTextMock: ReturnType<typeof vi.fn> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mockSessions = [];
  mockActiveTab = "tab-1";

  // Silence intentional error branches
  consoleErrorSpy?.mockRestore();
  consoleWarnSpy?.mockRestore();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  // Clipboard - reset the mock
  clipboardWriteTextMock = vi.fn().mockResolvedValue(undefined);
  // Always use spyOn to ensure it's tracked as a spy
  if (navigator.clipboard.writeText) {
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(clipboardWriteTextMock);
  } else {
    // If writeText doesn't exist, define it as a spy
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: clipboardWriteTextMock,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  // RAF
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0 as any;
  };

  // Default profile path
  mockedGetProfileDbPath.mockResolvedValue("/db/p1.db3");

  // Reset playerStatsCommands mocks to default implementation
  mockedPlayerStatsCommands.calculatePlayerSidebarModel.mockImplementation(async (siteStatsData: any[]) => {
    const sites = siteStatsData ?? [];
    return {
      status: "ok",
      data: {
        has_data: sites.length > 0,
        style: { label: "playerStyle.mixedStyle", description: "playerStyle.mixedStyleDescription", color: "gray" },
        elo: sites.map((site: any) => ({
          platform: site.site,
          rows: [{ label: site.site, bullet: "-", blitz: "-", rapid: "-" }],
        })),
      },
    };
  });
  mockedPlayerStatsCommands.mergePlayerSiteStats.mockImplementation(async (siteStatsDataList: any[]) => ({
    status: "ok",
    data: siteStatsDataList ?? [],
  }));

  // Default query_players: return exact match if present
  mockedQueryPlayers.mockImplementation(async (_dbPath: string, args: any) => {
    const name = String(args?.name ?? "");
    if (name === "lichess:player1") return { data: [{ id: 10, name: "lichess:player1" }] } as any;
    if (name === "chesscom:player1") return { data: [{ id: 20, name: "chesscom:player1" }] } as any;
    if (name === "Human Label") return { data: [{ id: 30, name: "human label" }] } as any;
    return { data: [] } as any;
  });

  // Default getPlayersGameInfo: provide two sites
  mockedCommands.getPlayersGameInfo.mockImplementation(async (_dbPath: string, playerId: number) => {
    if (playerId === 10) {
      return {
        status: "ok",
        data: {
          site_stats_data: [
            {
              site: "Lichess",
              player: "lichess:player1",
              data: [{ date: "2024.01.10", time_control: "blitz", opponent_elo: 1510 }],
            },
          ],
        },
      } as any;
    }
    if (playerId === 20) {
      return {
        status: "ok",
        data: {
          site_stats_data: [
            {
              site: "Chess.com",
              player: "chesscom:player1",
              data: [{ date: "2024.01.20", time_control: "bullet", opponent_elo: 1650 }],
            },
          ],
        },
      } as any;
    }
    return { status: "ok", data: { site_stats_data: [] } } as any;
  });

  // Default parsePGN
  mockedParsePGN.mockResolvedValue({
    headers: { white: "W", black: "B" },
    root: { fen: "x x x x 0 1", children: [] },
  } as any);
});

afterEach(() => {
  consoleErrorSpy?.mockRestore();
  consoleWarnSpy?.mockRestore();
  consoleErrorSpy = null;
  consoleWarnSpy = null;
});

// Helper: wait for query to settle
async function waitForProfileQueryReady(expectedSites: string) {
  await waitFor(
    () => {
      const sitesElement = screen.getByTestId("sidebar-sites");
      const loadingElement = screen.getByTestId("sidebar-loading");
      expect(sitesElement).toHaveTextContent(expectedSites);
      expect(loadingElement).toHaveTextContent(/ready/i);
    },
    { timeout: 5000 },
  );
}

// -----------------------------
// Tests
// -----------------------------
describe("PawnStructuresPanel (high coverage)", () => {
  test("renders shell + merges sites (opponent options computed)", async () => {
    mockSessions = [
      { profileId: "p1", player: "Player1", lichess: { username: "player1" } },
      { profileId: "p1", player: "Player1", chessCom: { username: "player1" } },
    ];

    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);

    await waitForProfileQueryReady("2");

    expect(screen.getByTestId("sidebar-opponent-options").textContent).toContain("all");
    expect(screen.getByTestId("sidebar-opponent-options").textContent).toContain("1400");
    expect(screen.getByTestId("sidebar-opponent-options").textContent).toContain("1600");

    expect(screen.getByRole("button", { name: /search/i })).toBeInTheDocument();
  });

  test("handleSearch: shows error when no dbPath (no profileId + no databaseFile)", async () => {
    const user = userEvent.setup();
    render(<PawnStructuresPanel playerName="X" />);

    await user.click(screen.getByRole("button", { name: /search/i }));
    expect(mockedNotifications.show).toHaveBeenCalled();

    const arg = mockedNotifications.show.mock.calls.at(-1)?.[0];
    expect(String(arg?.message ?? "")).toMatch(/noPawnStructures/i);
  });

  test("handleSearch: missingName when profileId has dbPath but no account keys (playerName empty + no sessions)", async () => {
    const user = userEvent.setup();
    render(<PawnStructuresPanel playerName="" profileId="p1" />);

    await user.click(screen.getByRole("button", { name: /search/i }));
    expect(mockedNotifications.show).toHaveBeenCalled();

    const arg = mockedNotifications.show.mock.calls.at(-1)?.[0];
    expect(String(arg?.message ?? "")).toMatch(/Profile name is required|missingName/i);
  });

  test("handleSearch: playerName fallback works when no sessions (queries by raw playerName)", async () => {
    const user = userEvent.setup();

    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);

    mockedCommands.computePawnStructures.mockResolvedValue({
      status: "ok",
      data: [{ structure: "S1", frequency: 1, win_rate: 0.5, sample_fen: null, games: [] }],
    } as any);

    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(mockedQueryPlayers).toHaveBeenCalled();
      expect(mockedCommands.computePawnStructures).toHaveBeenCalled();
    });

    expect(await screen.findByText("S1")).toBeInTheDocument();
  });

  test("handleSearch: continues when one query_players throws and still finds playerIds from another key", async () => {
    const user = userEvent.setup();
    mockSessions = [
      { profileId: "p1", player: "Player1", lichess: { username: "player1" } },
      { profileId: "p1", player: "Player1", chessCom: { username: "player1" } },
    ];

    mockedCommands.computePawnStructures.mockResolvedValue({
      status: "ok",
      data: [{ structure: "S-ok", frequency: 1, win_rate: 0.5, sample_fen: null, games: [] }],
    } as any);

    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);

    // IMPORTANT: let react-query finish first (so "2" sites is stable)
    await waitForProfileQueryReady("2");

    // Now the first query_players call inside handleSearch will throw, second will succeed
    mockedQueryPlayers.mockImplementationOnce(async () => {
      throw new Error("boom");
    });

    await user.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByText("S-ok")).toBeInTheDocument();
  });

  test("handleSearch: passes dateRange to backend (all filtering happens in backend)", async () => {
    const user = userEvent.setup();
    mockSessions = [
      { profileId: "p1", player: "Player1", lichess: { username: "player1" } },
      { profileId: "p1", player: "Player1", chessCom: { username: "player1" } },
    ];
  
    mockedCommands.computePawnStructures.mockResolvedValue({
      status: "ok",
      data: [{ structure: "S-date", frequency: 1, win_rate: 0.5, sample_fen: null, games: [] }],
    } as any);
  
    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);
    await waitForProfileQueryReady("2");
  
    // Apply filters
    await user.click(screen.getByText("platform-lichess"));
    await user.click(screen.getByText("tc-blitz"));
    await user.click(screen.getByText("dr-1y"));
  
    await user.click(screen.getByRole("button", { name: /search/i }));
  
    await waitFor(() => {
      expect(mockedCommands.computePawnStructures).toHaveBeenCalled();
    });
  
    const call = mockedCommands.computePawnStructures.mock.calls.at(-1);
    const params = call?.[1];
  
    // Filters are applied
    expect(params?.platformFilter).toBe("Lichess");
    expect(params?.timeControlFilter).toBe("blitz");
  
    // Component now passes dateRange to backend (backend calculates earliestDate)
    // dateRange is converted to backend format: "OneYear" -> "OneYear"
    expect(params?.dateRange).toBe("OneYear");
  });
  

  test("handleSearch: shows noPawnStructures when backend returns empty structures", async () => {
    const user = userEvent.setup();
    mockSessions = [{ profileId: "p1", player: "Player1", lichess: { username: "player1" } }];

    mockedCommands.computePawnStructures.mockResolvedValue({ status: "ok", data: [] } as any);

    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);
    await waitForProfileQueryReady("1");

    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => expect(mockedNotifications.show).toHaveBeenCalled());

    const arg = mockedNotifications.show.mock.calls.at(-1)?.[0];
    expect(String(arg?.title ?? "")).toMatch(/noPawnStructures/i);
  });

  test("sorting: clicking winRate header changes order (frequency vs winRate)", async () => {
    const user = userEvent.setup();
    mockSessions = [{ profileId: "p1", player: "Player1", lichess: { username: "player1" } }];

    mockedCommands.computePawnStructures.mockResolvedValue({
      status: "ok",
      data: [
        { structure: "A", frequency: 10, win_rate: 0.1, sample_fen: null, games: [] },
        { structure: "B", frequency: 1, win_rate: 0.9, sample_fen: null, games: [] },
      ],
    } as any);

    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);
    await waitForProfileQueryReady("1");

    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText("A")).toBeInTheDocument();
      expect(screen.getByText("B")).toBeInTheDocument();
    });

    const firstBefore = screen.getAllByText(/^(A|B)$/)[0]?.textContent;
    expect(firstBefore).toBe("A");

    await user.click(screen.getByText(/features\.dashboard\.winRate/i));

    const firstAfter = screen.getAllByText(/^(A|B)$/)[0]?.textContent;
    expect(firstAfter).toBe("B");
  });

  test("expand/collapse: view shows details; hide closes and resets", async () => {
    const user = userEvent.setup();
    mockSessions = [{ profileId: "p1", player: "Player1", lichess: { username: "player1" } }];

    const fen = "8/8/8/8/8/8/8/8 w - - 0 1";

    mockedCommands.computePawnStructures.mockResolvedValue({
      status: "ok",
      data: [
        {
          structure: "S-expand",
          frequency: 1,
          win_rate: 0.5,
          sample_fen: fen,
          games: [{ game_id: 1, white: "x", black: "y", white_elo: 1, black_elo: 2, result: "*", fen }],
        },
      ],
    } as any);

    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);
    await waitForProfileQueryReady("1");

    await user.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("S-expand");

    await user.click(screen.getByRole("button", { name: /features\.dashboard\.view/i }));
    expect(screen.getByTestId("board")).toHaveTextContent(fen);

    await user.click(screen.getByRole("button", { name: /features\.dashboard\.hide/i }));
    expect(screen.queryByTestId("board")).not.toBeInTheDocument();
  });

  test("fallback FEN is used when sample_fen is missing", async () => {
    const user = userEvent.setup();
    mockSessions = [{ profileId: "p1", player: "Player1", lichess: { username: "player1" } }];

    const fallbackFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    mockedCommands.computePawnStructures.mockResolvedValue({
      status: "ok",
      data: [{ structure: "S-fallback", frequency: 1, win_rate: 0.5, sample_fen: null, games: [] }],
    } as any);

    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);
    await waitForProfileQueryReady("1");

    await user.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("S-fallback");

    await user.click(screen.getByRole("button", { name: /features\.dashboard\.view/i }));
    expect(screen.getByTestId("board")).toHaveTextContent(fallbackFen);
  });

  test("pagination renders when games > 5 and disabled Open Game when gameId missing", async () => {
    const user = userEvent.setup();
    mockSessions = [{ profileId: "p1", player: "Player1", lichess: { username: "player1" } }];

    const fen = "8/8/8/8/8/8/8/8 w - - 0 1";

    mockedCommands.computePawnStructures.mockResolvedValue({
      status: "ok",
      data: [
        {
          structure: "S-pages",
          frequency: 1,
          win_rate: 0.5,
          sample_fen: fen,
          games: [
            { game_id: null, white: "player1", black: "opp0", white_elo: 1, black_elo: 2, result: "*", fen },
            { game_id: 2, white: "player1", black: "opp1", white_elo: 1, black_elo: 2, result: "*", fen },
            { game_id: 3, white: "player1", black: "opp2", white_elo: 1, black_elo: 2, result: "*", fen },
            { game_id: 4, white: "player1", black: "opp3", white_elo: 1, black_elo: 2, result: "*", fen },
            { game_id: 5, white: "player1", black: "opp4", white_elo: 1, black_elo: 2, result: "*", fen },
            { game_id: 6, white: "player1", black: "opp5", white_elo: 1, black_elo: 2, result: "*", fen },
          ],
        },
      ],
    } as any);

    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);
    await waitForProfileQueryReady("1");

    await user.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("S-pages");

    await user.click(screen.getByRole("button", { name: /features\.dashboard\.view/i }));

    const openBtns = screen.getAllByRole("button", { name: /open game/i });
    expect(openBtns.length).toBeGreaterThan(0);
    expect(openBtns[0]).toBeDisabled();

    // Avoid collision with Select dropdown options ("2" is also a Select option)
    expect(screen.getByRole("button", { name: "2" })).toBeInTheDocument();
  });

  test("copy FEN triggers clipboard + success notification", async () => {
    const user = userEvent.setup();
    mockSessions = [{ profileId: "p1", player: "Player1", lichess: { username: "player1" } }];

    const fen = "8/8/8/8/8/8/8/8 w - - 0 1";

    mockedCommands.computePawnStructures.mockResolvedValue({
      status: "ok",
      data: [{ structure: "S-copy", frequency: 1, win_rate: 0.5, sample_fen: fen, games: [] }],
    } as any);

    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);
    await waitForProfileQueryReady("1");

    await user.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("S-copy");

    await user.click(screen.getByRole("button", { name: /features\.dashboard\.view/i }));

    const copyIcon = screen.getByTestId("icon-copy");
    const copyBtn = copyIcon.closest("button");
    expect(copyBtn).toBeTruthy();
    expect(copyBtn).not.toBeDisabled();

    // Verify clipboard is available
    expect(navigator.clipboard).toBeDefined();
    expect(navigator.clipboard.writeText).toBeDefined();
    expect(clipboardWriteTextMock).toBeDefined();

    await user.click(copyBtn!);

    // Wait a bit for the async clipboard call and notification
    await new Promise((resolve) => setTimeout(resolve, 100));

    await waitFor(() => {
      expect(clipboardWriteTextMock).toHaveBeenCalledWith(fen);
      expect(mockedNotifications.show).toHaveBeenCalled();
    }, { timeout: 3000 });
  });

  test("open game: finds target position in mainline child and calls createTab with position", async () => {
    const user = userEvent.setup();
    mockSessions = [{ profileId: "p1", player: "Player1", lichess: { username: "player1" } }];

    const fen = "8/8/8/8/8/8/8/8 w - - 0 1";
    mockedCommands.computePawnStructures.mockResolvedValue({
      status: "ok",
      data: [
        {
          structure: "S-open",
          frequency: 1,
          win_rate: 0.5,
          sample_fen: fen,
          games: [{ game_id: 99, white: "player1", black: "opp", white_elo: 1, black_elo: 2, result: "*", fen }],
        },
      ],
    } as any);

    mockedCommands.getGame.mockResolvedValue({
      status: "ok",
      data: {
        id: 99,
        site: "Lichess",
        date: "2024.01.01",
        round: "1",
        white: "player1",
        black: "opp",
        result: "1-0",
        white_elo: 1500,
        black_elo: 1400,
        time_control: "blitz",
        eco: "C20",
        moves: "1. e4 e5 1-0",
      },
    } as any);

    mockedParsePGN.mockResolvedValue({
      headers: { white: "W", black: "B" },
      root: {
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        children: [{ fen, children: [] }],
      },
    } as any);

    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);
    await waitForProfileQueryReady("1");

    await user.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("S-open");

    await user.click(screen.getByRole("button", { name: /features\.dashboard\.view/i }));
    await user.click(screen.getByRole("button", { name: /open game/i }));

    await waitFor(() => {
      expect(mockedCommands.getGame).toHaveBeenCalledWith("/db/p1.db3", 99);
      expect(mockedCreateTab).toHaveBeenCalled();
    });

    const arg = mockedCreateTab.mock.calls[0]?.[0];
    expect(arg?.autoActivate).toBe(false);
    expect(arg?.position).toEqual([0]);
  });

  test("open game: if dbPath becomes null at open time -> gameNotFound notification", async () => {
    const user = userEvent.setup();
    mockSessions = [{ profileId: "p1", player: "Player1", lichess: { username: "player1" } }];

    const fen = "8/8/8/8/8/8/8/8 w - - 0 1";
    mockedCommands.computePawnStructures.mockResolvedValue({
      status: "ok",
      data: [
        {
          structure: "S-open-nodb",
          frequency: 1,
          win_rate: 0.5,
          sample_fen: fen,
          games: [{ game_id: 1, white: "player1", black: "opp", white_elo: 1, black_elo: 2, result: "*", fen }],
        },
      ],
    } as any);

    // Set up the mock: return dbPath for initial queries, then null when opening game
    let getProfileDbPathCallCount = 0;
    mockedGetProfileDbPath.mockImplementation(async (profileId: string) => {
      getProfileDbPathCallCount++;
      // First few calls (for initial data loading) return dbPath
      // Later calls (when opening game) return null
      if (getProfileDbPathCallCount <= 2) {
        return "/db/p1.db3";
      }
      return null as any;
    });

    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);
    await waitForProfileQueryReady("1");

    await user.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("S-open-nodb");

    await user.click(screen.getByRole("button", { name: /features\.dashboard\.view/i }));
    await user.click(screen.getByRole("button", { name: /open game/i }));

    await waitFor(() => expect(mockedNotifications.show).toHaveBeenCalled());

    const arg = mockedNotifications.show.mock.calls.at(-1)?.[0];
    expect(String(arg?.title ?? "")).toMatch(/gameNotFound/i);
  });

  test("open game: parsePGN throws -> caught -> errorOpeningGame notification", async () => {
    const user = userEvent.setup();
    mockSessions = [{ profileId: "p1", player: "Player1", lichess: { username: "player1" } }];

    const fen = "8/8/8/8/8/8/8/8 w - - 0 1";
    mockedCommands.computePawnStructures.mockResolvedValue({
      status: "ok",
      data: [
        {
          structure: "S-open-parsefail",
          frequency: 1,
          win_rate: 0.5,
          sample_fen: fen,
          games: [{ game_id: 1, white: "player1", black: "opp", white_elo: 1, black_elo: 2, result: "*", fen }],
        },
      ],
    } as any);

    mockedCommands.getGame.mockResolvedValue({
      status: "ok",
      data: {
        id: 1,
        site: "Lichess",
        date: "2024.01.01",
        white: "player1",
        black: "opp",
        result: "1-0",
        moves: "1. e4 e5 1-0",
      },
    } as any);

    mockedParsePGN.mockRejectedValueOnce(new Error("parse failed"));

    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);
    await waitForProfileQueryReady("1");

    await user.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("S-open-parsefail");

    await user.click(screen.getByRole("button", { name: /features\.dashboard\.view/i }));
    await user.click(screen.getByRole("button", { name: /open game/i }));

    await waitFor(() => expect(mockedNotifications.show).toHaveBeenCalled());

    const arg = mockedNotifications.show.mock.calls.at(-1)?.[0];
    expect(String(arg?.message ?? "")).toMatch(/errorOpeningGame/i);
  });

  test("handleSearch: computePawnStructures throws -> errorAnalyzingPawns", async () => {
    const user = userEvent.setup();
    mockSessions = [{ profileId: "p1", player: "Player1", lichess: { username: "player1" } }];

    mockedCommands.computePawnStructures.mockRejectedValueOnce(new Error("boom"));

    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);
    await waitForProfileQueryReady("1");

    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => expect(mockedNotifications.show).toHaveBeenCalled());

    const arg = mockedNotifications.show.mock.calls.at(-1)?.[0];
    expect(String(arg?.message ?? "")).toMatch(/errorAnalyzingPawns/i);
  });

  test("progress UI appears while compute is pending (covers loading/progress branch)", async () => {
    const user = userEvent.setup();
    mockSessions = [{ profileId: "p1", player: "Player1", lichess: { username: "player1" } }];

    let resolveCompute: (v: any) => void = () => {};
    const computePromise = new Promise((res) => (resolveCompute = res));

    mockedCommands.computePawnStructures.mockReturnValueOnce(computePromise as any);

    render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);
    await waitForProfileQueryReady("1");

    await user.click(screen.getByRole("button", { name: /search/i }));

    expect(screen.getByText(/Analyzing pawn structures/i)).toBeInTheDocument();

    resolveCompute({
      status: "ok",
      data: [{ structure: "S-done", frequency: 1, win_rate: 0.5, sample_fen: null, games: [] }],
    });

    expect(await screen.findByText("S-done")).toBeInTheDocument();
  });
});
