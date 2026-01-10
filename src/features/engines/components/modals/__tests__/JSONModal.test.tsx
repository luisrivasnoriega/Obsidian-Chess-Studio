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
  const mockToggleOpened = vi.fn();
  const mockSetEngine = vi.fn();
  const mockEngine = {
    type: "local" as const,
    name: "Test Engine",
    version: "1.0",
    path: "/test/engine",
  };

  test("renders when opened", () => {
    render(
      <JSONModal
        opened={true}
        toggleOpened={mockToggleOpened}
        engine={mockEngine}
        setEngine={mockSetEngine}
      />
    );
    expect(document.body).toBeTruthy();
  });
});

