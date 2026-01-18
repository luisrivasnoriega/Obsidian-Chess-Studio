import { beforeAll, describe, expect, test, vi } from "vitest";
import TournamentTable from "../../views/TournamentTable";
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

vi.mock("@/bindings", () => ({
  commands: {
    getTournaments: vi.fn().mockResolvedValue({ status: "ok", data: { data: [] } }),
  },
}));

vi.mock("@/utils/unwrap", () => ({
  unwrap: (r: any) => (r?.status === "ok" ? r.data : null),
}));

vi.mock("zustand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zustand")>();
  return {
    ...actual,
    useStore: (_store: any, selector: any) => {
      if (selector) {
        return selector({
          database: { file: "/test.db" },
          tournaments: {
            query: { options: { pageSize: 25, page: 1 } },
            selectedTournamet: null,
            setTournamentsQuery: vi.fn(),
            setTournamentsSelectedTournamet: vi.fn(),
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
    tournaments: {
      query: { options: { pageSize: 25, page: 1 } },
      selectedTournamet: null,
      setTournamentsQuery: vi.fn(),
      setTournamentsSelectedTournamet: vi.fn(),
    },
  };
  const DatabaseViewStateContext = React.createContext(mockStore);
  return {
    DatabaseViewStateContext,
  };
});

vi.mock("../../drawers/TournamentCard", () => ({
  default: () => <div>TournamentCard</div>,
}));

vi.mock("./GridLayout", () => ({
  default: () => <div>GridLayout</div>,
}));

describe("TournamentTable", () => {
  test("renders without crashing", () => {
    render(<TournamentTable />);
    expect(document.body).toBeTruthy();
  });
});
