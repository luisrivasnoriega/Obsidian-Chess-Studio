import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import { EngineSettings } from "../../drawers/EngineSettings";

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
    useAtom: () => [
      [
        {
          type: "local" as const,
          name: "Test Engine",
          path: "/test/engine",
          settings: [],
        },
      ],
      vi.fn(),
    ],
  };
});

vi.mock("@/bindings", () => ({
  commands: {
    fileExists: vi.fn().mockResolvedValue({ status: "ok", data: true }),
    getEngineConfig: vi.fn().mockResolvedValue({
      status: "ok",
      data: { name: "Test Engine", options: [] },
    }),
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/components/GoModeInput", () => ({
  default: () => <div>GoModeInput</div>,
}));

vi.mock("@/components/LocalImage", () => ({
  default: () => <div>LocalImage</div>,
}));

vi.mock("@/utils/engines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/engines")>();
  return {
    ...actual,
    requiredEngineSettings: [],
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@/bindings", () => ({
  commands: {
    fileExists: vi.fn().mockResolvedValue({ status: "ok", data: true }),
    getEngineConfig: vi.fn().mockResolvedValue({
      status: "ok",
      data: { name: "Test Engine", options: [] },
    }),
  },
}));

describe("EngineSettings", () => {
  test("renders without crashing", () => {
    render(<EngineSettings selected={0} setSelected={vi.fn()} isMobile={false} />);
    expect(document.body).toBeTruthy();
  });
});

