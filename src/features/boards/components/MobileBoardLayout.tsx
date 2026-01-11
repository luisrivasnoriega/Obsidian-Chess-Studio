import type { Color, Piece } from "@lichess-org/chessground/types";
import { ActionIcon, Box, Collapse, Group, Paper, Stack, Text } from "@mantine/core";
import { useToggle } from "@mantine/hooks";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { memo, Suspense, useCallback, useContext } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import MoveControls from "@/components/MoveControls";
import AnalysisPanel from "@/components/panels/analysis/AnalysisPanel";
import { ResponsiveLoadingWrapper } from "@/components/ResponsiveLoadingWrapper";
import { ResponsiveSkeleton } from "@/components/ResponsiveSkeleton";
import { TreeStateContext } from "@/components/TreeStateContext";
import { currentEvalOpenAtom } from "@/state/atoms";
import Board from "./Board";
import EvalBar from "./EvalBar";
import { useSimulatedInit } from "./hooks/useSimulatedInit";

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
  const [isCollapsed, toggleCollapsed] = useToggle([true, false]);
  const { isInitializing, initializationError, retry } = useSimulatedInit({ onRetry });
  const showAnalysisPanel = currentTabType !== "play";
  const hideClockSpacesResolved = hideClockSpaces || currentTabType !== "play";
  const store = useContext(TreeStateContext)!;
  const score = useStore(store, (s) => s.currentNode().score?.value ?? null);
  const orientation = useStore(store, (s) => (s.headers.orientation ?? "white") as Color);
  const [, setEvalOpen] = useAtom(currentEvalOpenAtom);

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
        <Paper withBorder p="xs">
          <Group justify="space-between" align="center">
            <Text fw={700} size="sm">
              {t("features.board.tabs.analysis")}
            </Text>
            <ActionIcon variant="subtle" onClick={() => toggleCollapsed()}>
              {isCollapsed ? <IconChevronDown size="1rem" /> : <IconChevronUp size="1rem" />}
            </ActionIcon>
          </Group>
          <Collapse in={!isCollapsed} transitionDuration={200} transitionTimingFunction="linear">
            <Box mt="xs">
              <Suspense fallback={<ResponsiveSkeleton type="default" />}>
                <AnalysisPanel />
              </Suspense>
            </Box>
          </Collapse>
        </Paper>
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
          <EvalBar score={score} orientation={orientation} layout="horizontal" />
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
