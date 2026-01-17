import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import PlayerSidebarCard from "../components/PersonalCardPanels/PlayerSidebarCard";
import type { PlayerSidebarModel } from "@/bindings/playerStats";

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

vi.mock("../components/PersonalCardPanels/DateRangeTabs", () => ({
  __esModule: true,
  default: () => <div />,
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

const model: PlayerSidebarModel = {
  has_data: true,
  style: {
    color: "blue",
    label: "playerStyle.positional",
    description: "playerStyle.positionalDescription",
  },
  elo: [
    {
      platform: "Chess.com",
      rows: [{ label: "Chess.com", bullet: "1500", blitz: "1520", rapid: "-" }],
    },
    {
      platform: "Lichess",
      rows: [{ label: "Lichess", bullet: "-", blitz: "-", rapid: "1800" }],
    },
  ],
};

describe("PlayerSidebarCard (presentational)", () => {
  test("renders style and elo values from model", () => {
    render(
      <PlayerSidebarCard
        playerName="Test Player"
        model={model}
        visiblePlatforms={["Chess.com", "Lichess"]}
        platform="all"
        onPlatformChange={vi.fn()}
        timeControl="any"
        onTimeControlChange={vi.fn()}
        opponentEloOptions={[{ value: "all", label: "All" }]}
        opponentEloBucket="all"
        onOpponentEloChange={vi.fn()}
        isLoading={false}
        fullHeight={false}
      />,
    );

    expect(screen.getByText("Test Player")).toBeInTheDocument();
    expect(screen.getByText("playerStyle.positional")).toBeInTheDocument();
    expect(screen.getAllByText("Chess.com").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Lichess").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1500").length).toBeGreaterThan(0);
  });

  test("shows loading state when isLoading=true", () => {
    render(
      <PlayerSidebarCard
        playerName="Test Player"
        model={model}
        visiblePlatforms={["Chess.com"]}
        platform="Chess.com"
        onPlatformChange={vi.fn()}
        timeControl="any"
        onTimeControlChange={vi.fn()}
        isLoading
      />,
    );
    expect(screen.getByText("Loading games...")).toBeInTheDocument();
  });
});

