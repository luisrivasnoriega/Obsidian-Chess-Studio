import { describe, expect, it } from "vitest";
import type { HumanStrategicLiveResponse } from "@/bindings";
import { getHumanStrategicLineBadgeKey, getHumanStrategicLineText, shouldRenderHumanStrategicPanel } from "./BestMoves";

function makeReport(overrides: Partial<HumanStrategicLiveResponse>): HumanStrategicLiveResponse {
  return {
    display: "lines",
    suppressionReason: null,
    selectedUci: "e1e8",
    selectedSan: "Re8+",
    bestEngineUci: "e1e8",
    bestEngineSan: "Re8+",
    lines: [
      {
        uci: "e1e8",
        san: "Re8+",
        engineRank: 1,
        engineCp: 120,
        engineDropCp: 0,
        strategicScore: 0.48,
        finalScore: 0.74,
        isSelected: true,
        isEngineBest: true,
        motifs: [],
        strategicAxes: [],
        strategicPlan: "",
        commentKey: "features.board.analysis.gmGuardrail.comments.kingPressure",
        commentParams: { move: "Re8+", score: "0.48", drop: "0" },
        detailKey: "features.board.analysis.gmGuardrail.details.engineSafety",
        detailParams: { move: "Re8+", score: "0.48", drop: "0" },
        commentShort: "raw short should not render",
        commentLong: "raw long should not render",
        suggestedVariationUci: [],
        suggestedVariationSan: [],
      },
    ],
    ...overrides,
  };
}

describe("human strategic live helpers", () => {
  it("does not render hidden reports", () => {
    const hidden = makeReport({
      display: "hidden",
      suppressionReason: "routineOpening",
      lines: [],
    });

    expect(shouldRenderHumanStrategicPanel(false, hidden)).toBe(false);
    expect(shouldRenderHumanStrategicPanel(true, hidden)).toBe(false);
    expect(shouldRenderHumanStrategicPanel(true, null)).toBe(false);
  });

  it("renders visible reports through translation keys", () => {
    const report = makeReport({});
    const line = report.lines[0];

    const text = getHumanStrategicLineText(line, (key, params) => `${key}:${params?.move ?? ""}:${params?.drop ?? ""}`);

    expect(shouldRenderHumanStrategicPanel(false, report)).toBe(true);
    expect(text.short).toBe("features.board.analysis.gmGuardrail.comments.kingPressure:Re8+:0");
    expect(text.detail).toBe("features.board.analysis.gmGuardrail.details.engineSafety:Re8+:0");
    expect(text.short).not.toContain("raw short");
  });

  it("uses neutral badge labels for low strategic scores", () => {
    const line = {
      ...makeReport({}).lines[0],
      isSelected: false,
      isEngineBest: false,
      strategicScore: 0.08,
    };

    expect(getHumanStrategicLineBadgeKey(line)).toBe("features.board.analysis.gmGuardrail.badges.lowSignal");
  });
});
