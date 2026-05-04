import type { CSSProperties } from "react";

export const PREMIUM_BORDER_COLOR = "color-mix(in srgb, var(--mantine-color-blue-8) 18%, var(--mantine-color-dark-4))";

export const premiumKpiCardStyle: CSSProperties = {
  background:
    "radial-gradient(110% 165% at 100% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 16%, transparent) 0%, transparent 62%), linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-7) 84%, var(--mantine-color-dark-5) 16%), var(--mantine-color-dark-7))",
  borderColor: PREMIUM_BORDER_COLOR,
  minHeight: 104,
};

export const premiumPanelStyle: CSSProperties = {
  background:
    "radial-gradient(120% 170% at 100% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 20%, transparent) 0%, transparent 58%), linear-gradient(160deg, color-mix(in srgb, var(--mantine-color-dark-7) 88%, var(--mantine-color-dark-5) 12%), var(--mantine-color-dark-7))",
  borderColor: PREMIUM_BORDER_COLOR,
};

export const premiumMutedPanelStyle: CSSProperties = {
  background:
    "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-7) 90%, var(--mantine-color-dark-5) 10%), var(--mantine-color-dark-7))",
  borderColor: "color-mix(in srgb, var(--mantine-color-blue-8) 12%, var(--mantine-color-dark-4))",
};

export const premiumTabListStyle: CSSProperties = {
  background:
    "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-8) 94%, var(--mantine-color-blue-9) 6%), color-mix(in srgb, var(--mantine-color-dark-8) 96%, var(--mantine-color-blue-8) 4%))",
  border: "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 16%, var(--mantine-color-dark-4))",
  borderRadius: 10,
  padding: 4,
};

export const premiumActionButtonStyles = {
  root: {
    minHeight: 30,
    paddingInline: 12,
  },
};
