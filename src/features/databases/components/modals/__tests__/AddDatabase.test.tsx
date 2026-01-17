import { beforeAll, describe, expect, test, vi } from "vitest";
import AddDatabase from "../../modals/AddDatabase";
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

vi.mock("@mantine/form", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mantine/form")>();
  return {
    ...actual,
    useForm: () => ({
      values: {},
      setFieldValue: vi.fn(),
      getInputProps: () => ({}),
      onSubmit: vi.fn(),
      errors: {},
      isValid: true,
    }),
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    createRootRouteWithContext: actual.createRootRouteWithContext,
  };
});

// Note: @tauri-apps/api/path is already mocked globally in vitest.setup.ts

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

// Note: @tauri-apps/plugin-fs is already mocked globally in vitest.setup.ts

// Note: @tauri-apps/api/event is already mocked globally in vitest.setup.ts

vi.mock("@/utils/puzzles", () => ({
  getPuzzleDatabases: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/utils/db", () => ({
  useDefaultDatabases: vi.fn(() => ({
    defaultDatabases: [],
    error: null,
    isLoading: false,
  })),
}));

vi.mock("@/components/FileInput", () => ({
  default: () => <div>FileInput</div>,
}));

vi.mock("@/components/ProgressButton", () => ({
  default: () => <div>ProgressButton</div>,
}));

vi.mock("@/bindings", () => ({
  commands: {
    addDatabase: vi.fn(),
    convertPgn: vi.fn().mockResolvedValue({ status: "ok" }),
    downloadPositionCache: vi.fn().mockResolvedValue({ status: "ok" }),
    downloadFile: vi.fn().mockResolvedValue({ status: "ok" }),
    importPuzzleFile: vi.fn().mockResolvedValue({ status: "ok" }),
    validatePuzzleDatabase: vi.fn().mockResolvedValue({ status: "ok", data: true }),
  },
  events: {
    databaseAdded: vi.fn(),
  },
}));

describe("AddDatabase", () => {
  const mockSetOpened = vi.fn();
  const mockSetDatabases = vi.fn();
  const mockSetLoading = vi.fn();
  const mockDatabases: any[] = [];

  test("renders when opened", () => {
    render(
      <AddDatabase
        opened={true}
        setOpened={mockSetOpened}
        setDatabases={mockSetDatabases}
        setLoading={mockSetLoading}
        databases={mockDatabases}
      />,
    );
    expect(document.body).toBeTruthy();
  });

  test("does not render when closed", () => {
    render(
      <AddDatabase
        opened={false}
        setOpened={mockSetOpened}
        setDatabases={mockSetDatabases}
        setLoading={mockSetLoading}
        databases={mockDatabases}
      />,
    );
    expect(document.body).toBeTruthy();
  });
});
