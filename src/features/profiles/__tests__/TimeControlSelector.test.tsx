import { beforeAll, describe, expect, test, vi } from "vitest";
import TimeControlSelector from "../components/PersonalCardPanels/TimeControlSelector";
import { render, screen } from "./test-utils";

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

describe("TimeControlSelector", () => {
  test("calls onTimeControlChange with default value", () => {
    const onTimeControlChange = vi.fn();
    render(<TimeControlSelector onTimeControlChange={onTimeControlChange} website="Chess.com" allowAll />);

    // effect should fire with default "any"
    expect(onTimeControlChange).toHaveBeenCalled();
  });

  test("renders label", () => {
    render(<TimeControlSelector onTimeControlChange={() => {}} website="Lichess" allowAll />);
    expect(screen.getAllByText(/time control/i).length).toBeGreaterThan(0);
  });
});
