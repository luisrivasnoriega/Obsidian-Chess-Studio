import { appDataDir, resolve } from "@tauri-apps/api/path";

export function profileDbFilename(profileId: string) {
  return `profile_${profileId}.db3`;
}

export async function getProfileDbPath(profileId: string) {
  return await resolve(await appDataDir(), "db", profileDbFilename(profileId));
}

