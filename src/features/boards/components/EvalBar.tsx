import type { Color } from "@lichess-org/chessground/types";
import { Box, Text, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { ScoreValue } from "@/bindings";
import { getWinChance } from "@/utils/score";

function EvalBar({
  score,
  orientation: _orientation,
  turn: _turn,
  layout = "vertical",
}: {
  score: ScoreValue | null;
  orientation: Color;
  turn?: Color;
  layout?: "vertical" | "horizontal";
}) {
  const { t } = useTranslation();

  // Always render the evaluation bar using pure black/white, regardless of theme.
  const blackColor = "#000";
  const whiteColor = "#fff";
  const _blackTextColor = "#fff";
  const _whiteTextColor = "#000";

  const isHorizontal = layout === "horizontal";

  // UCI scores are from the side-to-move perspective. Normalize to White POV so the bar doesn't
  // appear to invert every ply (a flip-board currently forces a redraw, which masked this).
  //
  // NOTE: In OCS, stored scores are already normalized to White POV across sources (engine/cloud/db).
  // Flipping by `turn` would incorrectly swap the bar colors every ply.
  const normalizedScore: ScoreValue | null = score;
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

  // Keep the eval bar orientation stable:
  // - Vertical (desktop): Black is always above, White is always below.
  // - Horizontal (mobile): White is always left, Black is always right.

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
      <Tooltip
        position={isHorizontal ? "top" : "right"}
        color={normalizedScore && normalizedScore.value < 0 ? "dark" : undefined}
        label={normalizedScore ? t("units.score", { score: normalizedScore }) : undefined}
        disabled={!normalizedScore}
      >
        <Box
          style={{
            width: isHorizontal ? "100%" : 25,
            height: isHorizontal ? "0.5rem" : undefined,
            flex: isHorizontal ? undefined : 1,
            minHeight: 0,
            position: "relative",
            overflow: "visible",
          }}
        >
          <Box
            style={{
              width: "100%",
              height: "100%",
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
          </Box>

          {/*
            Vertical layout (desktop): we only have 25px width and the parent container clips overflow.
            Render a rotated pill *inside* the bar area so it can’t get clipped.
          */}
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
                <Text fz={10} fw={700} ta="center" c={labelFg} style={{ lineHeight: 1.1, userSelect: "none" }}>
                  {displayScore}
                </Text>
              </Box>
            </Box>
          )}
        </Box>
      </Tooltip>
    </Box>
  );
}

export default EvalBar;
