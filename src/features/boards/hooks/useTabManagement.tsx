import { Text } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useAtom, useAtomValue } from "jotai";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { commands } from "@/bindings";
import { MAX_TABS } from "@/features/boards/constants";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { createTreeStore } from "@/state/store/tree";
import { keyMapAtom } from "@/state/keybindings";
import { getDocumentDir } from "@/utils/documentDir";
import { createTab, genID, saveToFile, type Tab } from "@/utils/tabs";
import { getTabState as getTabStateRaw, removeTabState, setTabState } from "@/utils/tabStateStorage";
import { unwrap } from "@/utils/unwrap";

function isValidTabState(value: unknown): value is { version: number; state: { dirty?: boolean } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "number" &&
    "state" in value &&
    typeof value.state === "object" &&
    value.state !== null
  );
}

function getTabStateData(tabId: string): { version: number; state: { dirty?: boolean } } | null {
  try {
    const rawState = getTabStateRaw(tabId);
    if (!rawState) {
      return null;
    }

    const parsedState = JSON.parse(rawState);

    if (isValidTabState(parsedState)) {
      return parsedState;
    }
    removeTabState(tabId);
    return null;
  } catch {
    removeTabState(tabId);
    return null;
  }
}

export function useTabManagement(options?: { enableHotkeys?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [activeTab, setActiveTab] = useAtom(activeTabAtom);
  const enableHotkeys = options?.enableHotkeys ?? true;

  useEffect(() => {
    if (tabs.length === 0) {
      setActiveTab(null);
      return;
    }

    if (activeTab && tabs.some((tab) => tab.value === activeTab)) {
      return;
    }

    setActiveTab(tabs[0].value);
  }, [activeTab, setActiveTab, tabs]);

  const closeTab = useCallback(
    async (value: string | null, forced?: boolean) => {
      if (value !== null) {
        const isClosingLastTab = tabs.length === 1 && tabs[0]?.value === value;
        const isClosingActiveTab = value === activeTab;

        const closingIndex = tabs.findIndex((t) => t.value === value);
        const newTabsSnapshot = closingIndex === -1 ? tabs : tabs.filter((t) => t.value !== value);
        const nextActiveTabValueSnapshot =
          !isClosingActiveTab || closingIndex === -1
            ? activeTab
            : newTabsSnapshot.length === 0
              ? null
              : closingIndex === tabs.length - 1
                ? newTabsSnapshot[closingIndex - 1]?.value ?? null
                : newTabsSnapshot[closingIndex]?.value ?? null;
        const nextActiveTabSnapshot =
          nextActiveTabValueSnapshot != null
            ? newTabsSnapshot.find((t) => t.value === nextActiveTabValueSnapshot) ?? null
            : null;

        // If we are closing the last tab for the current boards route (/analysis, /play, /puzzles),
        // BoardsRouteEntry will try to recreate it. Mark that we want to skip that ensure once.
        if (isClosingActiveTab && typeof window !== "undefined") {
          const path = window.location.pathname;
          const routeMode = path === "/analysis" ? "analysis" : path === "/play" ? "play" : path === "/puzzles" ? "puzzles" : null;
          if (routeMode) {
            const hasRemainingSameModeTab = newTabsSnapshot.some((t) =>
              routeMode === "analysis" ? t.type === "analysis" || t.type === "new" : t.type === routeMode,
            );
            if (!hasRemainingSameModeTab) {
              try {
                sessionStorage.setItem("boardsRouteEntry.skipEnsureOnce", routeMode);
              } catch {}
            }
          }
        }

        const tabState = getTabStateData(value);
        const tab = tabs.find((t) => t.value === value);
        const isDirty = !!tabState?.state?.dirty;

        if (isDirty && !forced && tab?.type !== "new") {
          modals.openConfirmModal({
            title: t("common.unsavedChanges.title"),
            withCloseButton: false,
            children: <Text>{t("common.unsavedChanges.desc")}</Text>,
            labels: {
              confirm: t("common.unsavedChanges.saveAndClose"),
              cancel: t("common.unsavedChanges.closeWithoutSaving"),
            },
            onConfirm: () => {
              void (async () => {
                const noopSetCurrentTab: Dispatch<SetStateAction<Tab>> = () => {};
                const tabStore = createTreeStore(value);
                const documentDir = await getDocumentDir();
                await saveToFile({
                  dir: documentDir,
                  setCurrentTab: noopSetCurrentTab,
                  tab: tab,
                  store: tabStore,
                });
                await closeTab(value, true);
              })();
            },
            onCancel: () => {
              closeTab(value, true);
            },
          });
          return;
        }

        setTabs((prevTabs) => {
          const index = prevTabs.findIndex((tab) => tab.value === value);
          if (index === -1) return prevTabs;

          const newTabs = prevTabs.filter((tab) => tab.value !== value);

          setActiveTab((currentActiveTab) => {
            if (value === currentActiveTab) {
              if (newTabs.length === 0) {
                return null;
              }
              if (index === prevTabs.length - 1) {
                return newTabs[index - 1].value;
              }
              return newTabs[index].value;
            }
            return currentActiveTab;
          });

          return newTabs;
        });

        if (isClosingLastTab) {
          try {
            sessionStorage.setItem("tabsClosedToZero", "1");
          } catch {}
          navigate({ to: "/" });
        } else if (isClosingActiveTab && nextActiveTabSnapshot) {
          try {
            const path = window.location.pathname;
            const isBoardsRoute = path === "/analysis" || path === "/play" || path === "/puzzles";
            if (isBoardsRoute) {
              const to =
                nextActiveTabSnapshot.type === "play"
                  ? "/play"
                  : nextActiveTabSnapshot.type === "puzzles"
                    ? "/puzzles"
                    : "/analysis";
              navigate({ to });
            }
          } catch {}
        }

        try {
          unwrap(await commands.killEngines(value));
        } catch {}
      }
    },
    [activeTab, navigate, setActiveTab, setTabs, t, tabs],
  );

  const selectTab = useCallback(
    (index: number) => {
      setTabs((prevTabs) => {
        const targetIndex = Math.min(index, prevTabs.length - 1);
        if (targetIndex >= 0 && prevTabs[targetIndex]) {
          setActiveTab(prevTabs[targetIndex].value);
        }
        return prevTabs;
      });
    },
    [setTabs, setActiveTab],
  );

  const cycleTabs = useCallback(
    (reverse = false) => {
      setTabs((prevTabs) => {
        setActiveTab((currentActiveTab) => {
          const index = prevTabs.findIndex((tab) => tab.value === currentActiveTab);
          if (reverse) {
            if (index === 0) {
              return prevTabs[prevTabs.length - 1].value;
            }
            return prevTabs[index - 1].value;
          }
          if (index === prevTabs.length - 1) {
            return prevTabs[0].value;
          }
          return prevTabs[index + 1].value;
        });
        return prevTabs;
      });
    },
    [setTabs, setActiveTab],
  );

  const renameTab = useCallback(
    (value: string, name: string) => {
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.value === value) {
            return { ...tab, name };
          }
          return tab;
        }),
      );
    },
    [setTabs],
  );

  const duplicateTab = useCallback(
    (value: string) => {
      const id = genID();
      setTabs((prevTabs) => {
        const tab = prevTabs.find((tab) => tab.value === value);

        try {
          const existingState = getTabStateRaw(value);
          if (existingState) {
            setTabState(id, existingState);
          }
        } catch {}

        if (tab) {
          setActiveTab(id);
          return [
            ...prevTabs,
            {
              name: tab.name,
              value: id,
              type: tab.type,
            },
          ];
        }
        return prevTabs;
      });
    },
    [setTabs, setActiveTab],
  );

  const keyMap = useAtomValue(keyMapAtom);
  useHotkeys(
    enableHotkeys
      ? [
          [keyMap.CLOSE_BOARD_TAB.keys, () => closeTab(activeTab, true)],
          [keyMap.CYCLE_BOARD_TABS.keys, () => cycleTabs()],
          [keyMap.REVERSE_CYCLE_BOARD_TABS.keys, () => cycleTabs(true)],
          [keyMap.BOARD_TAB_ONE.keys, () => selectTab(0)],
          [keyMap.BOARD_TAB_TWO.keys, () => selectTab(1)],
          [keyMap.BOARD_TAB_THREE.keys, () => selectTab(2)],
          [keyMap.BOARD_TAB_FOUR.keys, () => selectTab(3)],
          [keyMap.BOARD_TAB_FIVE.keys, () => selectTab(4)],
          [keyMap.BOARD_TAB_SIX.keys, () => selectTab(5)],
          [keyMap.BOARD_TAB_SEVEN.keys, () => selectTab(6)],
          [keyMap.BOARD_TAB_EIGHT.keys, () => selectTab(7)],
          [
            keyMap.BOARD_TAB_LAST.keys,
            () => {
              setTabs((prevTabs) => {
                selectTab(prevTabs.length - 1);
                return prevTabs;
              });
            },
          ],
          [
            keyMap.DUPLICATE_TAB.keys,
            () => {
              setActiveTab((current) => {
                if (current) {
                  duplicateTab(current);
                }
                return current;
              });
            },
          ],
          [
            keyMap.NEW_GAME.keys,
            () => {
              if (tabs.length >= MAX_TABS) {
                notifications.show({
                  title: t("features.tabs.limitReached"),
                  message: t("features.tabs.limitReachedDesc", { max: MAX_TABS }),
                  color: "yellow",
                  autoClose: 5000,
                });
                return;
              }
              createTab({
                tab: { name: t("features.tabs.playBoard.title"), type: "play" },
                setTabs,
                setActiveTab,
              });
            },
          ],
        ]
      : [],
  );

  const canCreateNewTab = useCallback(() => {
    return tabs.length < MAX_TABS;
  }, [tabs.length]);

  const showTabLimitNotification = useCallback(() => {
    notifications.show({
      title: t("features.tabs.limitReached"),
      message: t("features.tabs.limitReachedDesc", { max: MAX_TABS }),
      color: "yellow",
      autoClose: 5000,
    });
  }, [t]);

  return {
    tabs,
    activeTab,
    setActiveTab,
    setTabs,
    closeTab,
    renameTab,
    duplicateTab,
    selectTab,
    cycleTabs,
    canCreateNewTab,
    showTabLimitNotification,
  };
}
