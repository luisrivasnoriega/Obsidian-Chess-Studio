import { Portal, Stack } from "@mantine/core";
import React, { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAtomValue } from "jotai";
import GameNotation from "@/components/GameNotation";
import MoveControls from "@/components/MoveControls";
import { ResponsiveLoadingWrapper } from "@/components/ResponsiveLoadingWrapper";
import { ResponsiveSkeleton } from "@/components/ResponsiveSkeleton";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { currentTabAtom } from "@/state/atoms";
import { useSimulatedInit } from "./hooks/useSimulatedInit";

interface GameNotationWrapperProps {
  topBar?: boolean;
  editingMode?: boolean;
  editingCard?: React.ReactNode;
  isLoading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  children?: ReactNode;
}

function GameNotationWrapper({
  topBar = false,
  editingMode = false,
  editingCard,
  isLoading = false,
  error = null,
  onRetry,
  children = null,
}: GameNotationWrapperProps) {
  const { t } = useTranslation();
  const { layout } = useResponsiveLayout();
  const currentTab = useAtomValue(currentTabAtom);
  const [initialVariationState, setInitialVariationState] = useState<"variations" | "repertoire" | "report">("report");

  // Read initial configuration from sessionStorage and set notation view if configured
  useEffect(() => {
    if (currentTab?.value && typeof window !== "undefined") {
      const configKey = `${currentTab.value}_initialConfig`;
      const configJson = sessionStorage.getItem(configKey);
      if (configJson) {
        try {
          const config = JSON.parse(configJson);
          if (config.notationView && ["variations", "repertoire", "report"].includes(config.notationView)) {
            setInitialVariationState(config.notationView as "variations" | "repertoire" | "report");
            // Remove notationView from config, or remove entire config if it's the only key
            const updatedConfig = { ...config };
            delete updatedConfig.notationView;
            if (Object.keys(updatedConfig).length === 0) {
              sessionStorage.removeItem(configKey);
            } else {
              sessionStorage.setItem(configKey, JSON.stringify(updatedConfig));
            }
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }
    }
  }, [currentTab?.value]);

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
      portalTarget: isNotationUnderBoard ? "#bottom" : "#bottomRight",
      stackDirection: isNotationUnderBoard ? ("column" as const) : ("column" as const),
      gap: isNotationUnderBoard ? "md" : "xs",
    };
  }, [layout.gameNotationUnderBoard]);
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
    <Stack h={renderInline ? "auto" : "100%"} gap={positioning.gap} style={{ flexDirection: positioning.stackDirection }}>
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

  const portalTarget =
    typeof document !== "undefined" ? document.querySelector(positioning.portalTarget) : null;

  if (!portalTarget) {
    return analysisContent;
  }

  return (
    <Portal target={positioning.portalTarget} style={{ height: "100%" }}>
      {analysisContent}
    </Portal>
  );
}

export default memo(GameNotationWrapper);
