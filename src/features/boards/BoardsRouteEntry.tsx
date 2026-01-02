import { useAtom } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { createTab, type Tab } from "@/utils/tabs";
import { debugNavLog } from "@/utils/debugNav";
import BoardsPage from "./BoardsPage";

type EntryMode = "play" | "analysis" | "puzzles";

function isTabMode(tab: Tab, mode: EntryMode): boolean {
  if (mode === "analysis") return tab.type === "analysis" || tab.type === "new";
  return tab.type === mode;
}

export function getRouteForTab(tab: Tab | null | undefined): "/play" | "/analysis" | "/puzzles" {
  if (!tab) return "/analysis";
  if (tab.type === "play") return "/play";
  if (tab.type === "puzzles") return "/puzzles";
  return "/analysis";
}

export default function BoardsRouteEntry({ mode }: { mode: EntryMode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [activeTab, setActiveTab] = useAtom(activeTabAtom);

  const active = useMemo(() => tabs.find((tab) => tab.value === activeTab) ?? null, [activeTab, tabs]);
  const ensureKey = `${mode}:${tabs.length}:${activeTab ?? ""}`;
  const lastEnsureKey = useRef<string | null>(null);

  useEffect(() => {
    debugNavLog("route-entry", { mode, tabs: tabs.length, activeTab, activeType: active?.type ?? null });
    if (lastEnsureKey.current === ensureKey) return;
    lastEnsureKey.current = ensureKey;

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
          navigate({ to: getRouteForTab(active) });
          return;
        }
      }
    } catch {}

    const existing = tabs.find((tab) => isTabMode(tab, mode)) ?? null;
    if (existing) {
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
  }, [active, ensureKey, mode, navigate, setActiveTab, setTabs, tabs, t]);

  return <BoardsPage />;
}
