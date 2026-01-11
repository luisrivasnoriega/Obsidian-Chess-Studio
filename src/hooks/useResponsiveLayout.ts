import type { AppShellProps } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { type } from "@tauri-apps/plugin-os";
import { useMemo } from "react";
import { DEFAULT_THEME } from "@mantine/core";

// Platform types
export type Platform = "desktop" | "mobile" | "web";

// Get platform from Tauri OS plugin
export const getPlatform = (): Platform => {
  try {
    const osType = type();
    if (osType === "android" || osType === "ios") {
      return "mobile";
    }
    return "desktop";
  } catch {
    // If Tauri is not available (web), assume web platform
    return "web";
  }
};

export type MenuBarMode = "disabled" | "native" | "custom";
export type SideBarPosition = "navbar" | "footer";
export type PanelsType = "drawer" | "sidepanel";
export type DrawerPosition = "top" | "bottom";
export type LayoutType = "mobile" | "desktop";
export type DatabasesDensity = "compact" | "normal" | "comfortable";

type ResponsiveLayout = {
  // App shell configuration
  menuBar: {
    mode: MenuBarMode;
    displayWindowControls: boolean;
  };
  sidebar: {
    position: SideBarPosition;
  };
  appShellProps: AppShellProps;

  // Game-specific layout
  gameInfoCollapsedByDefault: boolean;
  gameNotationUnderBoard: boolean;

  // Panel configuration
  panels: {
    type: PanelsType;
    drawer: {
      position: DrawerPosition;
      size: string;
    };
  };

  // Feature-specific configurations
  settings: {
    layoutType: LayoutType;
  };
  databases: {
    density: DatabasesDensity;
    layoutType: LayoutType;
  };
  learn: {
    layoutType: LayoutType;
  };
  engines: {
    layoutType: LayoutType;
  };
  accounts: {
    layoutType: LayoutType;
  };
  files: {
    layoutType: LayoutType;
  };
  chessBoard: {
    layoutType: LayoutType;
    touchOptimized: boolean;
    maintainAspectRatio: boolean;
  };
};

// Performance metrics interface
interface PerformanceMetrics {
  calculationTime: number;
  lastCalculated: number;
}

export const useResponsiveLayout: () => {
  layout: ResponsiveLayout;
  headerOffset: string;
  footerOffset: string;
  mainContentHeight: string;
  performanceMetrics: PerformanceMetrics;
} = () => {
  const platform = getPlatform();
  const smallScreenMax = useMediaQuery(`(width < ${DEFAULT_THEME.breakpoints.sm})`);
  const mediumScreenMax = useMediaQuery(`(width < ${DEFAULT_THEME.breakpoints.md})`);
  const largeScreenMax = useMediaQuery(`(width < ${DEFAULT_THEME.breakpoints.lg})`);
  const extraLargeScreenMax = useMediaQuery(`(width < ${DEFAULT_THEME.breakpoints.xl})`);

  return useMemo(() => {
    const startTime = performance.now();

    // Layout configurations
    const useDrawerOnDesktop = false; // To use drawer on desktop regardless of screen size

    // Platform-specific mobile detection
    const isMobileOS = platform === "mobile";
    const isPhoneLayout = isMobileOS || smallScreenMax;
    const isTabletLayout = isMobileOS || mediumScreenMax;

    const menuBarMode: MenuBarMode = "custom";
    const sideBarPosition: SideBarPosition = isTabletLayout ? "footer" : "navbar";
    const panelsType: PanelsType = isTabletLayout || useDrawerOnDesktop ? "drawer" : "sidepanel";
    const drawerPosition: DrawerPosition = "bottom";
    const settingsLayoutType: LayoutType = isTabletLayout ? "mobile" : "desktop";
    const chessBoardLayoutType: LayoutType = isTabletLayout ? "mobile" : "desktop";

    const databasesDensity: DatabasesDensity = isTabletLayout
      ? "compact"
      : extraLargeScreenMax
        ? "comfortable"
        : "normal";
    const databasesLayoutType: LayoutType = isTabletLayout || largeScreenMax ? "mobile" : "desktop";
    const twoColumnLayoutType: LayoutType = isTabletLayout || largeScreenMax ? "mobile" : "desktop";

    // AppShell states
    // menuBarMode is always "custom", so header is never collapsed
    const isHeaderCollapsed = false;
    const isFooterCollapsed = sideBarPosition !== "footer";
    const isNavbarCollapsed = sideBarPosition !== "navbar";

    // Layout dimensions
    const headerHeight = isHeaderCollapsed
      ? "0rem"
      : isPhoneLayout
        ? "3.25rem"
        : isTabletLayout
          ? "3rem"
          : "2.6rem";
    const navbarWidth = isNavbarCollapsed ? "0rem" : "3rem";
    const footerHeight = isFooterCollapsed ? "0rem" : isPhoneLayout ? "3.75rem" : "3.25rem";
    const marginTop = isHeaderCollapsed && isPhoneLayout ? "3rem" : "0rem";

    // Calculated dimensions
    const headerOffset = !isHeaderCollapsed ? headerHeight : "0rem";
    const footerOffset = !isFooterCollapsed ? footerHeight : "0rem";
    const mainContentHeight = `calc(100vh - ${headerOffset} - ${footerOffset})`;
    const drawerContentSize = `calc(100vh - ${headerOffset} - ${marginTop})`;

    // Layout configurations
    const layout = {
      // App shell configuration
      menuBar: {
        mode: menuBarMode,
        displayWindowControls: !isTabletLayout,
      },
      sidebar: {
        position: sideBarPosition,
      },

      // AppShell configuration with CSS transitions
      appShellProps: {
        mt: marginTop,
        header: {
          height: headerHeight,
          collapsed: isHeaderCollapsed,
          offset: true,
        },
        navbar: {
          width: navbarWidth,
          breakpoint: "sm",
          collapsed: { desktop: false, mobile: true },
        },
        footer: {
          height: footerHeight,
          collapsed: isFooterCollapsed,
          offset: true,
        },
      },

      // Game-specific layout
      gameInfoCollapsedByDefault: isTabletLayout,
      gameNotationUnderBoard: isPhoneLayout,

      // Panel configuration
      panels: {
        type: panelsType,
        drawer: {
          position: drawerPosition,
          size: drawerContentSize,
        },
      },

      // Feature-specific configurations
      settings: {
        layoutType: settingsLayoutType,
      },
      databases: {
        density: databasesDensity,
        layoutType: databasesLayoutType,
      },
      learn: {
        layoutType: twoColumnLayoutType,
      },
      engines: {
        layoutType: twoColumnLayoutType,
      },
      accounts: {
        layoutType: twoColumnLayoutType,
      },
      files: {
        layoutType: twoColumnLayoutType,
      },
      chessBoard: {
        layoutType: chessBoardLayoutType,
        touchOptimized: isTabletLayout,
        maintainAspectRatio: true,
      },
    };

    // Performance metrics
    const endTime = performance.now();
    const performanceMetrics: PerformanceMetrics = {
      calculationTime: endTime - startTime,
      lastCalculated: endTime,
    };

    return {
      layout,
      headerOffset,
      footerOffset,
      mainContentHeight,
      performanceMetrics,
    };
  }, [platform, smallScreenMax, mediumScreenMax, extraLargeScreenMax, largeScreenMax]);
};
