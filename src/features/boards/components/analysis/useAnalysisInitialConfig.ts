import { useEffect } from "react";
import { getLegacyAnalysisInitialConfig, removeAnalysisInitialConfigField } from "@/utils/tabs";
import type { AnalysisBoardState } from "./types";

type UseAnalysisInitialConfigArgs = Pick<
  AnalysisBoardState,
  "currentTab" | "currentTabSelected" | "setCurrentTab" | "setCurrentTabSelected"
>;

export function useAnalysisInitialConfig({
  currentTab,
  currentTabSelected,
  setCurrentTab,
  setCurrentTabSelected,
}: UseAnalysisInitialConfigArgs) {
  useEffect(() => {
    if (!currentTab?.value) return;

    const typedConfig = currentTab.meta?.initialConfig;
    const legacyConfig = typedConfig ? null : getLegacyAnalysisInitialConfig(currentTab.value);
    const analysisTab = typedConfig?.analysisTab ?? legacyConfig?.analysisTab;
    if (!analysisTab) return;

    if (currentTabSelected !== analysisTab) {
      setCurrentTabSelected(analysisTab);
    }

    if (typedConfig?.analysisTab) {
      setCurrentTab((prev) => {
        if (prev.value !== currentTab.value) return prev;
        return removeAnalysisInitialConfigField(prev, "analysisTab");
      });
      return;
    }

    if (legacyConfig?.analysisTab && typeof window !== "undefined") {
      const configKey = `${currentTab.value}_initialConfig`;
      const updatedConfig = { ...legacyConfig };
      delete updatedConfig.analysisTab;
      if (Object.keys(updatedConfig).length === 0) {
        sessionStorage.removeItem(configKey);
      } else {
        try {
          sessionStorage.setItem(configKey, JSON.stringify(updatedConfig));
        } catch {
          // Ignore storage errors.
        }
      }
    }
  }, [currentTab?.value, currentTab?.meta?.initialConfig, currentTabSelected, setCurrentTab, setCurrentTabSelected]);
}
