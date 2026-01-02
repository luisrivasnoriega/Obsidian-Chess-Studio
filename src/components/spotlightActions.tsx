import type { SpotlightActionData, SpotlightActionGroupData } from "@mantine/spotlight";
import { IconSettings } from "@tabler/icons-react";
import type { useNavigate } from "@tanstack/react-router";
import React from "react";
import { linksdata } from "@/components/Sidebar";

export function getSpotlightActions(
  navigate: ReturnType<typeof useNavigate>,
  t: (key: string) => string,
): (SpotlightActionGroupData | SpotlightActionData)[] {
  return [
    {
      group: "Pages",
      actions: linksdata.map((link) => {
        const label = t(`features.sidebar.${link.label}`);

        return {
          id: link.label,
          label,
          description: `Go to ${label} page`,
          onClick: () => navigate({ to: link.url }),
          leftSection: <link.icon size={24} stroke={1.5} />,
        };
      }),
    },
    {
      group: "Settings",
      actions: [
        {
          id: "keybindings",
          label: t("features.sidebar.keyboardShortcuts"),
          description: `Open ${t("features.sidebar.keyboardShortcuts")} page`,
          onClick: () => navigate({ to: "/settings/keyboard-shortcuts" }),
          leftSection: <IconSettings size={24} stroke={1.5} />,
        },
        {
          id: "settings",
          label: t("features.sidebar.settings"),
          description: `Open ${t("features.sidebar.settings")} page`,
          onClick: () => navigate({ to: "/settings" }),
          leftSection: <IconSettings size={24} stroke={1.5} />,
        },
      ],
    },
  ];
}

