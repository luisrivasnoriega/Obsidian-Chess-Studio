import { beforeAll, describe, expect, test, vi } from "vitest";
import { PuzzleVariantsCard } from "../../components/PuzzleVariantsCard";
import { render } from "./test-utils";

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

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtom: () => [[], vi.fn()],
    useSetAtom: () => vi.fn(),
  };
});

vi.mock("@/App", () => ({
  loadDirectories: vi.fn(),
}));

vi.mock("@/features/files/utils/file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/files/utils/file")>();
  return {
    ...actual,
    processEntriesRecursively: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@/utils/pgnPuzzleProgress", () => ({
  getSolvedPgnPuzzleCount: vi.fn().mockResolvedValue(0),
  PGN_PUZZLE_PROGRESS_UPDATED_EVENT: "puzzle-progress-updated",
}));

vi.mock("@/utils/tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/tabs")>();
  return {
    ...actual,
    createTab: vi.fn(),
  };
});

describe("PuzzleVariantsCard", () => {
  test("renders without crashing", () => {
    render(<PuzzleVariantsCard />);
    expect(document.body).toBeTruthy();
  });
});
