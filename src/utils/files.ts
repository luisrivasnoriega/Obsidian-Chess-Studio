import { Result } from "@badrap/result";
import { useQuery } from "@tanstack/react-query";
import { BaseDirectory, basename, extname, join, tempDir } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { platform } from "@tauri-apps/plugin-os";
import { defaultGame, makePgn } from "chessops/pgn";
import { commands } from "@/bindings";
import {
  createDefaultFileInfoMetadata,
  type FileInfoMetadata,
  type FileMetadata,
  type FileType,
  normalizeFileInfoMetadata,
} from "@/features/files/utils/file";
import { unwrap } from "@/utils/unwrap";
import { parsePGN } from "./chess";
import { createTab, type Tab } from "./tabs";
import { getGameName } from "./treeReducer";

export function usePlatform() {
  const r = useQuery({
    queryKey: ["os"],
    queryFn: async () => {
      return platform();
    },
    staleTime: Infinity,
  });
  return { os: r.data, ...r };
}

export async function getFileNameWithoutExtension(filePath: string): Promise<string> {
  const fileNameWithExtension = await basename(filePath);
  const extension = await extname(filePath);
  return fileNameWithExtension.replace(`.${extension}`, "");
}

export async function readInfoMetadata(filePath: string, fallbackType: FileType = "other"): Promise<FileInfoMetadata> {
  const metadataPath = filePath.replace(".pgn", ".info");
  if (!(await exists(metadataPath))) {
    return createDefaultFileInfoMetadata(fallbackType);
  }

  try {
    const raw = JSON.parse(await readTextFile(metadataPath));
    return normalizeFileInfoMetadata(raw, fallbackType);
  } catch {
    return createDefaultFileInfoMetadata(fallbackType);
  }
}

export async function writeInfoMetadata(filePath: string, metadata: FileInfoMetadata): Promise<void> {
  const metadataPath = filePath.replace(".pgn", ".info");
  const normalized = normalizeFileInfoMetadata(metadata, metadata.type);
  await writeTextFile(metadataPath, JSON.stringify(normalized, null, 2));
}

export async function openFile(
  file: string,
  setTabs: React.Dispatch<React.SetStateAction<Tab[]>>,
  setActiveTab: React.Dispatch<React.SetStateAction<string | null>>,
  options?: {
    position?: number[];
    initialAnalysisTab?: string;
    initialAnalysisSubTab?: string;
    initialNotationView?: "variations" | "repertoire" | "report";
  },
) {
  const count = unwrap(await commands.countPgnGames(file));
  const games = unwrap(await commands.readGames(file, 0, count - 1));
  const allGamesContent = games.join("");

  const fileName = await getFileNameWithoutExtension(file);

  // Read the file metadata from .info file to get the correct file type
  const metadata = await readInfoMetadata(file, "game");
  const fileType = metadata.type;

  const fileInfo: FileMetadata = {
    type: "file",
    metadata,
    name: fileName,
    path: file,
    numGames: count,
    lastModified: new Date().getUTCSeconds(),
  };

  // Parse only the first game for session storage
  // For variants files, parse as normal PGN (with variations) but display in variants view
  // Don't use isVariantsMode for parsing - that's only for special PGNs where all sequences are variations
  const firstGameTree = await parsePGN(games[0]);

  // For variants files, use the file name as the tab name
  const tabName = fileType === "variants" ? fileName : getGameName(firstGameTree?.headers) || "Multiple Games";

  const tabId = await createTab({
    tab: {
      name: tabName,
      type: "analysis",
    },
    setTabs,
    setActiveTab,
    pgn: allGamesContent,
    srcInfo: fileInfo,
    position: options?.position,
    initialAnalysisTab: options?.initialAnalysisTab,
    initialAnalysisSubTab: options?.initialAnalysisSubTab,
    initialNotationView: options?.initialNotationView,
  });

  // Store the first game's state in session storage (for backward compatibility)
  // The analysis board will handle multiple games through the pgn content
  if (options?.position) {
    firstGameTree.position = [...options.position];
  }
  sessionStorage.setItem(
    tabId,
    JSON.stringify({
      version: 0,
      state: firstGameTree,
    }),
  );
}

export async function createFile({
  filename,
  filetype,
  tags,
  pgn,
  dir,
}: {
  filename: string;
  filetype: "game" | "repertoire" | "tournament" | "puzzle" | "variants" | "other";
  tags?: string[];
  pgn?: string;
  dir: string;
}): Promise<Result<FileMetadata>> {
  try {
    const file = await join(dir, `${filename}.pgn`);
    if (await exists(file)) {
      return Result.err(Error("File already exists"));
    }
    const metadata = createDefaultFileInfoMetadata(filetype, tags ?? []);
    // Ensure directory exists
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true });
    }
    await writeTextFile(file, pgn || makePgn(defaultGame()));
    await writeInfoMetadata(file, metadata);

    const numGames = unwrap(await commands.countPgnGames(file));

    return Result.ok({
      type: "file",
      name: filename,
      path: file,
      numGames,
      metadata,
      lastModified: new Date().getUTCSeconds(),
    });
  } catch (err) {
    return Result.err(err instanceof Error ? err : Error(String(err)));
  }
}

export async function createTempImportFile(
  pgn: string,
  filetype: "game" | "repertoire" | "tournament" | "puzzle" | "variants" | "other" = "game",
): Promise<FileMetadata> {
  const primaryTempDirName = "obsidian-chess-studio";
  const fallbackTempDirName = "ocs";

  let actualTempDirName = primaryTempDirName;

  // Ensure temp directory exists
  try {
    await mkdir(primaryTempDirName, { baseDir: BaseDirectory.Temp });
  } catch {
    // If creation fails (permissions/platform quirks), fall back to a shorter folder name.
    actualTempDirName = fallbackTempDirName;
    try {
      await mkdir(fallbackTempDirName, { baseDir: BaseDirectory.Temp });
    } catch {
      // ignore
    }
  }

  const tempDirPath = await join(await tempDir(), actualTempDirName);
  const tempFilePath = await join(tempDirPath, `temp_import_${Date.now()}.pgn`);

  await writeTextFile(tempFilePath, pgn);

  const numGames = unwrap(await commands.countPgnGames(tempFilePath));

  return {
    type: "file",
    name: "Untitled",
    path: tempFilePath,
    numGames,
    metadata: createDefaultFileInfoMetadata(filetype),
    lastModified: Date.now(),
  };
}

export function isTempImportFile(filePath: string): boolean {
  return filePath.includes("temp_import_");
}
