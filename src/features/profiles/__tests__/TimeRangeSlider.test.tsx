import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import TimeRangeSlider from "../components/PersonalCardPanels/TimeRangeSlider";

// Mock RangeSlider to make interaction deterministic in JSDOM
vi.mock("@mantine/core", async (importOriginal) => {
  const mod = (await importOriginal()) as any;
  return {
    ...mod,
    RangeSlider: (props: any) => (
      <div
        data-testid="range-slider"
        onClick={() => props.onChange?.([0, Math.min(2, props.max ?? 0)])}
      >
        RangeSlider
      </div>
    ),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, _opts?: any) => "date",
  }),
  initReactI18next: { type: "languageDetector", init: vi.fn() },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe("TimeRangeSlider", () => {
  test("renders and calls onDateRangeChange on interaction", async () => {
    const onDateRangeChange = vi.fn();
    render(<TimeRangeSlider ratingDates={[1, 2, 3, 4]} onDateRangeChange={onDateRangeChange} />);

    const slider = screen.getByTestId("range-slider");
    expect(slider).toBeInTheDocument();

    slider.click();
    expect(onDateRangeChange).toHaveBeenCalledWith({ start: 0, end: 2 });
  });
});


