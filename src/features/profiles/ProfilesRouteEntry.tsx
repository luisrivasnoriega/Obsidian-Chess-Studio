import { useAtom } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { createTab } from "@/utils/tabs";
import { debugNavLog } from "@/utils/debugNav";
import BoardsPage from "@/features/boards/BoardsPage";

export default function ProfilesRouteEntry() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [activeTab, setActiveTab] = useAtom(activeTabAtom);

  const active = useMemo(() => tabs.find((tab) => tab.value === activeTab) ?? null, [activeTab, tabs]);
  const ensureKey = `profiles:${tabs.length}:${activeTab ?? ""}`;
  const lastEnsureKey = useRef<string | null>(null);

  useEffect(() => {
    debugNavLog("profiles-route-entry", { tabs: tabs.length, activeTab, activeType: active?.type ?? null });
    if (lastEnsureKey.current === ensureKey) return;
    lastEnsureKey.current = ensureKey;

    // Check if there's an existing profiles tab
    const existing = tabs.find((tab) => tab.type === "profiles") ?? null;
    
    // If we have a profiles tab and it's active, we're good
    if (existing && active && active.value === existing.value) {
      debugNavLog("profiles-route-entry: profiles tab is active", { tab: existing.value, type: existing.type });
      return;
    }

    // If we have a profiles tab but it's not active, don't switch to it automatically
    // This allows other tabs (like analysis tabs opened from openings) to remain active
    // The tab will remain in the background and can be switched to manually
    if (existing && active && active.type !== "profiles") {
      debugNavLog("profiles-route-entry: profiles tab exists but not active, keeping current tab", { 
        activeTab: active.type,
        profilesTab: existing.value 
      });
      return;
    }

    // If active tab is a profiles tab, we're good
    if (active && active.type === "profiles") {
      debugNavLog("profiles-route-entry: active tab already matches", { tab: active.value, type: active.type });
      return;
    }

    // If we have an existing profiles tab but no active tab, activate it
    if (existing && !active) {
      debugNavLog("profiles-route-entry: activating existing profiles tab", { tab: existing.value, type: existing.type });
      setActiveTab(existing.value);
      return;
    }

    // Create a new profiles tab only if none exists
    if (!existing) {
      debugNavLog("profiles-route-entry: creating new tab");
      void createTab({
        tab: { name: t("profiles.title", { defaultValue: "Profiles" }), type: "profiles" },
        setTabs,
        setActiveTab,
      });
    }
  }, [active, ensureKey, navigate, setActiveTab, setTabs, tabs, t]);

  // Always render BoardsPage which will handle the tab rendering
  return <BoardsPage />;
}

