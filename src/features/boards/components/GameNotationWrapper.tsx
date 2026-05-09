import { Portal, Stack } from "@mantine/core";
import { useAtom } from "jotai";
import React, { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import GameNotation from "@/components/GameNotation";
import MoveControls from "@/components/MoveControls";
import { ResponsiveLoadingWrapper } from "@/components/ResponsiveLoadingWrapper";
import { ResponsiveSkeleton } from "@/components/ResponsiveSkeleton";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { currentTabAtom } from "@/state/atoms";
import { getLegacyAnalysisInitialConfig, removeAnalysisInitialConfigField } from "@/utils/tabs";
import { useSimulatedInit } from "./hooks/useSimulatedInit";

interface GameNotationWrapperProps {
  topBar?: boolean;
  editingMode?: boolean;
  editingCard?: React.ReactNode;
  portalTargetOverride?: string;
  isLoading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  children?: ReactNode;
}

function GameNotationWrapper({
  topBar = false,
  editingMode = false,
  editingCard,
  portalTargetOverride,
  isLoading = false,
  error = null,
  onRetry,
  children = null,
}: GameNotationWrapperProps) {
  const { t } = useTranslation();
  const { layout } = useResponsiveLayout();
  const [currentTab, setCurrentTab] = useAtom(currentTabAtom);
  const [initialVariationState, setInitialVariationState] = useState<"variations" | "repertoire" | "report">("report");

  // Apply one-shot initial configuration attached to the tab. Legacy sessionStorage is only a fallback for old tabs.
  useEffect(() => {
    if (!currentTab?.value) return;

    const typedConfig = currentTab.meta?.initialConfig;
    const legacyConfig = typedConfig ? null : getLegacyAnalysisInitialConfig(currentTab.value);
    const notationView = typedConfig?.notationView ?? legacyConfig?.notationView;
    if (!notationView || !["variations", "repertoire", "report"].includes(notationView)) return;

    setInitialVariationState(notationView);

    if (typedConfig?.notationView) {
      setCurrentTab((prev) => {
        if (prev.value !== currentTab.value) return prev;
        return removeAnalysisInitialConfigField(prev, "notationView");
      });
      return;
    }

    if (legacyConfig?.notationView && typeof window !== "undefined") {
      const configKey = `${currentTab.value}_initialConfig`;
      const updatedConfig = { ...legacyConfig };
      delete updatedConfig.notationView;
      if (Object.keys(updatedConfig).length === 0) {
        sessionStorage.removeItem(configKey);
      } else {
        try {
          sessionStorage.setItem(configKey, JSON.stringify(updatedConfig));
        } catch {
          // Ignore storage errors
        }
      }
    }
  }, [currentTab?.value, currentTab?.meta?.initialConfig, setCurrentTab]);

  const { isInitializing, initializationError, retry } = useSimulatedInit({ onRetry });

  // Error handling for analysis panel initialization
  const handleRetry = useCallback(() => {
    retry();
  }, [retry]);

  // Calculate responsive positioning
  const positioning = useMemo(() => {
    const isNotationUnderBoard = layout.gameNotationUnderBoard;

    return {
      isNotationUnderBoard,
      portalTarget: isNotationUnderBoard ? "#bottom" : (portalTargetOverride ?? "#bottomRight"),
      stackDirection: isNotationUnderBoard ? ("column" as const) : ("column" as const),
      gap: isNotationUnderBoard ? "md" : "xs",
    };
  }, [layout.gameNotationUnderBoard, portalTargetOverride]);
  const renderInline = layout.chessBoard.layoutType === "mobile";

  // Show loading state
  if (isLoading || isInitializing) {
    return (
      <ResponsiveLoadingWrapper isLoading={true}>
        <ResponsiveSkeleton type="default" />
      </ResponsiveLoadingWrapper>
    );
  }

  // Show error state
  if (error || initializationError) {
    return (
      <Stack align="center" gap="md">
        <div>{t("errors.failedToLoadGameAnalysis")}</div>
        <button type="button" onClick={handleRetry}>
          {t("common.reset")}
        </button>
      </Stack>
    );
  }

  // Render the analysis panels
  // If children are provided and they're not just MoveControls, render only those (like VariantsNotation)
  // Otherwise, render GameNotation with optional additional children (like MoveControls)
  const hasCustomNotation = React.Children.toArray(children).some(
    (child) => React.isValidElement(child) && child.type !== MoveControls,
  );

  const analysisContent = (
    <Stack
      h={renderInline ? "auto" : "100%"}
      gap={positioning.gap}
      style={{ flexDirection: positioning.stackDirection }}
    >
      {editingMode && editingCard ? (
        editingCard
      ) : hasCustomNotation ? (
        // Custom notation component (like VariantsNotation) - render only those
        children
      ) : (
        // Default: render GameNotation with optional additional children (like MoveControls)
        <>
          <GameNotation topBar={topBar} initialVariationState={initialVariationState} />
          {children}
        </>
      )}
    </Stack>
  );

  if (renderInline) {
    return analysisContent;
  }

  return (
    <Portal target={positioning.portalTarget} style={{ height: "100%" }}>
      {analysisContent}
    </Portal>
  );
}

export default memo(GameNotationWrapper);
