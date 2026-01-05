import { style } from "@vanilla-extract/css";

export const linearGradientProps = {
  id: "ratings-gradient",
  x1: 0,
  y1: 0,
  x2: 0,
  y2: 1,
};

export const gradientStops = [
  { offset: "0%", stopColor: "var(--mantine-color-blue-filled)", stopOpacity: 0.65 },
  { offset: "100%", stopColor: "var(--mantine-color-blue-filled)", stopOpacity: 0.15 },
];

export const tooltipContentStyle = {
  backgroundColor: "var(--mantine-color-dark-7)",
  border: "1px solid var(--mantine-color-dark-4)",
  borderRadius: "var(--mantine-radius-sm)",
  color: "var(--mantine-color-white)",
  fontSize: "0.75rem",
};

export const tooltipCursorStyle = {
  stroke: "var(--mantine-color-dark-4)",
  strokeWidth: 1,
};

export const link = style({
  cursor: "pointer",
  ":hover": {
    textDecoration: "underline",
  },
});
