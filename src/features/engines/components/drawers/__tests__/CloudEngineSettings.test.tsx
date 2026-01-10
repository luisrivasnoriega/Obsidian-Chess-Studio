import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import { CloudEngineSettings } from "../../drawers/CloudEngineSettings";

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

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtom: () => [[], vi.fn()],
  };
});

vi.mock("@/components/panels/analysis/LinesSlider", () => ({
  default: () => <div>LinesSlider</div>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

describe("CloudEngineSettings", () => {
  test("renders without crashing", () => {
    const mockEngine = {
      type: "chessdb" as const,
      name: "Test Engine",
      url: "https://example.com",
    };
    render(<CloudEngineSettings selectedEngine={mockEngine} selected={0} setSelected={vi.fn()} />);
    expect(document.body).toBeTruthy();
  });
});

