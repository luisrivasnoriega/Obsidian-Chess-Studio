import { style } from "@vanilla-extract/css";
import { DEFAULT_THEME } from "@mantine/core";
import { vars } from "@/styles/theme";

export const tab = style({
  cursor: "unset",
  paddingLeft: "0.6rem",
  paddingRight: 9,
  marginRight: 5,
  "@media": {
    [`(width < ${DEFAULT_THEME.breakpoints.md})`]: {
      paddingLeft: "0.45rem",
      paddingRight: 6,
      marginRight: 3,
    },
    [`(width < ${DEFAULT_THEME.breakpoints.sm})`]: {
      paddingLeft: "0.35rem",
      paddingRight: 4,
      marginRight: 2,
    },
  },
  [vars.lightSelector]: {
    backgroundColor: "transparent",
    color: vars.colors.gray[9],
  },
  [vars.darkSelector]: {
    backgroundColor: vars.colors.dark[7],
    color: vars.colors.gray[4],
  },
  ":hover": {
    [vars.lightSelector]: {
      backgroundColor: vars.colors.gray[2],
    },
    [vars.darkSelector]: {
      backgroundColor: vars.colors.dark[6],
    },
  },
});

export const selected = style({
  [vars.lightSelector]: {
    backgroundColor: vars.colors.gray[0],
    color: vars.colors.gray[9],
  },
  [vars.darkSelector]: {
    backgroundColor: vars.colors.dark[6],
    color: vars.colors.gray[0],
  },
});

export const input = style({
  minWidth: "5rem",
  maxWidth: "14rem",
  fontSize: "0.8rem",
  paddingTop: "0.4rem",
  paddingBottom: "0.4rem",
  outline: "none",
  textAlign: "start",
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  "@media": {
    [`(width < ${DEFAULT_THEME.breakpoints.md})`]: {
      maxWidth: "10rem",
      fontSize: "0.75rem",
      paddingTop: "0.3rem",
      paddingBottom: "0.3rem",
    },
    [`(width < ${DEFAULT_THEME.breakpoints.sm})`]: {
      maxWidth: "8rem",
      fontSize: "0.7rem",
      paddingTop: "0.25rem",
      paddingBottom: "0.25rem",
    },
  },
});

export const closeTabBtn = style({
  boxSizing: "content-box",
  padding: "0.3rem",
  transition: "background-color 100ms ease",
  "@media": {
    [`(width < ${DEFAULT_THEME.breakpoints.md})`]: {
      padding: "0.2rem",
    },
  },
  ":hover": {
    backgroundColor: "rgba(255, 255, 255, 0.1)",
  },
});

export const flash = style({
  animation: "tab-flash 2s ease-in-out !important",
  position: "relative",
  zIndex: "1000 !important",
});

export const flashDark = style({
  animation: "tab-flash-dark 2s ease-in-out !important",
  position: "relative",
  zIndex: "1000 !important",
});

