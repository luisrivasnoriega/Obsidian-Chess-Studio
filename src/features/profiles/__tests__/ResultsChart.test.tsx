import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import ResultsChart from "../components/PersonalCardPanels/ResultsChart";

// ✅ Mock Mantine Tooltip so its `label` is always in the DOM for tests.
// This avoids portal/hover behavior and makes assertions deterministic.
vi.mock("@mantine/core", async () => {
  const actual = await vi.importActual<any>("@mantine/core");
  return {
    ...actual,
    Tooltip: ({ label, children }: any) => (
      <span>
        {/* expose tooltip label in DOM */}
        <span>{label}</span>
        {children}
      </span>
    ),
  };
});

// Mantine sometimes relies on ResizeObserver in JSDOM
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
});

describe("ResultsChart", () => {
  test("renders tooltip labels with correct values", () => {
    render(<ResultsChart won={10} draw={5} lost={3} size="2rem" />);

    // These exist because Tooltip is mocked to render `label`
    expect(screen.getByText("10 wins")).toBeInTheDocument();
    expect(screen.getByText("5 draws")).toBeInTheDocument();
    expect(screen.getByText("3 losses")).toBeInTheDocument();

    // And percentages should show for all (each > 15%)
    expect(screen.getByText("55.6%")).toBeInTheDocument(); // 10/18
    expect(screen.getByText("27.8%")).toBeInTheDocument(); // 5/18
    expect(screen.getByText("16.7%")).toBeInTheDocument(); // 3/18
  });

  test("renders percentage labels when ratio > 15%", () => {
    render(<ResultsChart won={20} draw={10} lost={10} size="2rem" />);

    // Total=40 => 50.0%, 25.0%, 25.0%
    expect(screen.getByText("50.0%")).toBeInTheDocument();
    expect(screen.getAllByText("25.0%").length).toBeGreaterThanOrEqual(1);

    // Tooltip labels still present
    expect(screen.getByText("20 wins")).toBeInTheDocument();
    expect(screen.getByText("10 draws")).toBeInTheDocument();
    expect(screen.getByText("10 losses")).toBeInTheDocument();
  });

  test("handles zero values safely (no NaN/Infinity text)", () => {
    render(<ResultsChart won={0} draw={0} lost={0} size="2rem" />);

    // Tooltip labels exist (thanks to mocked Tooltip)
    expect(screen.getByText("0 wins")).toBeInTheDocument();
    expect(screen.getByText("0 draws")).toBeInTheDocument();
    expect(screen.getByText("0 losses")).toBeInTheDocument();

    // Your component renders percentage labels only if ratio > 0.15,
    // and 0/0 -> NaN, so it should NOT render any percentage labels.
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Infinity/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  test("shows labels only when percentage > 15%", () => {
    render(<ResultsChart won={1} draw={1} lost={98} size="2rem" />);

    // Tooltip labels present
    expect(screen.getByText("1 wins")).toBeInTheDocument();
    expect(screen.getByText("1 draws")).toBeInTheDocument();
    expect(screen.getByText("98 losses")).toBeInTheDocument();

    // Total=100 => lost label should show, won/draw should not
    expect(screen.getByText("98.0%")).toBeInTheDocument();
    expect(screen.queryByText("1.0%")).not.toBeInTheDocument();
  });

  test("handles large values (and respects 15% rule)", () => {
    render(<ResultsChart won={1000} draw={500} lost={250} size="2rem" />);

    // Tooltip labels
    expect(screen.getByText("1000 wins")).toBeInTheDocument();
    expect(screen.getByText("500 draws")).toBeInTheDocument();
    expect(screen.getByText("250 losses")).toBeInTheDocument();

    // Total=1750:
    // won = 57.1% (shown), draw = 28.6% (shown), lost = 14.3% (hidden because <= 15%)
    expect(screen.getByText("57.1%")).toBeInTheDocument();
    expect(screen.getByText("28.6%")).toBeInTheDocument();
    expect(screen.queryByText("14.3%")).not.toBeInTheDocument();
  });
});
