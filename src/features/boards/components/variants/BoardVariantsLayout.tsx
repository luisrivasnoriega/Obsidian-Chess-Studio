import { Box, Paper, Stack, Tabs } from "@mantine/core";
import { type CSSProperties, type ReactNode, Suspense } from "react";
import { useTranslation } from "react-i18next";
import MoveControls from "@/components/MoveControls";
import AnalysisPanel from "@/components/panels/analysis/AnalysisPanel";
import LogsPanel from "@/components/panels/analysis/LogsPanel";
import ReportPanel from "@/components/panels/analysis/ReportPanel";
import AnnotationPanel from "@/components/panels/annotation/AnnotationPanel";
import DatabasePanel from "@/components/panels/database/DatabasePanel";
import InfoPanel from "@/components/panels/info/InfoPanel";
import GraphPanel from "@/components/panels/practice/GraphPanel";
import PracticePanel from "@/components/panels/practice/PracticePanel";
import { ResponsiveSkeleton } from "@/components/ResponsiveSkeleton";
import EditingCard from "../EditingCard";
import EvalListener from "../EvalListener";
import GameNotationWrapper from "../GameNotationWrapper";
import { PuzzleVariantsModal } from "../PuzzleVariantsModal";
import ResponsiveAnalysisPanels from "../ResponsiveAnalysisPanels";
import ResponsiveBoard from "../ResponsiveBoard";
import { VariantsActions } from "../VariantsActions";
import VariantsNotation from "../VariantsNotation";
import { VariantsTreeBuilderModal } from "../VariantsTreeBuilderModal";
import { openDetachedVariantsNotationPanel } from "./detachedPanelWindows";
import type {
  VariantsAnalysisMainTab,
  VariantsBoardCommands,
  VariantsBoardFileActions,
  VariantsBoardState,
} from "./types";
import type { VariantsBuilderModel } from "./useVariantsBuilder";
import type { VariantsDesktopLayoutState } from "./useVariantsDesktopLayoutState";
import type { VariantsPuzzleGeneration } from "./useVariantsPuzzleGeneration";

type BoardVariantsLayoutProps = {
  buildPanel: ReactNode;
  builder: VariantsBuilderModel;
  commands: VariantsBoardCommands;
  desktopLayout: VariantsDesktopLayoutState;
  fileActions: VariantsBoardFileActions;
  puzzles: VariantsPuzzleGeneration;
  state: VariantsBoardState;
};

const variantsPanelBorder =
  "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 10%, var(--mantine-color-dark-4))";

const variantsPanelSurface: CSSProperties = {
  border: variantsPanelBorder,
  borderRadius: 8,
  background:
    "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-8) 92%, var(--mantine-color-dark-6) 8%), var(--mantine-color-dark-8))",
  boxShadow: "0 18px 40px rgba(0, 0, 0, 0.18)",
};

const variantsBoardSurface: CSSProperties = {
  background: "transparent",
  border: "none",
  boxShadow: "none",
};

const variantsTabsStyles = {
  list: {
    gap: 6,
    borderBottom: "none",
    paddingBottom: 2,
  },
  tab: {
    borderRadius: 6,
    fontWeight: 600,
    minHeight: 30,
    paddingInline: 10,
  },
} satisfies { list: CSSProperties; tab: CSSProperties };

