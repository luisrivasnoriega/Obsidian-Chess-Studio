import type { Color } from "@lichess-org/chessground/types";
import { Box, Text, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { ScoreValue } from "@/bindings";
import { getWinChance } from "@/utils/score";

function EvalBar({
  score,
  orientation,
  turn,
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
  let ScoreBars = [
    <Box
      key="black"
      style={{
        height: isHorizontal ? "100%" : "100%",
        width: isHorizontal ? "100%" : undefined,
        backgroundColor: blackColor,
        transition: isHorizontal ? "width 0.2s ease" : "height 0.2s ease",
        display: "flex",
        flexDirection: isHorizontal ? "row" : "column",
      }}
    />,
  ];

  // UCI scores are from the side-to-move perspective. Normalize to White POV so the bar doesn't
  // appear to invert every ply (a flip-board currently forces a redraw, which masked this).
  const normalizedScore: ScoreValue | null =
    score && turn ? ({ ...score, value: score.value * (turn === "black" ? -1 : 1) } as ScoreValue) : score;

  if (normalizedScore) {
    const progress =
      normalizedScore.type === "cp" ? getWinChance(normalizedScore.value) : normalizedScore.value > 0 ? 100 : 0;

    ScoreBars = [
      <Box
        key="black"
        style={{
          height: isHorizontal ? "100%" : `${100 - progress}%`,
          width: isHorizontal ? `${100 - progress}%` : undefined,
          backgroundColor: blackColor,
          transition: isHorizontal ? "width 0.2s ease" : "height 0.2s ease",
          display: "flex",
          flexDirection: isHorizontal ? "row" : "column",
        }}
      >
        {!isHorizontal && (
          <Text fz="xs" c={blackTextColor} ta="center" py={3} mt={orientation === "black" ? "auto" : undefined}>
            {normalizedScore.value <= 0 &&
              t("units.score", { score: normalizedScore, precision: 1 }).replace(/\+|-/, "")}
          </Text>
        )}
      </Box>,
      <Box
        key="white"
        style={{
          height: isHorizontal ? "100%" : `${progress}%`,
          width: isHorizontal ? `${progress}%` : undefined,
          backgroundColor: whiteColor,
          transition: isHorizontal ? "width 0.2s ease" : "height 0.2s ease",
          display: "flex",
          flexDirection: isHorizontal ? "row" : "column",
        }}
      >
        {!isHorizontal && (
          <Text fz="xs" py={3} c={whiteTextColor} ta="center" mt={orientation === "white" ? "auto" : undefined}>
            {normalizedScore.value > 0 && t("units.score", { score: normalizedScore, precision: 1 }).slice(1)}
          </Text>
        )}
      </Box>,
    ];
  }

  // For the vertical eval bar, we mirror the bar when the board is flipped.
  // For the horizontal (mobile) bar, keep black on the left and white on the right.
  if (!isHorizontal && orientation === "black") {
    ScoreBars = ScoreBars?.reverse();
  }

  return (
    <Tooltip
      position={isHorizontal ? "top" : "right"}
      color={normalizedScore && normalizedScore.value < 0 ? "dark" : undefined}
      label={normalizedScore ? t("units.score", { score: normalizedScore }) : undefined}
      disabled={!normalizedScore}
    >
      <Box
        style={{
          width: isHorizontal ? "100%" : 25,
          height: isHorizontal ? "0.5rem" : "100%",
          display: "flex",
          flexDirection: isHorizontal ? "row" : "column",
          borderRadius: "var(--mantine-radius-xs)",
          overflow: "hidden",
        }}
      >
        {ScoreBars}
      </Box>
    </Tooltip>
  );
}

export default EvalBar;
