import { ActionIcon, Box, ScrollArea, Stack, Tooltip } from "@mantine/core";
import {
  IconArrowBack,
  IconCamera,
  IconChess,
  IconChessFilled,
  IconDeviceFloppy,
  IconEdit,
  IconEditOff,
  IconEraser,
  IconReload,
  IconShare,
  IconSwitchVertical,
  IconTarget,
  IconZoomCheck,
} from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { keyMapAtom } from "@/state/keybindings";

interface BoardControlsMenuProps {
  viewPawnStructure?: boolean;
  setViewPawnStructure?: (value: boolean) => void;
  takeSnapshot?: () => void;
  canTakeBack?: boolean;
  deleteMove?: () => void;
  changeTabType?: () => void;
  currentTabType?: "analysis" | "play";
  eraseDrawablesOnClick?: boolean;
  clearShapes?: () => void;
  disableVariations?: boolean;
  editingMode?: boolean;
  toggleEditingMode?: () => void;
  saveFile?: () => void;
  copyPgn?: () => void;
  reload?: () => void;
  addGame?: () => void;
  toggleOrientation?: () => void;
  currentTabSourceType?: string;
  count?: number;
  dirty?: boolean;
  autoSave?: boolean;
  orientation?: "horizontal" | "vertical";
}

interface MenuItemConfig {
  id: string;
  condition: boolean;
  icon: React.ReactNode;
  activeIcon?: React.ReactNode;
  onClick: () => void;
  label: string;
  tooltipLabel?: string;
  variant?: "default" | "outline";
}

