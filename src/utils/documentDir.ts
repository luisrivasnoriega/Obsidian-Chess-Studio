import { homeDir, resolve, documentDir as tauriDocumentDir } from "@tauri-apps/api/path";
import { exists, mkdir } from "@tauri-apps/plugin-fs";
import { error, info } from "@tauri-apps/plugin-log";
import { getDefaultStore } from "jotai";
import { storedDocumentDirAtom } from "@/state/atoms";

const APP_FOLDER_NAME = "Obsidian Chess Studio";

export async function getDocumentDir(): Promise<string> {
  try {
    const store = getDefaultStore();
    let docDir = store.get(storedDocumentDirAtom);

    if (!docDir) {
      const base = await tauriDocumentDir();
      const current = await resolve(base, APP_FOLDER_NAME);
      docDir = current;
    }

    // Ensure the directory exists
    if (!(await exists(docDir))) {
      await mkdir(docDir, { recursive: true });
      info(`Created documents directory: ${docDir}`);
    }

    info(`Using documents directory: ${docDir}`);
    return docDir;
  } catch (e) {
    error(`Failed to access documents directory: ${e}`);
    try {
      const base = await homeDir();
      const current = await resolve(base, APP_FOLDER_NAME);
      const homeDirPath = current;

      // Ensure the fallback directory exists
      if (!(await exists(homeDirPath))) {
        await mkdir(homeDirPath, { recursive: true });
        info(`Created fallback documents directory: ${homeDirPath}`);
      }

      info(`Fallback to home directory: ${homeDirPath}`);
      return homeDirPath;
    } catch (homeError) {
      error(`Failed to access home directory: ${homeError}`);
      throw new Error(`Cannot access any suitable directory: ${e}, ${homeError}`);
    }
  }
}
