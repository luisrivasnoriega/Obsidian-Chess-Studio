import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { PlayerSearchInput } from "../../components/PlayerSearchInput";
import { render, screen, waitFor } from "./test-utils";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
});

vi.mock("@/bindings", () => ({
  commands: {
    getPlayer: vi.fn(),
  },
}));

vi.mock("@/utils/db", () => ({
  query_players: vi.fn(),
}));

vi.mock("@/utils/unwrap", () => ({
  unwrap: (r: any) => (r?.status === "ok" ? r.data : null),
}));

describe("PlayerSearchInput", () => {
  const mockSetValue = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("renders without crashing", () => {
    render(<PlayerSearchInput label="Search Player" value={undefined} file="/test.db" setValue={mockSetValue} />);
    expect(document.body).toBeTruthy();
  });

  test("loads player name when value is provided", async () => {
    const { commands } = await import("@/bindings");
    vi.mocked(commands.getPlayer).mockResolvedValue({
      status: "ok",
      data: { id: 1, name: "Test Player" },
    } as any);

    render(<PlayerSearchInput label="Search Player" value={1} file="/test.db" setValue={mockSetValue} />);

    await waitFor(() => {
      expect(commands.getPlayer).toHaveBeenCalledWith("/test.db", 1);
    });
  });

  test("searches players when input changes", async () => {
    const user = userEvent.setup();
    const { query_players } = await import("@/utils/db");
    vi.mocked(query_players).mockResolvedValue({
      data: [{ id: 1, name: "Test Player" }],
    } as any);

    render(<PlayerSearchInput label="Search Player" value={undefined} file="/test.db" setValue={mockSetValue} />);

    const input = screen.getByPlaceholderText("Search Player");
    await user.type(input, "Test");

    await waitFor(() => {
      expect(query_players).toHaveBeenCalled();
    });
  });
});
