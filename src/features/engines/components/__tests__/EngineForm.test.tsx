import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import EngineForm from "../../components/EngineForm";

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
      values: { name: "", path: "", type: "local" as const },
      setFieldValue: vi.fn(),
      getInputProps: (name: string) => ({ name, value: "" }),
      onSubmit: vi.fn(),
      isValid: vi.fn().mockReturnValue(true),
      errors: {},
    }),
  };
});

vi.mock("@/components/FileInput", () => ({
  default: () => <div>FileInput</div>,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/utils/files", () => ({
  usePlatform: () => ({ os: "windows" }),
}));

describe("EngineForm", () => {
  const mockOnSubmit = vi.fn();

  test("renders without crashing", async () => {
    const { useForm } = await import("@mantine/form");
    const form = useForm({
      initialValues: {
        name: "",
        path: "",
        type: "local" as const,
      },
    });
    render(<EngineForm onSubmit={mockOnSubmit} form={form} submitLabel="Submit" />);
    expect(document.body).toBeTruthy();
  });
});

