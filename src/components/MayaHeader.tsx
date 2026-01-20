import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { ActionIcon, Box, Group, Menu, ScrollArea, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconMenu2 } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useAtomValue } from "jotai";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WindowControls } from "@/components/WindowControls";
import { getRouteForTab } from "@/features/boards/BoardsRouteEntry";
import { BoardTab } from "@/features/boards/components/BoardTab";
import { DROPPABLE_IDS, SCROLL_AREA_CONFIG } from "@/features/boards/constants";
import { useTabManagement } from "@/features/boards/hooks/useTabManagement";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { currentGameStateAtom } from "@/state/atoms";
import { env } from "@/utils/detectEnvironment";
import type { Tab } from "@/utils/tabs";

type MenuAction = {
  id?: string;
  label: string;
  shortcut?: string;
  action?: () => void;
};

type MenuGroup = {
  label: string;
  options: MenuAction[];
};

export function MayaHeader({ menuActions }: { menuActions: MenuGroup[] }) {
  const navigate = useNavigate();
  const { layout } = useResponsiveLayout();
  const gameState = useAtomValue(currentGameStateAtom);
  const isCompactHeader = layout.chessBoard.layoutType === "mobile";
  const hasCoarsePointer = useMediaQuery("(pointer: coarse)");
  const safeTop = "max(env(safe-area-inset-top, 0px), 24px)";
  const headerPaddingTop = isCompactHeader && hasCoarsePointer ? safeTop : undefined;

  const { tabs, activeTab, setActiveTab, setTabs, closeTab, renameTab, duplicateTab } = useTabManagement({
    enableHotkeys: false,
  });

  const activeTabData = useMemo(() => tabs.find((tab) => tab.value === activeTab) ?? null, [activeTab, tabs]);
  const shouldHideTabs = activeTabData?.type === "play" && (gameState === "playing" || gameState === "gameOver");

  // Track tabs that should flash when opened or created
  const previousActiveTab = useRef<string | null>(activeTab);
  const previousTabsLength = useRef(tabs.length);
  const previousTabValues = useRef<Set<string>>(new Set(tabs.map((t) => t.value)));
  const [flashingTab, setFlashingTab] = useState<string | null>(null);

  useEffect(() => {
    // Detect when a new tab is created
    if (tabs.length > previousTabsLength.current) {
      const newTab = tabs.find((tab) => !previousTabValues.current.has(tab.value));
      if (newTab) {
        setFlashingTab(newTab.value);
        const timer = setTimeout(() => {
          setFlashingTab(null);
        }, 2000);
        previousTabsLength.current = tabs.length;
        previousTabValues.current = new Set(tabs.map((t) => t.value));
        return () => clearTimeout(timer);
      }
    }

    // Detect when a tab is opened (becomes active)
    if (activeTab && activeTab !== previousActiveTab.current) {
      // Only flash if it's not already flashing (to avoid double flash)
      if (flashingTab !== activeTab) {
        setFlashingTab(activeTab);
        const timer = setTimeout(() => {
          setFlashingTab(null);
        }, 2000);
        previousActiveTab.current = activeTab;
        return () => clearTimeout(timer);
      }
    }

    previousActiveTab.current = activeTab;
    previousTabsLength.current = tabs.length;
    previousTabValues.current = new Set(tabs.map((t) => t.value));
  }, [activeTab, tabs, flashingTab]);

  const openBoards = useCallback(
    (tabValue?: string) => {
      const tab = tabValue ? (tabs.find((t) => t.value === tabValue) ?? null) : activeTabData;
      navigate({ to: getRouteForTab(tab) });
    },
    [activeTabData, navigate, tabs],
  );

  const handleTabSelect = useCallback(
    (value: string) => {
      setActiveTab(value);
      openBoards(value);
    },
    [openBoards, setActiveTab],
  );

  const openTabInNewWindow = useCallback(
    (tab: Tab) => {
      if (!env.isDesktop()) return;
      const payloadId = `${tab.value}-${Date.now()}`;
      const payloadKey = `tearoff:${payloadId}`;

      const session: Record<string, string> = {};
      try {
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (!key) continue;
          if (key === tab.value || key.startsWith(`${tab.value}_`)) {
            const value = sessionStorage.getItem(key);
            if (typeof value === "string") session[key] = value;
          }
        }
      } catch {}

      try {
        localStorage.setItem(payloadKey, JSON.stringify({ tab, session }));
      } catch {
        notifications.show({
          title: "Error",
          message: "Could not prepare tab for new window.",
          color: "red",
        });
        return;
      }

      const label = `tearoff_${payloadId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      const newWindow = new WebviewWindow(label, {
        url: `/?tearoff=${encodeURIComponent(payloadId)}`,
      });

      newWindow.once("tauri://created", () => {
        closeTab(tab.value);
      });

      newWindow.once("tauri://error", (e) => {
        try {
          localStorage.removeItem(payloadKey);
        } catch {}
        const payload = e && typeof e === "object" && "payload" in e ? (e as { payload?: unknown }).payload : e;
        const details =
          typeof payload === "string"
            ? payload
            : payload != null
              ? (() => {
                  try {
                    return JSON.stringify(payload);
                  } catch {
                    return String(payload);
                  }
                })()
              : "";
        notifications.show({
          title: "Error",
          message: `Failed to open new window for tab${details ? `: ${details}` : ""}`,
          color: "red",
        });
      });
    },
    [closeTab],
  );

  const onDragEnd = useCallback(
    ({ destination, source }: DropResult) => {
      if (!destination) {
        if (source.droppableId === DROPPABLE_IDS.TABS) {
          const tab = tabs[source.index];
          if (tab) openTabInNewWindow(tab);
        }
        return;
      }
      if (source.droppableId !== DROPPABLE_IDS.TABS || destination.droppableId !== DROPPABLE_IDS.TABS) return;

      setTabs((prev) => {
        const result = Array.from(prev);
        const [removed] = result.splice(source.index, 1);
        result.splice(destination.index, 0, removed);
        return result;
      });
    },
    [openTabInNewWindow, setTabs, tabs],
  );

  const headerPadding = isCompactHeader ? "xs" : "sm";
  const headerGap = isCompactHeader ? "xs" : "sm";
  const trailingSpacerWidth = layout.menuBar.displayWindowControls ? "3rem" : isCompactHeader ? "0.5rem" : "1.5rem";

  const mobileMenuOptions = useMemo(() => {
    if (!isCompactHeader) return null;
    const byId = new Map<string, MenuAction>();
    for (const group of menuActions) {
      for (const option of group.options) {
        if (option.id) byId.set(option.id, option);
      }
    }

    const orderedIds = ["about", "check_for_updates", "settings", "quit", "force_reload"];
    return orderedIds.map((id) => byId.get(id) ?? null);
  }, [isCompactHeader, menuActions]);

  return (
    <Box
      h="100%"
      style={{ display: "flex", alignItems: "center", paddingTop: headerPaddingTop }}
      data-tauri-drag-region
    >
      <DragDropContext onDragEnd={onDragEnd}>
        <Group
          h="100%"
          px={headerPadding}
          gap={headerGap}
          wrap="nowrap"
          style={{ flex: 1, minWidth: 0 }}
          data-tauri-drag-region
        >
          <Menu shadow="md" position="bottom-start" transitionProps={{ duration: 0 }}>
            <Menu.Target>
              <ActionIcon variant="subtle" size="lg" aria-label="Menu" data-tauri-drag-region={false}>
                <IconMenu2 size={18} stroke={1.5} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {mobileMenuOptions
                ? mobileMenuOptions.map((option, index) => {
                    if (!option) return null;
                    return (
                      <React.Fragment key={option.id ?? `${option.label}-${index}`}>
                        {index > 0 ? <Menu.Divider /> : null}
                        <Menu.Item
                          onClick={option.action}
                          rightSection={
                            option.shortcut ? (
                              <Text size="xs" c="dimmed">
                                {option.shortcut}
                              </Text>
                            ) : null
                          }
                        >
                          {option.label}
                        </Menu.Item>
                      </React.Fragment>
                    );
                  })
                : menuActions.map((group) => (
                    <React.Fragment key={group.label}>
                      <Menu.Label>{group.label}</Menu.Label>
                      {group.options.map((option, i) =>
                        option.label === "divider" ? (
                          <Menu.Divider key={`${group.label}-divider-${i}`} />
                        ) : (
                          <Menu.Item
                            key={option.id ?? `${group.label}-${option.label}`}
                            onClick={option.action}
                            rightSection={
                              option.shortcut ? (
                                <Text size="xs" c="dimmed">
                                  {option.shortcut}
                                </Text>
                              ) : null
                            }
                          >
                            {option.label}
                          </Menu.Item>
                        ),
                      )}
                    </React.Fragment>
                  ))}
            </Menu.Dropdown>
          </Menu>

          {!shouldHideTabs && (
            <ScrollArea
              scrollbarSize={SCROLL_AREA_CONFIG.SCROLLBAR_SIZE}
              scrollbars="x"
              style={{ flex: 1, minWidth: 0 }}
              data-tauri-drag-region
            >
              <Droppable droppableId={DROPPABLE_IDS.TABS} direction="horizontal">
                {(provided) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    style={{ display: "flex", minHeight: "100%" }}
                    data-tauri-drag-region
                  >
                    {tabs.map((tab, i) => (
                      <Draggable key={tab.value} draggableId={tab.value} index={i}>
                        {(provided) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            {...provided.dragHandleProps}
                            data-tauri-drag-region={false}
                          >
                            <BoardTab
                              tab={tab}
                              setActiveTab={handleTabSelect}
                              closeTab={closeTab}
                              renameTab={renameTab}
                              duplicateTab={duplicateTab}
                              openInNewWindow={openTabInNewWindow}
                              selected={activeTab === tab.value}
                              shouldFlash={flashingTab === tab.value}
                            />
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </ScrollArea>
          )}

          <Box w={trailingSpacerWidth} h="100%" data-tauri-drag-region />

          {layout.menuBar.displayWindowControls && (
            <Box data-tauri-drag-region={false}>
              <WindowControls />
            </Box>
          )}
        </Group>
      </DragDropContext>
    </Box>
  );
}
