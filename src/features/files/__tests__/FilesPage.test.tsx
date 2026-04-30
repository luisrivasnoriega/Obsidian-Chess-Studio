import { beforeAll, describe, expect, test, vi } from "vitest";
import FilesPage from "../FilesPage";
import { render } from "./test-utils";

// -----------------------------
// Mocks
// -----------------------------

vi.mock("react-i18next", () => ({
  initReactI18next: {
    type: "3rdParty",
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtom: () => [[], vi.fn()],
    useAtomValue: () => [],
  };
});

vi.mock("@/App", () => ({
  loadDirectories: vi.fn(),
  updateDirectoriesCache: vi.fn(),
}));

vi.mock("@mantine/modals", () => ({
  modals: {
    open: vi.fn(),
    closeAll: vi.fn(),
  },
}));

vi.mock("@/bindings", () => ({
  commands: {
    getFiles: vi.fn(),
  },
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

describe("FilesPage", () => {
  test("renders without crashing", () => {
    render(<FilesPage />);
    // Basic smoke test - component should render
    expect(document.body).toBeTruthy();
  });
});
