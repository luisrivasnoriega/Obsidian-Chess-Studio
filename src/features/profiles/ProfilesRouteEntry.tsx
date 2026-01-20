import { useAtom } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import BoardsPage from "@/features/boards/BoardsPage";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { debugNavLog } from "@/utils/debugNav";
import { createTab } from "@/utils/tabs";

export default function ProfilesRouteEntry() {
  const { t } = useTranslation();
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [activeTab, setActiveTab] = useAtom(activeTabAtom);

  const active = useMemo(() => tabs.find((tab) => tab.value === activeTab) ?? null, [activeTab, tabs]);
  const ensuredOnceRef = useRef(false);

  useEffect(() => {
    // Only ensure once per route mount.
    // This prevents the profiles tab from being recreated after the user closes it.
    if (ensuredOnceRef.current) return;
    ensuredOnceRef.current = true;

    // Check if there's an existing profiles tab
    const existing = tabs.find((tab) => tab.type === "profiles") ?? null;

    debugNavLog("profiles-route-entry:init", { tabs: tabs.length, activeTab, activeType: active?.type ?? null });

    if (existing) {
      // If there is no active tab (e.g. after storage restore), activate the existing profiles tab.
      if (!active) {
        setActiveTab(existing.value);
      }
      return;
    }

    // Create a new profiles tab only on initial mount, if none exists.
    void createTab({
      tab: { name: t("profiles.title", { defaultValue: "Profiles" }), type: "profiles" },
      setTabs,
      setActiveTab,
    });
  }, [active, activeTab, setActiveTab, setTabs, tabs, t]);

  // Always render BoardsPage which will handle the tab rendering
  return <BoardsPage />;
}
