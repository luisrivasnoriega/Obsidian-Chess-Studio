import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getMatches } from "@tauri-apps/plugin-cli";
import { attachConsole, error, info } from "@tauri-apps/plugin-log";
import { useAtom, useAtomValue } from "jotai";
import { ContextMenuProvider } from "mantine-contextmenu";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isFailedToFetchError, startNetworkCooldown } from "@/utils/networkCooldown";
import {
  activeProfileIdAtom,
  activeTabAtom,
  fontSizeAtom,
  pieceSetAtom,
  profilesAtom,
  sessionsAtom,
  tabsAtom,
} from "./state/atoms";
import { ensurePieceSetCss } from "./utils/pieceSetCss";

import "@mantine/charts/styles.css";
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/tiptap/styles.css";
import "@mantine/spotlight/styles.css";
import "mantine-contextmenu/styles.css";
import "mantine-datatable/styles.css";
import "@/styles/chessgroundBaseOverride.css";
import "@/styles/chessgroundColorsOverride.css";
import "@/styles/global.css";

import ErrorComponent from "@/components/ErrorComponent";
import { EventMonitor } from "@/components/EventMonitor";
import { showUpdateNotification, UpdateNotificationModal } from "@/components/UpdateNotification";
import { VERSION_CHECK_SETTINGS } from "@/config";
import ThemeProvider from "@/features/themes/components/ThemeProvider";
import { useVersionCheck } from "@/hooks/useVersionCheck";
import type { Dirs } from "@/types/dirs";
import { commands } from "./bindings";
import { IS_DEV } from "./config";
import i18n from "./i18n";
import { routeTree } from "./routeTree.gen";
import type { VersionCheckResult } from "./services/version-checker";
import { autoRegisterBundledEngines } from "./utils/bundledEngines";
import { getDocumentDir } from "./utils/documentDir";
import { openFile } from "./utils/files";
import { migrateLegacyGameRecordsProfileId } from "./utils/gameRecords";
import { ensureProfilesInitialized } from "./utils/profiles";

type InitializationState = "loading" | "initialized" | "error";

const DEFAULT_FONT_SIZE = 18;
const SPINNER_STYLES = {
  width: "24px",
  height: "24px",
  border: "2px solid #374151",
  borderTop: "2px solid #667eea",
  borderRadius: "50%",
  animation: "spin 1s linear infinite",
} as const;

const LOADING_CONTAINER_STYLES = {
  backgroundColor: "#1a1b1e",
  color: "#ffffff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "100vh",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
} as const;

const ERROR_CONTAINER_STYLES = {
  backgroundColor: "#1a1b1e",
  color: "#ffffff",
  padding: "20px",
  minHeight: "100vh",
} as const;

let directoriesCache: Promise<Dirs> | null = null;

export const loadDirectories = async (): Promise<Dirs> => {
  if (directoriesCache) {
    return directoriesCache;
  }

  directoriesCache = (async (): Promise<Dirs> => {
    return { documentDir: await getDocumentDir() };
  })();

  return directoriesCache;
};

export const clearDirectoriesCache = () => {
  directoriesCache = null;
};

export const updateDirectoriesCache = async (): Promise<Dirs> => {
  clearDirectoriesCache();
  return loadDirectories();
};

// Singleton to prevent multiple console attachments (prevents "Cannot have two MultiBackends" error)
let consoleAttachmentPromise: Promise<(() => void) | null> | null = null;
let isConsoleAttached = false;

