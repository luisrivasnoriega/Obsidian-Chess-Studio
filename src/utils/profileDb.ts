import { invoke } from "@tauri-apps/api/core";
import { appDataDir, resolve } from "@tauri-apps/api/path";

export function profileDbFilename(profileId: string) {
  return `profile_${profileId}.db3`;
}

export async function getProfileDbPath(profileId: string) {
  return await resolve(await appDataDir(), "db", profileDbFilename(profileId));
}

const LICHESS_TOKEN_KEY = "lichessToken";

export async function setProfileLichessToken(profileId: string, token: string | null) {
  const dbPath = await getProfileDbPath(profileId);
  await invoke("set_profile_metadata", {
    file: dbPath,
    key: LICHESS_TOKEN_KEY,
    value: token,
  });
}
