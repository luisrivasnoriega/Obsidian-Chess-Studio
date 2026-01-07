import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import GamePreview from "../../drawers/GamePreview";

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
    render(<GamePreview gameId={1} file="/test.db" />);
    expect(document.body).toBeTruthy();
  });
});

