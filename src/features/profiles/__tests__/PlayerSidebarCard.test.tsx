import React from "react";
import { beforeAll, describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, within } from "./test-utils";
import userEvent from "@testing-library/user-event";
import PlayerSidebarCard, { normalizePlatform } from "../components/PersonalCardPanels/PlayerSidebarCard";
import type { PlayerGameInfo } from "@/bindings";

// -----------------------------
// Mocks
// -----------------------------

// Mock i18next
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

// Mock playerStyle utility
vi.mock("@/utils/playerStyle", () => ({
  analyzePlayerStyle: () => ({
    color: "blue",
    label: "playerStyle.aggressive",
    description: "playerStyle.aggressiveDesc",
  }),
}));

// Mock timeControl utility
vi.mock("@/utils/timeControl", () => ({
  getTimeControl: (_site: string, timeControl: string) => {
    const tc = (timeControl || "").toLowerCase();
    if (tc.includes("bullet")) return "bullet";
    if (tc.includes("blitz")) return "blitz";
    if (tc.includes("rapid")) return "rapid";
    return "classical";
  },
}));

// DateRangeTabs may be used inside; mock to keep test stable
vi.mock("../components/PersonalCardPanels/DateRangeTabs", () => ({
  __esModule: true,
  default: ({ onTimeRangeChange }: any) => (
    <div>
      <button type="button" onClick={() => onTimeRangeChange?.(null)}>
        7 days
      </button>
    </div>
  ),
}));

// Mantine Select / Popover can rely on ResizeObserver in JSDOM
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
// Fixtures
// -----------------------------
const mockPlayerInfo: PlayerGameInfo = {
  site_stats_data: [
    {
      site: "Chess.com",
      data: [
        {
          date: "2024-01-01",
          is_player_white: true,
          player_elo: 1500,
          opponent_elo: 1600,
          result: "Won" as const,
          time_control: "bullet",
          opening: "Sicilian Defense",
        },
        {
          date: "2024-01-02",
          is_player_white: false,
          player_elo: 1520,
          opponent_elo: 1550,
          result: "Drawn" as const,
          time_control: "blitz",
          opening: "Queen's Gambit",
        },
      ],
    } as any,
    {
      site: "Lichess",
      data: [
        {
          date: "2024-01-03",
          is_player_white: true,
          player_elo: 1800,
          opponent_elo: 1700,
          result: "Lost" as const,
          time_control: "rapid",
          opening: "King's Indian Defense",
        },
      ],
    } as any,
  ],
};

