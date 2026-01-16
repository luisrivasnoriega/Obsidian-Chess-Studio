import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import RatingsPanel from "../components/PersonalCardPanels/RatingsPanel";
import type { PlayerGameInfo } from "@/bindings";

vi.mock("@/components/ChartSizeGuard", () => ({
  ChartSizeGuard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  AreaChart: ({ children }: any) => <div>{children}</div>,
  Area: () => <div />,
  CartesianGrid: () => <div />,
  Tooltip: () => <div />,
  XAxis: () => <div />,
  YAxis: () => <div />,
}));

vi.mock("../components/PersonalCardPanels/ResultsChart", () => ({
  __esModule: true,
  default: () => <div data-testid="results-chart" />,
}));

vi.mock("../components/PersonalCardPanels/PlayerSidebarCard", () => ({
  __esModule: true,
  default: () => <div data-testid="sidebar" />,
}));

vi.mock("@/bindings/playerStats", () => ({
  playerStatsCommands: {
    calculatePlayerSidebarModel: vi.fn(async () => ({
      status: "ok",
      data: {
        has_data: true,
        style: { label: "playerStyle.mixedStyle", description: "playerStyle.mixedStyleDescription", color: "gray" },
        elo: [],
      },
    })),
    calculatePlayerRatingTimeline: vi.fn(async () => ({
      status: "ok",
      data: {
        data: [
          { date: 1000, chesscom: null, lichess: 1500 },
          { date: 2000, chesscom: null, lichess: 1550 },
        ],
        dates: [1000, 2000], // Need at least 2 dates for hasPanelData to be true
        platforms: [{ key: "lichess", label: "Lichess", stroke: "#fff" }],
      },
    })),
    calculatePlayerGameStats: vi.fn(async () => ({
      status: "ok",
      data: { total: 1, won: 1, draw: 0, lost: 0, data_per_month: [], unknown_count: 0 },
    })),
    calculatePlayerEloDomain: vi.fn(async () => ({ status: "ok", data: { min: 1400, max: 1600 } })),
    calculatePlayerEloBuckets: vi.fn(async () => ({ status: "ok", data: [] })),
  },
}));

const mockInfo: PlayerGameInfo = {
  site_stats_data: [
    {
      site: "Lichess",
      data: [
        {
          date: "2024-01-01",
          is_player_white: true,
          player_elo: 1500,
          opponent_elo: 1400,
          result: "Won",
          time_control: "blitz",
          opening: "Sicilian",
        },
      ],
    } as any,
  ],
};

describe("RatingsPanel", () => {
  test("renders sidebar and results summary", async () => {
    render(<RatingsPanel playerName="Test Player" info={mockInfo} />);
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(await screen.findByTestId("results-chart")).toBeInTheDocument();
  });
});


