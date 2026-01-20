import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useAtom } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { debugNavLog } from "@/utils/debugNav";
import { createTab, type Tab } from "@/utils/tabs";
import BoardsPage from "./BoardsPage";

type EntryMode = "play" | "analysis" | "puzzles";

function isTabMode(tab: Tab, mode: EntryMode): boolean {
  if (mode === "analysis") return tab.type === "analysis" || tab.type === "new";
  return tab.type === mode;
}

export function getRouteForTab(tab: Tab | null | undefined): string {
  if (!tab) return "/analysis";
  if (tab.route) return tab.route;
  if (tab.type === "play") return "/play";
  if (tab.type === "puzzles") return "/puzzles";
  if (tab.type === "profiles") return "/profiles";
  return "/analysis";
}

export default function BoardsRouteEntry({ mode }: { mode: EntryMode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [activeTab, setActiveTab] = useAtom(activeTabAtom);
  const currentPath = routerState.location.pathname;

  const active = useMemo(() => tabs.find((tab) => tab.value === activeTab) ?? null, [activeTab, tabs]);
  const ensureKey = `${mode}:${tabs.length}:${activeTab ?? ""}`;
  const lastEnsureKey = useRef<string | null>(null);

  useEffect(() => {
    debugNavLog("route-entry", { mode, tabs: tabs.length, activeTab, activeType: active?.type ?? null, currentPath });
    if (lastEnsureKey.current === ensureKey) return;
    lastEnsureKey.current = ensureKey;

    // Don't navigate if we're on /profiles and the active tab is not of this mode
    // This allows tabs created from profiles (like analysis tabs from openings) to remain active
    // without forcing navigation away from /profiles
    if (currentPath === "/profiles" && active && !isTabMode(active, mode)) {
      debugNavLog("route-entry: skipping navigation - on /profiles with different tab type", {
        activeType: active.type,
        mode,
      });
      return;
    }

    if (tabs.length === 0) {
      try {
        if (sessionStorage.getItem("tabsClosedToZero") === "1") {
          sessionStorage.removeItem("tabsClosedToZero");
          navigate({ to: "/" });
          return;
        }
      } catch {}

      debugNavLog("route-entry: creating initial tab", mode);
      void createTab({
        tab:
          mode === "play"
            ? { name: t("features.tabs.playBoard.title"), type: "play" }
            : mode === "puzzles"
              ? { name: t("features.tabs.puzzle.title"), type: "puzzles" }
              : { name: t("features.tabs.analysisBoard.title"), type: "analysis" },
        setTabs,
        setActiveTab,
        ...(mode === "analysis"
          ? {
              initialAnalysisTab: "analysis",
              initialAnalysisSubTab: "report",
              initialNotationView: "report" as const,
            }
          : {}),
      });
      return;
    }

    if (active && isTabMode(active, mode)) {
      debugNavLog("route-entry: active tab already matches", { tab: active.value, type: active.type });
      return;
    }

    // When a tab close action leaves this route-mode without any tabs,
    // do not recreate a fresh tab: navigate to whatever tab is now active.
    try {
      const skipMode = sessionStorage.getItem("boardsRouteEntry.skipEnsureOnce");
      if (skipMode === mode) {
        sessionStorage.removeItem("boardsRouteEntry.skipEnsureOnce");
        if (active) {
          // Don't navigate if we're on /profiles - allow the user to stay there
          if (currentPath === "/profiles") {
            debugNavLog("route-entry: skipping navigation after tab close - on /profiles", {
              activeType: active.type,
            });
            return;
          }
          navigate({ to: getRouteForTab(active) });
          return;
        }
      }
    } catch {}

    const existing = tabs.find((tab) => isTabMode(tab, mode)) ?? null;
    if (existing) {
      // Don't switch tabs if we're on /profiles - allow the user to stay there
      if (currentPath === "/profiles") {
        debugNavLog("route-entry: skipping tab switch - on /profiles", {
          existingTab: existing.value,
          activeTab: active?.value,
        });
        return;
      }
      debugNavLog("route-entry: switching to existing tab", { tab: existing.value, type: existing.type });
      setActiveTab(existing.value);
      return;
    }

    debugNavLog("route-entry: creating new tab", mode);
    void createTab({
      tab:
        mode === "play"
          ? { name: t("features.tabs.playBoard.title"), type: "play" }
          : mode === "puzzles"
            ? { name: t("features.tabs.puzzle.title"), type: "puzzles" }
            : { name: t("features.tabs.analysisBoard.title"), type: "analysis" },
      setTabs,
      setActiveTab,
      ...(mode === "analysis"
        ? {
            initialAnalysisTab: "analysis",
            initialAnalysisSubTab: "report",
            initialNotationView: "report" as const,
          }
        : {}),
    });
  }, [active, ensureKey, mode, navigate, setActiveTab, setTabs, tabs, t, activeTab, currentPath]);

  return <BoardsPage />;
}
