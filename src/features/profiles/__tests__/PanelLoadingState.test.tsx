import type React from "react";
import { describe, expect, test, vi } from "vitest";
import { PanelLoadingState } from "../components/PersonalCardPanels/PanelLoadingState";
import { render, screen } from "./test-utils";

// Keep translations stable
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
  }),
  initReactI18next: { type: "languageDetector", init: vi.fn() },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe("PanelLoadingState", () => {
  test("renders nothing when not loading and not fetching", () => {
    render(<PanelLoadingState isLoading={false} isFetching={false} hasData={false} />);
    // Component returns null, so no loading message should be present
    expect(screen.queryByText("Loading games...")).not.toBeInTheDocument();
  });

  test("renders centered loader message when loading and has no data", () => {
    render(<PanelLoadingState isLoading hasData={false} />);
    expect(screen.getByText("Loading games...")).toBeInTheDocument();
  });

  test("renders banner loader message when fetching and has data", () => {
    render(
      <div>
        <PanelLoadingState isFetching hasData />
        <div data-testid="content">content</div>
      </div>,
    );
    expect(screen.getByText("Loading games...")).toBeInTheDocument();
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });
});