function BoardControlsMenu({
  viewPawnStructure,
  setViewPawnStructure,
  takeSnapshot,
  canTakeBack,
  deleteMove,
  changeTabType,
  currentTabType,
  eraseDrawablesOnClick,
  clearShapes,
  disableVariations,
  editingMode,
  toggleEditingMode,
  saveFile,
  copyPgn,
  reload,
  addGame: _addGame,
  toggleOrientation,
  currentTabSourceType,
  count: _count = 0,
  dirty = false,
  autoSave = false,
  orientation = "horizontal",
}: BoardControlsMenuProps) {
  const keyMap = useAtomValue(keyMapAtom);
  const { t } = useTranslation();
  const { layout } = useResponsiveLayout();
  const isCompact = layout.chessBoard.layoutType === "mobile";
  const actionSize = isCompact ? "md" : "lg";
  const iconSize = isCompact ? "1.05rem" : "1.3rem";
  // Academia Maya accent (matches the tab highlight line)
  const accentColor = "#f9a825";

  // Define all menu items with their configurations
  const allMenuItems: MenuItemConfig[] = [
    {
      id: "pawnStructure",
      condition: !!setViewPawnStructure,
      icon: <IconChess size={iconSize} />,
      activeIcon: <IconChessFilled size={iconSize} />,
      onClick: () => setViewPawnStructure?.(!viewPawnStructure),
      label: t("features.board.actions.togglePawnStructureView"),
      tooltipLabel: t("features.board.actions.togglePawnStructureView"),
    },
    {
      id: "snapshot",
      condition: !!takeSnapshot,
      icon: <IconCamera size={iconSize} />,
      onClick: () => takeSnapshot?.(),
      label: t("features.board.actions.takeSnapshot"),
      tooltipLabel: t("features.board.actions.takeSnapshot"),
    },
    {
      id: "takeBack",
      condition: !!canTakeBack && !!deleteMove,
      icon: <IconArrowBack size={iconSize} />,
      onClick: () => deleteMove?.(),
      label: t("features.board.actions.takeBack"),
      tooltipLabel: t("features.board.actions.takeBack"),
    },
    {
      id: "changeTabType",
      condition: !!changeTabType,
      icon:
        currentTabType === "analysis" ? (
          <IconTarget size={iconSize} />
        ) : (
          <IconZoomCheck size={iconSize} />
        ),
      onClick: () => changeTabType?.(),
      label: t(
        currentTabType === "analysis" ? "features.board.actions.playFromHere" : "features.board.actions.analyzeGame",
      ),
      tooltipLabel: t(
        currentTabType === "analysis" ? "features.board.actions.playFromHere" : "features.board.actions.analyzeGame",
      ),
    },
    {
      id: "clearShapes",
      condition: !eraseDrawablesOnClick && !!clearShapes,
      icon: <IconEraser size={iconSize} />,
      onClick: () => clearShapes?.(),
      label: t("features.board.actions.clearDrawings"),
      tooltipLabel: t("features.board.actions.clearDrawings"),
    },
    {
      id: "editingMode",
      condition: !disableVariations && !!toggleEditingMode,
      icon: <IconEdit size={iconSize} />,
      activeIcon: <IconEditOff size={iconSize} />,
      onClick: () => toggleEditingMode?.(),
      label: t("features.board.actions.editPosition"),
      tooltipLabel: t("features.board.actions.editPosition"),
    },
    {
      id: "saveFile",
      condition: !!saveFile,
      icon: <IconDeviceFloppy size={iconSize} />,
      onClick: () => saveFile?.(),
      label: t("features.board.actions.savePGN", { key: keyMap.SAVE_FILE.keys }),
      tooltipLabel: t("features.board.actions.savePGN", { key: keyMap.SAVE_FILE.keys }),
      variant: (dirty && !autoSave ? "outline" : "default") as "default" | "outline",
    },
    {
      id: "copyPgn",
      condition: !!copyPgn,
      icon: <IconShare size={iconSize} />,
      onClick: () => copyPgn?.(),
      label: t("features.board.actions.sharePGN", { key: keyMap.COPY_PGN.keys }),
      tooltipLabel: t("features.board.actions.sharePGN", { key: keyMap.COPY_PGN.keys }),
    },
    {
      id: "reload",
      condition: !!reload,
      icon: <IconReload size={iconSize} />,
      onClick: () => reload?.(),
      label: t("features.menu.reload"),
      tooltipLabel: t("features.menu.reload"),
    },
    {
      id: "toggleOrientation",
      condition: !!toggleOrientation,
      icon: <IconSwitchVertical size={iconSize} />,
      onClick: () => toggleOrientation?.(),
      label: t("features.board.actions.flipBoard", { key: keyMap.SWAP_ORIENTATION.keys }),
      tooltipLabel: t("features.board.actions.flipBoard", { key: keyMap.SWAP_ORIENTATION.keys }),
    },
  ];

  // Filter items that should be shown
  const visibleItems = allMenuItems.filter((item) => item.condition);

  const renderIcon = (item: MenuItemConfig) => {
    if (item.id === "pawnStructure") {
      return viewPawnStructure ? item.activeIcon || item.icon : item.icon;
    }
    if (item.id === "editingMode") {
      return editingMode ? item.activeIcon || item.icon : item.icon;
    }
    return item.icon;
  };

  const shouldHighlight = currentTabType === "analysis";
  const highlightStyles = shouldHighlight ? {} : {};

  const getActionIconVariant = (item: MenuItemConfig): "subtle" | "light" => {
    // Keep the "needs save" hint without adding borders.
    if (item.id === "saveFile" && item.variant === "outline") return "light";
    return "subtle";
  };
  const actionIconStyle = { color: accentColor } as const;
  const actionIconStyles = {
    root: {
      color: accentColor,
    },
  } as const;

  if (orientation === "vertical") {
    return (
      <ScrollArea
        type="auto"
        scrollbars="y"
        h="100%"
        scrollbarSize={6}
        styles={{
          viewport: {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0.375rem",
          },
        }}
      >
        <Box
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0.375rem",
            borderRadius: "12px",
            ...highlightStyles,
          }}
        >
          <Stack gap={6} align="center" py={2}>
            {visibleItems.map((item) => (
              <Tooltip key={item.id} label={item.tooltipLabel || item.label} position="left">
                <ActionIcon
                  onClick={item.onClick}
                  size={actionSize}
                  variant={getActionIconVariant(item)}
                  style={actionIconStyle}
                  styles={actionIconStyles}
                >
                  {renderIcon(item)}
                </ActionIcon>
              </Tooltip>
            ))}
          </Stack>
        </Box>
      </ScrollArea>
    );
  }

  return (
    <Box
      style={{
        height: isCompact ? "auto" : "100%",
        width: isCompact ? "100%" : "auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        alignSelf: "center",
        padding: isCompact ? "0.2rem 0" : "0.375rem",
        borderRadius: "12px",
        ...highlightStyles,
      }}
    >
      {isCompact ? (
        <ScrollArea
          type="auto"
          scrollbars="x"
          scrollbarSize={6}
          styles={{
            viewport: {
              display: "flex",
              overflowY: "hidden",
            },
          }}
          style={{ width: "100%" }}
        >
          <Box style={{ minWidth: "100%", display: "flex", justifyContent: "center" }}>
            <Box style={{ display: "flex", gap: "0.35rem", width: "max-content", padding: "0.125rem 0.35rem" }}>
              {visibleItems.map((item) => (
                <Tooltip key={item.id} label={item.tooltipLabel || item.label}>
                  <ActionIcon
                    onClick={item.onClick}
                    size={actionSize}
                    variant={getActionIconVariant(item)}
                    style={actionIconStyle}
                    styles={actionIconStyles}
                  >
                    {renderIcon(item)}
                  </ActionIcon>
                </Tooltip>
              ))}
            </Box>
          </Box>
        </ScrollArea>
      ) : (
        <ActionIcon.Group>
          {visibleItems.map((item) => (
            <Tooltip key={item.id} label={item.tooltipLabel || item.label}>
              <ActionIcon
                onClick={item.onClick}
                size={actionSize}
                variant={getActionIconVariant(item)}
                style={actionIconStyle}
                styles={actionIconStyles}
              >
                {renderIcon(item)}
              </ActionIcon>
            </Tooltip>
          ))}
        </ActionIcon.Group>
      )}
    </Box>
  );
}

export default memo(BoardControlsMenu);
