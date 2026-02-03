import { expect, test, vi } from "vitest";
import { render, screen, waitFor } from "./test-utils";

let currentActiveProfileId = "p1";
let mockPlayers: any = {
  white: { type: "human", profileId: "p1", timeControl: { seconds: 180 } },
  black: { type: "engine", engine: { name: "Engine", path: "engine.exe" }, timeControl: { seconds: 180 } },
};

// -----------------------------
// Mocks
// -----------------------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/bindings", () => ({
  commands: {
    killEngines: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/components/Clock", () => ({
  default: () => null,
}));

vi.mock("@/components/GameInfo", () => ({
  default: () => null,
}));

vi.mock("@/components/TreeStateContext", async () => {
  const React = await import("react");
  // The component only checks that the context is non-null; state comes from mocked useStore.
  return { TreeStateContext: React.createContext({}) };
});

const setHeadersMock = vi.fn();
const setFenMock = vi.fn();
const setResultMock = vi.fn();
const clearShapesMock = vi.fn();

const leafNode: any = { fen: "fen-leaf", children: [] };
const rootNode: any = { fen: "fen-root", children: [leafNode] };

const headersState: any = {
  event: "?",
  site: "?",
  white: "You",
  black: "Engine",
  result: "*",
  fen: undefined,
  variant: undefined,
  time_control: "180+2",
};

vi.mock("zustand", () => ({
  useStore: (_store: unknown, selector: (s: any) => unknown) =>
    selector({
      root: rootNode,
      position: null,
      headers: headersState,
      setHeaders: setHeadersMock,
      setFen: setFenMock,
      setResult: setResultMock,
      clearShapes: clearShapesMock,
    }),
}));

vi.mock("@/utils/chessops", () => ({
  positionFromFen: () => [
    {
      turn: "white",
      isEnd: () => false,
    },
  ],
}));

vi.mock("@/utils/chess", () => ({
  getMainLine: () => ["e2e4"],
  getOpening: async () => "",
  getPGN: (_tree: unknown, opts: any) => {
    const site = opts?.headers?.site ?? "?";
    const result = opts?.headers?.result ?? "*";
    return `[Site "${site}"]\n[Result "${result}"]\n\n1. e4 ${result}`;
  },
}));

const saveGameRecordMock = vi.fn<(record: any, dedupeKey?: string) => Promise<void>>(() => Promise.resolve());

vi.mock("@/utils/gameRecords", () => ({
  saveGameRecord: (record: any, dedupeKey?: string) => saveGameRecordMock(record, dedupeKey),
}));

vi.mock("@/utils/tabs", () => ({
  createTab: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../components/hooks/useEngineMoves", () => ({
  useEngineMoves: () => undefined,
}));

vi.mock("../components/BoardGame", () => ({
  default: () => null,
  useClockTimer: () => undefined,
}));

vi.mock("../components/ResponsiveBoard", () => ({
  default: () => null,
}));

vi.mock("react-mosaic-component", () => ({
  Mosaic: () => null,
}));

vi.mock("@mantine/notifications", () => ({
  notifications: {
    show: vi.fn(),
  },
}));

// Atom identity mapping used by the jotai mock.
vi.mock("@/state/atoms", () => {
  const activeProfileIdAtom = Symbol("activeProfileIdAtom");
  const activeTabAtom = Symbol("activeTabAtom");
  const currentGameStateAtom = Symbol("currentGameStateAtom");
  const currentPlayersAtom = Symbol("currentPlayersAtom");
  const profilesAtom = Symbol("profilesAtom");
  const tabsAtom = Symbol("tabsAtom");
  return {
    activeProfileIdAtom,
    activeTabAtom,
    currentGameStateAtom,
    currentPlayersAtom,
    profilesAtom,
    tabsAtom,
  };
});

vi.mock("jotai", async () => {
  const atoms = await import("@/state/atoms");
  return {
    useAtomValue: (atom: any) => {
      if (atom === atoms.activeProfileIdAtom) return currentActiveProfileId;
      if (atom === atoms.profilesAtom)
        return [
          { id: "p1", name: "LR", displayName: "LR" },
          { id: "p2", name: "P2" },
        ];
      if (atom === atoms.activeTabAtom) return "tab1";
      return null;
    },
    useAtom: (atom: any) => {
      if (atom === atoms.activeTabAtom) return ["tab1", vi.fn()];
      if (atom === atoms.currentGameStateAtom) return ["playing", vi.fn()];
      if (atom === atoms.currentPlayersAtom) return [mockPlayers, vi.fn()];
      if (atom === atoms.tabsAtom) return [[{ value: "tab1", type: "play", name: "Play" }], vi.fn()];
      return [null, vi.fn()];
    },
  };
});

