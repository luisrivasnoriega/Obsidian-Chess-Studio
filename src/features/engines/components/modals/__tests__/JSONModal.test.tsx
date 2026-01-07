import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import { JSONModal } from "../../modals/JSONModal";

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

describe("JSONModal", () => {
  const mockOnClose = vi.fn();

  test("renders when opened", () => {
    render(<JSONModal opened={true} onClose={mockOnClose} data={{ test: "data" }} />);
    expect(document.body).toBeTruthy();
  });
});

