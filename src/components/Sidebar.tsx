import { ActionIcon, AppShellSection, Group, Menu, Stack, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import {
  type Icon,
  IconChartLine,
  IconCpu,
  IconDatabase,
  IconFiles,
  IconKeyboard,
  IconLayoutDashboard,
  IconMenu2,
  IconPlayerPlay,
  IconPuzzle,
  IconSettings,
  IconTrophy,
  IconUpload,
  IconUsers,
} from "@tabler/icons-react";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import cx from "clsx";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { createTab } from "@/utils/tabs";
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

export const linksdata = [
  { icon: IconLayoutDashboard, label: "dashboard", url: "/" },
  { icon: IconCpu, label: "engines", url: "/engines" },
  {
    icon: IconDatabase,
    label: "databases",
    url: "/databases",
  },
  { icon: IconFiles, label: "files", url: "/files" },
  { icon: IconUsers, label: "accounts", url: "/accounts" },
  { icon: IconTrophy, label: "tournaments", url: "/tournaments" },
];

export function SideBar() {
  const matchesRoute = useMatchRoute();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [, setTabs] = useAtom(tabsAtom);
  const [, setActiveTab] = useAtom(activeTabAtom);
  const { layout } = useResponsiveLayout();

  const dashboardLinkData = linksdata.find((link) => link.url === "/")!;
  const dashboardLink = (
    <NavbarLink
      key={dashboardLinkData.label}
      {...dashboardLinkData}
      label={t(`features.sidebar.${dashboardLinkData.label}`)}
    />
  );

  const secondaryLinks = linksdata
    .filter((link) => link.url !== "/")
    .map((link) => <NavbarLink {...link} label={t(`features.sidebar.${link.label}`)} key={link.label} />);

  const actionLinks: React.ReactNode[] = [
    <MayaActionLink
      key="play"
      icon={IconPlayerPlay}
      label={t("maya.nav.playVsPc")}
      onClick={() => {
        createTab({
          tab: { name: t("features.tabs.playBoard.title"), type: "play" },
          setTabs,
          setActiveTab,
        });
        navigate({ to: "/play" });
      }}
    />,
    <MayaActionLink
      key="analysis"
      icon={IconChartLine}
      label={t("maya.nav.analysis")}
      onClick={() => {
        createTab({
          tab: { name: t("features.tabs.analysisBoard.title"), type: "analysis" },
          setTabs,
          setActiveTab,
          initialAnalysisTab: "analysis",
          initialAnalysisSubTab: "report",
          initialNotationView: "report" as const,
        });
        navigate({ to: "/analysis" });
      }}
    />,
    <MayaActionLink
      key="puzzles"
      icon={IconPuzzle}
      label={t("maya.nav.puzzles")}
      onClick={() => {
        createTab({
          tab: { name: t("features.tabs.puzzle.title"), type: "puzzles" },
          setTabs,
          setActiveTab,
        });
        navigate({ to: "/puzzles" });
      }}
    />,
    <MayaActionLink
      key="import"
      icon={IconUpload}
      label={t("maya.nav.importGame")}
      onClick={() => {
        navigate({ to: "/analysis" });
        modals.openContextModal({ modal: "importModal", innerProps: {} });
      }}
    />,
  ];

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
        {dashboardLink}
        {layout.sidebar.position === "navbar" && actionLinks}
        {secondaryLinks}

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
