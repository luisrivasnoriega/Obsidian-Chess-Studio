import { beforeAll, describe, expect, test, vi } from "vitest";
import GameTable from "../../views/GameTable";
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

vi.mock("@/hooks/useResponsiveLayout", () => ({
  useResponsiveLayout: () => ({
    layout: {
      panels: { type: "drawer", drawer: { position: "right", size: "md" } },
      databases: { density: "normal", layoutType: "desktop" },
    },
  }),
  getPlatform: () => "desktop",
}));

vi.mock("@/utils/db", () => ({
  query_games: vi.fn(),
}));

vi.mock("@/utils/format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/format")>();
  return {
    ...actual,
    formatDateToPGN: vi.fn(),
    parseDate: vi.fn(),
  };
});

vi.mock("@/utils/tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/tabs")>();
  return {
    ...actual,
    createTab: vi.fn(),
  };
});

vi.mock("zustand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zustand")>();
  return {
    ...actual,
    useStore: (_store: any, selector: any) => {
      if (selector) {
        return selector({
          database: { file: "/test.db" },
          games: {
            query: {},
            selectedGame: null,
            setGamesQuery: vi.fn(),
            setGamesSelectedGame: vi.fn(),
          },
          mutate: vi.fn(),
        });
      }
      return {};
    },
  };
});

vi.mock("../../drawers/GameCard", () => ({
  default: () => <div>GameCard</div>,
}));

vi.mock("../../DatabaseViewStateContext", async () => {
  const React = await import("react");
  const mockStore = {
    database: { file: "/test.db" },
    games: {
      query: {},
      setGamesQuery: vi.fn(),
      selectedGame: null,
      setGamesSelectedGame: vi.fn(),
    },
    mutate: vi.fn(),
  };
  const DatabaseViewStateContext = React.createContext(mockStore);
  return {
    DatabaseViewStateContext,
  };
});

vi.mock("../../PlayerSearchInput", () => ({
  PlayerSearchInput: () => <div>PlayerSearchInput</div>,
}));

vi.mock("../../SideInput", () => ({
  SideInput: () => <div>SideInput</div>,
}));

vi.mock("./GridLayout", () => ({
  default: () => <div>GridLayout</div>,
}));

describe("GameTable", () => {
  test("renders without crashing", () => {
    render(<GameTable />);
    expect(document.body).toBeTruthy();
  });
});
