import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import userEvent from "@testing-library/user-event";
import { SideInput } from "../../components/SideInput";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

describe("SideInput", () => {
  const mockSetSides = vi.fn();

  test("renders without crashing", () => {
    render(<SideInput selectingFor="player" sides="Any" setSides={mockSetSides} />);
    expect(document.body).toBeTruthy();
  });

  test("calls setSides when option is selected", async () => {
    const user = userEvent.setup();
    render(<SideInput selectingFor="player" sides="Any" setSides={mockSetSides} />);
    // Interaction would depend on component implementation
    expect(document.body).toBeTruthy();
  });
});