export const attachConsoleOnce = async (): Promise<(() => void) | null> => {
  // If already attached, return a no-op detach function
  if (isConsoleAttached) {
    return () => {
      // No-op: console is already attached and managed elsewhere
    };
  }

  // If there's an ongoing attachment, wait for it
  if (consoleAttachmentPromise) {
    return consoleAttachmentPromise;
  }

  // Create new attachment promise
  consoleAttachmentPromise = (async () => {
    try {
      const detach = await attachConsole();
      isConsoleAttached = true;
      return detach;
    } catch (error) {
      // If attachment fails (e.g., already attached), mark as attached anyway
      // to prevent retry loops
      const errorMsg = String(error);
      if (errorMsg.includes("MultiBackend") || errorMsg.includes("already")) {
        isConsoleAttached = true;
        return () => {
          // No-op: console was already attached
        };
      }
      // Re-throw other errors
      throw error;
    }
  })();

  return consoleAttachmentPromise;
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (isFailedToFetchError(error)) {
          // Avoid retry storms when the network is down. Cool down for 10 minutes.
          startNetworkCooldown();
          return false;
        }
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60 * 5, // 5 minutes
    },
  },
});

const router = createRouter({
  routeTree,
  defaultErrorComponent: ErrorComponent,
  context: {
    loadDirs: loadDirectories,
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function AppLoading() {
  return (
    <div style={LOADING_CONTAINER_STYLES}>
      <div style={SPINNER_STYLES} />
    </div>
  );
}

function AppError({ error: errorMsg }: { error: string }) {
  const { t } = useTranslation();
  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  return (
    <div style={ERROR_CONTAINER_STYLES}>
      <h2 style={{ color: "#ef4444", marginBottom: "16px" }}>{t("common.initializationErrorTitle")}</h2>
      <p style={{ color: "#9ca3af", marginBottom: "16px" }}>{t("common.initializationErrorDescription")}</p>
      <pre
        style={{
          backgroundColor: "#374151",
          padding: "12px",
          borderRadius: "6px",
          color: "#ffffff",
          fontSize: "12px",
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {errorMsg}
      </pre>
      <button
        type="button"
        onClick={handleReload}
        style={{
          marginTop: "16px",
          padding: "8px 16px",
          backgroundColor: "#667eea",
          color: "white",
          border: "none",
          borderRadius: "6px",
          cursor: "pointer",
          fontSize: "14px",
        }}
      >
        {t("common.reloadApplication")}
      </button>
    </div>
  );
}

function useAppInitialization() {
  const [initState, setInitState] = useState<InitializationState>("loading");
  const [initError, setInitError] = useState<string | null>(null);
  const [, setTabs] = useAtom(tabsAtom);
  const [, setActiveTab] = useAtom(activeTabAtom);

  const handleCommandLineFile = useCallback(async () => {
    try {
      const matches = await getMatches();
      if (matches.args.file.occurrences > 0 && typeof matches.args.file.value === "string") {
        info(`Opening file from command line: ${matches.args.file.value}`);
        await openFile(matches.args.file.value, setTabs, setActiveTab);
      }
    } catch (e) {
      error(`Failed to handle command line file: ${e}`);
    }
  }, [setTabs, setActiveTab]);

  const initializeApp = useCallback(async () => {
    let detachConsole: (() => void) | null = null;

    try {
      info("Starting React app initialization");

      const [, detach] = await Promise.all([loadDirectories(), attachConsoleOnce()]);

      detachConsole = detach;
      info("Console logging attached successfully");

      // Minimize window at startup
      try {
        const webviewWindow = getCurrentWebviewWindow();
        await webviewWindow.minimize();
        info("Window minimized at startup");
      } catch (e) {
        error(`Failed to minimize window at startup: ${e}`);
      }

      // Detect system locale on first run and set language accordingly
      try {
        const hasLang = localStorage.getItem("lang");
        if (!hasLang) {
          info("No language set in localStorage, detecting system locale...");
          const localeResult = await commands.getSystemLocale();
          let systemLocale: string | null = null;

          if (localeResult.status === "ok") {
            systemLocale = localeResult.data;
          } else {
            error(`System locale detection returned error: ${localeResult.error}`);
          }

          if (systemLocale) {
            const localeLower = systemLocale.toLowerCase();
            let detectedLang: string;
            // Detect Spanish variants (es-MX, es-ES, es, etc.)
            if (localeLower.startsWith("es")) {
              detectedLang = "es-ES";
              info(`Detected Spanish locale (${systemLocale}), setting language to es-ES`);
            }
            // Detect English variants (en-US, en-GB, en, etc.)
            else if (localeLower.startsWith("en")) {
              detectedLang = "en-US";
              info(`Detected English locale (${systemLocale}), setting language to en-US`);
            }
            // For other locales, default to English
            else {
              detectedLang = "en-US";
              info(`Detected locale ${systemLocale}, defaulting to en-US`);
            }
            localStorage.setItem("lang", detectedLang);
            i18n.changeLanguage(detectedLang);
          } else {
            // If system locale detection returns null, use browser locale as fallback
            const browserLang = navigator.language || navigator.languages?.[0] || "en-US";
            const browserLangLower = browserLang.toLowerCase();
            let fallbackLang: string;
            if (browserLangLower.startsWith("es")) {
              fallbackLang = "es-ES";
            } else if (browserLangLower.startsWith("en")) {
              fallbackLang = "en-US";
            } else {
              fallbackLang = "en-US";
            }
            localStorage.setItem("lang", fallbackLang);
            i18n.changeLanguage(fallbackLang);
            info(`System locale detection returned null, using browser locale (${browserLang}) -> ${fallbackLang}`);
          }
        } else {
          info(`Language already set in localStorage: ${hasLang}`);
        }
      } catch (e) {
        error(`Failed to detect system locale: ${e}`);
        // If detection fails, ensure we have a language set
        const hasLang = localStorage.getItem("lang");
        if (!hasLang) {
          const browserLang = navigator.language || navigator.languages?.[0] || "en-US";
          const browserLangLower = browserLang.toLowerCase();
          let fallbackLang: string;
          if (browserLangLower.startsWith("es")) {
            fallbackLang = "es-ES";
          } else if (browserLangLower.startsWith("en")) {
            fallbackLang = "en-US";
          } else {
            fallbackLang = "en-US";
          }
          localStorage.setItem("lang", fallbackLang);
          i18n.changeLanguage(fallbackLang);
          info(`Using browser locale as fallback after error: ${browserLang} -> ${fallbackLang}`);
        }
      }

      await handleCommandLineFile();
      await commands.screenCapture();

      // Maximize window after app loads
      try {
        const webviewWindow = getCurrentWebviewWindow();
        const isMaximized = await webviewWindow.isMaximized();
        if (!isMaximized) {
          await webviewWindow.toggleMaximize();
          info("Window maximized after initialization");
        }
      } catch (e) {
        error(`Failed to maximize window: ${e}`);
      }

      setInitState("initialized");
      info("React app initialization completed successfully");

      return detachConsole;
    } catch (e) {
      const errorMsg = `Failed to initialize app: ${e}`;
      error(errorMsg);
      setInitError(errorMsg);
      setInitState("error");

      try {
        await commands.screenCapture();
      } catch (_error) {
        error(`Failed to capture screen after error: ${_error}`);
      }

      return detachConsole;
    }
  }, [handleCommandLineFile]);

  return { initState, initError, initializeApp };
}

function usePieceSetManager(pieceSet: string) {
  useEffect(() => {
    const loadingElement = document.getElementById("app-loading");
    if (loadingElement) {
      loadingElement.style.display = "none";
    }
  }, []);

  useEffect(() => {
    if (!pieceSet) return;

    const controller = new AbortController();

    // Apply the new piece set in an atomic swap:
    // keep old CSS until the new one is loaded and ready, then replace.
    ensurePieceSetCss(pieceSet, { signal: controller.signal }).catch(() => {
      // Non-critical: if it fails, keep the current pieces.
    });

    return () => controller.abort();
  }, [pieceSet]);
}

function useFontSizeManager(fontSize: number | null) {
  const fontSizeValue = useMemo(() => fontSize || DEFAULT_FONT_SIZE, [fontSize]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSizeValue}%`;
  }, [fontSizeValue]);

  return fontSizeValue;
}

export default function App() {
  const { t } = useTranslation();
  const pieceSet = useAtomValue(pieceSetAtom);
  const fontSize = useAtomValue(fontSizeAtom);
  const [sessions, setSessions] = useAtom(sessionsAtom);
  const [profiles, setProfiles] = useAtom(profilesAtom);
  const [activeProfileId, setActiveProfileId] = useAtom(activeProfileIdAtom);

  const [updateModalData, setUpdateModalData] = useState<VersionCheckResult | null>(null);

  const { initState, initError, initializeApp } = useAppInitialization();

  useFontSizeManager(fontSize);
  usePieceSetManager(pieceSet);

  const { installUpdate, isUpdating } = useVersionCheck({
    autoCheck: true,
    onUpdateAvailable: (result) => {
      if (VERSION_CHECK_SETTINGS.useModalNotification && result.versionInfo) {
        setUpdateModalData(result);
      } else if (result.versionInfo) {
        showUpdateNotification(
          result.versionInfo,
          () => installUpdate(),
          () => setUpdateModalData(result),
          t,
        );
      }
    },
    onCheckError: (error) => {
      info(`Version check failed: ${error}`);
    },
    onNoUpdates: () => {
      info("No updates available");
    },
  });

  const handleUpdateModalClose = useCallback(() => {
    setUpdateModalData(null);
  }, []);

  const handleUpdateModalUpdate = useCallback(() => {
    installUpdate();
    setUpdateModalData(null);
  }, [installUpdate]);

  useEffect(() => {
    let detachConsole: (() => void) | null = null;
    let mounted = true;

    const init = async () => {
      detachConsole = await initializeApp();
    };

    init();

    return () => {
      mounted = false;
      if (detachConsole) {
        try {
          detachConsole();
        } catch (e) {
          // Only log error if component is still mounted
          if (mounted) {
            error(`Failed to detach console: ${e}`);
          }
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initializeApp]); // Only run once on mount, not when initializeApp changes

  useEffect(() => {
    const rootElement = document.documentElement;
    const direction = i18n.dir();

    rootElement.setAttribute("dir", direction);
    rootElement.classList.toggle("rtl", direction === "rtl");
  }, []);

  useEffect(() => {
    localStorage.removeItem("orion-plan-api-key");
    sessionStorage.removeItem("orion-plan-api-key");
  }, []);

  // Use ref to prevent infinite loop from state updates triggering this effect
  const isProcessingProfilesRef = useRef(false);
  const lastProcessedHashRef = useRef<string>("");

  useEffect(() => {
    // Prevent re-entry if we're already processing
    if (isProcessingProfilesRef.current) {
      return;
    }

    // Build a compact deterministic fingerprint to avoid expensive JSON serialization
    // of large arrays on every render.
    const profileHash = profiles.map((p) => `${p.id}:${p.name}`).join("|");
    const sessionHash = sessions
      .map((s) => {
        const platform = s.lichess ? "lichess" : "chesscom";
        const username = s.lichess?.username ?? s.chessCom?.username ?? "";
        return `${s.profileId ?? ""}:${platform}:${username}:${s.player ?? ""}`;
      })
      .join("|");
    const currentHash = `${activeProfileId ?? ""}::${profileHash}::${sessionHash}`;

    // Skip if nothing has actually changed
    if (lastProcessedHashRef.current === currentHash) {
      return;
    }

    isProcessingProfilesRef.current = true;

    try {
      const res = ensureProfilesInitialized({ sessions, profiles, activeProfileId });

      // Deep comparison for profiles - check if any profile actually changed
      const profilesChanged =
        res.profiles.length !== profiles.length ||
        res.profiles.some((p, i) => {
          const existing = profiles[i];
          return !existing || existing.id !== p.id || existing.name !== p.name;
        });

      // More robust comparison for sessions - check by unique key instead of index
      // Only update if there are actual changes (profile updates, etc.)
      // Don't restore sessions that were deleted (i.e., sessions in res.sessions that don't exist in current sessions)
      const currentSessionKeys = new Set(
        sessions.map((s) => {
          const platform = s.lichess ? "lichess" : "chesscom";
          const username = s.lichess?.username ?? s.chessCom?.username ?? "";
          return `${s.profileId ?? ""}:${platform}:${username}`;
        }),
      );

      // Filter out any sessions from res.sessions that don't exist in current sessions
      // This prevents restoring deleted sessions
      const filteredResSessions = res.sessions.filter((s) => {
        const platform = s.lichess ? "lichess" : "chesscom";
        const username = s.lichess?.username ?? s.chessCom?.username ?? "";
        const key = `${s.profileId ?? ""}:${platform}:${username}`;
        return currentSessionKeys.has(key);
      });

      const existingSessionsByKey = new Map(
        sessions.map((existing) => {
          const existingPlatform = existing.lichess ? "lichess" : "chesscom";
          const existingUsername = existing.lichess?.username ?? existing.chessCom?.username ?? "";
          const existingKey = `${existing.profileId ?? ""}:${existingPlatform}:${existingUsername}`;
          return [existingKey, existing] as const;
        }),
      );

      const sessionsChanged =
        filteredResSessions.length !== sessions.length ||
        filteredResSessions.some((s) => {
          const platform = s.lichess ? "lichess" : "chesscom";
          const username = s.lichess?.username ?? s.chessCom?.username ?? "";
          const sessionKey = `${s.profileId ?? ""}:${platform}:${username}`;
          const existing = existingSessionsByKey.get(sessionKey);
          // Only consider it changed if profile/player name changed, not if it's a new session
          if (!existing) return false;
          return existing.profileId !== s.profileId || existing.player !== s.player;
        });

      // Only update state if there are actual changes
      if (profilesChanged) {
        setProfiles(res.profiles);
      }

      // Only update sessions if there are actual meaningful changes (profile updates)
      // Don't restore deleted sessions
      if (sessionsChanged) {
        setSessions(filteredResSessions);
      }

      if (res.activeProfileId !== activeProfileId) {
        setActiveProfileId(res.activeProfileId);
      }

      // Update hash after processing to prevent immediate re-trigger
      lastProcessedHashRef.current = currentHash;
    } finally {
      // Reset the processing flag after a microtask to allow state updates to complete
      Promise.resolve().then(() => {
        isProcessingProfilesRef.current = false;
      });
    }
  }, [activeProfileId, profiles, sessions, setActiveProfileId, setProfiles, setSessions]);

  // Auto-register bundled engines (e.g., Stockfish on Android) on app startup
  useEffect(() => {
    if (initState === "initialized") {
      autoRegisterBundledEngines().catch((error) => {
        error(`Failed to auto-register bundled engines: ${error}`);
      });
    }
  }, [initState]);

  useEffect(() => {
    if (activeProfileId) {
      migrateLegacyGameRecordsProfileId(activeProfileId).catch(() => {});
    }
  }, [activeProfileId]);

  if (initState === "loading") {
    return <AppLoading />;
  }

  if (initState === "error" && initError) {
    return <AppError error={initError} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ContextMenuProvider>
          <Notifications />
          {IS_DEV && <EventMonitor />}
          <Suspense fallback={<AppLoading />}>
            <RouterProvider router={router} />
          </Suspense>

          {updateModalData?.versionInfo && (
            <UpdateNotificationModal
              versionInfo={updateModalData.versionInfo}
              onUpdate={handleUpdateModalUpdate}
              onSkip={handleUpdateModalClose}
              onDismiss={handleUpdateModalClose}
              isUpdating={isUpdating}
            />
          )}
        </ContextMenuProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
