import { notifications } from "@mantine/notifications";
import { TauriEvent } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { TFunction } from "i18next";
import { env } from "@/utils/detectEnvironment";
import type { Tab } from "@/utils/tabs";

function createPayloadId(tabId: string) {
  return `${tabId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function collectTabSession(tabId: string) {
  const session: Record<string, string> = {};
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key) continue;
      if (key === tabId || key.startsWith(`${tabId}_`)) {
        const value = sessionStorage.getItem(key);
        if (typeof value === "string") {
          session[key] = value;
        }
      }
    }
  } catch {}
  return session;
}

export function openDetachedVariantsNotationPanel(
  tab: Tab | undefined,
  t: TFunction,
  callbacks?: {
    onCreated?: () => void;
    onClosed?: () => void;
  },
): boolean {
  if (!tab || !env.isDesktop()) return false;

  const payloadId = createPayloadId(tab.value);
  const payloadKey = `detached-panel:${payloadId}`;

  try {
    localStorage.setItem(
      payloadKey,
      JSON.stringify({
        tab,
        session: collectTabSession(tab.value),
      }),
    );
  } catch {
    notifications.show({
      title: t("common.error"),
      message: t("features.gameNotation.openNotationWindowFailed"),
      color: "red",
    });
    return false;
  }

  const label = `panel_variants_notation_${payloadId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const url = `/?detachedPanel=variantsNotation&payload=${encodeURIComponent(payloadId)}&tab=${encodeURIComponent(
    tab.value,
  )}`;
  const panelTitle = `${tab.name} - ${t("features.gameNotation.panelTitle")}`;
  const panelWindow = new WebviewWindow(label, {
    url,
    title: panelTitle,
    width: 520,
    height: 900,
    minWidth: 360,
    minHeight: 480,
    decorations: true,
  });

  panelWindow.once("tauri://error", () => {
    try {
      localStorage.removeItem(payloadKey);
    } catch {}
    callbacks?.onClosed?.();
    notifications.show({
      title: t("common.error"),
      message: t("features.gameNotation.openNotationWindowFailed"),
      color: "red",
    });
  });
  panelWindow.once("tauri://created", () => {
    callbacks?.onCreated?.();
  });
  panelWindow.once(TauriEvent.WINDOW_DESTROYED, () => {
    callbacks?.onClosed?.();
  });

  return true;
}
