import { beforeAll, describe, expect, test, vi } from "vitest";
import DatabasesPage from "../DatabasesPage";
import { render } from "./test-utils";

// -----------------------------
// Mocks
// -----------------------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

// Mock App.tsx to prevent router initialization
vi.mock("@/App", () => ({
  loadDirectories: vi.fn().mockResolvedValue({}),
}));

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtom: () => [[], vi.fn()],
    useAtomValue: () => [],
  };
});

vi.mock("zustand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zustand")>();
  return {
    ...actual,
    useStore: () => ({
      players: { activeTab: "overview" },
      setPlayersActiveTab: vi.fn(),
    }),
  };
});

vi.mock("@/features/databases/components/DatabaseViewStateContext", async () => {
  const React = await import("react");
  const mockStore = {
    players: { activeTab: "overview" },
    setPlayersActiveTab: vi.fn(),
  };
  const DatabaseViewStateContext = React.createContext(mockStore);
  DatabaseViewStateContext.displayName = "DatabaseViewStateContext";
  return {
    DatabaseViewStateContext,
  };
});

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

describe("DatabasesPage", () => {
  test("renders without crashing", () => {
    render(<DatabasesPage />);
    // Basic smoke test - component should render
    expect(document.body).toBeTruthy();
  });
});
