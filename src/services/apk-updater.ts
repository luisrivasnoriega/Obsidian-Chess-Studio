import { join, tempDir } from "@tauri-apps/api/path";
import { mkdir, writeFile } from "@tauri-apps/plugin-fs";
import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import { openPath } from "@tauri-apps/plugin-opener";

export interface DownloadedApk {
  path: string;
  bytes: number;
}

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch {
    // Best-effort; writeFile will fail if the directory truly doesn't exist.
  }
}

export async function downloadApkToTemp(options: { url: string; version: string }): Promise<DownloadedApk> {
  const response = await httpFetch(options.url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`APK download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = arrayBuffer.byteLength;

  const dirPath = await join(await tempDir(), "obsidian-chess-studio");
  await ensureDir(dirPath);

  const filename = `obsidian-chess-studio-${options.version.replace(/^v/, "")}.apk`;
  const apkPath = await join(dirPath, filename);

  await writeFile(apkPath, new Uint8Array(arrayBuffer));

  return { path: apkPath, bytes };
}

export async function openApkInstaller(apkPath: string): Promise<void> {
  await openPath(apkPath);
}
