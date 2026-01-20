import { beforeAll, describe, expect, test, vi } from "vitest";
import PlayerCard from "../../drawers/PlayerCard";
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
    const player = { id: 1, name: "Test Player", elo: null };
    render(<PlayerCard player={player} file="/test.db" />);
    expect(document.body).toBeTruthy();
  });
});
