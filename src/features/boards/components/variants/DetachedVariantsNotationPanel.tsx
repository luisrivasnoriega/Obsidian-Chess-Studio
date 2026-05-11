import { Box, Center, Loader, Stack, Text } from "@mantine/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useAtom } from "jotai";
import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TreeStateContext, TreeStateProvider } from "@/components/TreeStateContext";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import type { Tab } from "@/utils/tabs";
import { tabSchema } from "@/utils/tabs";
import VariantsNotation from "../VariantsNotation";
import { useVariantsNotationPanelSync } from "./variantsNotationPanelSync";

type DetachedPanelPayload = {
  tab?: unknown;
  session?: Record<string, string>;
};

function readPayload(payloadId: string | null): Tab | null {
  if (!payloadId || typeof window === "undefined") return null;

  const payloadKey = `detached-panel:${payloadId}`;
  const payloadJson = localStorage.getItem(payloadKey);
  if (!payloadJson) return null;

  try {
    const payload = JSON.parse(payloadJson) as DetachedPanelPayload;
    if (payload.session) {
      for (const [key, value] of Object.entries(payload.session)) {
        sessionStorage.setItem(key, value);
      }
    }

    const parsed = tabSchema.safeParse(payload.tab);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function DetachedVariantsNotationContent({ tabId }: { tabId: string }) {
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("DetachedVariantsNotationContent must be used within a TreeStateProvider");
  }

  useVariantsNotationPanelSync({
    mode: "client",
    store,
    tabId,
  });

  return (
    <Box h="100vh" w="100vw" p="xs" style={{ minHeight: 0, minWidth: 0, overflow: "hidden" }}>
      <VariantsNotation topBar forceDesktopLayout />
    </Box>
  );
}

export function DetachedVariantsNotationPanel({
  payloadId,
  tabId,
}: {
  payloadId: string | null;
  tabId: string | null;
}) {
  const { t } = useTranslation();
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [, setActiveTab] = useAtom(activeTabAtom);
  const [resolvedTabId, setResolvedTabId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const tab = readPayload(payloadId);
    const fallbackTab = tabId ? tabs.find((item) => item.value === tabId) : undefined;
    const resolvedTab = tab ?? fallbackTab ?? null;

    if (!resolvedTab) {
      setFailed(true);
      return;
    }

    setTabs((prev) => (prev.some((item) => item.value === resolvedTab.value) ? prev : [...prev, resolvedTab]));
    setActiveTab(resolvedTab.value);
    setResolvedTabId(resolvedTab.value);

    try {
      void getCurrentWebviewWindow().setTitle(`${resolvedTab.name} - ${t("features.gameNotation.panelTitle")}`);
    } catch {}
  }, [payloadId, setActiveTab, setTabs, t, tabId, tabs]);

  if (failed) {
    return (
      <Center h="100vh" p="md">
        <Text c="red">{t("features.gameNotation.detachedPanelLoadFailed")}</Text>
      </Center>
    );
  }

  if (!resolvedTabId) {
    return (
      <Center h="100vh">
        <Stack align="center" gap="sm">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            {t("common.loading")}
          </Text>
        </Stack>
      </Center>
    );
  }

  return (
    <TreeStateProvider id={resolvedTabId}>
      <DetachedVariantsNotationContent tabId={resolvedTabId} />
    </TreeStateProvider>
  );
}
