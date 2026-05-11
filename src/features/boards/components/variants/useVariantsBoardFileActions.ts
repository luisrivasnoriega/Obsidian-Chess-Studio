import { notifications } from "@mantine/notifications";
import { useAtom, useAtomValue } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useDebouncedAutoSave } from "@/features/boards/hooks/useDebouncedAutoSave";
import { getVariantsDirectory } from "@/features/variants/utils/profileDir";
import { activeProfileIdAtom, autoSaveAtom, tabsAtom } from "@/state/atoms";
import type { TreeStore } from "@/state/store/tree";
import { isTempImportFile } from "@/utils/files";
import { reloadTab, saveTab, saveToFile, type Tab } from "@/utils/tabs";
import type { VariantsBoardFileActions, VariantsBoardState } from "./types";

type UseVariantsBoardFileActionsArgs = {
  store: TreeStore;
  currentTab: Tab | undefined;
  setCurrentTab: VariantsBoardState["setCurrentTab"];
  treeBuilderRunning: boolean;
};

export function useVariantsBoardFileActions({
  store,
  currentTab,
  setCurrentTab,
  treeBuilderRunning,
}: UseVariantsBoardFileActionsArgs): VariantsBoardFileActions {
  const { t } = useTranslation();
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const autoSave = useAtomValue(autoSaveAtom);
  const [, setTabs] = useAtom(tabsAtom);
  const setStoreState = useStore(store, (s) => s.setState);
  const setStoreSave = useStore(store, (s) => s.save);

  const saveFile = useCallback(
    async (showNotification = true) => {
      if (treeBuilderRunning) {
        return false;
      }

      try {
        if (
          currentTab?.source != null &&
          currentTab.source.type === "file" &&
          !isTempImportFile(currentTab.source.path)
        ) {
          await saveTab(currentTab, store, setTabs);
          setStoreSave();
        } else {
          const variantsDir = await getVariantsDirectory(activeProfileId);
          if (!variantsDir) {
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
            dir: variantsDir,
            setCurrentTab,
            tab: currentTab,
            store,
            setTabs,
            isVariantsFile: true,
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
    [activeProfileId, currentTab, setCurrentTab, setStoreSave, setTabs, store, t, treeBuilderRunning],
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
    enabled: autoSave && !treeBuilderRunning,
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
