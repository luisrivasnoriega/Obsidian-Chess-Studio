import { Portal, ScrollArea, Stack } from "@mantine/core";
import MoveControls from "@/components/MoveControls";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import EditingCard from "../EditingCard";
import EvalListener from "../EvalListener";
import GameNotationWrapper from "../GameNotationWrapper";
import ResponsiveAnalysisPanels from "../ResponsiveAnalysisPanels";
import ResponsiveBoard from "../ResponsiveBoard";
import type { AnalysisBoardCommands, AnalysisBoardFileActions, AnalysisBoardState } from "./types";

type AnalysisBoardLayoutProps = {
  commands: AnalysisBoardCommands;
  fileActions: AnalysisBoardFileActions;
  portalTargets: {
    left: string;
    topRight: string;
    bottomRight: string;
  };
  state: AnalysisBoardState;
};

export function AnalysisBoardLayout({ commands, fileActions, portalTargets, state }: AnalysisBoardLayoutProps) {
  const { layout } = useResponsiveLayout();
  const isMobileLayout = layout.chessBoard.layoutType === "mobile";
  const saveFile = () => {
    void fileActions.saveFile();
  };
  const copyPgn = () => {
    void commands.copyPgn();
  };
  const reload = () => {
    void fileActions.reloadBoard();
  };
  const editingCard = (
    <EditingCard
      boardRef={state.boardRef}
      setEditingMode={state.toggleEditingMode}
      selectedPiece={state.selectedPiece}
      setSelectedPiece={state.setSelectedPiece}
    />
  );
  const boardContent = (
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
      currentTabSourceType={state.currentTab?.source?.type}
    />
  );
  const analysisPanelsContent = (
    <ResponsiveAnalysisPanels
      currentTab={state.currentTabSelected}
      onTabChange={(value) => state.setCurrentTabSelected(value || "info")}
      isRepertoire={state.isRepertoire}
      isPuzzle={state.isPuzzle}
    />
  );

  if (isMobileLayout) {
    return (
      <>
        <EvalListener />
        <ScrollArea h="100%">
          <Stack gap="md">
            {boardContent}
            <GameNotationWrapper topBar editingMode={state.editingMode} editingCard={editingCard} />
          </Stack>
        </ScrollArea>
      </>
    );
  }

  return (
    <>
      <EvalListener />
      <Portal target={portalTargets.left} style={{ height: "100%" }}>
        {boardContent}
      </Portal>
      <Portal target={portalTargets.topRight} style={{ height: "100%" }}>
        {analysisPanelsContent}
      </Portal>
      <GameNotationWrapper
        topBar
        portalTargetOverride={portalTargets.bottomRight}
        editingMode={state.editingMode}
        editingCard={editingCard}
      >
        <MoveControls readOnly />
      </GameNotationWrapper>
    </>
  );
}
