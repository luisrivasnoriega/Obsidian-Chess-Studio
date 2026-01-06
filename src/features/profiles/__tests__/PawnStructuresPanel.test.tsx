import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "./test-utils";
import userEvent from "@testing-library/user-event";
import PawnStructuresPanel from "../components/PersonalCardPanels/PawnStructuresPanel";
import { notifications } from "@mantine/notifications";
import { commands } from "@/bindings";
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

// ✅ react-query partial mock (keep QueryClient exports for test-utils)
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    useQuery: () => ({
      data: [],
      isLoading: false,
      isFetching: false,
    }),
  };
});

// Icons
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

// Sidebar (lightweight)
vi.mock("../components/PersonalCardPanels/PlayerSidebarCard", () => ({
  __esModule: true,
  default: (props: any) => (
    <div data-testid="sidebar">
      sidebar:{String(props.platform)}:{String(props.timeControl)}
    </div>
  ),
  normalizePlatform: (site: string | null | undefined) => {
    const s = (site ?? "").toLowerCase();
    if (s.includes("chess")) return "Chess.com";
    if (s.includes("lichess")) return "Lichess";
    return null;
  },
}));

// Chessground
vi.mock("@/components/Chessground", () => ({
  Chessground: ({ fen }: any) => <div data-testid="board">{fen}</div>,
}));

// Load gate
vi.mock("@/features/profiles/components/PersonalCardPanels/PanelLoadGate", () => ({
  PanelLoadGate: ({ children }: any) => <div data-testid="loadgate">{children}</div>,
}));

// Backend bindings
vi.mock("@/bindings", () => ({
  commands: {
    getPlayersGameInfo: vi.fn(async () => ({ status: "ok", data: { site_stats_data: [] } })),
    computePawnStructures: vi.fn(),
    getGame: vi.fn(),
  },
}));

// Helpers / db
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

// -----------------------------
// Per-test setup
// -----------------------------
beforeEach(() => {
  vi.clearAllMocks();
  mockSessions = [];
  mockActiveTab = "tab-1";

  // Clipboard
  if (!navigator.clipboard) (navigator as any).clipboard = {};
  navigator.clipboard.writeText = vi.fn().mockResolvedValue(undefined);

  // RAF
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0 as any;
  };
});

