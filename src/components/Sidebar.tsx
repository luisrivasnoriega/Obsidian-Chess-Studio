import { AppShellSection, Group, Stack, Tooltip } from "@mantine/core";
import type { IconProps } from "@tabler/icons-react";
import {
  IconCalendarEvent,
  IconChartLine,
  IconCpu,
  IconDatabase,
  IconGitBranch,
  IconKeyboard,
  IconLayoutDashboard,
  IconPlayerPlay,
  IconPuzzle,
  IconSettings,
  IconUserCircle,
} from "@tabler/icons-react";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import cx from "clsx";
import { useAtom } from "jotai";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import LichessLogo from "@/features/profiles/components/LichessLogo";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { createTab, type Tab } from "@/utils/tabs";
import * as classes from "./Sidebar.css";

type SidebarIcon = ComponentType<IconProps>;

interface NavbarLinkProps {
  icon: SidebarIcon;
  label: string;
  url: string;
  onClick?: () => void;
}

function NavbarLink({ url, icon: Icon, label, onClick }: NavbarLinkProps) {
  const matchesRoute = useMatchRoute();
  const { layout } = useResponsiveLayout();
  const isFooter = layout.sidebar.position === "footer";
  const isActive = matchesRoute({ to: url, fuzzy: url !== "/" });
  return (
    <Tooltip label={label} position={isFooter ? "top" : "right"}>
      <button
        type="button"
        onClick={onClick}
        className={cx(classes.link, {
          [classes.active]: isActive,
        })}
        data-position={isFooter ? "footer" : "navbar"}
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
      >
        <Icon size={isFooter ? "1.8rem" : "1.5rem"} stroke={1.5} />
      </button>
    </Tooltip>
  );
}

