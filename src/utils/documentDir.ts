import { homeDir, resolve, documentDir as tauriDocumentDir } from "@tauri-apps/api/path";
import { exists, mkdir, rename } from "@tauri-apps/plugin-fs";
import { error, info } from "@tauri-apps/plugin-log";
import { getDefaultStore } from "jotai";
import { storedDocumentDirAtom } from "@/state/atoms";

const APP_FOLDER_NAME = "Obsidian Chess Studio";
const LEGACY_APP_FOLDER_NAME = "Pawn Appetit";

export async function getDocumentDir(): Promise<string> {
  try {
    const store = getDefaultStore();
    let docDir = store.get(storedDocumentDirAtom);

    if (!docDir) {
      const base = await tauriDocumentDir();
      const current = await resolve(base, APP_FOLDER_NAME);
      const legacy = await resolve(base, LEGACY_APP_FOLDER_NAME);

      // Prefer migrating legacy data into the new folder name on first run.
      // If migration fails (e.g., permissions), fall back to using the legacy directory.
      if ((await exists(legacy)) && !(await exists(current))) {
        try {
          await rename(legacy, current);
          info(`Migrated documents directory: ${legacy} -> ${current}`);
        } catch (e) {
          info(`Using legacy documents directory (migration failed): ${legacy} (${e})`);
          docDir = legacy;
        }
      }

      docDir = docDir || current;
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
      const legacy = await resolve(base, LEGACY_APP_FOLDER_NAME);

      let homeDirPath = current;
      if ((await exists(legacy)) && !(await exists(current))) {
        try {
          await rename(legacy, current);
          info(`Migrated fallback documents directory: ${legacy} -> ${current}`);
          homeDirPath = current;
        } catch (renameError) {
          info(`Using legacy fallback documents directory (migration failed): ${legacy} (${renameError})`);
          homeDirPath = legacy;
        }
      }

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
