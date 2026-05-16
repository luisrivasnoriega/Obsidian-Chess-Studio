import { AppShellSection, Group, Stack, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { IconProps } from "@tabler/icons-react";
import {
  IconCalendarEvent,
  IconChartLine,
  IconChevronsLeft,
  IconChevronsRight,
  IconCpu,
  IconDatabase,
  IconGitBranch,
  IconKeyboard,
  IconLayoutDashboard,
  IconPlayerPlay,
  IconPuzzle,
  IconRefresh,
  IconSettings,
  IconUserCircle,
  IconWorld,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import cx from "clsx";
import { useAtom } from "jotai";
import { type ComponentType, type MouseEvent, type ReactNode, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import LichessLogo from "@/features/profiles/components/LichessLogo";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import {
  activeProfileIdAtom,
  activeTabAtom,
  type Profile,
  profilesAtom,
  sessionsAtom,
  sidebarExpandedAtom,
  tabsAtom,
} from "@/state/atoms";
import { syncSessionGamesToProfileDb } from "@/utils/profileGameSync";
import type { Session } from "@/utils/session";
import { createTab, type Tab } from "@/utils/tabs";
import * as classes from "./Sidebar.css";

type SidebarIcon = ComponentType<IconProps>;

interface NavbarLinkProps {
  icon: SidebarIcon;
  label: string;
  url: string;
  onClick?: () => void;
  expanded?: boolean;
}
function NavbarLink({ url, icon: Icon, label, onClick, expanded = false }: NavbarLinkProps) {
  const matchesRoute = useMatchRoute();
  const { layout } = useResponsiveLayout();
  const isFooter = layout.sidebar.position === "footer";
  const isActive = matchesRoute({ to: url, fuzzy: url !== "/" });
  const iconSize = isFooter ? "1.8rem" : "1.5rem";

  return (
    <Tooltip label={label} position={isFooter ? "top" : "right"} disabled={expanded}>
      <button
        type="button"
        onClick={onClick}
        className={cx(classes.link, {
          [classes.active]: isActive,
        })}
        data-position={isFooter ? "footer" : "navbar"}
        data-expanded={expanded}
      >
        <span className={classes.iconWrap}>
          <Icon size={iconSize} stroke={1.5} />
        </span>
        {expanded ? <span className={classes.linkLabel}>{label}</span> : null}
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
  expanded = false,
  className,
  dataRole,
}: {
  icon: SidebarIcon;
  label: string;
  onClick: (e?: MouseEvent<HTMLButtonElement>) => void;
  expanded?: boolean;
  className?: string;
  dataRole?: string;
}) {
  const { layout } = useResponsiveLayout();
  const isFooter = layout.sidebar.position === "footer";
  const iconSize = isFooter ? "1.8rem" : "1.5rem";

  return (
    <Tooltip label={label} position={isFooter ? "top" : "right"} disabled={expanded}>
      <button
        type="button"
        onClick={onClick}
        className={cx(classes.link, className)}
        data-position={isFooter ? "footer" : "navbar"}
        data-expanded={expanded}
        data-role={dataRole}
      >
        <span className={classes.iconWrap}>
          <Icon size={iconSize} stroke={1.5} />
        </span>
        {expanded ? <span className={classes.linkLabel}>{label}</span> : null}
      </button>
    </Tooltip>
  );
}

// Primary section (daily use)
const primaryLinks = [
  { icon: IconLayoutDashboard, label: "dashboard", url: "/" },
  { icon: IconUserCircle, label: "profiles", url: "/profiles" },
  { icon: IconCalendarEvent, label: "events", url: "/events" },
];

// Secondary section (regular use)
const secondaryLinksData = [
  { icon: IconDatabase, label: "databases", url: "/databases" },
  { icon: IconCpu, label: "engines", url: "/engines" },
  { icon: IconGitBranch, label: "variants", url: "/variants" },
  { icon: IconWorld, label: "chessbase", url: "/chessbase" },
];

// Tertiary section (advanced)
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

// Keep linksdata for compatibility
export const linksdata = [...primaryLinks, ...secondaryLinksData, ...tertiaryLinksData];

export function SideBar() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [, setActiveTab] = useAtom(activeTabAtom);
  const [sidebarExpanded, setSidebarExpanded] = useAtom(sidebarExpandedAtom);
  const [profiles] = useAtom(profilesAtom);
  const [activeProfileId] = useAtom(activeProfileIdAtom);
  const [sessions, setSessions] = useAtom(sessionsAtom);
  const { layout } = useResponsiveLayout();
  const isFooterNav = layout.sidebar.position === "footer";
  const profileSyncInFlightRef = useRef(false);

  const sessionMeta = useCallback((session: Session) => {
    if (session.lichess?.username) return { platform: "lichess" as const, username: session.lichess.username };
    if (session.chessCom?.username) return { platform: "chesscom" as const, username: session.chessCom.username };
    return { platform: "unknown" as const, username: "-" };
  }, []);

  const upsertSession = useCallback(
    (session: Session) => {
      setSessions((prev) => {
        const nextMeta = sessionMeta(session);
        const nextKey = `${session.profileId ?? ""}:${nextMeta.platform}:${nextMeta.username}`;
        const filtered = prev.filter((existing) => {
          const meta = sessionMeta(existing);
          const key = `${existing.profileId ?? ""}:${meta.platform}:${meta.username}`;
          return key !== nextKey;
        });
        return [...filtered, { ...session, updatedAt: session.updatedAt ?? Date.now() }];
      });
    },
    [setSessions, sessionMeta],
  );

  const invalidateProfileStats = useCallback(
    (profileId: string) => {
      queryClient.invalidateQueries({ queryKey: ["personalInfo", profileId] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["mergedPlayerInfo"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["playerSidebarModel"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["playerEloBuckets"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["playerGameStats"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["profilePhaseStats"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["playerOpeningsWhite"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["playerOpeningsBlack"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["playerRatingTimeline"] }).catch(() => {});
    },
    [queryClient],
  );

  const syncProfileSessions = useCallback(
    async (profile: Profile) => {
      if (profileSyncInFlightRef.current) {
        notifications.show({
          title: t("common.warning", { defaultValue: "Warning" }),
          message: t("profiles.sync.inProgress", { defaultValue: "A profile update is already running." }),
          color: "yellow",
          autoClose: 3000,
        });
        return;
      }

      const linkedSessions = sessions.filter((session) => session.profileId === profile.id);
      const syncableSessions = linkedSessions.filter((session) => {
        const meta = sessionMeta(session);
        return (meta.platform === "lichess" || meta.platform === "chesscom") && meta.username !== "-";
      });

      if (syncableSessions.length === 0) {
        notifications.show({
          title: t("common.warning", { defaultValue: "Warning" }),
          message: t("profiles.sync.noAccounts", { defaultValue: "This profile has no linked accounts to update." }),
          color: "yellow",
          autoClose: 3000,
        });
        return;
      }

      const orderedSessions = [...syncableSessions].sort((a, b) => {
        const aPlatform = sessionMeta(a).platform;
        const bPlatform = sessionMeta(b).platform;
        if (aPlatform === bPlatform) return 0;
        return aPlatform === "lichess" ? -1 : 1;
      });

      profileSyncInFlightRef.current = true;
      let importedGames = 0;

      try {
        for (const session of orderedSessions) {
          const meta = sessionMeta(session);
          const username = meta.username;
          const notificationId = `sidebar-sync:${profile.id}:${meta.platform}:${username}`;

          notifications.show({
            id: notificationId,
            title: t("accounts.processingGames", { defaultValue: "Processing Games..." }),
            message: `${profile.name} - ${username} (${meta.platform})`,
            loading: true,
            autoClose: false,
          });

          try {
            const result = await syncSessionGamesToProfileDb({
              profile,
              session,
              onBatchUpdate: (update) => {
                const message =
                  update.totalBatches > 0
                    ? `${profile.name} - ${username} (${update.platform}) ${t("accounts.sync.batchProgress", {
                        defaultValue: "Batch {{current}} of {{total}}",
                        current: update.currentBatch,
                        total: update.totalBatches,
                      })}`
                    : `${profile.name} - ${username} (${update.platform})`;

                notifications.update({
                  id: notificationId,
                  message,
                  loading: true,
                  autoClose: false,
                });
              },
            });

            importedGames += result.importedGames ?? 0;
            if (result.updatedSession) upsertSession(result.updatedSession);

            notifications.update({
              id: notificationId,
              title: t("common.success", { defaultValue: "Success" }),
              message: `${profile.name} - ${username} (${meta.platform})`,
              color: "green",
              loading: false,
              autoClose: 2500,
            });
          } catch (error) {
            notifications.update({
              id: notificationId,
              title: t("common.error", { defaultValue: "Error" }),
              message: `${t("accounts.databaseLoadError", { defaultValue: "Error loading database" })}: ${String(error)}`,
              color: "red",
              loading: false,
              autoClose: 4000,
            });
          }
        }
      } finally {
        profileSyncInFlightRef.current = false;
      }

      if (importedGames > 0) {
        invalidateProfileStats(profile.id);
      }

      notifications.show({
        title: t("common.success", { defaultValue: "Success" }),
        message: t("profiles.sync.completed", {
          defaultValue: "Profile {{profile}} updated.",
          profile: profile.name,
        }),
        color: "green",
        autoClose: 2500,
      });
    },
    [invalidateProfileStats, sessionMeta, sessions, t, upsertSession],
  );

  const syncActiveProfileNow = useCallback(() => {
    const profile = profiles.find((item) => item.id === activeProfileId) ?? null;
    if (!profile) {
      notifications.show({
        title: t("common.warning", { defaultValue: "Warning" }),
        message: t("profiles.selectProfile", { defaultValue: "Select profile" }),
        color: "yellow",
        autoClose: 3000,
      });
      return;
    }

    void syncProfileSessions(profile);
  }, [activeProfileId, profiles, syncProfileSessions, t]);

  const openRouteTab = async (route: string, name: string) => {
    const existing = tabs.find((tab) => tab.route === route);
    if (existing) {
      setActiveTab(existing.value);
      try {
        navigate({ to: route as never });
      } catch {}
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
        } catch {}
      });
    } catch {}
  };

  const openProfilesPage = useCallback(async () => {
    const existingProfileTab = tabs.find((t) => t.type === "profiles");
    if (existingProfileTab) {
      setActiveTab(existingProfileTab.value);
      try {
        navigate({ to: "/profiles" });
      } catch {}
      return;
    }

    await createTab({
      tab: { name: t("profiles.title", { defaultValue: "Profiles" }), type: "profiles" },
      setTabs,
      setActiveTab,
    });
    try {
      requestAnimationFrame(() => {
        try {
          navigate({ to: "/profiles" });
        } catch {}
      });
    } catch {}
  }, [navigate, setActiveTab, setTabs, t, tabs]);

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
        } catch {}
      });
    } catch {}
  };

  // Primary section: Dashboard and Profiles
  const primaryNavLinks = primaryLinks.map((link) => {
    if (link.url === "/profiles") {
      return (
        <MayaActionLink
          key={link.label}
          icon={link.icon}
          label={t(`features.sidebar.${link.label}`)}
          expanded={sidebarExpanded}
          onClick={() => void openProfilesPage()}
        />
      );
    }
    return (
      <NavbarLink
        {...link}
        label={t(`features.sidebar.${link.label}`)}
        key={link.label}
        expanded={sidebarExpanded}
        onClick={() => void openRouteTab(link.url, t(`features.sidebar.${link.label}`))}
      />
    );
  });

  const profileSyncLink = (
    <MayaActionLink
      key="profiles-sync"
      icon={IconRefresh}
      label={t("profiles.sync.active", { defaultValue: "Update active profile" })}
      expanded={sidebarExpanded}
      onClick={syncActiveProfileNow}
    />
  );

  // Primary actions: Play, Analysis, Puzzles
  const primaryActionLinks: ReactNode[] = [
    <MayaActionLink
      key="play"
      icon={IconPlayerPlay}
      label={t("maya.nav.playVsPc")}
      expanded={sidebarExpanded}
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
      expanded={sidebarExpanded}
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
      expanded={sidebarExpanded}
      onClick={() => {
        void openTabAndNavigate({
          tab: { name: t("features.tabs.puzzle.title"), type: "puzzles" },
          route: "/puzzles",
        });
      }}
    />,
  ];

  // Secondary section: Databases, Engines, Variants, ChessBase
  const secondaryNavLinks = secondaryLinksData.map((link) => (
    <NavbarLink
      {...link}
      label={t(`features.sidebar.${link.label}`)}
      key={link.label}
      expanded={sidebarExpanded}
      onClick={() => void openRouteTab(link.url, t(`features.sidebar.${link.label}`))}
    />
  ));

  // Tertiary section: Tournaments
  const tertiaryNavLinks = tertiaryLinksData.map((link) => (
    <NavbarLink
      {...link}
      label={t(`features.sidebar.${link.label}`)}
      key={link.label}
      expanded={sidebarExpanded}
      onClick={() => void openRouteTab(link.url, t(`features.sidebar.${link.label}`))}
    />
  ));

  const toggleSidebarExpanded = useCallback(() => {
    setSidebarExpanded((prev) => !prev);
  }, [setSidebarExpanded]);

  const sidebarToggleLink = (
    <MayaActionLink
      key="sidebar-toggle"
      icon={sidebarExpanded ? IconChevronsLeft : IconChevronsRight}
      label={sidebarExpanded ? t("features.sidebar.collapse") : t("features.sidebar.expand")}
      expanded={sidebarExpanded}
      className={classes.toggleLink}
      dataRole="toggle"
      onClick={toggleSidebarExpanded}
    />
  );

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
                  void openProfilesPage();
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

  // Desktop layout
  return (
    <AppShellSection grow>
      <Stack className={classes.container} data-expanded={sidebarExpanded} justify="flex-start" gap={0} h="100%">
        {sidebarToggleLink}
        {sidebarExpanded ? <div className={classes.sectionDivider} /> : null}
        {sidebarExpanded ? <div className={classes.sectionTitle}>{t("features.sidebar.navigation")}</div> : null}
        {primaryNavLinks}
        {profileSyncLink}

        {sidebarExpanded ? <div className={classes.sectionDivider} /> : null}
        {sidebarExpanded ? <div className={classes.sectionTitle}>{t("features.sidebar.play")}</div> : null}
        {primaryActionLinks}

        {sidebarExpanded ? <div className={classes.sectionDivider} /> : null}
        {sidebarExpanded ? <div className={classes.sectionTitle}>{t("features.sidebar.workspace")}</div> : null}
        {secondaryNavLinks}
        {tertiaryNavLinks}

        <Stack justify="flex-end" gap={0} mt="auto" visibleFrom="sm">
          {sidebarExpanded ? <div className={classes.sectionDivider} /> : null}
          {sidebarExpanded ? <div className={classes.sectionTitle}>{t("features.sidebar.system")}</div> : null}
          <NavbarLink
            url="/settings/keyboard-shortcuts"
            icon={IconKeyboard}
            label={t("features.sidebar.keyboardShortcuts")}
            expanded={sidebarExpanded}
            onClick={() => void openRouteTab("/settings/keyboard-shortcuts", t("features.sidebar.keyboardShortcuts"))}
          />
          <NavbarLink
            url="/settings"
            icon={IconSettings}
            label={t("features.sidebar.settings")}
            expanded={sidebarExpanded}
            onClick={() => void openRouteTab("/settings", t("features.sidebar.settings"))}
          />
        </Stack>
      </Stack>
    </AppShellSection>
  );
}
