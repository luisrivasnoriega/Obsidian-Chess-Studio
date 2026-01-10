import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import AddEngine from "../../modals/AddEngine";

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
    }),
  };
});

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtom: () => [[], vi.fn()],
  };
});

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn(),
  join: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@/components/ProgressButton", () => ({
  default: () => <div>ProgressButton</div>,
}));

vi.mock("@/utils/engines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/engines")>();
  return {
    ...actual,
    useDefaultEngines: vi.fn().mockReturnValue({
      defaultEngines: [],
      error: null,
      isLoading: false,
    }),
    requiredEngineSettings: [],
  };
});

vi.mock("@/utils/files", () => ({
  usePlatform: () => ({ os: "windows" }),
}));

vi.mock("@/utils/unwrap", () => ({
  unwrap: (r: any) => (r?.status === "ok" ? r.data : null),
}));

vi.mock("../EngineForm", () => ({
  default: () => <div>EngineForm</div>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

describe("AddEngine", () => {
  const mockSetOpened = vi.fn();

  test("renders when opened", () => {
    render(<AddEngine opened={true} setOpened={mockSetOpened} />);
    expect(document.body).toBeTruthy();
  });
});

