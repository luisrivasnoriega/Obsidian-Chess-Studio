import type { Color, Piece } from "@lichess-org/chessground/types";
import { Box, Stack } from "@mantine/core";
import { useAtom, useAtomValue } from "jotai";
import { memo, Suspense, useCallback, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import MoveControls from "@/components/MoveControls";
import { ResponsiveLoadingWrapper } from "@/components/ResponsiveLoadingWrapper";
import { ResponsiveSkeleton } from "@/components/ResponsiveSkeleton";
import { TreeStateContext } from "@/components/TreeStateContext";
import { currentEvalOpenAtom, currentTabAtom, currentTabSelectedAtom } from "@/state/atoms";
import Board from "./Board";
import EvalBar from "./EvalBar";
import { useSimulatedInit } from "./hooks/useSimulatedInit";
import ResponsiveAnalysisPanels from "./ResponsiveAnalysisPanels";

interface MobileBoardLayoutProps {
  // Board props
  dirty: boolean;
  editingMode: boolean;
  toggleEditingMode: () => void;
  viewOnly?: boolean;
  disableVariations?: boolean;
  movable?: "both" | "white" | "black" | "turn" | "none";
  boardRef: React.MutableRefObject<HTMLDivElement | null>;
  saveFile?: () => void;
  copyPgn?: () => void;
  reload?: () => void;
  addGame?: () => void;
  canTakeBack?: boolean;
  whiteTime?: number;
  blackTime?: number;
  practicing?: boolean;

  // Analysis props
  topBar?: boolean;
  editingCard?: React.ReactNode;
  isLoading?: boolean;
  error?: Error | null;
  onRetry?: () => void;

  // Board controls props
  viewPawnStructure?: boolean;
  setViewPawnStructure?: (value: boolean) => void;
  takeSnapshot?: () => void;
  deleteMove?: () => void;
  changeTabType?: () => void;
  currentTabType?: "analysis" | "play";
  eraseDrawablesOnClick?: boolean;
  clearShapes?: () => void;
  toggleOrientation?: () => void;
  currentTabSourceType?: string;
  selectedPiece?: Piece | null;
  setSelectedPiece?: (piece: Piece | null) => void;
  hideAnalysisPanel?: boolean;

  // Start Game props
  startGame?: () => void;
  endGame?: () => void;
  gameState?: "settingUp" | "playing" | "gameOver";
  startGameDisabled?: boolean;
  // Hide clock spaces, eval bar and footer controls for compact mode (e.g., PlayVsEngineBoard)
  hideClockSpaces?: boolean;
  hideEvalBar?: boolean;
  hideFooterControls?: boolean;
}

function MobileBoardLayout({
  // Board props
  dirty,
  editingMode,
  toggleEditingMode,
  viewOnly,
  disableVariations,
  movable = "turn",
  boardRef,
  saveFile,
  copyPgn,
  reload,
  addGame,
  canTakeBack,
  whiteTime,
  blackTime,
  practicing,

  // Analysis props
  topBar: _topBar = false,
  editingCard: _editingCard,
  isLoading = false,
  error = null,
  onRetry,

  // Board controls props
  viewPawnStructure,
  setViewPawnStructure,
  takeSnapshot,
  deleteMove,
  changeTabType,
  currentTabType,
  eraseDrawablesOnClick,
  clearShapes,
  toggleOrientation,
  currentTabSourceType,
  selectedPiece,
  setSelectedPiece,
  hideAnalysisPanel = false,

  // Start Game props
  startGame,
  endGame,
  gameState,
  startGameDisabled,
  hideClockSpaces = false,
  hideEvalBar = false,
  hideFooterControls = false,
}: MobileBoardLayoutProps) {
  const { t } = useTranslation();
  const { isInitializing, initializationError, retry } = useSimulatedInit({ onRetry });
  const showAnalysisPanel = !hideAnalysisPanel && currentTabType !== "play";
  const hideClockSpacesResolved = hideClockSpaces || currentTabType !== "play";
  const store = useContext(TreeStateContext)!;
  const score = useStore(store, (s) => s.currentNode().score?.value ?? null);
  const turn = useStore(store, (s) => {
    const fen = s.currentNode().fen;
    const field = typeof fen === "string" ? fen.split(" ")[1] : null;
    return (field === "b" ? "black" : "white") as Color;
  });
  const orientation = useStore(store, (s) => (s.headers.orientation ?? "white") as Color);
  const [, setEvalOpen] = useAtom(currentEvalOpenAtom);
  const currentTab = useAtomValue(currentTabAtom);
  const [, setCurrentTabSelected] = useAtom(currentTabSelectedAtom);
  const [mobilePanelsTab, setMobilePanelsTab] = useState<string | null>("analysis");
  const showRepertoirePanels =
    currentTab?.source?.type === "file" &&
    (currentTab.source.metadata?.type === "repertoire" || currentTab.source.metadata?.type === "variants");
  const isPuzzle = currentTab?.source?.type === "file" && currentTab.source.metadata?.type === "puzzle";

  useEffect(() => {
    const next = isPuzzle ? "info" : "analysis";
    setMobilePanelsTab(next);
    setCurrentTabSelected(next);
  }, [isPuzzle, setCurrentTabSelected]);

  // Mobile layout pattern is now passed as a prop from ResponsiveBoard

  // Error handling
  const handleRetry = useCallback(() => {
    retry();
  }, [retry]);

  // Show loading state
  if (isLoading || isInitializing) {
    return (
      <ResponsiveLoadingWrapper isLoading={true}>
        <ResponsiveSkeleton type="board" />
      </ResponsiveLoadingWrapper>
    );
  }

  // Show error state
  if (error || initializationError) {
    return (
      <Stack align="center" gap="md">
        <div>{t("errors.failedToLoadMobileBoardLayout")}</div>
        <button type="button" onClick={handleRetry}>
          {t("common.reset")}
        </button>
      </Stack>
    );
  }

  return (
    <Stack gap="xs" align="stretch">
      {showAnalysisPanel && (
        <Box>
          <Suspense fallback={<ResponsiveSkeleton type="default" />}>
            <ResponsiveAnalysisPanels
              currentTab={mobilePanelsTab}
              onTabChange={(value) => {
                setMobilePanelsTab(value);
                if (value) {
                  setCurrentTabSelected(value);
                }
              }}
              isRepertoire={showRepertoirePanels}
              isPuzzle={isPuzzle}
              disableCollapse
              renderAsSelect
              unstyledContainer
            />
          </Suspense>
        </Box>
      )}

      <Box
        style={{
          aspectRatio: "1 / 1",
          height: "100vw",
          width: "100%",
          maxWidth: "100vw",
        }}
      >
        <Board
          dirty={dirty}
          editingMode={editingMode}
          toggleEditingMode={toggleEditingMode}
          viewOnly={viewOnly}
          disableVariations={disableVariations}
          movable={movable}
          boardRef={boardRef}
          saveFile={saveFile}
          copyPgn={copyPgn}
          reload={reload}
          addGame={addGame}
          canTakeBack={canTakeBack}
          whiteTime={whiteTime}
          blackTime={blackTime}
          practicing={practicing}
          // Board controls props
          viewPawnStructure={viewPawnStructure}
          setViewPawnStructure={setViewPawnStructure}
          takeSnapshot={takeSnapshot}
          deleteMove={deleteMove}
          changeTabType={changeTabType}
          currentTabType={currentTabType}
          eraseDrawablesOnClick={eraseDrawablesOnClick}
          clearShapes={clearShapes}
          toggleOrientation={toggleOrientation}
          currentTabSourceType={currentTabSourceType}
          selectedPiece={selectedPiece}
          setSelectedPiece={setSelectedPiece}
          // Start Game props
          startGame={startGame}
          gameState={gameState}
          startGameDisabled={startGameDisabled}
          hideClockSpaces={hideClockSpacesResolved}
          hideEvalBar={true}
          hideFooterControls={true}
        />
      </Box>

      {!hideEvalBar && (
        <Box
          style={{
            width: "100%",
            paddingLeft: "0.75rem",
            paddingRight: "0.75rem",
            marginTop: "0.5rem",
          }}
          onClick={() => setEvalOpen((v) => !v)}
        >
          <EvalBar score={score} orientation={orientation} turn={turn} layout="horizontal" />
        </Box>
      )}

      {!hideFooterControls && (
        <MoveControls
          viewPawnStructure={viewPawnStructure}
          setViewPawnStructure={setViewPawnStructure}
          takeSnapshot={takeSnapshot}
          canTakeBack={canTakeBack}
          deleteMove={deleteMove}
          changeTabType={changeTabType}
          currentTabType={currentTabType}
          eraseDrawablesOnClick={eraseDrawablesOnClick}
          clearShapes={clearShapes}
          disableVariations={disableVariations}
          editingMode={editingMode}
          toggleEditingMode={toggleEditingMode}
          saveFile={saveFile}
          reload={reload}
          addGame={addGame}
          toggleOrientation={toggleOrientation}
          currentTabSourceType={currentTabSourceType}
          startGame={startGame}
          endGame={endGame}
          gameState={gameState}
          startGameDisabled={startGameDisabled}
        />
      )}

      {editingMode && _editingCard ? _editingCard : null}
    </Stack>
  );
}

export default memo(MobileBoardLayout);
