import { AppShell } from "@mantine/core";
import { type HotkeyItem, useHotkeys } from "@mantine/hooks";
import { ModalsProvider, modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { Spotlight, spotlight } from "@mantine/spotlight";
import { createRootRouteWithContext, Outlet, useNavigate } from "@tanstack/react-router";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { platform } from "@tauri-apps/plugin-os";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import AboutModal from "@/components/About";
import { MayaHeader } from "@/components/MayaHeader";
import { SideBar } from "@/components/Sidebar";
import { getSpotlightActions } from "@/components/spotlightActions";
import {
  hideUpdateProgressNotification,
  showApkReadyToInstallNotification,
  showApkUpdateProgressNotification,
  showUpdateErrorNotification,
} from "@/components/UpdateNotification";
import { getVersionCheckConfig } from "@/config";
import { getRouteForTab } from "@/features/boards/BoardsRouteEntry";
import ImportModal from "@/features/boards/components/ImportModal";
import { DetachedVariantsNotationPanel } from "@/features/boards/components/variants/DetachedVariantsNotationPanel";
import { useTabManagement } from "@/features/boards/hooks/useTabManagement";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { downloadApkToTemp, openApkInstaller } from "@/services/apk-updater";
import { checkForUpdates as checkForUpdatesService } from "@/services/version-checker";
import { keyMapAtom } from "@/state/keybindings";
import type { Dirs } from "@/types/dirs";
import { openFile } from "@/utils/files";
import { formatHotkeyDisplay } from "@/utils/formatHotkey";
import { createTab, tabSchema } from "@/utils/tabs";

type MenuGroup = {
  label: string;
  options: MenuAction[];
};

type MenuAction = {
  id?: string;
  label: string;
  shortcut?: string;
  action?: () => void;
};

const INPUT_ELEMENT_TAGS = new Set(["INPUT", "TEXTAREA"]);
const CLIPBOARD_OPERATIONS = {
  CUT: "cut",
  COPY: "copy",
  PASTE: "paste",
  SELECT_ALL: "selectAll",
} as const;

const isInputElement = (element: Element): element is HTMLInputElement | HTMLTextAreaElement => {
  return INPUT_ELEMENT_TAGS.has(element.tagName);
};

const isContentEditableElement = (element: Element): element is HTMLElement => {
  return element instanceof HTMLElement && element.isContentEditable;
};

const getSelectedText = (element: HTMLInputElement | HTMLTextAreaElement): string => {
  const start = element.selectionStart ?? 0;
  const end = element.selectionEnd ?? 0;
  return element.value.substring(start, end);
};

const replaceSelection = (element: HTMLInputElement | HTMLTextAreaElement, newText: string): void => {
  const start = element.selectionStart ?? 0;
  const end = element.selectionEnd ?? 0;
  const currentValue = element.value;

  element.value = currentValue.substring(0, start) + newText + currentValue.substring(end);
  element.setSelectionRange(start + newText.length, start + newText.length);

  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
};

const writeToClipboard = (text: string): Promise<void> => navigator.clipboard.writeText(text);

const readFromClipboard = (): Promise<string> => navigator.clipboard.readText();

export const Route = createRootRouteWithContext<{
  loadDirs: () => Promise<Dirs>;
}>()({
  component: RootLayout,
});

function getDetachedPanelParams() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const panel = params.get("detachedPanel");
  if (panel !== "variantsNotation") return null;
  return {
    panel,
    payloadId: params.get("payload"),
    tabId: params.get("tab"),
  };
}

function RootLayout() {
  const detachedPanel = getDetachedPanelParams();
  if (detachedPanel?.panel === "variantsNotation") {
    return <DetachedVariantsNotationPanel payloadId={detachedPanel.payloadId} tabId={detachedPanel.tabId} />;
  }

  return <MainRootLayout />;
}

