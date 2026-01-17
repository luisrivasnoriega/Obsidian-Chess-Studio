import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import GamePreview from "../../drawers/GamePreview";
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

vi.mock("@/components/Chessground", () => ({
  Chessground: () => <div>Chessground</div>,
}));

vi.mock("@/components/GameNotation", () => ({
  default: () => <div>GameNotation</div>,
}));

vi.mock("@/components/MoveControls", () => ({
  default: () => <div>MoveControls</div>,
}));

vi.mock("@/components/OpeningName", () => ({
  default: () => <div>OpeningName</div>,
}));

vi.mock("@/components/TreeStateContext", () => ({
  TreeStateContext: React.createContext(null),
  TreeStateProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/hooks/useResponsiveLayout", () => ({
  useResponsiveLayout: () => ({ layout: {} }),
}));

vi.mock("@/utils/chess", () => ({
  parsePGN: vi.fn(),
}));

vi.mock("zustand", () => ({
  useStore: () => ({}),
}));

describe("GamePreview", () => {
  test("renders without crashing", () => {
    render(<GamePreview pgn="1. e4 e5 2. Nf3" />);
    expect(document.body).toBeTruthy();
  });
});
