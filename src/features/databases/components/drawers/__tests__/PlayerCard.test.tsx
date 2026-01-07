import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import PlayerCard from "../../drawers/PlayerCard";

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

vi.mock("@/features/profiles/components/PersonalCard", () => ({
  default: () => <div>PersonalPlayerCard</div>,
}));

vi.mock("@/bindings", () => ({
  commands: {
    getPlayersGameInfo: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

vi.mock("@/utils/unwrap", () => ({
  unwrap: (r: any) => (r?.status === "ok" ? r.data : null),
}));

describe("PlayerCard", () => {
  test("renders without crashing", () => {
    const player = { id: 1, name: "Test Player" };
    render(<PlayerCard player={player} file="/test.db" />);
    expect(document.body).toBeTruthy();
  });
});

