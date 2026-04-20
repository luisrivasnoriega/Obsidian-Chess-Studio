import { describe, expect, it } from "vitest";
import type { HumanMoveNarrative } from "@/bindings";
import type { Annotation } from "@/utils/annotation";
import type { TreeNode } from "@/utils/treeReducer";
import { countTreeComments, injectHumanNarrativesIntoMainline } from "./ReportModal";

function makeNode(halfMoves: number, san: string | null): TreeNode {
  return {
    fen: `fen-${halfMoves}`,
    move: null,
    san,
    children: [],
    score: null,
    depth: null,
    halfMoves,
    shapes: [],
    annotations: [],
    comment: "",
  };
}

function makeMainlineTree(plies: number): TreeNode {
  const root = makeNode(0, null);
  let current = root;
  for (let ply = 1; ply <= plies; ply += 1) {
    const child = makeNode(ply, `m${ply}`);
    current.children = [child];
    current = child;
  }
  return root;
}

function makeNarrative(overrides: Partial<HumanMoveNarrative>): HumanMoveNarrative {
  return {
    ply: 1,
    sideToMove: "white",
    playedUci: "e2e4",
    playedSan: "e4",
    engineBestUci: null,
    engineBestSan: null,
    strategicChoiceUci: null,
    strategicChoiceSan: null,
    verdict: "Interesting",
    evalBeforeCp: null,
    evalAfterCp: null,
    cpLoss: null,
    playedStrategicScore: null,
    playedMotifs: [],
    strategicAxes: [],
    strategicPlan: "",
    commentShort: "",
    commentLong: "",
    suggestedVariationUci: [],
    suggestedVariationSan: [],
    ...overrides,
  };
}

describe("ReportModal human strategic comment injection", () => {
  it("injects commentLong when available", () => {
    const root = makeMainlineTree(49);
    const narratives: HumanMoveNarrative[] = [
      makeNarrative({
        ply: 49,
        verdict: "Mistake",
        commentLong: "Wrong tension release. Black activates the king and rook.",
      }),
    ];

    const injected = injectHumanNarrativesIntoMainline(root, narratives);
    const comments = countTreeComments(root);

    expect(injected).toBeGreaterThan(0);
    expect(comments).toBeGreaterThan(0);

    // Ply 49 is index 48 in mainline nodes.
    let node: TreeNode = root;
    for (let i = 0; i < 49; i += 1) {
      node = node.children[0]!;
    }
    expect(node.comment).toContain("Wrong tension release");
    expect(node.annotations).toContain("?" as Annotation);
  });

  it("does not inject strategicPlan-only narratives", () => {
    const root = makeMainlineTree(20);
    const narratives: HumanMoveNarrative[] = [
      makeNarrative({
        ply: 7,
        verdict: "Interesting",
        strategicPlan: "Should not be injected as a comment.",
      }),
    ];

    const injected = injectHumanNarrativesIntoMainline(root, narratives);
    const comments = countTreeComments(root);

    expect(injected).toBe(0);
    expect(comments).toBe(0);
  });

  it("does not inject when ply is out of range", () => {
    const root = makeMainlineTree(10);
    const narratives: HumanMoveNarrative[] = [
      makeNarrative({
        ply: 200,
        verdict: "Blunder",
        strategicPlan: "Should not appear.",
      }),
    ];

    const injected = injectHumanNarrativesIntoMainline(root, narratives);
    const comments = countTreeComments(root);

    expect(injected).toBe(0);
    expect(comments).toBe(0);
  });
});