function MainRootLayout() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { layout } = useResponsiveLayout();

  const {
    tabs,
    activeTab,
    setTabs,
    setActiveTab,
    closeTab,
    closeAllTabs: closeAllTabsFromHook,
  } = useTabManagement({
    enableHotkeys: false,
  });
  const [keyMap] = useAtom(keyMapAtom);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const syncAppVisibility = () => {
      root.dataset.appVisibility = document.hidden ? "hidden" : "visible";
    };
    syncAppVisibility();
    document.addEventListener("visibilitychange", syncAppVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncAppVisibility);
      delete root.dataset.appVisibility;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const tearoffId = params.get("tearoff");
    if (!tearoffId) return;

    const payloadKey = `tearoff:${tearoffId}`;
    const payloadJson = localStorage.getItem(payloadKey);
    if (!payloadJson) return;

    try {
      const payload = JSON.parse(payloadJson) as {
        tab?: unknown;
        session?: Record<string, string>;
      };

      const parsed = tabSchema.safeParse(payload.tab);
      if (!parsed.success) return;

      const tab = parsed.data;

      try {
        if (payload.session) {
          for (const [key, value] of Object.entries(payload.session)) {
            sessionStorage.setItem(key, value);
          }
        }
      } catch {}

      setTabs((prev) => (prev.some((t) => t.value === tab.value) ? prev : [...prev, tab]));
      setActiveTab(tab.value);
      navigate({ to: getRouteForTab(tab) });
    } finally {
      try {
        localStorage.removeItem(payloadKey);
      } catch {}
    }
  }, [navigate, setActiveTab, setTabs]);

  const openNewFile = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "PGN file", extensions: ["pgn"] }],
      });

      if (typeof selected === "string") {
        navigate({ to: "/" });
        openFile(selected, setTabs, setActiveTab);
      }
    } catch {
      notifications.show({
        title: t("common.error"),
        message: t("notifications.failedToOpenFile"),
        color: "red",
      });
    }
  }, [navigate, setActiveTab, setTabs, t]);

  const createNewTab = useCallback(() => {
    createTab({
      tab: { name: t("features.tabs.analysisBoard.title"), type: "analysis" },
      setTabs,
      setActiveTab,
      initialAnalysisTab: "analysis",
      initialAnalysisSubTab: "report",
      initialNotationView: "report" as const,
    });
    navigate({ to: "/analysis" });
  }, [navigate, setActiveTab, setTabs, t]);

  const checkForUpdates = useCallback(async () => {
    try {
      const os = await platform();

      if (os === "android") {
        const config = getVersionCheckConfig();
        const result = await checkForUpdatesService(config);

        if (result.hasUpdate && result.versionInfo) {
          const apkUrl = result.versionInfo.apkDownloadUrl;
          if (!apkUrl) {
            await message(t("notifications.apkNotAvailable"));
            return;
          }

          const shouldInstall = await ask(
            t("notifications.updateAvailablePrompt", { version: result.versionInfo.version }),
            {
              title: t("notifications.newVersionAvailable"),
            },
          );

          if (!shouldInstall) return;

          showApkUpdateProgressNotification(t);
          const downloaded = await downloadApkToTemp({ url: apkUrl, version: result.versionInfo.version });
          hideUpdateProgressNotification();

          await openApkInstaller(downloaded.path);
          showApkReadyToInstallNotification(t);
          return;
        }

        await message(t("notifications.latestVersion"));
        return;
      }

      const update = await check();
      if (update) {
        const shouldInstall = await ask(t("notifications.updateAvailablePrompt", { version: update.version }), {
          title: t("notifications.newVersionAvailable"),
        });

        if (shouldInstall) {
          notifications.show({
            title: t("notifications.updating"),
            message: t("notifications.downloadingUpdate"),
            loading: true,
          });

          await update.downloadAndInstall();
          await relaunch();
        }
      } else {
        await message(t("notifications.latestVersion"));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t("notifications.updateCheckFailed");
      showUpdateErrorNotification(errorMessage, t);
    }
  }, [t]);

  const handleCut = useCallback(async () => {
    const activeElement = document.activeElement;

    if (activeElement && isInputElement(activeElement)) {
      const selectedText = getSelectedText(activeElement);
      if (!selectedText) return;

      try {
        await writeToClipboard(selectedText);
        replaceSelection(activeElement, "");
      } catch {
        try {
          document.execCommand(CLIPBOARD_OPERATIONS.CUT);
        } catch {}
      }
    } else {
      try {
        document.execCommand(CLIPBOARD_OPERATIONS.CUT);
      } catch {}
    }
  }, []);

  const handleCopy = useCallback(async () => {
    const activeElement = document.activeElement;

    if (activeElement && isInputElement(activeElement)) {
      const selectedText = getSelectedText(activeElement);
      if (selectedText) {
        try {
          await writeToClipboard(selectedText);
        } catch {
          // Silent fallback - copy operations often fail silently anyway
        }
      }
    } else {
      const selection = window.getSelection();
      const selectedText = selection?.toString().trim();

      if (selectedText) {
        try {
          await writeToClipboard(selectedText);
        } catch {
          try {
            document.execCommand(CLIPBOARD_OPERATIONS.COPY);
          } catch {}
        }
      }
    }
  }, []);

  const handlePaste = useCallback(async () => {
    const activeElement = document.activeElement;

    if (activeElement && isInputElement(activeElement)) {
      try {
        const clipboardText = await readFromClipboard();
        if (clipboardText) {
          replaceSelection(activeElement, clipboardText);
        }
      } catch {
        try {
          document.execCommand(CLIPBOARD_OPERATIONS.PASTE);
        } catch {}
      }
    } else if (activeElement && isContentEditableElement(activeElement)) {
      try {
        const clipboardText = await readFromClipboard();
        if (!clipboardText) return;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(clipboardText));
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        activeElement.dispatchEvent(new Event("input", { bubbles: true }));
        activeElement.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {
        // Let the browser handle it if possible.
      }
    } else {
      try {
        document.execCommand(CLIPBOARD_OPERATIONS.PASTE);
      } catch {}
    }
  }, []);

  const handleSelectAll = useCallback(() => {
    const activeElement = document.activeElement;

    if (activeElement && isInputElement(activeElement)) {
      activeElement.select();
    } else {
      try {
        document.execCommand(CLIPBOARD_OPERATIONS.SELECT_ALL);
      } catch {}
    }
  }, []);

  const handleGlobalKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const activeElement = document.activeElement;
      if (
        (activeElement && isInputElement(activeElement)) ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable)
      ) {
        return;
      }

      const isMac = navigator.platform.toLowerCase().includes("mac");
      const ctrlOrCmd = isMac ? e.metaKey : e.ctrlKey;

      if (!ctrlOrCmd || e.shiftKey || e.altKey) return;

      const keyActions: Record<string, () => void> = {
        x: () => {
          e.preventDefault();
          handleCut();
        },
        c: () => {
          e.preventDefault();
          handleCopy();
        },
        v: () => {
          e.preventDefault();
          handlePaste();
        },
        a: () => {
          e.preventDefault();
          handleSelectAll();
        },
      };

      const action = keyActions[e.key.toLowerCase()];
      if (action) {
        action();
      }
    },
    [handleCut, handleCopy, handlePaste, handleSelectAll],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => document.removeEventListener("keydown", handleGlobalKeyDown, true);
  }, [handleGlobalKeyDown]);

  const hotkeyBindings = useMemo(
    () =>
      [
        [keyMap.NEW_BOARD_TAB.keys, createNewTab],
        // Navigation - Primary Section
        [keyMap.GO_TO_DASHBOARD.keys, () => navigate({ to: "/" })],
        [
          keyMap.GO_TO_PROFILES.keys,
          () => {
            const existingProfileTab = tabs.find((t) => t.type === "profiles");
            if (existingProfileTab) {
              setActiveTab(existingProfileTab.value);
              navigate({ to: "/profiles" });
            } else {
              createTab({
                tab: { name: t("profiles.title", { defaultValue: "Profiles" }), type: "profiles" },
                setTabs,
                setActiveTab,
              });
              navigate({ to: "/profiles" });
            }
          },
        ],
        [keyMap.GO_TO_EVENTS.keys, () => navigate({ to: "/events" })],
        // Navigation - Primary Actions
        [
          keyMap.PLAY_BOARD.keys,
          () => {
            navigate({ to: "/play" });
            createTab({
              tab: { name: "Play", type: "play" },
              setTabs,
              setActiveTab,
            });
          },
        ],
        [
          keyMap.ANALYZE_BOARD.keys,
          () => {
            navigate({ to: "/analysis" });
            createTab({
              tab: { name: t("features.tabs.analysisBoard.title"), type: "analysis" },
              setTabs,
              setActiveTab,
              initialAnalysisTab: "analysis",
              initialAnalysisSubTab: "report",
              initialNotationView: "report" as const,
            });
          },
        ],
        [
          keyMap.TRAIN_BOARD.keys,
          () => {
            navigate({ to: "/puzzles" });
            createTab({
              tab: { name: t("features.tabs.puzzle.title"), type: "puzzles" },
              setTabs,
              setActiveTab,
            });
          },
        ],
        // Navigation - Secondary Section
        [keyMap.GO_TO_DATABASES.keys, () => navigate({ to: "/databases" })],
        [keyMap.GO_TO_ENGINES.keys, () => navigate({ to: "/engines" })],
        [keyMap.GO_TO_FILES.keys, () => navigate({ to: "/files" })],
        [keyMap.GO_TO_VARIANTS.keys, () => navigate({ to: "/variants" })],
        [keyMap.GO_TO_CHESSBASE.keys, () => navigate({ to: "/chessbase" })],
        // Navigation - Tertiary Section
        [keyMap.GO_TO_TOURNAMENTS.keys, () => navigate({ to: "/tournaments" })],
        [
          keyMap.IMPORT_BOARD.keys,
          () => {
            navigate({ to: "/analysis" });
            modals.openContextModal({
              modal: "importModal",
              innerProps: {},
            });
          },
        ],
        // File Operations
        [keyMap.OPEN_FILE.keys, openNewFile],
        [keyMap.APP_RELOAD.keys, () => location.reload()],
        [keyMap.EXIT_APP.keys, () => exit(0)],
        // Settings
        [keyMap.OPEN_SETTINGS.keys, () => navigate({ to: "/settings" })],
        [keyMap.SHOW_KEYBINDINGS.keys, () => navigate({ to: "/settings/keyboard-shortcuts" })],
        [keyMap.TOGGLE_HELP.keys, () => navigate({ to: "/settings/keyboard-shortcuts" })],
      ] as HotkeyItem[],
    [keyMap, createNewTab, navigate, t, setTabs, setActiveTab, openNewFile, tabs.find],
  );

  useHotkeys(hotkeyBindings);

  const handleClearData = useCallback(async () => {
    const confirmed = await ask(t("notifications.clearAllDataPrompt"), { title: t("notifications.clearAllData") });

    if (confirmed) {
      try {
        localStorage.clear();
        sessionStorage.clear();
        notifications.show({
          title: t("notifications.dataCleared"),
          message: t("notifications.dataClearedMessage"),
        });
        setTimeout(() => location.reload(), 1000);
      } catch {
        notifications.show({
          title: t("common.error"),
          message: t("notifications.failedToClearData"),
          color: "red",
        });
      }
    }
  }, [t]);

  const handleAbout = useCallback(() => {
    modals.openContextModal({
      modal: "aboutModal",
      title: t("notifications.aboutTitle"),
      innerProps: {},
    });
  }, [t]);

  const handleReportIssue = useCallback(async () => {
    await openPath("https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/issues/new/choose");
  }, []);

  const openRouteTab = useCallback(
    async (route: string, name: string) => {
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

      requestAnimationFrame(() => {
        try {
          navigate({ to: route as never });
        } catch {}
      });
    },
    [navigate, setActiveTab, setTabs, tabs],
  );

  const openProfilesPage = useCallback(async () => {
    const existingProfileTab = tabs.find((tab) => tab.type === "profiles");
    if (existingProfileTab) {
      setActiveTab(existingProfileTab.value);
      navigate({ to: "/profiles" });
      return;
    }

    await createTab({
      tab: { name: t("profiles.title", { defaultValue: "Profiles" }), type: "profiles" },
      setTabs,
      setActiveTab,
    });

    requestAnimationFrame(() => {
      navigate({ to: "/profiles" });
    });
  }, [navigate, setActiveTab, setTabs, t, tabs]);

  const openPlayBoard = useCallback(() => {
    navigate({ to: "/play" });
    createTab({
      tab: { name: t("features.tabs.playBoard.title"), type: "play" },
      setTabs,
      setActiveTab,
    });
  }, [navigate, setActiveTab, setTabs, t]);

  const openAnalysisBoard = useCallback(() => {
    navigate({ to: "/analysis" });
    createTab({
      tab: { name: t("features.tabs.analysisBoard.title"), type: "analysis" },
      setTabs,
      setActiveTab,
      initialAnalysisTab: "analysis",
      initialAnalysisSubTab: "report",
      initialNotationView: "report" as const,
    });
  }, [navigate, setActiveTab, setTabs, t]);

  const openPuzzlesBoard = useCallback(() => {
    navigate({ to: "/puzzles" });
    createTab({
      tab: { name: t("features.tabs.puzzle.title"), type: "puzzles" },
      setTabs,
      setActiveTab,
    });
  }, [navigate, setActiveTab, setTabs, t]);

  const handleCloseTab = useCallback(() => {
    void closeTab(activeTab);
  }, [activeTab, closeTab]);

  const handleCloseAllTabs = useCallback(() => {
    void closeAllTabsFromHook();
  }, [closeAllTabsFromHook]);

  const handleMinimizeWindow = useCallback(async () => {
    try {
      const webviewWindow = getCurrentWebviewWindow();
      await webviewWindow.minimize();
    } catch {}
  }, []);

  const handleToggleMaximize = useCallback(async () => {
    try {
      const webviewWindow = getCurrentWebviewWindow();
      await webviewWindow.toggleMaximize();
    } catch {}
  }, []);

  const _handleToggleFullScreen = useCallback(async () => {
    try {
      const webviewWindow = getCurrentWebviewWindow();
      const isFullscreen = await webviewWindow.isFullscreen();
      await webviewWindow.setFullscreen(!isFullscreen);
    } catch {}
  }, []);

  const menuHotkeyBindings = useMemo(
    () =>
      [
        [keyMap.ABOUT.keys, handleAbout],
        [keyMap.CHECK_FOR_UPDATES.keys, checkForUpdates],
        [keyMap.REPORT_ISSUE.keys, handleReportIssue],
        [keyMap.CLEAR_SAVED_DATA.keys, handleClearData],
        [keyMap.CLOSE_BOARD_TAB.keys, handleCloseTab],
        [keyMap.CLOSE_ALL_TABS.keys, handleCloseAllTabs],
        [keyMap.MINIMIZE_WINDOW.keys, handleMinimizeWindow],
        [keyMap.TOGGLE_MAXIMIZE_WINDOW.keys, handleToggleMaximize],
      ] as HotkeyItem[],
    [
      keyMap,
      handleAbout,
      checkForUpdates,
      handleReportIssue,
      handleClearData,
      handleCloseTab,
      handleCloseAllTabs,
      handleMinimizeWindow,
      handleToggleMaximize,
    ],
  );

  useHotkeys(menuHotkeyBindings);

  const menuActions: MenuGroup[] = useMemo(
    () => [
      {
        label: t("features.menu.pawnAppetit"),
        options: [
          {
            label: t("features.menu.about"),
            id: "about",
            shortcut: formatHotkeyDisplay(keyMap.ABOUT.keys),
            action: handleAbout,
          },
          { label: "divider" },
          {
            label: t("features.menu.checkUpdate"),
            id: "check_for_updates",
            shortcut: formatHotkeyDisplay(keyMap.CHECK_FOR_UPDATES.keys),
            action: checkForUpdates,
          },
          { label: "divider" },
          {
            label: t("features.menu.settings"),
            id: "settings",
            shortcut: formatHotkeyDisplay(keyMap.OPEN_SETTINGS.keys),
            action: () => void openRouteTab("/settings", t("features.sidebar.settings")),
          },
          { label: "divider" },
          {
            label: t("features.menu.quit"),
            id: "quit",
            shortcut: formatHotkeyDisplay(keyMap.EXIT_APP.keys),
            action: () => exit(0),
          },
        ],
      },
      {
        label: t("features.menu.file"),
        options: [
          {
            label: t("features.menu.newPlayBoard"),
            id: "new_play_board",
            shortcut: formatHotkeyDisplay(keyMap.PLAY_BOARD.keys),
            action: openPlayBoard,
          },
          {
            label: t("features.menu.newAnalysisBoard"),
            id: "new_analysis_board",
            shortcut: formatHotkeyDisplay(keyMap.ANALYZE_BOARD.keys),
            action: openAnalysisBoard,
          },
          {
            label: t("features.tabs.puzzle.title"),
            id: "new_puzzles_board",
            shortcut: formatHotkeyDisplay(keyMap.TRAIN_BOARD.keys),
            action: openPuzzlesBoard,
          },
        ],
      },
      {
        label: t("features.menu.view"),
        options: [
          {
            label: t("features.menu.commandPalette"),
            id: "command_palette",
            shortcut: formatHotkeyDisplay(keyMap.SPOTLIGHT_SEARCH.keys),
            action: () => spotlight.open(),
          },
          { label: "divider" },
          {
            label: t("features.menu.reload"),
            id: "reload",
            shortcut: formatHotkeyDisplay(keyMap.APP_RELOAD.keys),
            action: () => location.reload(),
          },
        ],
      },
      {
        label: t("features.menu.go"),
        options: [
          {
            label: t("features.menu.goToDashboard"),
            id: "go_dashboard",
            shortcut: formatHotkeyDisplay(keyMap.GO_TO_DASHBOARD.keys),
            action: () => void openRouteTab("/", t("features.sidebar.dashboard")),
          },
          {
            label: t("features.sidebar.profiles"),
            id: "go_profiles",
            shortcut: formatHotkeyDisplay(keyMap.GO_TO_PROFILES.keys),
            action: () => void openProfilesPage(),
          },
          {
            label: t("features.sidebar.events"),
            id: "go_events",
            shortcut: formatHotkeyDisplay(keyMap.GO_TO_EVENTS.keys),
            action: () => void openRouteTab("/events", t("features.sidebar.events")),
          },
          { label: "divider" },
          {
            label: t("features.menu.newPlayBoard"),
            id: "go_play_board",
            shortcut: formatHotkeyDisplay(keyMap.PLAY_BOARD.keys),
            action: openPlayBoard,
          },
          {
            label: t("features.menu.newAnalysisBoard"),
            id: "go_analysis_board",
            shortcut: formatHotkeyDisplay(keyMap.ANALYZE_BOARD.keys),
            action: openAnalysisBoard,
          },
          {
            label: t("features.tabs.puzzle.title"),
            id: "go_puzzles",
            shortcut: formatHotkeyDisplay(keyMap.TRAIN_BOARD.keys),
            action: openPuzzlesBoard,
          },
          { label: "divider" },
          {
            label: t("features.menu.goToFiles"),
            id: "go_files",
            shortcut: formatHotkeyDisplay(keyMap.GO_TO_FILES.keys),
            action: () => void openRouteTab("/files", t("features.sidebar.files")),
          },
          {
            label: t("features.menu.goToDatabases"),
            id: "go_databases",
            shortcut: formatHotkeyDisplay(keyMap.GO_TO_DATABASES.keys),
            action: () => void openRouteTab("/databases", t("features.sidebar.databases")),
          },
          {
            label: t("features.menu.goToEngines"),
            id: "go_engines",
            shortcut: formatHotkeyDisplay(keyMap.GO_TO_ENGINES.keys),
            action: () => void openRouteTab("/engines", t("features.sidebar.engines")),
          },
          {
            label: t("features.sidebar.variants"),
            id: "go_variants",
            shortcut: formatHotkeyDisplay(keyMap.GO_TO_VARIANTS.keys),
            action: () => void openRouteTab("/variants", t("features.sidebar.variants")),
          },
          {
            label: t("features.sidebar.chessbase"),
            id: "go_chessbase",
            shortcut: formatHotkeyDisplay(keyMap.GO_TO_CHESSBASE.keys),
            action: () => void openRouteTab("/chessbase", t("features.sidebar.chessbase")),
          },
          {
            label: t("features.sidebar.tournaments"),
            id: "go_tournaments",
            shortcut: formatHotkeyDisplay(keyMap.GO_TO_TOURNAMENTS.keys),
            action: () => void openRouteTab("/tournaments", t("features.sidebar.tournaments")),
          },
          { label: "divider" },
          {
            label: t("features.menu.goToSettings"),
            id: "go_settings",
            shortcut: formatHotkeyDisplay(keyMap.OPEN_SETTINGS.keys),
            action: () => void openRouteTab("/settings", t("features.sidebar.settings")),
          },
          {
            label: t("features.menu.goToKeyboardShortcuts"),
            id: "go_keyboard_shortcuts",
            shortcut: formatHotkeyDisplay(keyMap.SHOW_KEYBINDINGS.keys),
            action: () => void openRouteTab("/settings/keyboard-shortcuts", t("features.sidebar.keyboardShortcuts")),
          },
        ],
      },
      {
        label: t("features.menu.window"),
        options: [
          {
            label: t("features.menu.minimize"),
            id: "minimize",
            shortcut: formatHotkeyDisplay(keyMap.MINIMIZE_WINDOW.keys),
            action: handleMinimizeWindow,
          },
          {
            label: t("features.menu.zoom"),
            id: "zoom",
            shortcut: formatHotkeyDisplay(keyMap.TOGGLE_MAXIMIZE_WINDOW.keys),
            action: handleToggleMaximize,
          },
          { label: "divider" },
          {
            label: t("features.menu.closeTab"),
            id: "close_tab",
            shortcut: formatHotkeyDisplay(keyMap.CLOSE_BOARD_TAB.keys),
            action: handleCloseTab,
          },
          {
            label: t("features.menu.closeAllTabs"),
            id: "close_all_tabs",
            shortcut: formatHotkeyDisplay(keyMap.CLOSE_ALL_TABS.keys),
            action: handleCloseAllTabs,
          },
        ],
      },
      {
        label: t("features.menu.help"),
        options: [
          {
            label: t("features.menu.reportIssue"),
            id: "report_issue",
            shortcut: formatHotkeyDisplay(keyMap.REPORT_ISSUE.keys),
            action: handleReportIssue,
          },
          { label: "divider" },
          {
            label: t("features.menu.clearSavedData"),
            id: "clear_saved_data",
            shortcut: formatHotkeyDisplay(keyMap.CLEAR_SAVED_DATA.keys),
            action: handleClearData,
          },
        ],
      },
    ],
    [
      t,
      keyMap,
      openRouteTab,
      openProfilesPage,
      openPlayBoard,
      openAnalysisBoard,
      openPuzzlesBoard,
      handleClearData,
      checkForUpdates,
      handleAbout,
      handleReportIssue,
      handleCloseTab,
      handleCloseAllTabs,
      handleMinimizeWindow,
      handleToggleMaximize,
    ],
  );

  useEffect(() => {
    if (layout.menuBar.mode === "disabled") return;

    const applyWindowChrome = async () => {
      try {
        const emptyMenu = await Menu.new();
        await emptyMenu.setAsAppMenu();
      } catch {}

      try {
        const webviewWindow = getCurrentWebviewWindow();
        await webviewWindow.setDecorations(false);
      } catch {}
    };

    void applyWindowChrome();
  }, [layout.menuBar.mode]);

  return (
    <ModalsProvider modals={{ importModal: ImportModal, aboutModal: AboutModal }}>
      <AppShell
        {...layout.appShellProps}
        style={{ height: "100%", minHeight: 0 }}
        styles={{
          main: {
            userSelect: "none",
            minHeight: 0,
            height: "100%",
            flex: 1,
          },
          footer: {
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          },
        }}
      >
        <AppShell.Header>
          <MayaHeader menuActions={menuActions} />
        </AppShell.Header>
        <AppShell.Navbar>{layout.sidebar.position === "navbar" && <SideBar />}</AppShell.Navbar>
        <AppShell.Main style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <Outlet />
          </div>
        </AppShell.Main>
        <AppShell.Footer style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
          {layout.sidebar.position === "footer" && <SideBar />}
        </AppShell.Footer>

        <Spotlight
          actions={getSpotlightActions(navigate, t)}
          shortcut={keyMap.SPOTLIGHT_SEARCH.keys}
          nothingFound={t("spotlight.nothingFound")}
          highlightQuery
          searchProps={{ placeholder: t("spotlight.searchPlaceholder") }}
          scrollable
        />
      </AppShell>
    </ModalsProvider>
  );
}
