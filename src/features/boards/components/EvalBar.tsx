import type { Color } from "@lichess-org/chessground/types";
import { Box, Text, Tooltip, useMantineTheme } from "@mantine/core";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import type { ScoreValue } from "@/bindings";
import { currentThemeIdAtom } from "@/features/themes/state/themeAtoms";
import { getWinChance } from "@/utils/score";

function EvalBar({
  score,
  orientation,
  layout = "vertical",
}: {
  score: ScoreValue | null;
  orientation: Color;
  layout?: "vertical" | "horizontal";
}) {
  const theme = useMantineTheme();
  const { t } = useTranslation();
  const currentThemeId = useAtomValue(currentThemeIdAtom);

  // Colors for Academia Maya theme - more contrasting
  const isAcademiaMaya = currentThemeId === "academia-maya";
  const blackColor = isAcademiaMaya ? theme.black : theme.colors.dark[4];
  const whiteColor = isAcademiaMaya ? theme.white : theme.colors.gray[2];
  const blackTextColor = isAcademiaMaya ? theme.white : theme.colors.gray[2];
  const whiteTextColor = isAcademiaMaya ? theme.black : theme.colors.dark[8];

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

  if (score) {
    const progress = score.type === "cp" ? getWinChance(score.value) : score.value > 0 ? 100 : 0;

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
            {score.value <= 0 && t("units.score", { score, precision: 1 }).replace(/\+|-/, "")}
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
            {score.value > 0 && t("units.score", { score, precision: 1 }).slice(1)}
          </Text>
        )}
      </Box>,
    ];
  }

  if (orientation === "black") {
    ScoreBars = ScoreBars?.reverse();
  }

  return (
    <Tooltip
      position={isHorizontal ? "top" : "right"}
      color={score && score.value < 0 ? "dark" : undefined}
      label={score ? t("units.score", { score }) : undefined}
      disabled={!score}
    >
      <Box
        style={{
          width: isHorizontal ? "100%" : 25,
          height: isHorizontal ? "0.5rem" : "100%",
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
