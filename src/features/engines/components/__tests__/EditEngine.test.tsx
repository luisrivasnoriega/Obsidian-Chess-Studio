import { beforeAll, describe, expect, test, vi } from "vitest";
import EditEngine from "../../components/EditEngine";
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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

describe("EditEngine", () => {
  test("renders when opened", () => {
    const engine = {
      name: "Stockfish",
      type: "local" as const,
      version: "1.0",
      path: "/stockfish",
      elo: 3000,
    };
    render(<EditEngine initialEngine={engine} />);
    expect(document.body).toBeTruthy();
  });
});
