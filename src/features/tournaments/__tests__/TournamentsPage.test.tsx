import { beforeAll, describe, expect, test, vi } from "vitest";
import TournamentsPage from "../TournamentsPage";
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

vi.mock("@/App", () => ({
  loadDirectories: vi.fn().mockResolvedValue({}),
}));

vi.mock("../components/PlayVsLichessBoard", () => ({
  default: () => null,
}));

vi.mock("../components/TournamentList", () => ({
  TournamentList: () => null,
}));

vi.mock("../components/CreateTournamentForm", () => ({
  CreateTournamentForm: () => null,
}));

// Jotai is provided by test-utils with a preconfigured store.

vi.mock("@mantine/modals", () => ({
  modals: {
    open: vi.fn(),
    closeAll: vi.fn(),
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

describe("TournamentsPage", () => {
  test("renders without crashing", () => {
    render(<TournamentsPage />);
    // Basic smoke test - component should render
    expect(document.body).toBeTruthy();
  });
});
