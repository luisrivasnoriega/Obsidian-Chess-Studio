import { globalStyle, style } from "@vanilla-extract/css";
import { vars } from "@/styles/theme";

export const subtitle = style({
  [vars.lightSelector]: {
    color: vars.colors.black,
  },
  [vars.darkSelector]: {
    color: vars.colors.gray[5],
  },
});

export const planMarkdownRoot = style({
  fontSize: "0.875rem",
  lineHeight: 1.5,
  wordBreak: "break-word",
  whiteSpace: "pre-wrap",
});

globalStyle(`${planMarkdownRoot} p`, {
  margin: "0 0 0.45rem 0",
});

globalStyle(`${planMarkdownRoot} ul, ${planMarkdownRoot} ol`, {
  margin: "0.25rem 0 0.5rem 1.2rem",
  padding: 0,
});

globalStyle(`${planMarkdownRoot} li`, {
  margin: "0.2rem 0",
});

globalStyle(`${planMarkdownRoot} li > p`, {
  margin: 0,
});

globalStyle(`${planMarkdownRoot} li > ul, ${planMarkdownRoot} li > ol`, {
  marginTop: "0.2rem",
  marginBottom: "0.35rem",
});
