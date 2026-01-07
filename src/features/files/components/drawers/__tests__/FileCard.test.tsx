import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import FileCard from "../../drawers/FileCard";

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

vi.mock("@/components/panels/info/GameSelector", () => ({
  default: () => <div>GameSelector</div>,
}));

vi.mock("@/features/databases/components/drawers/GamePreview", () => ({
  default: () => <div>GamePreview</div>,
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

vi.mock("@/bindings", () => ({
  commands: {
    readGames: vi.fn().mockResolvedValue({
      status: "ok" as const,
      data: [{ pgn: "", headers: {} }],
    }),
  },
}));

describe("FileCard", () => {
  test("renders without crashing", () => {
    const file = {
      type: "file" as const,
      name: "test.pgn",
      path: "/test.pgn",
      numGames: 10,
      metadata: { type: "game" as const, tags: [] },
      lastModified: Date.now(),
    };
    render(
      <FileCard
        selected={file}
        games={new Map()}
        setGames={vi.fn()}
        toggleEditModal={vi.fn()}
        mutate={vi.fn()}
        setSelected={vi.fn()}
        files={[file]}
      />
    );
    expect(document.body).toBeTruthy();
  });
});

