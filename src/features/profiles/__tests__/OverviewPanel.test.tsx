import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import OverviewPanel from "../components/PersonalCardPanels/OverviewPanel";
import type { PlayerGameInfo } from "@/bindings";

vi.mock("@/components/ChartSizeGuard", () => ({
  ChartSizeGuard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children }: any) => <div>{children}</div>,
  Bar: () => <div />,
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
    calculatePlayerEloBuckets: vi.fn(async () => ({
      status: "ok",
      data: [{ value: "all", label: "All" }],
    })),
    calculatePlayerGameStats: vi.fn(async () => ({
      status: "ok",
      data: { total: 1, won: 1, draw: 0, lost: 0, data_per_month: [{ name: "2024-01", count: 1 }], unknown_count: 0 },
    })),
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

describe("OverviewPanel", () => {
  test("renders sidebar and results when data is available", async () => {
    render(<OverviewPanel playerName="Test Player" info={mockInfo} />);
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(await screen.findByTestId("results-chart")).toBeInTheDocument();
  });
});