const LichessSideIcon: SidebarIcon = ({ size }) => {
  const resolvedSize = typeof size === "number" ? `${size}px` : (size ?? "1.5rem");
  return (
    <div
      style={{
        width: resolvedSize,
        height: resolvedSize,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <LichessLogo
        style={{
          width: resolvedSize,
          height: resolvedSize,
          fill: "currentColor",
          stroke: "none",
          transform: "scale(0.92)",
          transformOrigin: "center",
          display: "block",
        }}
      />
    </div>
  );
};

function MayaActionLink({
  icon: Icon,
  label,
  onClick,
}: {
  icon: SidebarIcon;
  label: string;
  onClick: (e?: React.MouseEvent) => void;
}) {
  const { layout } = useResponsiveLayout();
  const isFooter = layout.sidebar.position === "footer";

  return (
    <Tooltip label={label} position={isFooter ? "top" : "right"}>
      <button
        type="button"
        onClick={onClick}
        className={cx(classes.link)}
        data-position={isFooter ? "footer" : "navbar"}
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
      >
        <Icon size={isFooter ? "1.8rem" : "1.5rem"} stroke={1.5} />
      </button>
    </Tooltip>
  );
}

// Sección principal (uso diario)
const primaryLinks = [
  { icon: IconLayoutDashboard, label: "dashboard", url: "/" },
  { icon: IconUserCircle, label: "profiles", url: "/profiles" },
  { icon: IconCalendarEvent, label: "events", url: "/events" },
];

// Sección secundaria (uso regular)
const secondaryLinksData = [
  { icon: IconDatabase, label: "databases", url: "/databases" },
  { icon: IconCpu, label: "engines", url: "/engines" },
  { icon: IconGitBranch, label: "variants", url: "/variants" },
];

// Sección terciaria (configuración/avanzado)
const tertiaryLinksData = [{ icon: LichessSideIcon, label: "tournaments", url: "/tournaments" }];

const mobileFooterLinks: Array<{ icon: SidebarIcon; labelKey: string; url: string }> = [
  { icon: IconLayoutDashboard, labelKey: "features.sidebar.dashboard", url: "/" },
  { icon: IconUserCircle, labelKey: "features.sidebar.profiles", url: "/profiles" },
  { icon: IconCalendarEvent, labelKey: "features.sidebar.events", url: "/events" },
  { icon: IconChartLine, labelKey: "maya.nav.analysis", url: "/analysis" },
  { icon: IconGitBranch, labelKey: "features.sidebar.variants", url: "/variants" },
  { icon: IconPuzzle, labelKey: "features.sidebar.puzzles", url: "/puzzles" },
  { icon: LichessSideIcon, labelKey: "features.sidebar.tournaments", url: "/tournaments" },
];

// Mantener linksdata para compatibilidad
export const linksdata = [...primaryLinks, ...secondaryLinksData, ...tertiaryLinksData];

export function SideBar() {
  const _matchesRoute = useMatchRoute();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [, setActiveTab] = useAtom(activeTabAtom);
  const { layout } = useResponsiveLayout();
  const isFooterNav = layout.sidebar.position === "footer";
  const openRouteTab = async (route: string, name: string) => {
    const existing = tabs.find((tab) => tab.route === route);
    if (existing) {
      setActiveTab(existing.value);
      try {
        navigate({ to: route as never });
      } catch (error) {
        console.error("Navigation error in openRouteTab:", error);
      }
      return;
    }

    await createTab({
      tab: { name, type: "route", route },
      setTabs,
      setActiveTab,
    });
    try {
      // Use requestAnimationFrame to ensure router is ready
      requestAnimationFrame(() => {
        try {
          navigate({ to: route as never });
        } catch (error) {
          console.error("Navigation error in openRouteTab (after createTab):", error);
        }
      });
    } catch (error) {
      console.error("Navigation error in openRouteTab:", error);
    }
  };

  const openTabAndNavigate = async ({
    tab,
    route,
    initialAnalysisTab,
    initialAnalysisSubTab,
    initialNotationView,
  }: {
    tab: Omit<Tab, "value">;
    route: "/play" | "/analysis" | "/puzzles";
    initialAnalysisTab?: string;
    initialAnalysisSubTab?: string;
    initialNotationView?: "variations" | "repertoire" | "report";
  }) => {
    await createTab({
      tab,
      setTabs,
      setActiveTab,
      initialAnalysisTab,
      initialAnalysisSubTab,
      initialNotationView,
    });
    try {
      // Use requestAnimationFrame to ensure router is ready
      requestAnimationFrame(() => {
        try {
          navigate({ to: route });
        } catch (error) {
          console.error("Navigation error in openTabAndNavigate:", error);
        }
      });
    } catch (error) {
      console.error("Navigation error in openTabAndNavigate:", error);
    }
  };

  // Sección principal: Dashboard y Profiles
  const primaryNavLinks = primaryLinks.map((link) => {
    if (link.url === "/profiles") {
      return (
        <MayaActionLink
          key={link.label}
          icon={link.icon}
          label={t(`features.sidebar.${link.label}`)}
          onClick={() => {
            const existingProfileTab = tabs.find((t) => t.type === "profiles");
            if (existingProfileTab) {
              setActiveTab(existingProfileTab.value);
              try {
                navigate({ to: "/profiles" });
              } catch (error) {
                console.error("Navigation error in profiles link:", error);
              }
            } else {
              void createTab({
                tab: { name: t("profiles.title", { defaultValue: "Profiles" }), type: "profiles" },
                setTabs,
                setActiveTab,
              });
              try {
                requestAnimationFrame(() => {
                  try {
                    navigate({ to: "/profiles" });
                  } catch (error) {
                    console.error("Navigation error in profiles link (after createTab):", error);
                  }
                });
              } catch (error) {
                console.error("Navigation error in profiles link:", error);
              }
            }
          }}
        />
      );
    }
    return (
      <NavbarLink
        {...link}
        label={t(`features.sidebar.${link.label}`)}
        key={link.label}
        onClick={() => void openRouteTab(link.url, t(`features.sidebar.${link.label}`))}
      />
    );
  });

  // Acciones principales: Play, Analysis, Puzzles
  const primaryActionLinks: React.ReactNode[] = [
    <MayaActionLink
      key="play"
      icon={IconPlayerPlay}
      label={t("maya.nav.playVsPc")}
      onClick={() => {
        void openTabAndNavigate({
          tab: { name: t("features.tabs.playBoard.title"), type: "play" },
          route: "/play",
        });
      }}
    />,
    <MayaActionLink
      key="analysis"
      icon={IconChartLine}
      label={t("maya.nav.analysis")}
      onClick={() => {
        void openTabAndNavigate({
          tab: { name: t("features.tabs.analysisBoard.title"), type: "analysis" },
          initialAnalysisTab: "analysis",
          initialAnalysisSubTab: "report",
          initialNotationView: "report" as const,
          route: "/analysis",
        });
      }}
    />,
    <MayaActionLink
      key="puzzles"
      icon={IconPuzzle}
      label={t("maya.nav.puzzles")}
      onClick={() => {
        void openTabAndNavigate({
          tab: { name: t("features.tabs.puzzle.title"), type: "puzzles" },
          route: "/puzzles",
        });
      }}
    />,
  ];

  // Sección secundaria: Databases, Engines, Files
  const secondaryNavLinks = secondaryLinksData.map((link) => (
    <NavbarLink
      {...link}
      label={t(`features.sidebar.${link.label}`)}
      key={link.label}
      onClick={() => void openRouteTab(link.url, t(`features.sidebar.${link.label}`))}
    />
  ));

  // Sección terciaria: Tournaments
  const tertiaryNavLinks = tertiaryLinksData.map((link) => (
    <NavbarLink
      {...link}
      label={t(`features.sidebar.${link.label}`)}
      key={link.label}
      onClick={() => void openRouteTab(link.url, t(`features.sidebar.${link.label}`))}
    />
  ));

  if (isFooterNav) {
    return (
      <div
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "center",
          paddingLeft: "calc(0.5rem + env(safe-area-inset-left, 0px))",
          paddingRight: "calc(0.5rem + env(safe-area-inset-right, 0px))",
        }}
      >
        <Group justify="center" gap="sm" wrap="nowrap">
          {mobileFooterLinks.map((link) => (
            <NavbarLink
              url={link.url}
              icon={link.icon}
              label={t(link.labelKey)}
              key={link.url}
              onClick={() => {
                if (link.url === "/play") {
                  void openTabAndNavigate({
                    tab: { name: t("features.tabs.playBoard.title"), type: "play" },
                    route: "/play",
                  });
                  return;
                }
                if (link.url === "/analysis") {
                  void openTabAndNavigate({
                    tab: { name: t("features.tabs.analysisBoard.title"), type: "analysis" },
                    initialAnalysisTab: "analysis",
                    initialAnalysisSubTab: "report",
                    initialNotationView: "report" as const,
                    route: "/analysis",
                  });
                  return;
                }
                if (link.url === "/puzzles") {
                  void openTabAndNavigate({
                    tab: { name: t("features.tabs.puzzle.title"), type: "puzzles" },
                    route: "/puzzles",
                  });
                  return;
                }
                if (link.url === "/profiles") {
                  const existingProfileTab = tabs.find((t) => t.type === "profiles");
                  if (existingProfileTab) {
                    setActiveTab(existingProfileTab.value);
                    try {
                      navigate({ to: "/profiles" });
                    } catch (error) {
                      console.error("Navigation error in footer profiles link:", error);
                    }
                  } else {
                    void createTab({
                      tab: { name: t("profiles.title", { defaultValue: "Profiles" }), type: "profiles" },
                      setTabs,
                      setActiveTab,
                    });
                    try {
                      requestAnimationFrame(() => {
                        try {
                          navigate({ to: "/profiles" });
                        } catch (error) {
                          console.error("Navigation error in footer profiles link (after createTab):", error);
                        }
                      });
                    } catch (error) {
                      console.error("Navigation error in footer profiles link:", error);
                    }
                  }
                  return;
                }

                void openRouteTab(link.url, t(link.labelKey));
              }}
            />
          ))}
        </Group>
      </div>
    );
  }

  // Para compatibilidad con código existente (footer/mobile)
  // Desktop layout
  return (
    <AppShellSection grow>
      <Stack justify="flex-start" gap={0} pt="xs" h="100%">
        {/* Sección principal: Dashboard y Profiles */}
        {primaryNavLinks}
        {/* Acciones principales: Play, Analysis, Puzzles */}
        {primaryActionLinks}
        {/* Sección secundaria: Databases, Engines, Files */}
        {secondaryNavLinks}
        {/* Sección terciaria: Tournaments */}
        {tertiaryNavLinks}

        {/* Sección final: Keyboard Shortcuts y Settings */}
        <Stack justify="flex-end" gap={0} mt="auto" visibleFrom="sm">
          <NavbarLink
            url="/settings/keyboard-shortcuts"
            icon={IconKeyboard}
            label={t("features.sidebar.keyboardShortcuts")}
            onClick={() => void openRouteTab("/settings/keyboard-shortcuts", t("features.sidebar.keyboardShortcuts"))}
          />
          <NavbarLink
            url="/settings"
            icon={IconSettings}
            label={t("features.sidebar.settings")}
            onClick={() => void openRouteTab("/settings", t("features.sidebar.settings"))}
          />
        </Stack>
      </Stack>
    </AppShellSection>
  );
}
