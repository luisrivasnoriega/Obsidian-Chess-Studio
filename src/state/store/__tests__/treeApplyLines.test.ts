import { describe, expect, it } from "vitest";
import { createTreeStore } from "@/state/store/tree";
import { getPGNFromReportView } from "@/utils/chess";

describe("tree store applyLinesAtPath", () => {
  it("applies all lines in a single update without moving the current position", () => {
    const store = createTreeStore();

    // Build a small mainline so we can insert from a non-root start path (after 2...g6).
    store.getState().makeMoves({ payload: ["e4", "c5", "Nf3", "g6"], mainline: false, changeHeaders: false });
    const startPath = [...store.getState().position];
    const savedPosition = [...store.getState().position];

    store.getState().applyLinesAtPath({
      startPath,
      lines: [
        // Mainline continuation.
        ["d4", "cxd4", "Nxd4", "Nc6", "Nc3", "Bg7"],
        // Alternative at the first ply from startPath.
        ["c3", "d5", "e5"],
      ],
      mainline: false,
      changeHeaders: false,
    });

    expect(store.getState().position).toEqual(savedPosition);

    const pgn = getPGNFromReportView(store.getState().root, {
      headers: store.getState().headers,
      comments: false,
      extraMarkups: false,
      glyphs: false,
      variations: true,
    });

    expect(pgn).toContain("3. d4");
    expect(pgn).toContain("(3. c3");
  });
});
