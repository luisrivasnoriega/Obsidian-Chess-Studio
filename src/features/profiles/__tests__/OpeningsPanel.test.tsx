import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import OpeningsPanel from "../components/PersonalCardPanels/OpeningsPanel";
import type { PlayerGameInfo } from "@/bindings";

vi.mock("../components/PersonalCardPanels/PlayerSidebarCard", () => ({
  __esModule: true,
  default: () => <div data-testid="sidebar" />,
}));

vi.mock("../components/PersonalCardPanels/ResultsChart", () => ({
  __esModule: true,
  default: () => <div data-testid="results-chart" />,
}));

vi.mock("@/bindings", () => ({
  commands: {
    getOpeningFromName: vi.fn(async () => ""),
  },
}));

vi.mock("@/utils/chess", () => ({
  parsePGN: vi.fn(async () => ({ root: { children: [] }, headers: {} })),
}));

vi.mock("@/utils/tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/tabs")>();
  return {
    ...actual,
    createTab: vi.fn(async () => "tab1"),
  };
});

vi.mock("@/utils/treeReducer", () => ({
  defaultTree: () => ({ headers: {} }),
  countMainPly: () => 0,
}));

vi.mock("@/bindings/playerStats", () => ({
  playerStatsCommands: {
    calculatePlayerEloBuckets: vi.fn(async () => ({ status: "ok", data: [] })),
    calculatePlayerOpeningsStats: vi.fn(async (_ssd: any, _filters: any, isWhite: boolean) => ({
      status: "ok",
      data: isWhite
        ? [{ name: "Sicilian Defense", games: 2, won: 1, draw: 1, lost: 0 }]
        : [{ name: "French Defense", games: 1, won: 0, draw: 0, lost: 1 }],
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
          opening: "Sicilian Defense",
        },
      ],
    } as any,
  ],
};

describe("OpeningsPanel", () => {
  test("renders sidebar and openings rows", async () => {
    render(<OpeningsPanel playerName="Test Player" info={mockInfo} />);
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(await screen.findByText("Sicilian Defense")).toBeInTheDocument();
    expect(await screen.findByText("French Defense")).toBeInTheDocument();
  });
});


