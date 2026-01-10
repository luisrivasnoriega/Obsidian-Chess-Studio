import { style } from "@vanilla-extract/css";
import { DEFAULT_THEME } from "@mantine/core";
import { vars } from "@/styles/theme";

export const link = style({
  width: "3rem",
  height: "3rem",
  display: "flex",
  alignItems: "center",
  borderRadius: vars.radius.md,
  "@media": {
    [`(width < ${DEFAULT_THEME.breakpoints.md})`]: {
      width: "2.75rem",
      height: "2.75rem",
    },
    [`(width < ${DEFAULT_THEME.breakpoints.sm})`]: {
      width: "2.5rem",
      height: "2.5rem",
    },
  },
  justifyContent: "center",
  selectors: {
    '&[data-position="navbar"]': {
      borderLeft: "3px solid transparent",
      borderRight: "3px solid transparent",
    },
    '&[data-position="footer"]': {
      borderTop: "3px solid transparent",
    },
  },
  [vars.lightSelector]: {
    color: vars.colors.gray[7],
  },
  [vars.darkSelector]: {
    color: vars.colors.dark[0],
  },

  ":hover": {
    [vars.lightSelector]: {
      color: vars.colors.dark[5],
      backgroundColor: vars.colors.gray[0],
    },
    [vars.darkSelector]: {
      color: vars.colors.gray[0],
      backgroundColor: vars.colors.dark[6],
    },
  },
});

export const active = style({
  [vars.lightSelector]: {
    color: vars.colors.dark[5],
  },
  [vars.darkSelector]: {
    color: vars.colors.white,
  },

  selectors: {
    '&[data-position="navbar"]': {
      borderLeftColor: vars.colors.primary,
    },
    '&[data-position="footer"]': {
      borderTopColor: vars.colors.primary,
    },
  },
});
