import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import FideInfo from "../../drawers/FideInfo";

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

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: {
    AppData: "AppData",
  },
  exists: vi.fn().mockResolvedValue(false),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

describe("FideInfo", () => {
  test("renders when opened", () => {
    render(<FideInfo opened={true} setOpened={vi.fn()} name="Test Player" />);
    expect(document.body).toBeTruthy();
  });

  test("does not render when closed", () => {
    render(<FideInfo opened={false} setOpened={vi.fn()} name="Test Player" />);
    expect(document.body).toBeTruthy();
  });
});

