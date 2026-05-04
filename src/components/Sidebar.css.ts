import { DEFAULT_THEME } from "@mantine/core";
import { style } from "@vanilla-extract/css";
import { vars } from "@/styles/theme";

export const container = style({
  height: "100%",
  paddingTop: "0.5rem",
  paddingBottom: "0.25rem",
  paddingLeft: "0.35rem",
  paddingRight: "0.35rem",
  transition: "padding 160ms ease",
  selectors: {
    "&[data-expanded='true']": {
      paddingLeft: "0.5rem",
      paddingRight: "0.5rem",
    },
  },
});

export const sectionTitle = style({
  paddingLeft: "0.75rem",
  paddingRight: "0.5rem",
  paddingTop: "0.35rem",
  paddingBottom: "0.2rem",
  fontSize: "0.62rem",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  fontWeight: 700,
  whiteSpace: "nowrap",
  [vars.lightSelector]: {
    color: vars.colors.gray[6],
  },
  [vars.darkSelector]: {
    color: vars.colors.dark[2],
  },
});

export const sectionDivider = style({
  width: "100%",
  height: "1px",
  marginTop: "0.45rem",
  marginBottom: "0.25rem",
  [vars.darkSelector]: {
    background:
      "linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--mantine-color-blue-8) 22%, var(--mantine-color-dark-4)) 24%, color-mix(in srgb, var(--mantine-color-blue-8) 22%, var(--mantine-color-dark-4)) 76%, transparent 100%)",
  },
  [vars.lightSelector]: {
    background:
      "linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--mantine-color-blue-4) 20%, var(--mantine-color-gray-3)) 24%, color-mix(in srgb, var(--mantine-color-blue-4) 20%, var(--mantine-color-gray-3)) 76%, transparent 100%)",
  },
});

export const iconWrap = style({
  minWidth: "1.75rem",
  width: "1.75rem",
  height: "1.75rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
});

export const linkLabel = style({
  fontSize: "0.82rem",
  fontWeight: 600,
  lineHeight: 1,
  letterSpacing: "0.01em",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

export const link = style({
  appearance: "none",
  width: "3rem",
  height: "3rem",
  maxWidth: "100%",
  display: "flex",
  alignItems: "center",
  gap: "0.55rem",
  paddingLeft: "0.55rem",
  paddingRight: "0.55rem",
  borderRadius: vars.radius.md,
  border: "1px solid transparent",
  background: "transparent",
  cursor: "pointer",
  transition: "all 160ms ease",
  "@media": {
    [`(width < ${DEFAULT_THEME.breakpoints.md})`]: {
      width: "2.75rem",
      height: "2.75rem",
      paddingLeft: "0.45rem",
      paddingRight: "0.45rem",
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
    "&[data-expanded='true']": {
      width: "100%",
      justifyContent: "flex-start",
      borderRightWidth: "1px",
      borderRightStyle: "solid",
      borderRightColor: "transparent",
      borderLeftWidth: "1px",
      borderLeftStyle: "solid",
      borderLeftColor: "transparent",
    },
  },
  [vars.lightSelector]: {
    color: vars.colors.gray[7],
    backgroundColor: "transparent",
  },
  [vars.darkSelector]: {
    color: vars.colors.dark[0],
    backgroundColor: "transparent",
  },

  ":hover": {
    [vars.lightSelector]: {
      color: vars.colors.dark[5],
      backgroundColor: "color-mix(in srgb, var(--mantine-color-blue-1) 42%, var(--mantine-color-gray-0))",
    },
    [vars.darkSelector]: {
      color: vars.colors.gray[0],
      backgroundColor: "color-mix(in srgb, var(--mantine-color-blue-9) 18%, var(--mantine-color-dark-6))",
    },
  },
});

export const active = style({
  [vars.lightSelector]: {
    color: vars.colors.dark[5],
    background:
      "linear-gradient(96deg, color-mix(in srgb, var(--mantine-color-blue-2) 62%, transparent) 0%, color-mix(in srgb, var(--mantine-color-cyan-2) 48%, transparent) 100%)",
  },
  [vars.darkSelector]: {
    color: vars.colors.white,
    background:
      "linear-gradient(96deg, color-mix(in srgb, var(--mantine-color-blue-8) 34%, transparent) 0%, color-mix(in srgb, var(--mantine-color-cyan-8) 18%, transparent) 100%)",
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

export const toggleLink = style({
  marginBottom: "0.2rem",
  selectors: {
    "&[data-expanded='true']": {
      boxShadow: "0 8px 22px -18px var(--mantine-color-blue-7)",
    },
  },
  [vars.lightSelector]: {
    background:
      "linear-gradient(96deg, color-mix(in srgb, var(--mantine-color-blue-1) 70%, transparent) 0%, color-mix(in srgb, var(--mantine-color-cyan-1) 56%, transparent) 100%)",
    borderColor: "color-mix(in srgb, var(--mantine-color-blue-4) 45%, transparent)",
  },
  [vars.darkSelector]: {
    background:
      "linear-gradient(96deg, color-mix(in srgb, var(--mantine-color-blue-9) 42%, transparent) 0%, color-mix(in srgb, var(--mantine-color-cyan-9) 30%, transparent) 100%)",
    borderColor: "color-mix(in srgb, var(--mantine-color-blue-6) 38%, transparent)",
  },
});
