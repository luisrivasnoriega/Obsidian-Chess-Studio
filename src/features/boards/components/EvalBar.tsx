import type { Color } from "@lichess-org/chessground/types";
import { Box, Text, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { ScoreValue } from "@/bindings";
import { getWinChance } from "@/utils/score";

function EvalBar({
  score,
  orientation,
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
  const blackTextColor = "#fff";
  const whiteTextColor = "#000";

  const isHorizontal = layout === "horizontal";

  // UCI scores are from the side-to-move perspective. Normalize to White POV so the bar doesn't
  // appear to invert every ply (a flip-board currently forces a redraw, which masked this).
  //
  // NOTE: In OCS, stored scores are already normalized to White POV across sources (engine/cloud/db).
  // Flipping by `turn` would incorrectly swap the bar colors every ply.
  const normalizedScore: ScoreValue | null = score;
  const displayScore = normalizedScore ? t("units.score", { score: normalizedScore, precision: 1 }) : null;

  // `progress` is the White side share (0..100). On mobile (horizontal) White is left and Black is right.
  // On desktop (vertical) Black is above and White is below (to match the board's top=Black, bottom=White).
  const progress = normalizedScore
    ? normalizedScore.type === "cp"
      ? getWinChance(normalizedScore.value)
      : normalizedScore.value > 0
        ? 100
        : 0
    : 50;

  let ScoreBars = isHorizontal
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

  // For the vertical eval bar, mirror the bar when the board is flipped.
  // For the horizontal (mobile) bar, keep White on the left and Black on the right.
  if (!isHorizontal && orientation === "black") {
    ScoreBars = ScoreBars?.reverse();
  }

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
      {displayScore && (
        <Text
          fz={isHorizontal ? "xs" : 10}
          fw={600}
          ta="center"
          c={normalizedScore && normalizedScore.value < 0 ? blackTextColor : whiteTextColor}
          style={{ lineHeight: 1, userSelect: "none" }}
        >
          {displayScore}
        </Text>
      )}
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
            display: "flex",
            flexDirection: isHorizontal ? "row" : "column",
            borderRadius: "var(--mantine-radius-xs)",
            overflow: "hidden",
          }}
        >
          {ScoreBars}
        </Box>
      </Tooltip>
    </Box>
  );
}

export default EvalBar;
