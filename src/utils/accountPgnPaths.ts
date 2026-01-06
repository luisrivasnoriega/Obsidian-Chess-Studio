import { resolve } from "@tauri-apps/api/path";

function sanitizeSegment(value: string): string {
  return value
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export type AccountPgnPlatform = "lichess" | "chesscom";

export function accountPgnFilename(input: {
  profileId?: string | null;
  platform: AccountPgnPlatform;
  username: string;
}) {
  const username = sanitizeSegment(input.username) || "account";
  const platform = input.platform;
  const profileId = input.profileId ? sanitizeSegment(input.profileId) : "";

  if (!profileId) return `${username}_${platform}.pgn`;
  return `profile_${profileId}_${platform}_${username}.pgn`;
}

export async function getAccountPgnPath(input: {
  appDataDir: string;
  profileId?: string | null;
  platform: AccountPgnPlatform;
  username: string;
}) {
  return await resolve(input.appDataDir, "db", accountPgnFilename(input));
}

