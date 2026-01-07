import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import DirectoryTable from "../../views/DirectoryTable";

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

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtom: () => [[], vi.fn()],
    useSetAtom: () => vi.fn(),
    atomWithStorage: () => ({ init: vi.fn() }),
  };
});

vi.mock("@tauri-apps/plugin-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/plugin-fs")>();
  return {
    ...actual,
    remove: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
  };
});

vi.mock("@/bindings", () => ({
  commands: {
    countPgnGames: vi.fn(),
  },
}));

vi.mock("@/utils/tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/tabs")>();
  return {
    ...actual,
    createTab: vi.fn(),
    tabSchema: actual.tabSchema,
  };
});

vi.mock("@/utils/unwrap", () => ({
  unwrap: (r: any) => (r?.status === "ok" ? r.data : null),
}));

vi.mock("mantine-contextmenu", () => ({
  useContextMenu: () => ({ showContextMenu: vi.fn() }),
}));

describe("DirectoryTable", () => {
  test("renders without crashing", () => {
    render(<DirectoryTable entries={[]} />);
    expect(document.body).toBeTruthy();
  });
});

