import { beforeAll, describe, expect, test, vi } from "vitest";
import DatabaseView from "../DatabaseView";
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

vi.mock("@/features/databases/components/views/GameTable", () => ({
  default: () => <div data-testid="GameTable" />,
}));

vi.mock("@/features/databases/components/views/PlayerTable", () => ({
  default: () => <div data-testid="PlayerTable" />,
}));

vi.mock("../components/views/TournamentTable", () => ({
  default: () => <div data-testid="TournamentTable" />,
}));

describe("DatabaseView", () => {
  test("renders without crashing", () => {
    render(<DatabaseView />);
    expect(document.body).toBeTruthy();
  });
});
