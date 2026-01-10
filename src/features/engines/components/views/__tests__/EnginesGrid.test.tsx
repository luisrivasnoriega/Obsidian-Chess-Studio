import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import { EnginesGrid } from "../../views/EnginesGrid";

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
  useResponsiveLayout: () => ({ layout: { engines: { layoutType: "desktop" } } }),
}));

vi.mock("@/components/GenericCard", () => ({
  default: () => <div>GenericCard</div>,
}));

vi.mock("../EngineCard", () => ({
  EngineCard: () => <div>EngineCard</div>,
}));

describe("EnginesGrid", () => {
  test("renders without crashing", () => {
    const engines = [
      {
        type: "local" as const,
        name: "Test Engine",
        version: "1.0",
        path: "/test/engine",
      },
    ];
    render(<EnginesGrid engines={engines} filteredIndices={[0]} selected={undefined} setSelected={vi.fn()} />);
    expect(document.body).toBeTruthy();
  });
});

