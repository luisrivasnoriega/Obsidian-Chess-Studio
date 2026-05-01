import { Box, rgba, useMantineTheme } from "@mantine/core";
import { IconBook, IconBookOff, IconFlag } from "@tabler/icons-react";
import { type ForwardedRef, forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { ANNOTATION_INFO, type Annotation } from "@/utils/annotation";
import * as classes from "./MoveCell.css";

interface MoveCellProps {
  annotations: Annotation[];
  isStart: boolean;
  isCurrentVariation: boolean;
  move: string;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

const MoveCell = forwardRef(function MoveCell(props: MoveCellProps, ref: ForwardedRef<HTMLButtonElement>) {
  const { t } = useTranslation();

  const color = ANNOTATION_INFO[props.annotations[0]]?.color || "gray";
  const theme = useMantineTheme();
  const hoverOpacity = props.isCurrentVariation ? 0.25 : 0.1;
  let baseLight = theme.colors.gray[8];
  let hoverLight = rgba(baseLight, hoverOpacity);
  let baseDark = theme.colors.gray[1];
  let hoverDark = rgba(baseDark, hoverOpacity);
  let darkBg = "transparent";
  let lightBg = "transparent";

  if (color !== "gray") {
    baseLight = theme.colors[color][6];
    hoverLight = rgba(baseLight, hoverOpacity);
    baseDark = theme.colors[color][6];
    hoverDark = rgba(baseDark, hoverOpacity);
  }

  if (props.isCurrentVariation) {
    darkBg = rgba(theme.colors[color][6], 0.2);
    lightBg = rgba(theme.colors[color][6], 0.2);
    hoverLight = rgba(lightBg, 0.25);
    hoverDark = rgba(darkBg, 0.25);
  }

  return (
    <Box
      ref={ref}
      component="button"
      className={classes.cell}
      style={{
        "--light-color": baseLight,
        "--light-hover-color": hoverLight,
        "--dark-color": baseDark,
        "--dark-hover-color": hoverDark,
        "--dark-bg": darkBg,
        "--light-bg": lightBg,
      }}
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
    >
      {props.isStart && <IconFlag style={{ marginRight: 5 }} size="0.875rem" />}
      {t("formatters.moveNotation", { move: props.move })}
      {props.annotations
        .filter((ann) => ann !== "Best") // Don't show "Best" as text, only as color
        .map((ann, idx) =>
          ann === "Book" ? (
            <IconBook key={`book-${idx}`} size="0.875rem" style={{ marginLeft: 3, verticalAlign: "text-bottom" }} />
          ) : ann === "BookUnknown" ? (
            <span
              key={`book-unknown-${idx}`}
              style={{
                marginLeft: 3,
                verticalAlign: "text-bottom",
                display: "inline-flex",
                alignItems: "center",
                color: "#F59E0B",
              }}
            >
              <IconBook size="0.875rem" />
              <span style={{ marginLeft: 1, fontSize: "0.625rem", fontWeight: 700 }}>?</span>
            </span>
          ) : ann === "BookError" ? (
            <IconBookOff
              key={`book-error-${idx}`}
              size="0.875rem"
              style={{ marginLeft: 3, verticalAlign: "text-bottom" }}
            />
          ) : (
            <span key={`${ann}-${idx}`}>{ann}</span>
          ),
        )}
    </Box>
  );
});

export default MoveCell;
