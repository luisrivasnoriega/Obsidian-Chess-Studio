import type { Color } from "@lichess-org/chessground/types";
import { Box, Text, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { Score, ScoreValue } from "@/bindings";
import { getWinChance } from "@/utils/score";

function EvalBar({
  score,
  orientation: _orientation,
  turn: _turn,
  layout = "vertical",
  showWDL = false,
}: {
  score: Score | null;
  orientation: Color;
  turn?: Color;
  layout?: "vertical" | "horizontal";
  showWDL?: boolean;
}) {
  const { t } = useTranslation();

  // Always render the evaluation bar using pure black/white, regardless of theme.
  const blackColor = "#000";
  const whiteColor = "#fff";
  const drawColor = "#888";

  const isHorizontal = layout === "horizontal";

  // UCI scores are from the side-to-move perspective. Normalize to White POV so the bar doesn't
  // appear to invert every ply (a flip-board currently forces a redraw, which masked this).
  //
  // NOTE: In OCS, stored scores are already normalized to White POV across sources (engine/cloud/db).
  // Flipping by `turn` would incorrectly swap the bar colors every ply.
  const normalizedScore: ScoreValue | null = score?.value ?? null;
  const wdl = score?.wdl ?? null;
  const displayScore = normalizedScore
    ? t("units.score", { score: normalizedScore, formatParams: { score: { precision: 1 } } })
    : null;

  // Keep the numeric label readable regardless of theme by drawing it on a high-contrast pill.
  const labelBg = "rgba(0, 0, 0, 0.78)";
  const labelFg = "#fff";

  // `progress` is the White side share (0..100). On mobile (horizontal) White is left and Black is right.
  // On desktop (vertical) Black is above and White is below (to match the board's top=Black, bottom=White).
  const progress = normalizedScore
    ? normalizedScore.type === "cp"
      ? getWinChance(normalizedScore.value)
      : normalizedScore.value > 0
        ? 100
        : 0
    : 50;

  const wdlTotal = wdl ? wdl[0] + wdl[1] + wdl[2] : 0;
  const wdlWhite = wdlTotal > 0 && wdl ? (wdl[0] * 100) / wdlTotal : 0;
  const wdlDraw = wdlTotal > 0 && wdl ? (wdl[1] * 100) / wdlTotal : 0;
  const wdlBlack = wdlTotal > 0 && wdl ? (wdl[2] * 100) / wdlTotal : 0;
  const hasWdl = !!wdl && wdlTotal > 0;

  const ScoreBars = isHorizontal
    ? [
        <Box
          key="white"
          style={{
            height: "100%",
            width: `${progress}%`,
            backgroundColor: whiteColor,
            transition: "width 0.2s ease",
          }}
        />,
        <Box
          key="black"
          style={{
            height: "100%",
            width: `${100 - progress}%`,
            backgroundColor: blackColor,
            transition: "width 0.2s ease",
          }}
        />,
      ]
    : [
        <Box
          key="black"
          style={{
            height: `${100 - progress}%`,
            backgroundColor: blackColor,
            transition: "height 0.2s ease",
          }}
        />,
        <Box
          key="white"
          style={{
            height: `${progress}%`,
            backgroundColor: whiteColor,
            transition: "height 0.2s ease",
          }}
        />,
      ];

  const WdlBars = hasWdl
    ? isHorizontal
      ? [
          <Box
            key="wdl-white"
            style={{
              height: "100%",
              width: `${wdlWhite}%`,
              backgroundColor: whiteColor,
              transition: "width 0.2s ease",
            }}
          />,
          <Box
            key="wdl-draw"
            style={{
              height: "100%",
              width: `${wdlDraw}%`,
              backgroundColor: drawColor,
              transition: "width 0.2s ease",
            }}
          />,
          <Box
            key="wdl-black"
            style={{
              height: "100%",
              width: `${wdlBlack}%`,
              backgroundColor: blackColor,
              transition: "width 0.2s ease",
            }}
          />,
        ]
      : [
          <Box
            key="wdl-black"
            style={{
              height: `${wdlBlack}%`,
              backgroundColor: blackColor,
              transition: "height 0.2s ease",
            }}
          />,
          <Box
            key="wdl-draw"
            style={{
              height: `${wdlDraw}%`,
              backgroundColor: drawColor,
              transition: "height 0.2s ease",
            }}
          />,
          <Box
            key="wdl-white"
            style={{
              height: `${wdlWhite}%`,
              backgroundColor: whiteColor,
              transition: "height 0.2s ease",
            }}
          />,
        ]
    : null;

  // Keep the eval bar orientation stable:
  // - Vertical (desktop): Black is always above, White is always below.
  // - Horizontal (mobile): White is always left, Black is always right.

  const evalVerticalWidth = 38; // 25px * 1.5 = 37.5px (used when WDL bar is present)
  const evalVerticalWidthNoWDL = 30; // Width when WDL bar is not present
  const wdlVerticalWidth = 14;
  const totalVerticalWidth = showWDL ? evalVerticalWidth + wdlVerticalWidth + 3 : evalVerticalWidthNoWDL;
  const currentEvalWidth = showWDL ? evalVerticalWidth : evalVerticalWidthNoWDL;
  const horizontalHeight = "0.75rem"; // 0.5rem * 1.5 = 0.75rem
  const wdlHorizontalHeight = "0.5rem";
  const barsGap = 3;

  return (
    <Box
      style={{
        height: isHorizontal ? undefined : "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: 4,
      }}
    >
      <Box
        style={{
          width: isHorizontal ? "100%" : totalVerticalWidth,
          flex: isHorizontal ? undefined : 1,
          minHeight: 0,
          position: "relative",
          display: "flex",
          flexDirection: isHorizontal ? "column" : "row",
          alignItems: "stretch",
          gap: barsGap,
        }}
      >
        <Tooltip
          position={isHorizontal ? "top" : "right"}
          color={normalizedScore && normalizedScore.value < 0 ? "dark" : undefined}
          label={normalizedScore ? t("units.score", { score: normalizedScore }) : undefined}
          disabled={!normalizedScore}
        >
          <Box
            style={{
              flex: isHorizontal ? undefined : 3,
              width: isHorizontal ? "100%" : currentEvalWidth,
              height: isHorizontal ? horizontalHeight : "100%",
              minHeight: 0,
              display: "flex",
              flexDirection: isHorizontal ? "row" : "column",
              borderRadius: "var(--mantine-radius-xs)",
              overflow: "hidden",
              position: "relative",
            }}
          >
            {ScoreBars}
            {/* Midline divider (50/50) to make advantage direction obvious at a glance. */}
            <Box
              style={{
                position: "absolute",
                left: isHorizontal ? "50%" : 0,
                top: isHorizontal ? 0 : "50%",
                width: isHorizontal ? 1 : "100%",
                height: isHorizontal ? "100%" : 1,
                backgroundColor: "rgba(127,127,127,0.7)",
                transform: isHorizontal ? "translateX(-0.5px)" : "translateY(-0.5px)",
                pointerEvents: "none",
              }}
            />

            {/* Vertical layout (desktop): keep the label inside the bar so it doesn't get clipped. */}
            {!isHorizontal && displayScore && (
              <Box
                style={{
                  position: "absolute",
                  left: "50%",
                  ...(normalizedScore
                    ? normalizedScore.value > 0
                      ? ({ top: "calc(100% - 12px)" } as const) // White advantage => bottom
                      : normalizedScore.value < 0
                        ? ({ top: 12 } as const) // Black advantage => top
                        : { top: "50%" as const }
                    : { top: "50%" as const }),
                  transform: "translate(-50%, -50%)",
                  pointerEvents: "none",
                  zIndex: 2,
                }}
              >
                <Box
                  style={{
                    transform: "rotate(-90deg)",
                    transformOrigin: "center",
                    backgroundColor: labelBg,
                    borderRadius: 999,
                    padding: "2px 8px",
                    boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
                    border: "1px solid rgba(255,255,255,0.18)",
                    whiteSpace: "nowrap",
                  }}
                >
                  <Text fz={12} fw={700} ta="center" c={labelFg} style={{ lineHeight: 1.1, userSelect: "none" }}>
                    {displayScore}
                  </Text>
                </Box>
              </Box>
            )}
          </Box>
        </Tooltip>

        {showWDL && (
          <Tooltip
            position={isHorizontal ? "top" : "right"}
            label={
              hasWdl && wdl
                ? `${(wdl[0] / 10).toFixed(1)}% / ${(wdl[1] / 10).toFixed(1)}% / ${(wdl[2] / 10).toFixed(1)}%`
                : t("features.board.analysis.enableWDL")
            }
            disabled={hasWdl ? false : !normalizedScore}
          >
            <Box
              style={{
                flex: isHorizontal ? undefined : 1,
                width: isHorizontal ? "100%" : wdlVerticalWidth,
                height: isHorizontal ? wdlHorizontalHeight : "100%",
                minHeight: 0,
                display: "flex",
                flexDirection: isHorizontal ? "row" : "column",
                borderRadius: "var(--mantine-radius-xs)",
                overflow: "hidden",
                background: hasWdl
                  ? undefined
                  : "repeating-linear-gradient(45deg, rgba(127,127,127,0.35), rgba(127,127,127,0.35) 4px, rgba(127,127,127,0.15) 4px, rgba(127,127,127,0.15) 8px)",
                border: hasWdl ? undefined : "1px solid rgba(127,127,127,0.35)",
              }}
            >
              {WdlBars}
            </Box>
          </Tooltip>
        )}
      </Box>
    </Box>
  );
}

export default EvalBar;
