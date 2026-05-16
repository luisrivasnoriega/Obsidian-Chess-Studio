import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chessground } from "@/components/Chessground";

const chessgroundMock = vi.hoisted(() => ({
  destroy: vi.fn(),
  factory: vi.fn(),
  getFen: vi.fn(() => "mock fen"),
  set: vi.fn(),
}));

vi.mock("@lichess-org/chessground", () => ({
  Chessground: vi.fn((...args: unknown[]) => {
    chessgroundMock.factory(...args);
    return {
      destroy: chessgroundMock.destroy,
      getFen: chessgroundMock.getFen,
      set: chessgroundMock.set,
    };
  }),
}));

function renderChessground(fen: string) {
  return (
    <MantineProvider>
      <Chessground fen={fen} orientation="white" turnColor="white" drawable={{ autoShapes: [] }} />
    </MantineProvider>
  );
}

describe("Chessground interaction updates", () => {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  let frameCallback: FrameRequestCallback | null = null;

  beforeEach(() => {
    chessgroundMock.destroy.mockClear();
    chessgroundMock.factory.mockClear();
    chessgroundMock.getFen.mockClear();
    chessgroundMock.set.mockClear();
    frameCallback = null;

    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        frameCallback = callback;
        return 1;
      }),
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: originalRequestAnimationFrame,
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: originalCancelAnimationFrame,
    });
  });

  it("queues config updates during drag and applies only the last one after release", async () => {
    const { rerender } = render(renderChessground("initial fen"));

    await act(async () => {});
    chessgroundMock.set.mockClear();

    const board = chessgroundMock.factory.mock.calls[0]?.[0] as HTMLElement | undefined;
    if (!board) {
      throw new Error("Chessground board element was not rendered");
    }
    const initialConfig = chessgroundMock.factory.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(initialConfig).not.toHaveProperty("highlight");
    expect(initialConfig).not.toHaveProperty("premovable");
    expect(initialConfig).not.toHaveProperty("predroppable");

    fireEvent.pointerDown(board);
    rerender(renderChessground("queued fen 1"));
    rerender(renderChessground("queued fen 2"));

    expect(chessgroundMock.set).not.toHaveBeenCalled();

    fireEvent.pointerUp(document);
    rerender(renderChessground("queued fen 3"));
    expect(chessgroundMock.set).not.toHaveBeenCalled();
    expect(frameCallback).not.toBeNull();

    act(() => {
      frameCallback?.(0);
    });

    expect(chessgroundMock.set).toHaveBeenCalledTimes(1);
    expect(chessgroundMock.set.mock.calls[0]?.[0]).toMatchObject({ fen: "queued fen 3" });
  });
});
