import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import GridLayout from "../../views/GridLayout";

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

vi.mock("@/components/SidePanelDrawerLayout", () => ({
  SidePanelDrawerLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("GridLayout", () => {
  test("renders without crashing", () => {
    render(
      <GridLayout
        search={<div>Search</div>}
        table={<div>Table</div>}
        preview={<div>Preview</div>}
        layoutType="desktop"
      />
    );
    expect(document.body).toBeTruthy();
  });
});

