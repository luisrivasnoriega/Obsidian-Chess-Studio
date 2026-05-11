import { notifications } from "@mantine/notifications";
import { useAtom, useAtomValue } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { allEnabledAtom, enableAllAtom } from "@/state/atoms";
import type { TreeStore } from "@/state/store/tree";
import { getPGN } from "@/utils/chess";
import { getNodeAtPath } from "@/utils/treeReducer";
import type { AnalysisBoardCommands, AnalysisBoardFileActions, AnalysisBoardState } from "./types";

type UseAnalysisBoardCommandsArgs = {
  store: TreeStore;
  setCurrentTab: AnalysisBoardState["setCurrentTab"];
  toggleEditingMode: () => void;
  saveFile: AnalysisBoardFileActions["saveFile"];
};

export function useAnalysisBoardCommands({
  store,
  setCurrentTab,
  toggleEditingMode,
  saveFile,
}: UseAnalysisBoardCommandsArgs): AnalysisBoardCommands {
  const { t } = useTranslation();
  const clearShapes = useStore(store, (s) => s.clearShapes);
  const deleteMove = useStore(store, (s) => s.deleteMove);
  const promoteVariation = useStore(store, (s) => s.promoteVariation);
  const reset = useStore(store, (s) => s.reset);
  const setAnnotation = useStore(store, (s) => s.setAnnotation);
  const setFen = useStore(store, (s) => s.setFen);
  const setHeaders = useStore(store, (s) => s.setHeaders);
  const [, enable] = useAtom(enableAllAtom);
  const allEnabledLoader = useAtomValue(allEnabledAtom);
  const allEnabled = allEnabledLoader.state === "hasData" && allEnabledLoader.data;

  const copyFen = useCallback(async () => {
    try {
      const currentNode = getNodeAtPath(store.getState().root, store.getState().position);
      await navigator.clipboard.writeText(currentNode.fen);
      notifications.show({
        title: t("keybindings.copyFen"),
        message: t("common.copiedFenToClipboard"),
        color: "green",
      });
    } catch {
      notifications.show({
        title: t("common.error"),
        message: t("errors.failedToCopyFen"),
        color: "red",
      });
    }
  }, [store, t]);

  const copyPgn = useCallback(async () => {
    try {
      const { root, headers } = store.getState();
      const pgn = getPGN(root, {
        headers,
        glyphs: true,
        comments: true,
        variations: true,
        extraMarkups: true,
      });
      await navigator.clipboard.writeText(pgn);
      notifications.show({
        title: t("keybindings.copyPgn"),
        message: t("common.copiedPgnToClipboard"),
        color: "green",
      });
    } catch {
      notifications.show({
        title: t("common.error"),
        message: t("errors.failedToCopyPgn"),
        color: "red",
      });
    }
  }, [store, t]);

  const pasteFen = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setFen(text.trim());
        notifications.show({
          title: t("keybindings.pasteFen"),
          message: t("common.pastedFenFromClipboard"),
          color: "green",
        });
      }
    } catch {
      notifications.show({
        title: t("common.error"),
        message: t("errors.failedToPasteFen"),
        color: "red",
      });
    }
  }, [setFen, t]);

  const exportGame = useCallback(async () => {
    const saved = await saveFile();
    if (!saved) {
      return;
    }

    notifications.show({
      title: t("keybindings.exportGame"),
      message: t("common.gameExportedSuccessfully"),
      color: "green",
    });
  }, [saveFile, t]);

  const flipBoard = useCallback(() => {
    const currentHeaders = store.getState().headers;
    const newOrientation = currentHeaders.orientation === "black" ? "white" : "black";
    setHeaders({
      ...currentHeaders,
      orientation: newOrientation,
    });
  }, [setHeaders, store]);

  const resetPosition = useCallback(() => {
    reset();
    notifications.show({
      title: t("keybindings.resetPosition"),
      message: t("common.positionResetToStart"),
      color: "blue",
    });
  }, [reset, t]);

  const setupPosition = useCallback(() => {
    toggleEditingMode();
  }, [toggleEditingMode]);

  const toggleEngine = useCallback(() => {
    enable(!allEnabled);
  }, [enable, allEnabled]);

  const stopAllEngines = useCallback(() => {
    if (allEnabled) {
      enable(false);
      notifications.show({
        title: t("keybindings.stopEngine"),
        message: t("common.enginesStopped"),
        color: "orange",
      });
    }
  }, [enable, allEnabled, t]);

  const promoteCurrentVariation = useCallback(() => {
    const currentPosition = store.getState().position;
    if (currentPosition.length > 0) {
      promoteVariation(currentPosition);
      notifications.show({
        title: t("keybindings.promoteVariation"),
        message: t("common.variationPromoted"),
        color: "blue",
      });
    }
  }, [promoteVariation, store, t]);

  const deleteCurrentVariation = useCallback(() => {
    const currentPosition = store.getState().position;
    if (currentPosition.length > 0) {
      deleteMove(currentPosition);
      notifications.show({
        title: t("keybindings.deleteVariation"),
        message: t("common.variationDeleted"),
        color: "red",
      });
    }
  }, [deleteMove, store, t]);

  const changeTabType = useCallback(() => {
    setCurrentTab((prev) => ({ ...prev, type: "play" }));
  }, [setCurrentTab]);

  return {
    clearShapes,
    copyFen,
    copyPgn,
    deleteCurrentVariation,
    exportGame,
    flipBoard,
    pasteFen,
    promoteCurrentVariation,
    resetPosition,
    setAnnotation,
    setupPosition,
    stopAllEngines,
    toggleEngine,
    changeTabType,
  };
}
