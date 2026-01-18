import { beforeAll, describe, expect, test, vi } from "vitest";
import PlayerTable from "../../views/PlayerTable";
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
  query_players: vi.fn().mockResolvedValue({ data: [] }),
}));

vi.mock("zustand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zustand")>();
  return {
    ...actual,
    useStore: (_store: any, selector: any) => {
      if (selector) {
        return selector({
          database: { file: "/test.db" },
          players: {
            query: { options: { pageSize: 25, page: 1 } },
            selectedPlayer: null,
            setPlayersQuery: vi.fn(),
            setPlayersSelectedPlayer: vi.fn(),
          },
        });
      }
      return {};
    },
  };
});

vi.mock("../../DatabaseViewStateContext", async () => {
  const React = await import("react");
  const mockStore = {
    database: { file: "/test.db" },
    players: {
      query: { options: { pageSize: 25, page: 1 } },
      selectedPlayer: null,
      setPlayersQuery: vi.fn(),
      setPlayersSelectedPlayer: vi.fn(),
    },
  };
  const DatabaseViewStateContext = React.createContext(mockStore);
  return {
    DatabaseViewStateContext,
  };
});

vi.mock("../../drawers/PlayerCard", () => ({
  default: () => <div>PlayerCard</div>,
}));

vi.mock("./GridLayout", () => ({
  default: () => <div>GridLayout</div>,
}));

describe("PlayerTable", () => {
  test("renders without crashing", () => {
    render(<PlayerTable />);
    expect(document.body).toBeTruthy();
  });
});
