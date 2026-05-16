import type React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import BoardsPage from "../BoardsPage";
import { render } from "./test-utils";

// -----------------------------
// Mocks
// -----------------------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
  initReactI18next: {
    type: "languageDetector",
    init: vi.fn(),
  },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtom: () => [[], vi.fn()],
    useAtomValue: () => [],
  };
});

vi.mock("jotai/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai/utils")>();
  const { atom } = await import("jotai");
  return {
    ...actual,
    atomWithStorage: <T,>(_key: string, initialValue: T) => atom(initialValue),
  };
});

vi.mock("@/hooks/useResponsiveLayout", () => ({
  useResponsiveLayout: () => ({
    layout: {
      chessBoard: {
        layoutType: "desktop",
      },
      panels: {
        type: "drawer",
        drawer: {
          position: "right",
          size: "md",
        },
      },
    },
    isMobile: false,
    isTablet: false,
  }),
  getPlatform: () => "desktop",
}));

vi.mock("../hooks/useTabManagement", () => ({
  useTabManagement: () => ({
    tabs: [],
    activeTab: null,
    setActiveTab: vi.fn(),
  }),
}));

vi.mock("@/components/TreeStateContext", () => ({
  TreeStateProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/features/profiles/ProfilesPage", () => ({
  default: () => <div>ProfilesPage</div>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

// Mock App.tsx to avoid loading the router
vi.mock("@/App", () => ({
  loadDirectories: vi.fn().mockResolvedValue(undefined),
}));

// ResizeObserver polyfill
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
});

// -----------------------------
// Tests
// -----------------------------

describe("BoardsPage", () => {
  test("renders without crashing", () => {
    render(<BoardsPage />);
    // Basic smoke test - component should render
    expect(document.body).toBeTruthy();
  });
});
