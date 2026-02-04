import { info, error as logError } from "@tauri-apps/plugin-log";
import { platform } from "@tauri-apps/plugin-os";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersionCheckConfig, VERSION_CHECK_SETTINGS } from "@/config";
import { downloadApkToTemp, openApkInstaller } from "@/services/apk-updater";
import {
  checkForUpdates,
  isVersionCheckEnabled,
  isVersionSkipped,
  recordVersionCheck,
  type VersionCheckResult,
} from "@/services/version-checker";
import {
  hideUpdateProgressNotification,
  showApkReadyToInstallNotification,
  showApkUpdateProgressNotification,
  showUpdateErrorNotification,
  showUpdateProgressNotification,
  showUpdateSuccessNotification,
} from "../components/UpdateNotification";

export interface UseVersionCheckOptions {
  autoCheck?: boolean;
  startupDelay?: number;
  onUpdateAvailable?: (result: VersionCheckResult) => void;
  onCheckError?: (error: string) => void;
  onNoUpdates?: () => void;
}

export interface UseVersionCheckReturn {
  isChecking: boolean;
  isUpdating: boolean;
  lastResult: VersionCheckResult | null;
  checkVersion: () => Promise<void>;
  installUpdate: () => Promise<void>;
  isAutoCheckEnabled: boolean;
}

export function useVersionCheck(options: UseVersionCheckOptions = {}): UseVersionCheckReturn {
  const {
    autoCheck = true,
    startupDelay = VERSION_CHECK_SETTINGS.startupDelayMs,
    onUpdateAvailable,
    onCheckError,
    onNoUpdates,
  } = options;

  const { t } = useTranslation();
  const [isChecking, setIsChecking] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [lastResult, setLastResult] = useState<VersionCheckResult | null>(null);
  const [isAutoCheckEnabled] = useState(() => isVersionCheckEnabled());

  const autoCheckInitiated = useRef(false);

  const checkVersion = useCallback(async () => {
    if (isChecking || isUpdating) {
      return;
    }

    setIsChecking(true);

    try {
      info("Starting version check");
      const config = getVersionCheckConfig();
      const result = await checkForUpdates(config);

      setLastResult(result);
      recordVersionCheck();

      if (result.error) {
        logError(`Version check failed: ${result.error}`);
        onCheckError?.(result.error);
        return;
      }

      if (result.hasUpdate && result.versionInfo) {
        if (isVersionSkipped(result.versionInfo.version)) {
          info(`Version ${result.versionInfo.version} was previously skipped by user`);
          return;
        }

        info(`Update available: ${result.versionInfo.version}`);
        onUpdateAvailable?.(result);
      } else {
        info("No updates available");
        onNoUpdates?.();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logError(`Version check failed with exception: ${errorMessage}`);
      onCheckError?.(errorMessage);
    } finally {
      setIsChecking(false);
    }
  }, [isChecking, isUpdating, onUpdateAvailable, onCheckError, onNoUpdates]);

  const installUpdate = useCallback(async () => {
    if (isUpdating || !lastResult?.hasUpdate) {
      return;
    }

    setIsUpdating(true);

    try {
      const os = await platform();

      if (os === "android") {
        const apkUrl = lastResult.versionInfo?.apkDownloadUrl;
        const version = lastResult.versionInfo?.version;

        if (!apkUrl || !version) {
          throw new Error(t("notifications.apkNotAvailable"));
        }

        info("Starting update installation via direct APK (Android)");

        showApkUpdateProgressNotification(t);

        const downloaded = await downloadApkToTemp({ url: apkUrl, version });
        info(`APK downloaded to: ${downloaded.path} (${downloaded.bytes} bytes)`);

        hideUpdateProgressNotification();

        await openApkInstaller(downloaded.path);
        showApkReadyToInstallNotification(t);
        return;
      }

      info("Starting update installation via Tauri updater");

      showUpdateProgressNotification(t);

      const update = await check();

      if (update) {
        info(`Installing update: ${update.version}`);
        await update.downloadAndInstall();

        hideUpdateProgressNotification();
        showUpdateSuccessNotification(t);

        info("Update installed successfully, restarting application");
        setTimeout(() => relaunch(), 2000);
      } else {
        throw new Error("No update available through Tauri updater");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Update installation failed";
      logError(`Update installation failed: ${errorMessage}`);

      hideUpdateProgressNotification();
      showUpdateErrorNotification(errorMessage, t);
    } finally {
      setIsUpdating(false);
    }
  }, [isUpdating, lastResult, t]);

  const checkVersionRef = useRef(checkVersion);
  checkVersionRef.current = checkVersion;

  useEffect(() => {
    if (!autoCheck || !isAutoCheckEnabled || autoCheckInitiated?.current) {
      return;
    }

    // Always check for updates on startup, regardless of interval
    autoCheckInitiated.current = true;

    const timeoutId = setTimeout(() => {
      checkVersionRef.current();
    }, startupDelay);

    return () => clearTimeout(timeoutId);
  }, [autoCheck, isAutoCheckEnabled, startupDelay]);

  return {
    isChecking,
    isUpdating,
    lastResult,
    checkVersion,
    installUpdate,
    isAutoCheckEnabled,
  };
}

export function useManualVersionCheck() {
  const { checkVersion, isChecking, lastResult } = useVersionCheck({ autoCheck: false });

  return {
    checkVersion,
    isChecking,
    lastResult,
  };
}
