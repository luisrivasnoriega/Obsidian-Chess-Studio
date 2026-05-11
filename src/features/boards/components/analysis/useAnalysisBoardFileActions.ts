import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { loadDirectories } from "@/App";
import { useDebouncedAutoSave } from "@/features/boards/hooks/useDebouncedAutoSave";
import { autoSaveAtom } from "@/state/atoms";
import type { TreeStore } from "@/state/store/tree";
import { isTempImportFile } from "@/utils/files";
import { reloadTab, saveTab, saveToFile, type Tab } from "@/utils/tabs";
import type { AnalysisBoardFileActions, AnalysisBoardState } from "./types";

type UseAnalysisBoardFileActionsArgs = {
  store: TreeStore;
  currentTab: Tab | undefined;
  setCurrentTab: AnalysisBoardState["setCurrentTab"];
};

export function useAnalysisBoardFileActions({
  store,
  currentTab,
  setCurrentTab,
}: UseAnalysisBoardFileActionsArgs): AnalysisBoardFileActions {
  const { t } = useTranslation();
  const autoSave = useAtomValue(autoSaveAtom);
  const { data: dirs } = useQuery({ queryKey: ["dirs"], queryFn: loadDirectories, staleTime: Infinity });
  const documentDir = dirs?.documentDir ?? null;
  const setStoreState = useStore(store, (s) => s.setState);
  const setStoreSave = useStore(store, (s) => s.save);

  const saveFile = useCallback(
    async (showNotification = true) => {
      try {
        if (
          currentTab?.source != null &&
          currentTab.source.type === "file" &&
          !isTempImportFile(currentTab.source.path)
        ) {
          await saveTab(currentTab, store);
          setStoreSave();
        } else if (currentTab?.source?.type === "db") {
          await saveTab(currentTab, store);
          setStoreSave();
        } else {
          if (!documentDir) {
            if (showNotification) {
              notifications.show({
                title: t("common.error"),
                message: t("errors.missingFilePath"),
                color: "red",
              });
            }
            return false;
          }

          const saved = await saveToFile({
            dir: documentDir,
            setCurrentTab,
            tab: currentTab,
            store,
          });

          if (!saved) {
            return false;
          }
        }

        if (showNotification) {
          notifications.show({
            title: t("common.save"),
            message: t("common.fileSavedSuccessfully"),
            color: "green",
          });
        }
        return true;
      } catch {
        if (showNotification) {
          notifications.show({
            title: t("common.error"),
            message: t("common.failedToSaveFile"),
            color: "red",
          });
        }
        return false;
      }
    },
    [currentTab, documentDir, setCurrentTab, setStoreSave, store, t],
  );

  const reloadBoard = useCallback(async () => {
    if (currentTab == null) {
      return;
    }

    const state = await reloadTab(currentTab);
    if (state != null) {
      setStoreState(state);
    }
  }, [currentTab, setStoreState]);

  useDebouncedAutoSave({
    store,
    enabled: autoSave,
    isFileTab: currentTab?.source?.type === "file",
    save: async () => {
      await saveFile(false);
    },
  });

  return {
    saveFile,
    reloadBoard,
  };
}
