import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import userEvent from "@testing-library/user-event";
import { FilenameInput } from "../../components/FilenameInput";

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

describe("FilenameInput", () => {
  const mockOnChange = vi.fn();

  test("renders without crashing", () => {
    render(<FilenameInput value="" onChange={mockOnChange} />);
    expect(document.body).toBeTruthy();
  });

  test("calls onChange when value changes", async () => {
    const user = userEvent.setup();
    render(<FilenameInput value="" onChange={mockOnChange} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "test");
    expect(mockOnChange).toHaveBeenCalled();
  });
});

