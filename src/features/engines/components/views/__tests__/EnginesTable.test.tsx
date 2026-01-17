import { beforeAll, describe, expect, test, vi } from "vitest";
import { EnginesTable } from "../../views/EnginesTable";
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

vi.mock("@/components/LocalImage", () => ({
  default: () => <div>LocalImage</div>,
}));

describe("EnginesTable", () => {
  test("renders without crashing", () => {
    const engines = [
      {
        type: "local" as const,
        name: "Test Engine",
        version: "1.0",
        path: "/test/engine",
      },
    ];
    render(<EnginesTable engines={engines} filteredIndices={[0]} selected={undefined} setSelected={vi.fn()} />);
    expect(document.body).toBeTruthy();
  });
});