// Inject keyframes once - we'll create separate animations for dark and light
if (typeof document !== "undefined" && !document.getElementById("tab-flash-keyframes")) {
  const styleSheet = document.createElement("style");
  styleSheet.id = "tab-flash-keyframes";
  styleSheet.textContent = `
    @keyframes tab-flash {
      0% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 0, 150, 0) !important;
        backgroundColor: transparent !important;
      }
      8% {
        transform: scale(1.18) !important;
        boxShadow: 0 0 40px 12px rgba(255, 0, 150, 1), 0 0 60px 20px rgba(255, 100, 200, 0.8) !important;
        backgroundColor: rgba(255, 0, 150, 1) !important;
      }
      16% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 0, 150, 0) !important;
        backgroundColor: transparent !important;
      }
      24% {
        transform: scale(1.15) !important;
        boxShadow: 0 0 35px 10px rgba(255, 0, 150, 1), 0 0 50px 15px rgba(255, 100, 200, 0.7) !important;
        backgroundColor: rgba(255, 0, 150, 1) !important;
      }
      32% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 0, 150, 0) !important;
        backgroundColor: transparent !important;
      }
      40% {
        transform: scale(1.12) !important;
        boxShadow: 0 0 30px 8px rgba(255, 0, 150, 1), 0 0 45px 12px rgba(255, 100, 200, 0.6) !important;
        backgroundColor: rgba(255, 0, 150, 0.95) !important;
      }
      48% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 0, 150, 0) !important;
        backgroundColor: transparent !important;
      }
      56% {
        transform: scale(1.1) !important;
        boxShadow: 0 0 25px 6px rgba(255, 0, 150, 0.95), 0 0 35px 10px rgba(255, 100, 200, 0.5) !important;
        backgroundColor: rgba(255, 0, 150, 0.9) !important;
      }
      64% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 0, 150, 0) !important;
        backgroundColor: transparent !important;
      }
      72% {
        transform: scale(1.08) !important;
        boxShadow: 0 0 20px 5px rgba(255, 0, 150, 0.9), 0 0 30px 8px rgba(255, 100, 200, 0.4) !important;
        backgroundColor: rgba(255, 0, 150, 0.85) !important;
      }
      80% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 0, 150, 0) !important;
        backgroundColor: transparent !important;
      }
      88% {
        transform: scale(1.05) !important;
        boxShadow: 0 0 15px 4px rgba(255, 0, 150, 0.8), 0 0 25px 6px rgba(255, 100, 200, 0.3) !important;
        backgroundColor: rgba(255, 0, 150, 0.75) !important;
      }
      96% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 0, 150, 0) !important;
        backgroundColor: transparent !important;
      }
      100% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 0, 150, 0) !important;
        backgroundColor: transparent !important;
      }
    }
    
    @keyframes tab-flash-dark {
      0% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 255, 255, 0) !important;
        backgroundColor: transparent !important;
      }
      8% {
        transform: scale(1.18) !important;
        boxShadow: 0 0 40px 12px rgba(255, 255, 255, 1), 0 0 60px 20px rgba(255, 255, 255, 0.9) !important;
        backgroundColor: rgba(255, 255, 255, 1) !important;
      }
      16% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 255, 255, 0) !important;
        backgroundColor: transparent !important;
      }
      24% {
        transform: scale(1.15) !important;
        boxShadow: 0 0 35px 10px rgba(255, 255, 255, 1), 0 0 50px 15px rgba(255, 255, 255, 0.8) !important;
        backgroundColor: rgba(255, 255, 255, 1) !important;
      }
      32% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 255, 255, 0) !important;
        backgroundColor: transparent !important;
      }
      40% {
        transform: scale(1.12) !important;
        boxShadow: 0 0 30px 8px rgba(255, 255, 255, 1), 0 0 45px 12px rgba(255, 255, 255, 0.7) !important;
        backgroundColor: rgba(255, 255, 255, 0.95) !important;
      }
      48% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 255, 255, 0) !important;
        backgroundColor: transparent !important;
      }
      56% {
        transform: scale(1.1) !important;
        boxShadow: 0 0 25px 6px rgba(255, 255, 255, 0.95), 0 0 35px 10px rgba(255, 255, 255, 0.6) !important;
        backgroundColor: rgba(255, 255, 255, 0.9) !important;
      }
      64% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 255, 255, 0) !important;
        backgroundColor: transparent !important;
      }
      72% {
        transform: scale(1.08) !important;
        boxShadow: 0 0 20px 5px rgba(255, 255, 255, 0.9), 0 0 30px 8px rgba(255, 255, 255, 0.5) !important;
        backgroundColor: rgba(255, 255, 255, 0.85) !important;
      }
      80% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 255, 255, 0) !important;
        backgroundColor: transparent !important;
      }
      88% {
        transform: scale(1.05) !important;
        boxShadow: 0 0 15px 4px rgba(255, 255, 255, 0.8), 0 0 25px 6px rgba(255, 255, 255, 0.4) !important;
        backgroundColor: rgba(255, 255, 255, 0.75) !important;
      }
      96% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 255, 255, 0) !important;
        backgroundColor: transparent !important;
      }
      100% {
        transform: scale(1) !important;
        boxShadow: 0 0 0 0 rgba(255, 255, 255, 0) !important;
        backgroundColor: transparent !important;
      }
    }
    
  `;
  document.head.appendChild(styleSheet);
}