export function BoardVariantsLayout({
  buildPanel,
  builder,
  commands,
  desktopLayout,
  fileActions,
  puzzles,
  state,
}: BoardVariantsLayoutProps) {
  const { t } = useTranslation();
  const topBar = true;
  const saveFile = () => {
    void fileActions.saveFile();
  };
  const copyPgn = () => {
    void commands.copyPgn();
  };
  const reload = () => {
    void fileActions.reloadBoard();
  };
  const detachNotationPanel = () => {
    openDetachedVariantsNotationPanel(state.currentTab, t, {
      onCreated: () => desktopLayout.setDesktopPanelCollapsed("pgn", true),
      onClosed: () => desktopLayout.setDesktopPanelCollapsed("pgn", false),
    });
  };
  const openPuzzleModal = () => puzzles.openPuzzleModal(builder.treeBuilderDepth);
  const editingCard = (
    <EditingCard
      boardRef={state.boardRef}
      setEditingMode={state.toggleEditingMode}
      selectedPiece={state.selectedPiece}
      setSelectedPiece={state.setSelectedPiece}
    />
  );

  if (state.isMobileLayout) {
    return (
      <>
        {!builder.treeBuilderRunning && <EvalListener />}
        <Box
          style={{
            paddingBottom: state.isAndroid
              ? "calc(var(--mantine-spacing-md) + env(safe-area-inset-bottom, 0px))"
              : undefined,
            minHeight: "100%",
            maxHeight: "100%",
            overflowY: "auto",
            overflowX: "hidden",
            touchAction: "pan-y",
            WebkitOverflowScrolling: "touch",
          }}
        >
          <Stack gap="md" style={{ minHeight: 0, paddingBottom: "var(--mantine-spacing-md)" }}>
            <Box style={{ zIndex: 3 }}>
              <Suspense fallback={<ResponsiveSkeleton type="default" />}>
                <ResponsiveAnalysisPanels
                  currentTab={state.currentTabSelected}
                  onTabChange={(value) => state.setCurrentTabSelected(value || "info")}
                  isRepertoire={state.showRepertoirePanels}
                  isPuzzle={state.isPuzzle}
                  showSimulate
                  disableCollapse
                  renderAsSelect
                  unstyledContainer
                />
              </Suspense>
            </Box>

            <Box style={{ position: "relative", zIndex: 2, minHeight: 0 }}>
              <ResponsiveBoard
                practicing={state.practicing}
                dirty={state.dirty}
                editingMode={state.editingMode}
                toggleEditingMode={state.toggleEditingMode}
                boardRef={state.boardRef}
                saveFile={saveFile}
                copyPgn={copyPgn}
                reload={reload}
                topBar={topBar}
                showClock={false}
                editingCard={state.editingMode ? editingCard : undefined}
                viewPawnStructure={state.viewPawnStructure}
                setViewPawnStructure={state.setViewPawnStructure}
                selectedPiece={state.selectedPiece}
                setSelectedPiece={state.setSelectedPiece}
                canTakeBack={false}
                changeTabType={commands.changeTabType}
                currentTabType="analysis"
                clearShapes={commands.clearShapes}
                toggleOrientation={commands.flipBoard}
                disableVariations={false}
                currentTabSourceType={state.currentTab?.source?.type || undefined}
                hideMobileAnalysisPanel
              />
            </Box>

            <Box style={{ minHeight: 0, touchAction: "pan-y" }}>
              <GameNotationWrapper topBar editingMode={state.editingMode} editingCard={editingCard}>
                <VariantsNotation topBar={topBar} editingMode={state.editingMode} />
                <VariantsActions
                  treeBuilderRunning={builder.treeBuilderRunning}
                  onOpenPuzzle={openPuzzleModal}
                  onOpenTreeBuilder={() => builder.setTreeBuilderOpened(true)}
                  onCancelTreeBuilder={builder.cancelTreeBuilder}
                />
              </GameNotationWrapper>
            </Box>
          </Stack>
        </Box>

        <PuzzleVariantsModal
          opened={puzzles.puzzleModalOpened}
          onClose={puzzles.closePuzzleModal}
          puzzleDepth={puzzles.puzzleDepth}
          maxPuzzleDepth={puzzles.maxPuzzleDepth}
          setPuzzleDepth={puzzles.setPuzzleDepth}
          onGenerate={(depth) => void puzzles.generatePuzzles(depth)}
        />

        <VariantsTreeBuilderModal
          opened={builder.treeBuilderOpened}
          onClose={() => builder.setTreeBuilderOpened(false)}
          dbType={builder.dbType}
          setDbType={builder.setDbType}
          localDbLabel={builder.referenceDatabase}
          engineOptions={builder.engineOptions}
          selectedEngineValue={builder.selectedEngineValue}
          setSelectedEngineValue={builder.setSelectedEngineKey}
          treeBuilderMode={builder.treeBuilderMode}
          setTreeBuilderMode={builder.setTreeBuilderMode}
          treeBuilderEngineMs={builder.treeBuilderEngineMs}
          setTreeBuilderEngineMs={builder.setTreeBuilderEngineMs}
          treeBuilderCoverage={builder.treeBuilderCoverage}
          setTreeBuilderCoverage={builder.setTreeBuilderCoverage}
          treeBuilderMinMoves={builder.treeBuilderMinMoves}
          setTreeBuilderMinMoves={builder.setTreeBuilderMinMoves}
          treeBuilderDepth={builder.treeBuilderDepth}
          setTreeBuilderDepth={builder.setTreeBuilderDepth}
          treeBuilderRunning={builder.treeBuilderRunning}
          treeBuilderProgress={builder.treeBuilderProgress}
          onRun={() => void builder.buildVariantsTree()}
          onCancel={builder.cancelTreeBuilder}
          runDisabled={builder.runDisabled}
        />
      </>
    );
  }

  return (
    <>
      {!builder.treeBuilderRunning && <EvalListener />}
      <Stack h="100%" gap="xs" style={{ minHeight: 0, minWidth: 0 }}>
        <Box
          ref={desktopLayout.desktopRootRef}
          h="100%"
          style={{
            display: "flex",
            gap: "var(--mantine-spacing-xs)",
            minHeight: 0,
            minWidth: 0,
          }}
        >
          <Box
            style={{
              minHeight: 0,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              gap: "var(--mantine-spacing-xs)",
              flex: `${desktopLayout.effectiveLeftSplit} 1 0`,
            }}
          >
            <Paper
              p="xs"
              style={{
                ...variantsBoardSurface,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                flex: "1 1 0",
              }}
            >
              <Box style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <ResponsiveBoard
                  practicing={state.practicing}
                  dirty={state.dirty}
                  editingMode={state.editingMode}
                  toggleEditingMode={state.toggleEditingMode}
                  boardRef={state.boardRef}
                  saveFile={saveFile}
                  copyPgn={copyPgn}
                  reload={reload}
                  topBar={false}
                  showClock={false}
                  editingCard={state.editingMode ? editingCard : undefined}
                  viewPawnStructure={state.viewPawnStructure}
                  setViewPawnStructure={state.setViewPawnStructure}
                  selectedPiece={state.selectedPiece}
                  setSelectedPiece={state.setSelectedPiece}
                  canTakeBack={false}
                  changeTabType={commands.changeTabType}
                  currentTabType="analysis"
                  clearShapes={commands.clearShapes}
                  toggleOrientation={commands.flipBoard}
                  disableVariations={false}
                  currentTabSourceType={state.currentTab?.source?.type || undefined}
                />
              </Box>
              {!state.editingMode && (
                <Box pt="xs">
                  <MoveControls readOnly />
                </Box>
              )}
            </Paper>
          </Box>

          {(desktopLayout.showCenterColumn || desktopLayout.showRightColumn) && (
            <Box onMouseDown={desktopLayout.handleMainLeftResize} style={desktopLayout.verticalHandleStyle} />
          )}

          {desktopLayout.showCenterColumn && (
            <Box
              style={{
                minHeight: 0,
                minWidth: 160,
                display: "flex",
                flexDirection: "column",
                gap: "var(--mantine-spacing-xs)",
                overflow: "hidden",
                flex: `${desktopLayout.effectiveCenterSplit} 1 0`,
              }}
            >
              {state.editingMode ? (
                editingCard
              ) : (
                <VariantsNotation topBar={topBar} editingMode={state.editingMode} onDetach={detachNotationPanel} />
              )}
            </Box>
          )}

          {desktopLayout.showCenterColumn && desktopLayout.showRightColumn && (
            <Box onMouseDown={desktopLayout.handleMainRightResize} style={desktopLayout.verticalHandleStyle} />
          )}

          {desktopLayout.showRightColumn && (
            <Box
              ref={desktopLayout.rightColumnRef}
              style={{
                minHeight: 0,
                minWidth: 260,
                display: "flex",
                flexDirection: "column",
                gap: "var(--mantine-spacing-xs)",
                flex: `${desktopLayout.effectiveRightSplit} 1 0`,
              }}
            >
              {!desktopLayout.collapsedDesktopPanels.analysis && (
                <Paper
                  p="sm"
                  style={{
                    ...variantsPanelSurface,
                    minHeight: 0,
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                    flex: desktopLayout.collapsedDesktopPanels.database
                      ? "1 1 0"
                      : `0 0 ${desktopLayout.rightTopSplit}%`,
                  }}
                >
                  <Tabs
                    variant="pills"
                    value={builder.analysisMainTab}
                    onChange={(value) => builder.setAnalysisMainTab((value as VariantsAnalysisMainTab) || "engines")}
                    keepMounted={false}
                    style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
                    styles={variantsTabsStyles}
                  >
                    <Tabs.List>
                      <Tabs.Tab value="engines">{t("features.board.variants.engine")}</Tabs.Tab>
                      <Tabs.Tab value="build">{t("features.board.variants.treeBuilder.button")}</Tabs.Tab>
                      <Tabs.Tab value="practice">{t("features.board.tabs.practice")}</Tabs.Tab>
                      <Tabs.Tab value="graph" disabled={!state.showRepertoirePanels}>
                        {t("features.board.tabs.graph")}
                      </Tabs.Tab>
                      <Tabs.Tab value="annotate">{t("features.board.tabs.annotate")}</Tabs.Tab>
                      <Tabs.Tab value="info">{t("features.board.tabs.info")}</Tabs.Tab>
                      <Tabs.Tab value="report">{t("features.board.analysis.report")}</Tabs.Tab>
                      <Tabs.Tab value="logs" disabled={builder.loadedEngines.length === 0}>
                        {t("features.board.analysis.logs")}
                      </Tabs.Tab>
                    </Tabs.List>
                    <Tabs.Panel value="engines" pt="xs" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                      <AnalysisPanel hideTabsList forceTab="engines" />
                    </Tabs.Panel>
                    <Tabs.Panel value="build" pt="xs" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                      {buildPanel}
                    </Tabs.Panel>
                    <Tabs.Panel value="practice" pt="xs" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                      <PracticePanel />
                    </Tabs.Panel>
                    <Tabs.Panel value="graph" pt="xs" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                      {state.showRepertoirePanels && <GraphPanel />}
                    </Tabs.Panel>
                    <Tabs.Panel value="annotate" pt="xs" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                      <AnnotationPanel />
                    </Tabs.Panel>
                    <Tabs.Panel value="info" pt="xs" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                      <InfoPanel />
                    </Tabs.Panel>
                    <Tabs.Panel value="report" pt="xs" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                      <ReportPanel />
                    </Tabs.Panel>
                    <Tabs.Panel value="logs" pt="xs" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                      <LogsPanel />
                    </Tabs.Panel>
                  </Tabs>
                </Paper>
              )}

              {!desktopLayout.collapsedDesktopPanels.analysis && !desktopLayout.collapsedDesktopPanels.database && (
                <Box
                  onMouseDown={desktopLayout.handleRightVerticalResize}
                  style={desktopLayout.horizontalHandleStyle}
                />
              )}

              {!desktopLayout.collapsedDesktopPanels.database && (
                <Paper
                  p="sm"
                  style={{
                    ...variantsPanelSurface,
                    minHeight: 0,
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                    flex: desktopLayout.collapsedDesktopPanels.analysis
                      ? "1 1 0"
                      : `0 0 ${100 - desktopLayout.rightTopSplit}%`,
                  }}
                >
                  <DatabasePanel forceActive />
                </Paper>
              )}
            </Box>
          )}
        </Box>
      </Stack>

      <PuzzleVariantsModal
        opened={puzzles.puzzleModalOpened}
        onClose={puzzles.closePuzzleModal}
        puzzleDepth={puzzles.puzzleDepth}
        maxPuzzleDepth={puzzles.maxPuzzleDepth}
        setPuzzleDepth={puzzles.setPuzzleDepth}
        onGenerate={(depth) => void puzzles.generatePuzzles(depth)}
      />
    </>
  );
}
