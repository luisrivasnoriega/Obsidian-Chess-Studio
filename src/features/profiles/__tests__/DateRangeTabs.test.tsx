import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import userEvent from "@testing-library/user-event";
import DateRangeTabs, { DateRange } from "../components/PersonalCardPanels/DateRangeTabs";

// Mantine Tabs (and sometimes other UI libs) can rely on ResizeObserver in JSDOM
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
});

describe("DateRangeTabs", () => {
  test("renders all time range options", () => {
    const mockOnChange = vi.fn();
    render(<DateRangeTabs timeRange={null} onTimeRangeChange={mockOnChange} />);

    expect(screen.getByText(/7 days/i)).toBeInTheDocument();
    expect(screen.getByText(/30 days/i)).toBeInTheDocument();
    expect(screen.getByText(/90 days/i)).toBeInTheDocument();
    expect(screen.getByText(/1 year/i)).toBeInTheDocument();
    expect(screen.getByText(/all time/i)).toBeInTheDocument();
  });

  test("calls onTimeRangeChange when tab is clicked", async () => {
    const user = userEvent.setup();
    const mockOnChange = vi.fn();
    render(<DateRangeTabs timeRange={null} onTimeRangeChange={mockOnChange} />);

    // Prefer role-based query if the component uses real tabs
    const sevenDaysTab =
      screen.queryByRole("tab", { name: /7 days/i }) ?? screen.getByText(/7 days/i);

    await user.click(sevenDaysTab);

    expect(mockOnChange).toHaveBeenCalledWith(DateRange.SevenDays);
  });

  test("shows selected tab when timeRange is provided", () => {
    const mockOnChange = vi.fn();
    render(<DateRangeTabs timeRange={DateRange.ThirtyDays} onTimeRangeChange={mockOnChange} />);

    // Mantine Tabs usually render role="tab"
    const thirtyDaysTab =
      screen.queryByRole("tab", { name: /30 days/i }) ?? screen.getByText(/30 days/i);

    // Different libs mark active differently; we support a few common patterns:
    const tabEl = (thirtyDaysTab as HTMLElement).closest('[role="tab"]') ?? (thirtyDaysTab as HTMLElement);

    // 1) Mantine often uses data-active="true"
    // 2) ARIA pattern uses aria-selected="true"
    const dataActive = tabEl.getAttribute("data-active");
    const ariaSelected = tabEl.getAttribute("aria-selected");

    expect(dataActive === "true" || ariaSelected === "true").toBe(true);
  });

  test("handles null timeRange", () => {
    const mockOnChange = vi.fn();
    render(<DateRangeTabs timeRange={null} onTimeRangeChange={mockOnChange} />);

    // Should render without errors
    expect(screen.getByText(/7 days/i)).toBeInTheDocument();
  });
});
