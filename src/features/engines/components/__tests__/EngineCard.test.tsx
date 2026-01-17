import { beforeAll, describe, expect, test, vi } from "vitest";
import { EngineCard } from "../../components/EngineCard";
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

describe("EngineCard", () => {
  test("renders without crashing", () => {
    const engine = {
      name: "Stockfish",
      type: "local" as const,
      version: "1.0",
      path: "/stockfish",
      elo: 3000,
    };
    render(<EngineCard engine={engine} />);
    expect(document.body).toBeTruthy();
  });
});