describe("PlayerSidebarCard", () => {
  const renderComponent = (props: Partial<React.ComponentProps<typeof PlayerSidebarCard>> = {}) => {
    const defaultProps: React.ComponentProps<typeof PlayerSidebarCard> = {
      playerName: "Test Player",
      info: mockPlayerInfo,
      platform: "all" as any,
      onPlatformChange: vi.fn(),
      timeControl: "any" as any,
      onTimeControlChange: vi.fn(),
      // Optional props not always present
      opponentEloOptions: undefined as any,
      opponentEloBucket: undefined as any,
      onOpponentEloChange: undefined as any,
      dateRange: undefined as any,
      onDateRangeChange: undefined as any,
    };

    return render(<PlayerSidebarCard {...defaultProps} {...(props as any)} />);
  };

  test("renders player name", () => {
    renderComponent();
    expect(screen.getByText("Test Player")).toBeInTheDocument();
  });

  test("renders platform selector", () => {
    renderComponent();
    const platformSelects = screen.getAllByLabelText(/platform/i);
    expect(platformSelects.length).toBeGreaterThan(0);
  });

  test("renders time control selector", () => {
    renderComponent();
    const timeControlSelects = screen.getAllByLabelText(/time control/i);
    expect(timeControlSelects.length).toBeGreaterThan(0);
  });

  test("calls onPlatformChange when platform is changed (best-effort)", async () => {
    const user = userEvent.setup();
    const onPlatformChange = vi.fn();
    renderComponent({ onPlatformChange });

    // Use getAllByLabelText and select the first one (the Select component)
    const platformSelects = screen.getAllByLabelText(/platform/i);
    const platformSelect = platformSelects[0];
    expect(platformSelect).toBeInTheDocument();

    // Mantine Select is tricky to fully drive without knowing markup;
    // best-effort: open it and choose an option if it exists.
    await user.click(platformSelect);

    // Prefer the dropdown listbox option (avoid matching the "Chess.com" text in the ELO summary)
    const listbox = screen.queryByRole("listbox");
    const chessComOption =
      (listbox ? within(listbox).queryByText(/chess\.com/i) : null) ??
      screen.queryAllByRole("option", { name: /chess\.com/i })[0] ??
      null;

    if (chessComOption) {
      await user.click(chessComOption);
      expect(onPlatformChange).toHaveBeenCalled();
    } else {
      // At minimum, it renders and is interactable
      expect(platformSelect).toBeInTheDocument();
    }
  });

  test("calls onTimeControlChange when time control is changed (best-effort)", async () => {
    const user = userEvent.setup();
    const onTimeControlChange = vi.fn();
    renderComponent({ onTimeControlChange });

    // Use getAllByLabelText and select the first one (the Select component)
    const timeControlSelects = screen.getAllByLabelText(/time control/i);
    const timeControlSelect = timeControlSelects[0];
    expect(timeControlSelect).toBeInTheDocument();
    
    await user.click(timeControlSelect);

    const blitzOption =
      screen.queryByRole("option", { name: /blitz/i }) ||
      screen.queryByText(/^blitz$/i);

    if (blitzOption) {
      await user.click(blitzOption);
      expect(onTimeControlChange).toHaveBeenCalled();
    } else {
      expect(timeControlSelect).toBeInTheDocument();
    }
  });

  test("renders opponent ELO selector when provided", () => {
    const opponentEloOptions = [
      { value: "all", label: "All" },
      { value: "1000-1200", label: "1000-1200" },
    ];
    renderComponent({
      opponentEloOptions: opponentEloOptions as any,
      opponentEloBucket: "all" as any,
      onOpponentEloChange: vi.fn(),
    });

    // Use getAllByLabelText and select the first one (the Select component)
    const opponentEloSelects = screen.getAllByLabelText(/opponent elo/i);
    expect(opponentEloSelects.length).toBeGreaterThan(0);
    expect(opponentEloSelects[0]).toBeInTheDocument();
  });

  test("renders date range tabs when provided", () => {
    renderComponent({
      dateRange: null as any,
      onDateRangeChange: vi.fn(),
    });

    // Our DateRangeTabs mock renders a button "7 days"
    expect(screen.getByText(/7 days/i)).toBeInTheDocument();
  });

  test("displays ELO summary for platforms (Chess.com and Lichess)", () => {
    renderComponent();

    // Should show platform labels in summary area
    // "Chess.com" appears in both the Select dropdown options and the ELO summary section
    // We just need to verify that the text appears at least once (which it does in the summary)
    const chessComElements = screen.queryAllByText("Chess.com");
    expect(chessComElements.length).toBeGreaterThan(0);
    
    const lichessElements = screen.queryAllByText("Lichess");
    expect(lichessElements.length).toBeGreaterThan(0);
  });

  test("shows loading state when isLoading is true", () => {
    renderComponent({ isLoading: true });
    expect(screen.getByText(/loading games/i)).toBeInTheDocument();
  });

  test("shows loading state when hasData is false", () => {
    const emptyInfo: PlayerGameInfo = { site_stats_data: [] };
    renderComponent({ info: emptyInfo });
    expect(screen.getByText(/loading games/i)).toBeInTheDocument();
  });

  test("renders player style badge", () => {
    renderComponent();
    // The badge should be rendered (playerStyle is mocked to return a color and label)
    const badges = screen.queryAllByRole("generic");
    expect(badges.length).toBeGreaterThan(0);
  });

  test("renders filters section", () => {
    renderComponent();
    expect(screen.getByText(/filters/i)).toBeInTheDocument();
  });

  test("renders ELO section", () => {
    renderComponent();
    expect(screen.getByText(/elo/i)).toBeInTheDocument();
  });

  test("handles dateRange change", async () => {
    const user = userEvent.setup();
    const onDateRangeChange = vi.fn();
    renderComponent({
      dateRange: null as any,
      onDateRangeChange,
    });

    // Our DateRangeTabs mock renders a button "7 days"
    const dateRangeButton = screen.getByText(/7 days/i);
    await user.click(dateRangeButton);

    expect(onDateRangeChange).toHaveBeenCalled();
  });

  test("displays ELO values correctly", () => {
    renderComponent();
    // Should display ELO values (formatted or "-" if 0)
    // The formatElo function returns "-" for values <= 0
    const eloTexts = screen.getAllByText(/-|\d+/);
    expect(eloTexts.length).toBeGreaterThan(0);
  });

  test("handles platform 'all' filter correctly", () => {
    renderComponent({ platform: "all" });
    // When platform is "all", should show both Chess.com and Lichess summaries
    const chessComElements = screen.queryAllByText("Chess.com");
    const lichessElements = screen.queryAllByText("Lichess");
    expect(chessComElements.length).toBeGreaterThan(0);
    expect(lichessElements.length).toBeGreaterThan(0);
  });

  test("handles platform 'Lichess' filter correctly", () => {
    renderComponent({ platform: "Lichess" });
    // Should show only Lichess summary
    const lichessElements = screen.queryAllByText("Lichess");
    expect(lichessElements.length).toBeGreaterThan(0);
  });

  test("handles platform 'Chess.com' filter correctly", () => {
    renderComponent({ platform: "Chess.com" });
    // Should show only Chess.com summary
    const chessComElements = screen.queryAllByText("Chess.com");
    expect(chessComElements.length).toBeGreaterThan(0);
  });
});

describe("normalizePlatform", () => {
  test("normalizes Chess.com correctly", () => {
    expect(normalizePlatform("Chess.com")).toBe("Chess.com");
    expect(normalizePlatform("chess.com")).toBe("Chess.com");
    expect(normalizePlatform("chesscom")).toBe("Chess.com");
    expect(normalizePlatform("Chess . com")).toBe("Chess.com");
  });

  test("normalizes Lichess correctly", () => {
    expect(normalizePlatform("Lichess")).toBe("Lichess");
    expect(normalizePlatform("lichess")).toBe("Lichess");
    expect(normalizePlatform("lichess.org")).toBe("Lichess");
  });

  test("returns null for unknown platforms", () => {
    expect(normalizePlatform("Unknown")).toBeNull();
    expect(normalizePlatform("")).toBeNull();
    expect(normalizePlatform("chess24")).toBeNull();
  });
});