// -----------------------------
// Tests
// -----------------------------
describe("PawnStructuresPanel", () => {
  test("renders sidebar and search button (shell)", () => {
    render(<PawnStructuresPanel playerName="Test Player" profileId="p1" />);
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /search/i })).toBeInTheDocument();
  });

  test("handleSearch: shows error notification when no dbPath (no profileId and no databaseFile)", async () => {
    const user = userEvent.setup();
    render(<PawnStructuresPanel playerName="Test Player" />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    expect(mockedNotifications.show).toHaveBeenCalled();
  });

  test("handleSearch: shows missing-name error when dbPath exists but no account keys can be derived", async () => {
    const user = userEvent.setup();

    // IMPORTANT: make dbPath exist to avoid the no-db branch
    mockedGetProfileDbPath.mockResolvedValueOnce("/db/p1.db3");

    // No sessions for profileId, and playerName is empty => playerAccountKeys will be []
    render(<PawnStructuresPanel playerName="" profileId="p1" />);

    await user.click(screen.getByRole("button", { name: /search/i }));

    expect(mockedNotifications.show).toHaveBeenCalled();
    const arg = mockedNotifications.show.mock.calls.at(-1)?.[0];

    // Your t() mock returns defaultValue if present; in this code it is:
    // "Profile name is required."
    expect(String(arg?.message ?? "")).toMatch(/(missingName|Profile name is required)/i);
  });

  test(
    "handleSearch: successful compute renders table, expand row, copy FEN, and open game",
    async () => {
      const user = userEvent.setup();

      mockSessions = [
        {
          profileId: "p1",
          player: "Player1",
          lichess: { username: "player1", accessToken: "t" },
        },
      ];

      mockedGetProfileDbPath.mockResolvedValue("/db/p1.db3");

      mockedQueryPlayers.mockResolvedValue({
        data: [{ id: 42, name: "lichess:player1" }],
      } as any);

      const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

      mockedCommands.computePawnStructures.mockResolvedValue({
        status: "ok",
        data: [
          {
            structure: "Isolated Queen Pawn",
            frequency: 2,
            win_rate: 0.55,
            sample_fen: fen,
            games: [
              {
                game_id: 1,
                white: "lichess:player1",
                black: "Opponent",
                white_elo: 1500,
                black_elo: 1400,
                result: "1-0",
                fen,
              },
            ],
          },
        ],
      } as any);

      mockedCommands.getGame.mockResolvedValue({
        status: "ok",
        data: {
          id: 1,
          site: "Lichess",
          date: "2024.01.01",
          white: "lichess:player1",
          black: "Opponent",
          result: "1-0",
          moves: "1. e4 e5 2. Nf3 Nc6 1-0",
          time_control: "blitz",
          eco: "C20",
        },
      } as any);

      mockedParsePGN.mockResolvedValue({
        headers: { white: "W", black: "B" },
        root: { fen, children: [] },
      } as any);

      render(<PawnStructuresPanel playerName="Human Label" profileId="p1" />);

      await user.click(screen.getByRole("button", { name: /search/i }));

      // Wait until results appear (includes the internal 300ms delay)
      await waitFor(() => {
        expect(screen.getByText("Isolated Queen Pawn")).toBeInTheDocument();
      }, { timeout: 6000 });

      // Expand
      await user.click(screen.getByRole("button", { name: /view/i }));
      expect(screen.getByTestId("board")).toHaveTextContent(fen);

      // Copy FEN
      const copyIcon = screen.getByTestId("icon-copy");
      const copyBtn = copyIcon.closest("button");
      expect(copyBtn).toBeTruthy();
      await user.click(copyBtn!);

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(fen);

      // Open game
      await user.click(screen.getByRole("button", { name: /open game/i }));

      await waitFor(() => {
        expect(mockedCommands.getGame).toHaveBeenCalledWith("/db/p1.db3", 1);
        expect(mockedCreateTab).toHaveBeenCalled();
      });

      const createArg = mockedCreateTab.mock.calls[0]?.[0];
      expect(createArg?.autoActivate).toBe(false);
    },
    10_000,
  );

  test("handleSearch: shows 'Player not found' when query_players returns no ids", async () => {
    const user = userEvent.setup();

    mockSessions = [{ profileId: "p1", player: "Player1", lichess: { username: "player1" } }];
    mockedGetProfileDbPath.mockResolvedValue("/db/p1.db3");
    mockedQueryPlayers.mockResolvedValue({ data: [] } as any);

    render(<PawnStructuresPanel playerName="Player Label" profileId="p1" />);
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(mockedNotifications.show).toHaveBeenCalled();
      const arg = mockedNotifications.show.mock.calls.at(-1)?.[0];
      expect(String(arg?.message ?? "")).toMatch(/Player not found/i);
    });
  });

  test("handleSearch: shows 'noPawnStructures' when backend returns empty structures", async () => {
    const user = userEvent.setup();

    mockSessions = [{ profileId: "p1", player: "Player1", lichess: { username: "player1" } }];
    mockedGetProfileDbPath.mockResolvedValue("/db/p1.db3");
    mockedQueryPlayers.mockResolvedValue({ data: [{ id: 42, name: "lichess:player1" }] } as any);
    mockedCommands.computePawnStructures.mockResolvedValue({ status: "ok", data: [] } as any);

    render(<PawnStructuresPanel playerName="Player Label" profileId="p1" />);
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(mockedNotifications.show).toHaveBeenCalled();
      const arg = mockedNotifications.show.mock.calls.at(-1)?.[0];
      expect(String(arg?.title ?? "")).toMatch(/noPawnStructures/i);
    });
  });
});
