import { ActionIcon, Button, Menu, useMantineColorScheme } from "@mantine/core";
import { useClickOutside, useHotkeys, useToggle, useColorScheme } from "@mantine/hooks";
import { IconCopy, IconEdit, IconWindowMaximize, IconX } from "@tabler/icons-react";
import cx from "clsx";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ContentEditable } from "@/components/ContentEditable";
import type { Tab } from "@/utils/tabs";
import * as classes from "./styles.css";

export function BoardTab({
  tab,
  setActiveTab,
  closeTab,
  renameTab,
  duplicateTab,
  openInNewWindow,
  selected,
  shouldFlash,
}: {
  tab: Tab;
  setActiveTab: (v: string) => void;
  closeTab: (v: string) => void;
  renameTab: (v: string, n: string) => void;
  duplicateTab: (v: string) => void;
  openInNewWindow?: (tab: Tab) => void;
  selected: boolean;
  shouldFlash?: boolean;
}) {
  const [open, toggleOpen] = useToggle();
  const [renaming, toggleRenaming] = useToggle();
  const [isFlashing, setIsFlashing] = useState(false);
  const ref = useClickOutside(() => {
    toggleOpen(false);
    toggleRenaming(false);
  });
  const { t } = useTranslation();
  const { colorScheme } = useMantineColorScheme();
  const osColorScheme = useColorScheme();
  
  // Determine if we're in dark mode
  const isDark = colorScheme === "dark" || (osColorScheme === "dark" && colorScheme === "auto");

  useHotkeys([
    [
      "F2",
      () => {
        if (selected) toggleRenaming();
      },
    ],
  ]);

  useEffect(() => {
    if (renaming) ref.current?.focus();
  }, [renaming, ref]);

  useEffect(() => {
    if (shouldFlash) {
      setIsFlashing(true);
      const timer = setTimeout(() => {
        setIsFlashing(false);
      }, 2000); // Match animation duration (2 seconds)
      return () => clearTimeout(timer);
    } else {
      setIsFlashing(false);
    }
  }, [shouldFlash]);

  return (
    <Menu opened={open} shadow="md" width={200} closeOnClickOutside>
      <Menu.Target>
        <Button
          component="div"
          className={cx(classes.tab, { 
            [classes.selected]: selected, 
            [classes.flash]: isFlashing && !isDark,
            [classes.flashDark]: isFlashing && isDark,
          })}
          variant="default"
          fw="normal"
          data-tauri-drag-region={false}
          styles={isFlashing ? {
            root: {
              backgroundColor: isDark ? "rgba(255, 255, 255, 1) !important" : "rgba(255, 0, 150, 1) !important",
              border: isDark ? "4px solid rgba(255, 255, 255, 1) !important" : "4px solid rgba(255, 0, 150, 1) !important",
              boxShadow: isDark 
                ? "0 0 40px rgba(255, 255, 255, 1), 0 0 60px rgba(255, 255, 255, 0.9) !important"
                : "0 0 40px rgba(255, 0, 150, 1), 0 0 60px rgba(255, 100, 200, 0.8) !important",
              transform: "scale(1.15)",
              zIndex: 1000,
              position: "relative",
            },
          } : undefined}
          rightSection={
            <ActionIcon
              component="div"
              className={classes.closeTabBtn}
              data-tauri-drag-region={false}
              onClick={(e) => {
                closeTab(tab.value);
                e.stopPropagation();
              }}
              size="0.875rem"
            >
              <IconX />
            </ActionIcon>
          }
          onPointerDown={(e) => {
            if (e.button === 0) {
              setActiveTab(tab.value);
            }
          }}
          onDoubleClick={() => toggleRenaming(true)}
          onAuxClick={(e) => {
            // middle button click
            if (e.button === 1) {
              closeTab(tab.value);
            }
          }}
          onContextMenu={(e) => {
            toggleOpen();
            e.preventDefault();
          }}
        >
          <ContentEditable
            innerRef={ref}
            disabled={!renaming}
            html={tab.name}
            className={classes.input}
            data-tauri-drag-region={false}
            onChange={(e) => renameTab(tab.value, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") toggleRenaming(false);
            }}
          />
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {openInNewWindow ? (
          <Menu.Item leftSection={<IconWindowMaximize size="0.875rem" />} onClick={() => openInNewWindow(tab)}>
            {t("common.openTabInNewWindow")}
          </Menu.Item>
        ) : null}
        <Menu.Item leftSection={<IconCopy size="0.875rem" />} onClick={() => duplicateTab(tab.value)}>
          {t("common.duplicateTab")}
        </Menu.Item>
        <Menu.Item leftSection={<IconEdit size="0.875rem" />} onClick={() => toggleRenaming(true)}>
          {t("common.renameTab")}
        </Menu.Item>
        <Menu.Item color="red" leftSection={<IconX size="0.875rem" />} onClick={() => closeTab(tab.value)}>
          {t("common.closeTab")}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
