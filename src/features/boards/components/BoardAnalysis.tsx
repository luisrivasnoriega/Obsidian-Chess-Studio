import { useContext } from "react";
import { TreeStateContext } from "@/components/TreeStateContext";
import { AnalysisBoardLayout } from "./analysis/AnalysisBoardLayout";
import { useAnalysisBoardCommands } from "./analysis/useAnalysisBoardCommands";
import { useAnalysisBoardFileActions } from "./analysis/useAnalysisBoardFileActions";
import { useAnalysisBoardHotkeys } from "./analysis/useAnalysisBoardHotkeys";
import { useAnalysisBoardState } from "./analysis/useAnalysisBoardState";
import { useAnalysisInitialConfig } from "./analysis/useAnalysisInitialConfig";

type BoardAnalysisProps = {
  portalTargets?: {
    left: string;
    topRight: string;
    bottomRight: string;
  };
};

function BoardAnalysis({
  portalTargets = {
    left: "#left",
    topRight: "#topRight",
    bottomRight: "#bottomRight",
  },
}: BoardAnalysisProps) {
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("BoardAnalysis must be used within a TreeStateProvider");
  }

  const state = useAnalysisBoardState(store);
  const fileActions = useAnalysisBoardFileActions({
    store,
    currentTab: state.currentTab,
    setCurrentTab: state.setCurrentTab,
  });
  const commands = useAnalysisBoardCommands({
    store,
    setCurrentTab: state.setCurrentTab,
    toggleEditingMode: state.toggleEditingMode,
    saveFile: fileActions.saveFile,
  });

  useAnalysisInitialConfig({
    currentTab: state.currentTab,
    currentTabSelected: state.currentTabSelected,
    setCurrentTab: state.setCurrentTab,
    setCurrentTabSelected: state.setCurrentTabSelected,
  });

  useAnalysisBoardHotkeys({
    commands,
    isRepertoire: state.isRepertoire,
    saveFile: fileActions.saveFile,
    setCurrentTabSelected: state.setCurrentTabSelected,
  });

  return (
    <AnalysisBoardLayout commands={commands} fileActions={fileActions} portalTargets={portalTargets} state={state} />
  );
}

export default BoardAnalysis;
