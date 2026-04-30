import { basename, join } from "@tauri-apps/api/path";
import { type DirEntry, exists, readDir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { z } from "zod";
import { commands } from "@/bindings";
import { unwrap } from "@/utils/unwrap";

const fileTypeSchema = z.enum(["repertoire", "game", "tournament", "puzzle", "variants", "other"]);

export type FileType = z.infer<typeof fileTypeSchema>;

export const FILE_TYPE_LABELS: Record<FileType, string> = {
  game: "features.files.fileType.game",
  repertoire: "features.files.fileType.repertoire",
  tournament: "features.files.fileType.tournament",
  puzzle: "features.files.fileType.puzzle",
  variants: "features.files.fileType.variants",
  other: "features.files.fileType.other",
} as const;

export type FileTypeItem = { labelKey: string; value: FileType };

export const FILE_TYPES: FileTypeItem[] = Object.entries(FILE_TYPE_LABELS).map(([value, labelKey]) => ({
  labelKey,
  value: value as FileType,
}));

const variantLinkRefSchema = z.object({
  path: z.string(),
  name: z.string(),
  anchorFen: z.string(),
  anchorPath: z.array(z.number().int().nonnegative()),
  anchorPly: z.number().int().nonnegative(),
  label: z.string().optional(),
});

const variantLinksSchema = z.object({
  parent: variantLinkRefSchema.optional(),
  children: z.array(variantLinkRefSchema).optional(),
});

const variantSplitSchema = z.object({
  mode: z.enum(["manual", "auto"]),
  splitAtPly: z.number().int().positive().optional(),
  createdAt: z.string(),
});

const fileInfoMetadataSchema = z
  .object({
    type: fileTypeSchema,
    tags: z.array(z.string()),
    schemaVersion: z.literal(2).optional(),
    links: variantLinksSchema.optional(),
    split: variantSplitSchema.optional(),
  })
  .passthrough();

export type FileInfoMetadata = z.infer<typeof fileInfoMetadataSchema>;

export const fileMetadataSchema = z.object({
  type: z.literal("file"),
  name: z.string(),
  path: z.string(),
  numGames: z.number(),
  metadata: fileInfoMetadataSchema,
  lastModified: z.number(),
});

export type FileMetadata = z.infer<typeof fileMetadataSchema>;

export type FileData = {
  metadata: FileInfoMetadata;
  games: string[];
};

const schemaVersionValue = 2 as const;

function normalizeVariantMetadata(metadata: FileInfoMetadata): FileInfoMetadata {
  if (metadata.type !== "variants") {
    return metadata;
  }
  return {
    ...metadata,
    schemaVersion: schemaVersionValue,
    links: {
      ...(metadata.links ?? {}),
      children: Array.isArray(metadata.links?.children) ? metadata.links.children : [],
    },
  };
}

export function createDefaultFileInfoMetadata(fileType: FileType, tags: string[] = []): FileInfoMetadata {
  const base: FileInfoMetadata = {
    type: fileType,
    tags: tags.filter((tag): tag is string => typeof tag === "string"),
  };
  return normalizeVariantMetadata(base);
}

export function normalizeFileInfoMetadata(raw: unknown, fallbackType: FileType = "other"): FileInfoMetadata {
  const parsed = fileInfoMetadataSchema.safeParse(raw);
  if (parsed.success) {
    return normalizeVariantMetadata(parsed.data);
  }

  const fallbackRecord = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const parsedType = fileTypeSchema.safeParse(fallbackRecord.type);
  const type = parsedType.success ? parsedType.data : fallbackType;
  const tags = Array.isArray(fallbackRecord.tags)
    ? fallbackRecord.tags.filter((tag): tag is string => typeof tag === "string")
    : [];

  return createDefaultFileInfoMetadata(type, tags);
}

async function readFileMetadata(path: string): Promise<FileMetadata | null> {
  if (!path.endsWith(".pgn")) {
    return null;
  }
  const metadataPath = path.replace(".pgn", ".info");
  let metadata: FileInfoMetadata;
  if (await exists(metadataPath)) {
    try {
      metadata = normalizeFileInfoMetadata(JSON.parse(await readTextFile(metadataPath)));
    } catch {
      metadata = createDefaultFileInfoMetadata("other");
    }
  } else {
    metadata = createDefaultFileInfoMetadata("other");
    await writeTextFile(metadataPath, JSON.stringify(metadata));
  }
  const fileMetadata = unwrap(await commands.getFileMetadata(path));
  const numGames = unwrap(await commands.countPgnGames(path));
  return {
    type: "file",
    path,
    name: (await basename(path)).replace(".pgn", ""),
    numGames,
    metadata,
    lastModified: Number(fileMetadata.last_modified),
  };
}

export type Directory = {
  type: "directory";
  children: (FileMetadata | Directory)[];
  path: string;
  name: string;
};

export async function processEntriesRecursively(parent: string, entries: DirEntry[]) {
  const allEntries: (FileMetadata | Directory)[] = [];
  for (const entry of entries) {
    if (entry.isFile) {
      const metadata = await readFileMetadata(await join(parent, entry.name));
      if (!metadata) continue;
      allEntries.push(metadata);
    }
    if (entry.isDirectory) {
      const dir = await join(parent, entry.name);
      // Use readDir without baseDir since dir is an absolute path
      const newEntries = await processEntriesRecursively(dir, await readDir(dir));
      allEntries.push({
        type: "directory",
        name: entry.name,
        path: dir,
        children: newEntries,
      });
    }
  }
  return allEntries;
}
