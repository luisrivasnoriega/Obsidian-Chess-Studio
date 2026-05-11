import { notifications } from "@mantine/notifications";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { TreeStore } from "@/state/store/tree";
import { getPGN } from "@/utils/chess";
import type { Tab } from "@/utils/tabs";
import { getNodeAtPath } from "@/utils/treeReducer";
import type { VariantsBoardCommands, VariantsBoardState } from "./types";

type UseVariantsBoardCommandsArgs = {
  store: TreeStore;
  setCurrentTab: VariantsBoardState["setCurrentTab"];
};

export function useVariantsBoardCommands({
  store,
  setCurrentTab,
}: UseVariantsBoardCommandsArgs): VariantsBoardCommands {
  const { t } = useTranslation();
  const clearShapes = useStore(store, (s) => s.clearShapes);
  const setHeaders = useStore(store, (s) => s.setHeaders);

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
        comments: true,
        extraMarkups: true,
        glyphs: true,
        variations: true,
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

  const flipBoard = useCallback(() => {
    const currentHeaders = store.getState().headers;
    const newOrientation = currentHeaders.orientation === "black" ? "white" : "black";
    setHeaders({
      ...currentHeaders,
      orientation: newOrientation,
    });
  }, [setHeaders, store]);

  const changeTabType = useCallback(() => {
    setCurrentTab((prev: Tab) => ({ ...prev, type: "play" }));
  }, [setCurrentTab]);

  return {
    clearShapes,
    copyFen,
    copyPgn,
    flipBoard,
    changeTabType,
  };
}
