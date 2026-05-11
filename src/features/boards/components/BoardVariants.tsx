import { useContext } from "react";
import { TreeStateContext } from "@/components/TreeStateContext";
import { BoardVariantsLayout } from "./variants/BoardVariantsLayout";
import { useVariantsBoardCommands } from "./variants/useVariantsBoardCommands";
import { useVariantsBoardFileActions } from "./variants/useVariantsBoardFileActions";
import { useVariantsBoardHotkeys } from "./variants/useVariantsBoardHotkeys";
import { useVariantsBoardState } from "./variants/useVariantsBoardState";
import { useVariantsBuilder } from "./variants/useVariantsBuilder";
import { useVariantsDesktopLayoutState } from "./variants/useVariantsDesktopLayoutState";
import { useVariantsPuzzleGeneration } from "./variants/useVariantsPuzzleGeneration";
import { VariantsBuildPanel } from "./variants/VariantsBuildPanel";
import { useVariantsNotationPanelSync } from "./variants/variantsNotationPanelSync";

function BoardVariants() {
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("BoardVariants must be used within a TreeStateProvider");
  }

  const state = useVariantsBoardState(store);
  const builder = useVariantsBuilder({
    store,
    currentTab: state.currentTab,
    boardOrientation: state.boardOrientation,
    is960: state.is960,
  });
  const fileActions = useVariantsBoardFileActions({
    store,
    currentTab: state.currentTab,
    setCurrentTab: state.setCurrentTab,
    treeBuilderRunning: builder.treeBuilderRunning,
  });
  const commands = useVariantsBoardCommands({
    store,
    setCurrentTab: state.setCurrentTab,
  });
  const puzzles = useVariantsPuzzleGeneration({
    store,
    currentTab: state.currentTab,
    boardOrientation: state.boardOrientation,
  });
  const desktopLayout = useVariantsDesktopLayoutState();
  const notationSyncEnabled =
    state.currentTab?.source?.type === "file" && state.currentTab.source.metadata?.type === "variants";

  useVariantsBoardHotkeys(commands);
  useVariantsNotationPanelSync({
    enabled: notationSyncEnabled,
    mode: "owner",
    store,
    tabId: state.currentTab?.value,
  });

  return (
    <BoardVariantsLayout
      buildPanel={<VariantsBuildPanel builder={builder} currentFen={state.currentFen} puzzles={puzzles} />}
      builder={builder}
      commands={commands}
      desktopLayout={desktopLayout}
      fileActions={fileActions}
      puzzles={puzzles}
      state={state}
    />
  );
}

export default BoardVariants;
