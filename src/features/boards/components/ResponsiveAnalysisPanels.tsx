import { ActionIcon, Box, Collapse, Group, Paper, Select, Stack, Tabs, Text } from "@mantine/core";
import { useMediaQuery, useToggle } from "@mantine/hooks";
import {
  IconChevronDown,
  IconChevronUp,
  IconDatabase,
  IconGraphFilled,
  IconInfoCircle,
  IconNotes,
  IconPlayerPlay,
  IconTargetArrow,
  IconZoomCheck,
} from "@tabler/icons-react";
import { memo, Suspense, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import AnalysisPanel from "@/components/panels/analysis/AnalysisPanel";
import AnnotationPanel from "@/components/panels/annotation/AnnotationPanel";
import DatabasePanel from "@/components/panels/database/DatabasePanel";
import InfoPanel from "@/components/panels/info/InfoPanel";
import GraphPanel from "@/components/panels/practice/GraphPanel";
import PracticePanel from "@/components/panels/practice/PracticePanel";
import SimulatePanel from "@/components/panels/simulate/SimulatePanel";
import { ResponsiveLoadingWrapper } from "@/components/ResponsiveLoadingWrapper";
import { ResponsiveSkeleton } from "@/components/ResponsiveSkeleton";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { useSimulatedInit } from "./hooks/useSimulatedInit";

interface ResponsiveAnalysisPanelsProps {
  currentTab?: string | null;
  onTabChange?: (value: string | null) => void;
  isRepertoire?: boolean;
  isPuzzle?: boolean;
  showSimulate?: boolean;
  isLoading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  disableCollapse?: boolean;
  renderAsSelect?: boolean;
  unstyledContainer?: boolean;
  selectStartsEmpty?: boolean;
}

function ResponsiveAnalysisPanels({
  currentTab = "info",
  onTabChange,
  isRepertoire = false,
  isPuzzle = false,
  showSimulate = false,
  isLoading = false,
  error = null,
  onRetry,
  disableCollapse = false,
  renderAsSelect = false,
  unstyledContainer = false,
  selectStartsEmpty = false,
}: ResponsiveAnalysisPanelsProps) {
  const { t } = useTranslation();
  const { layout } = useResponsiveLayout();
  const isMobile = useMediaQuery("(max-width: 48em)");
  const [isCollapsed, toggleCollapsed] = useToggle([false, true]);
  const { isInitializing, initializationError, retry } = useSimulatedInit({ onRetry });

  const tabOptions = useMemo(() => {
    const baseOptions: Record<string, { value: string; label: string }> = {};
    const orderedKeys = ["analysis", "database", "graph", "practice", "simulate", "annotate", "info"];

    if (isRepertoire) {
      baseOptions.graph = { value: "graph", label: t("features.board.tabs.graph") };
      baseOptions.practice = { value: "practice", label: t("features.board.tabs.practice") };
    }
    if (!isPuzzle) {
      baseOptions.analysis = { value: "analysis", label: t("features.board.tabs.analysis") };
      baseOptions.database = { value: "database", label: t("features.board.tabs.database") };
      if (showSimulate) {
        baseOptions.simulate = { value: "simulate", label: t("features.board.tabs.simulate") };
      }
      baseOptions.annotate = { value: "annotate", label: t("features.board.tabs.annotate") };
    }
    baseOptions.info = { value: "info", label: t("features.board.tabs.info") };

    return orderedKeys.reduce<Array<{ value: string; label: string }>>((acc, key) => {
      if (baseOptions[key]) {
        acc.push(baseOptions[key]);
      }
      return acc;
    }, []);
  }, [isPuzzle, isRepertoire, t, showSimulate]);

  const resolvedTabValue = useMemo(() => {
    if (tabOptions.some((option) => option.value === currentTab)) {
      return currentTab;
    }
    return tabOptions[0]?.value ?? null;
  }, [currentTab, tabOptions]);

  useEffect(() => {
    if (!renderAsSelect) return;
    if (selectStartsEmpty) return;
    if (!tabOptions.length) return;
    if (!tabOptions.some((option) => option.value === currentTab)) {
      onTabChange?.(tabOptions[0].value);
    }
  }, [currentTab, onTabChange, renderAsSelect, selectStartsEmpty, tabOptions]);

  // Error handling for analysis panels initialization
  const handleRetry = useCallback(() => {
    retry();
  }, [retry]);

  // Determine if panels should be collapsible
  const shouldCollapse = !disableCollapse && !renderAsSelect && layout.chessBoard.touchOptimized;
  const showControlsRail = !shouldCollapse && !renderAsSelect && layout.chessBoard.layoutType !== "mobile";
  const isInlineMobilePanel = layout.chessBoard.layoutType === "mobile" && renderAsSelect;
  const mobilePanelHeight = "min(42vh, 28rem)";

  // Set default collapsed state based on layout
  useEffect(() => {
    if (shouldCollapse) {
      toggleCollapsed(true); // Collapse by default on mobile
    } else {
      toggleCollapsed(false); // Expand by default on desktop
    }
  }, [shouldCollapse, toggleCollapsed]);

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
        <div>{t("errors.failedToLoadAnalysisPanels")}</div>
        <button type="button" onClick={handleRetry}>
          {t("common.reset")}
        </button>
      </Stack>
    );
  }

  // Render the analysis panels
  const containerStyle = {
    height: isInlineMobilePanel ? mobilePanelHeight : "100%",
    minHeight: isInlineMobilePanel ? "16rem" : 0,
    minWidth: 0,
    overflowX: "hidden" as const,
    overflowY: isInlineMobilePanel ? ("auto" as const) : ("hidden" as const),
    display: "flex",
    flexDirection: "row",
    touchAction: isInlineMobilePanel ? ("pan-y" as const) : undefined,
    WebkitOverflowScrolling: isInlineMobilePanel ? ("touch" as const) : undefined,
  } as const;
  const tabPanelStyle = {
    overflow: isInlineMobilePanel ? ("visible" as const) : ("hidden" as const),
    minHeight: 0,
    minWidth: 0,
    display: "flex",
    flexDirection: "column" as const,
  };

  const Container = unstyledContainer ? Box : Paper;
  const containerProps = unstyledContainer
    ? { style: containerStyle }
    : {
        withBorder: true,
        p: "xs" as const,
        style: containerStyle,
        pos: "relative" as const,
      };

  const analysisContent = (
    <Container {...(containerProps as any)}>
      {showControlsRail && (
        <Box
          id="board-controls-rail"
          style={{
            flex: "0 0 auto",
            width: "3rem",
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            alignItems: "stretch",
            justifyContent: "center",
            borderRight: "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))",
            paddingRight: "0.5rem",
            marginRight: "0.5rem",
            overflow: "hidden",
          }}
        />
      )}

      <Tabs
        w="100%"
        h={isInlineMobilePanel ? undefined : "100%"}
        value={resolvedTabValue}
        onChange={onTabChange}
        color="gold.4"
        keepMounted={false}
        activateTabWithKeyboard={false}
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
          touchAction: isInlineMobilePanel ? "pan-y" : undefined,
        }}
      >
        {renderAsSelect ? (
          <Select
            data={tabOptions}
            placeholder={t("common.options")}
            value={resolvedTabValue}
            onChange={(value) => onTabChange?.(value ?? tabOptions[0]?.value ?? null)}
            allowDeselect={false}
            mb="1rem"
            w="100%"
            comboboxProps={{ withinPortal: false, zIndex: 4000 }}
            variant="unstyled"
            styles={{
              root: {
                width: "100%",
              },
              input: {
                border: "none",
                background: "transparent",
                textAlign: "center",
              },
              section: {
                border: "none",
                background: "transparent",
              },
            }}
          />
        ) : (
          <Tabs.List
            grow={!isMobile}
            mb="1rem"
            style={
              isMobile
                ? {
                    justifyContent: "center",
                    display: "flex",
                    touchAction: isInlineMobilePanel ? "pan-y" : undefined,
                  }
                : undefined
            }
          >
            {!isPuzzle && (
              <Tabs.Tab value="analysis" leftSection={<IconZoomCheck size="1rem" />}>
                {t("features.board.tabs.analysis")}
              </Tabs.Tab>
            )}
            {!isPuzzle && (
              <Tabs.Tab value="database" leftSection={<IconDatabase size="1rem" />}>
                {t("features.board.tabs.database")}
              </Tabs.Tab>
            )}
            {isRepertoire && (
              <Tabs.Tab value="graph" leftSection={<IconGraphFilled size="1rem" />}>
                {t("features.board.tabs.graph")}
              </Tabs.Tab>
            )}
            {isRepertoire && (
              <Tabs.Tab value="practice" leftSection={<IconTargetArrow size="1rem" />}>
                {t("features.board.tabs.practice")}
              </Tabs.Tab>
            )}
            {!isPuzzle && showSimulate && (
              <Tabs.Tab value="simulate" leftSection={<IconPlayerPlay size="1rem" />}>
                {t("features.board.tabs.simulate")}
              </Tabs.Tab>
            )}
            {!isPuzzle && (
              <Tabs.Tab value="annotate" leftSection={<IconNotes size="1rem" />}>
                {t("features.board.tabs.annotate")}
              </Tabs.Tab>
            )}
            <Tabs.Tab value="info" leftSection={<IconInfoCircle size="1rem" />}>
              {t("features.board.tabs.info")}
            </Tabs.Tab>
          </Tabs.List>
        )}
        {isRepertoire && (
          <Tabs.Panel value="practice" flex={1} style={tabPanelStyle}>
            <Suspense>
              <PracticePanel />
            </Suspense>
          </Tabs.Panel>
        )}
        {isRepertoire && (
          <Tabs.Panel value="graph" flex={1} style={tabPanelStyle}>
            <Suspense>
              <GraphPanel />
            </Suspense>
          </Tabs.Panel>
        )}
        {!isPuzzle && showSimulate && (
          <Tabs.Panel value="simulate" flex={1} style={tabPanelStyle}>
            <SimulatePanel />
          </Tabs.Panel>
        )}
        <Tabs.Panel value="info" flex={1} style={tabPanelStyle}>
          <InfoPanel />
        </Tabs.Panel>
        <Tabs.Panel value="database" flex={1} style={tabPanelStyle}>
          <DatabasePanel />
        </Tabs.Panel>
        <Tabs.Panel value="annotate" flex={1} style={tabPanelStyle}>
          <AnnotationPanel />
        </Tabs.Panel>
        <Tabs.Panel value="analysis" flex={1} style={tabPanelStyle}>
          <Suspense>
            <AnalysisPanel />
          </Suspense>
        </Tabs.Panel>
      </Tabs>
    </Container>
  );

  // If panels should be collapsible, wrap in collapsible container
  if (shouldCollapse) {
    return (
      <Stack gap="xs">
        <Group justify="space-between" align="center">
          <Text size="sm" fw={500}>
            Analysis Panels
          </Text>
          <ActionIcon variant="subtle" size="sm" onClick={() => toggleCollapsed()}>
            {isCollapsed ? <IconChevronDown size="1rem" /> : <IconChevronUp size="1rem" />}
          </ActionIcon>
        </Group>
        <Collapse in={!isCollapsed}>{!isCollapsed ? analysisContent : null}</Collapse>
      </Stack>
    );
  }

  // Return full panels for desktop
  return analysisContent;
}

export default memo(ResponsiveAnalysisPanels);
