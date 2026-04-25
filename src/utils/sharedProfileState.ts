import { BaseDirectory, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { logger } from "@/utils/logger";

const options = { baseDir: BaseDirectory.AppData };
const SHARED_DIR = "profiles";
const SHARED_FILE = `${SHARED_DIR}/shared_state.json`;

type RawSharedProfileState = {
  version: number;
  sessions: unknown[];
  profiles: unknown[];
  activeProfileId: string | null;
  updatedAt: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeSharedState(value: unknown): RawSharedProfileState | null {
  if (!isObject(value)) return null;

  const sessions = Array.isArray(value.sessions) ? value.sessions : [];
  const profiles = Array.isArray(value.profiles) ? value.profiles : [];
  const activeProfileId =
    typeof value.activeProfileId === "string" || value.activeProfileId === null ? value.activeProfileId : null;
  const updatedAt = typeof value.updatedAt === "number" ? value.updatedAt : Date.now();
  const version = typeof value.version === "number" ? value.version : 1;

  return {
    version,
    sessions,
    profiles,
    activeProfileId,
    updatedAt,
  };
}

export async function readSharedProfileState(): Promise<RawSharedProfileState | null> {
  try {
    const raw = await readTextFile(SHARED_FILE, options);
    const parsed = JSON.parse(raw);
    return normalizeSharedState(parsed);
  } catch {
    return null;
  }
}

export async function writeSharedProfileState(input: {
  sessions: unknown[];
  profiles: unknown[];
  activeProfileId: string | null;
}) {
  await mkdir(SHARED_DIR, { ...options, recursive: true });
  const payload: RawSharedProfileState = {
    version: 1,
    sessions: input.sessions,
    profiles: input.profiles,
    activeProfileId: input.activeProfileId,
    updatedAt: Date.now(),
  };

  try {
    await writeTextFile(SHARED_FILE, JSON.stringify(payload, null, 2), options);
  } catch (error) {
    logger.error("Failed to write shared profile state", { error });
    throw error;
  }
}

export { SHARED_FILE as sharedProfileStatePath };
