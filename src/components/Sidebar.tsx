import { ActionIcon, AppShellSection, Group, Menu, Stack, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import {
  type Icon,
  IconChartLine,
  IconCpu,
  IconDatabase,
  IconFiles,
  IconGitBranch,
  IconKeyboard,
  IconLayoutDashboard,
  IconMenu2,
  IconPlayerPlay,
  IconPuzzle,
  IconSettings,
  IconTrophy,
  IconUpload,
  IconUserCircle,
} from "@tabler/icons-react";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import cx from "clsx";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { createTab, type Tab } from "@/utils/tabs";
import * as classes from "./Sidebar.css";

interface NavbarLinkProps {
  icon: Icon;
  label: string;
  url: string;
  active?: boolean;
}

function NavbarLink({ url, icon: Icon, label }: NavbarLinkProps) {
  const matchesRoute = useMatchRoute();
  const { layout } = useResponsiveLayout();
  const isActive = matchesRoute({ to: url, fuzzy: url !== "/" });
  return (
    <Tooltip label={label} position={layout.sidebar.position === "footer" ? "top" : "right"}>
      <Link
        to={url}
        className={cx(classes.link, {
          [classes.active]: isActive,
        })}
      >
        <Icon size={layout.sidebar.position === "footer" ? "2.0rem" : "1.5rem"} stroke={1.5} />
      </Link>
    </Tooltip>
  );
}

function MayaActionLink({
  icon: Icon,
  label,
  onClick,
}: {
  icon: Icon;
  label: string;
  onClick: (e?: React.MouseEvent) => void;
}) {
  const { layout } = useResponsiveLayout();

  return (
    <Tooltip label={label} position={layout.sidebar.position === "footer" ? "top" : "right"}>
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          onClick(e);
        }}
        className={cx(classes.link)}
      >
        <Icon size={layout.sidebar.position === "footer" ? "2.0rem" : "1.5rem"} stroke={1.5} />
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
  { icon: IconTrophy, label: "tournaments", url: "/tournaments" },
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
  const dashboardLink = primaryNavLinks[0];
  const secondaryLinks = [...secondaryNavLinks, ...tertiaryNavLinks];
  const actionLinks = [...primaryActionLinks, tertiaryActionLink];

  if (layout.sidebar.position === "footer") {
    // Show only first 4 links on mobile
    const footerLinks = [dashboardLink, ...actionLinks, ...secondaryLinks];
    const visibleLinks = footerLinks.slice(0, 4);

    // For burger menu, we need to render Menu.Items directly
    const renderBurgerMenuItem = (link: React.ReactNode, index: number) => {
      if (!link || typeof link !== "object" || !("props" in link)) {
        return null;
      }

      const linkProps = link.props as {
        icon: Icon;
        label: string;
        url?: string;
        onClick?: (e: React.MouseEvent) => void;
      };
      const IconComponent = linkProps.icon;
      const linkKey = (link as { key?: string }).key || `menu-item-${index}`;

      // If there's no URL, it's a quick action - use onClick
      if (!linkProps.url) {
        return (
          <Menu.Item
            key={linkKey}
            onClick={(e) => {
              if (linkProps.onClick) {
                linkProps.onClick(e);
              }
            }}
            leftSection={<IconComponent size="1.2rem" stroke={1.5} />}
          >
            {linkProps.label}
          </Menu.Item>
        );
      }

      // Regular navigation link (use navigate() for reliability with Mantine Menu)
      return (
        <Menu.Item
          key={linkKey}
          onClick={() => navigate({ to: linkProps.url! })}
          leftSection={<IconComponent size="1.2rem" stroke={1.5} />}
        >
          {linkProps.label}
        </Menu.Item>
      );
    };

    return (
      <AppShellSection grow>
        <Group justify="center" gap="md">
          {visibleLinks}
          <Menu shadow="md" position="top">
            <Menu.Target>
              <Tooltip label={t("sidebar.more")} position="top">
                <ActionIcon variant="subtle" size="xl" className={classes.link}>
                  <IconMenu2 size="2.0rem" stroke={1.5} />
                </ActionIcon>
              </Tooltip>
            </Menu.Target>
            <Menu.Dropdown>
              {footerLinks.slice(4).map((link, index) => renderBurgerMenuItem(link, index))}
              <Menu.Item
                key="settings"
                onClick={() => navigate({ to: "/settings" })}
                leftSection={<IconSettings size="1.2rem" stroke={1.5} />}
              >
                {t("features.sidebar.settings")}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </AppShellSection>
    );
  }

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
            >
              <IconSettings size="1.5rem" stroke={1.5} />
            </Link>
          </Tooltip>
        </Stack>
      </Stack>
    </AppShellSection>
  );
}
