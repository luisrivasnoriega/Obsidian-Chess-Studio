import { AppShellSection, Group, Stack, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import type { ComponentType } from "react";
import type { IconProps } from "@tabler/icons-react";
import {
  IconChartLine,
  IconCpu,
  IconDatabase,
  IconFiles,
  IconGitBranch,
  IconKeyboard,
  IconLayoutDashboard,
  IconPlayerPlay,
  IconPuzzle,
  IconSettings,
  IconUpload,
  IconUserCircle,
} from "@tabler/icons-react";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import cx from "clsx";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import LichessLogo from "@/features/profiles/components/LichessLogo";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { createTab, type Tab } from "@/utils/tabs";
import * as classes from "./Sidebar.css";

type SidebarIcon = ComponentType<IconProps>;

interface NavbarLinkProps {
  icon: SidebarIcon;
  label: string;
  url: string;
  active?: boolean;
}

function NavbarLink({ url, icon: Icon, label }: NavbarLinkProps) {
  const matchesRoute = useMatchRoute();
  const { layout } = useResponsiveLayout();
  const isFooter = layout.sidebar.position === "footer";
  const isActive = matchesRoute({ to: url, fuzzy: url !== "/" });
  return (
    <Tooltip label={label} position={isFooter ? "top" : "right"}>
      <Link
        to={url}
        className={cx(classes.link, {
          [classes.active]: isActive,
        })}
        data-position={isFooter ? "footer" : "navbar"}
      >
        <Icon size={isFooter ? "1.8rem" : "1.5rem"} stroke={1.5} />
      </Link>
    </Tooltip>
  );
}

const LichessSideIcon: SidebarIcon = ({ size }) => {
  const resolvedSize = typeof size === "number" ? `${size}px` : size ?? "1.5rem";
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
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          onClick(e);
        }}
        className={cx(classes.link)}
        data-position={isFooter ? "footer" : "navbar"}
      >
        <Icon size={isFooter ? "1.8rem" : "1.5rem"} stroke={1.5} />
      </a>
    </Tooltip>
  );
}

// Sección principal (uso diario)
const primaryLinks = [
  { icon: IconLayoutDashboard, label: "dashboard", url: "/" },
  { icon: IconUserCircle, label: "profiles", url: "/profiles" },
];

// Sección secundaria (uso regular)
const secondaryLinksData = [
  { icon: IconDatabase, label: "databases", url: "/databases" },
  { icon: IconCpu, label: "engines", url: "/engines" },
  { icon: IconFiles, label: "files", url: "/files" },
  { icon: IconGitBranch, label: "variants", url: "/variants" },
];

// Sección terciaria (configuración/avanzado)
const tertiaryLinksData = [
  { icon: LichessSideIcon, label: "tournaments", url: "/tournaments" },
];

const mobileFooterLinks: Array<{ icon: SidebarIcon; labelKey: string; url: string }> = [
  { icon: IconLayoutDashboard, labelKey: "features.sidebar.dashboard", url: "/" },
  { icon: IconUserCircle, labelKey: "features.sidebar.profiles", url: "/profiles" },
  { icon: IconChartLine, labelKey: "maya.nav.analysis", url: "/analysis" },
  { icon: IconGitBranch, labelKey: "features.sidebar.variants", url: "/variants" },
  { icon: IconPuzzle, labelKey: "features.sidebar.puzzles", url: "/puzzles" },
  { icon: LichessSideIcon, labelKey: "features.sidebar.tournaments", url: "/tournaments" },
  { icon: IconSettings, labelKey: "features.sidebar.settings", url: "/settings" },
];

// Mantener linksdata para compatibilidad
export const linksdata = [
  ...primaryLinks,
  ...secondaryLinksData,
  ...tertiaryLinksData,
];

export function SideBar() {
  const matchesRoute = useMatchRoute();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [, setActiveTab] = useAtom(activeTabAtom);
  const { layout } = useResponsiveLayout();
  const isFooterNav = layout.sidebar.position === "footer";
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
    navigate({ to: route });
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
              navigate({ to: "/profiles" });
            } else {
              void createTab({
                tab: { name: t("profiles.title", { defaultValue: "Profiles" }), type: "profiles" },
                setTabs,
                setActiveTab,
              });
              navigate({ to: "/profiles" });
            }
          }}
        />
      );
    }
    return <NavbarLink {...link} label={t(`features.sidebar.${link.label}`)} key={link.label} />;
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
    <NavbarLink {...link} label={t(`features.sidebar.${link.label}`)} key={link.label} />
  ));

  // Sección terciaria: Tournaments
  const tertiaryNavLinks = tertiaryLinksData.map((link) => (
    <NavbarLink {...link} label={t(`features.sidebar.${link.label}`)} key={link.label} />
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
            <NavbarLink url={link.url} icon={link.icon} label={t(link.labelKey)} key={link.url} />
          ))}
        </Group>
      </div>
    );
  }

  // Acción terciaria: Import
  const tertiaryActionLink = (
    <MayaActionLink
      key="import"
      icon={IconUpload}
      label={t("maya.nav.importGame")}
      onClick={() => {
        navigate({ to: "/analysis" });
        modals.openContextModal({ modal: "importModal", innerProps: {} });
      }}
    />
  );

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
        {/* Acción terciaria: Import */}
        {tertiaryActionLink}

        {/* Sección final: Keyboard Shortcuts y Settings */}
        <Stack justify="flex-end" gap={0} mt="auto" visibleFrom="sm">
          <Tooltip label={t("features.sidebar.keyboardShortcuts")} position="right">
            <Link
              to="/settings/keyboard-shortcuts"
              className={cx(classes.link, {
                [classes.active]: matchesRoute({ to: "/settings/keyboard-shortcuts", fuzzy: true }),
              })}
              data-position="navbar"
            >
              <IconKeyboard size="1.5rem" stroke={1.5} />
            </Link>
          </Tooltip>
          <Tooltip label={t("features.sidebar.settings")} position="right">
            <Link
              to="/settings"
              className={cx(classes.link, {
                [classes.active]: matchesRoute({ to: "/settings", fuzzy: true }),
              })}
              data-position="navbar"
            >
              <IconSettings size="1.5rem" stroke={1.5} />
            </Link>
          </Tooltip>
        </Stack>
      </Stack>
    </AppShellSection>
  );
}
