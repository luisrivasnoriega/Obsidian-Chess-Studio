import { style } from "@vanilla-extract/css";
import { vars } from "@/styles/theme";

export const card = style({
  cursor: "pointer",
  borderStyle: "solid",
  padding: "1rem",
  borderRadius: vars.radius.md,
  borderWidth: 2,
  borderColor: "transparent",

  [vars.lightSelector]: {
    backgroundColor: vars.colors.white,
    borderColor: vars.colors.gray[1],
  },
  [vars.darkSelector]: {
    backgroundColor: vars.colors.dark[6],
  },
  ":hover": {
    [vars.lightSelector]: {
      backgroundColor: vars.colors.gray[0],
      borderColor: vars.colors.gray[3],
    },
    [vars.darkSelector]: {
      backgroundColor: vars.colors.dark[6],
      borderColor: vars.colors.gray[6],
    },
  },
});

export const label = style({
  marginBottom: vars.spacing.xs,
  lineHeight: 1,
  fontWeight: 700,
  fontSize: vars.fontSizes.xs,
  letterSpacing: -0.25,
  textTransform: "uppercase",
});

export const error = style({
  borderColor: `${vars.colors.red[6]} !important`,
  borderWidth: 1,

  ":hover": {
    borderColor: vars.colors.red[6],
  },
});

export const selected = style({
  borderColor: "var(--mantine-primary-color-filled) !important",

  ":hover": {
    borderColor: "var(--mantine-primary-color-filled)",
  },
});

export const premium = style({
  borderRadius: vars.radius.lg,
  borderWidth: 1,
  borderColor: "color-mix(in srgb, var(--mantine-color-blue-8) 16%, var(--mantine-color-dark-4))",
  background:
    "radial-gradient(110% 165% at 100% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 16%, transparent) 0%, transparent 62%), linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-7) 84%, var(--mantine-color-dark-5) 16%), var(--mantine-color-dark-7))",
  transition: "border-color 120ms ease, transform 120ms ease",
  ":hover": {
    transform: "translateY(-1px)",
    borderColor: "color-mix(in srgb, var(--mantine-color-blue-7) 28%, var(--mantine-color-dark-4))",
  },
});
