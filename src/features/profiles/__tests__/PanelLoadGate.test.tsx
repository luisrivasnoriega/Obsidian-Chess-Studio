import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import { PanelLoadGate } from "../components/PersonalCardPanels/PanelLoadGate";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
  }),
  initReactI18next: { type: "languageDetector", init: vi.fn() },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe("PanelLoadGate", () => {
  test("blocks children when loading with no data", () => {
    render(
      <PanelLoadGate isLoading hasData={false}>
        <div data-testid="child">child</div>
      </PanelLoadGate>,
    );

    expect(screen.getByText("Loading games...")).toBeInTheDocument();
    expect(screen.queryByTestId("child")).not.toBeInTheDocument();
  });

  test("shows banner and children when fetching with data", () => {
    render(
      <PanelLoadGate isFetching hasData>
        <div data-testid="child">child</div>
      </PanelLoadGate>,
    );

    expect(screen.getByText("Loading games...")).toBeInTheDocument();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  test("renders children only when not loading/fetching", () => {
    render(
      <PanelLoadGate hasData>
        <div data-testid="child">child</div>
      </PanelLoadGate>,
    );

    expect(screen.queryByText("Loading games...")).not.toBeInTheDocument();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});