// -----------------------------
// Tests
// -----------------------------

test("finalizes and saves exactly once when multiple end buttons are pressed quickly", async () => {
  saveGameRecordMock.mockClear();
  currentActiveProfileId = "p1";
  mockPlayers = {
    white: { type: "human", profileId: "p1", timeControl: { seconds: 180 } },
    black: { type: "engine", engine: { name: "Engine", path: "engine.exe" }, timeControl: { seconds: 180 } },
  };

  const mod = await import("../components/PlayVsEngineBoard");
  const PlayVsEngineBoard = mod.default;

  render(<PlayVsEngineBoard />);

  const newGameBtn = screen.getByRole("button", { name: /new game/i });
  const againBtn = screen.getByRole("button", { name: /again/i });

  // Trigger two different end paths back-to-back.
  newGameBtn.click();
  againBtn.click();

  await waitFor(() => expect(saveGameRecordMock).toHaveBeenCalledTimes(1));

  const [record] = saveGameRecordMock.mock.calls[0] ?? [];
  expect(record.profileId).toBe("p1");
  expect(record.pgn).toContain('[Site "local"]');
});

test("captures profile id at the moment of finalization (profile changes after end do not affect save)", async () => {
  saveGameRecordMock.mockClear();
  currentActiveProfileId = "p1";
  mockPlayers = {
    white: { type: "human", profileId: "p1", timeControl: { seconds: 180 } },
    black: { type: "engine", engine: { name: "Engine", path: "engine.exe" }, timeControl: { seconds: 180 } },
  };

  let resolveSave: (() => void) | undefined;
  saveGameRecordMock.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = () => resolve();
      }),
  );

  const mod = await import("../components/PlayVsEngineBoard");
  const PlayVsEngineBoard = mod.default;

  render(<PlayVsEngineBoard />);

  const resignBtn = screen.getByRole("button", { name: /resign/i });
  resignBtn.click();

  // Change profile after the end path already triggered.
  currentActiveProfileId = "p2";
  resolveSave?.();

  await waitFor(() => expect(saveGameRecordMock).toHaveBeenCalledTimes(1));
  const [record] = saveGameRecordMock.mock.calls[0] ?? [];
  expect(record.profileId).toBe("p1");
});

test("does not save again when mounting the board with an already-finished game", async () => {
  saveGameRecordMock.mockClear();
  currentActiveProfileId = "p1";
  mockPlayers = {
    white: { type: "human", profileId: "p1", timeControl: { seconds: 180 } },
    black: { type: "engine", engine: { name: "Engine", path: "engine.exe" }, timeControl: { seconds: 180 } },
  };

  headersState.result = "0-1";

  const mod = await import("../components/PlayVsEngineBoard");
  const PlayVsEngineBoard = mod.default;

  render(<PlayVsEngineBoard />);

  // Remounting a finished game view should not trigger another save.
  await new Promise((r) => setTimeout(r, 50));
  expect(saveGameRecordMock).toHaveBeenCalledTimes(0);

  headersState.result = "*";
});

test("saves with the human on black when the player settings are black", async () => {
  saveGameRecordMock.mockClear();
  currentActiveProfileId = "p1";
  mockPlayers = {
    white: { type: "engine", engine: { name: "Leela", path: "leela.exe" }, timeControl: { seconds: 180 } },
    black: { type: "human", profileId: "p1", timeControl: { seconds: 180 } },
  };

  const mod = await import("../components/PlayVsEngineBoard");
  const PlayVsEngineBoard = mod.default;

  render(<PlayVsEngineBoard />);

  const backBtn = screen.getByRole("button", { name: /back/i });
  backBtn.click();

  await waitFor(() => expect(saveGameRecordMock).toHaveBeenCalledTimes(1));
  const [record] = saveGameRecordMock.mock.calls[0] ?? [];
  expect(record.white.type).toBe("engine");
  expect(record.white.name).toMatch(/leela/i);
  expect(record.black.type).toBe("human");
  expect(record.black.name).toBe("LR");
});
