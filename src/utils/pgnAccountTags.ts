import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { getAccountKey, type AccountPlatform } from "./accountKeys";

export async function rewritePgnAccountTags(
  filePath: string,
  platform: AccountPlatform,
  username: string,
): Promise<boolean> {
  const raw = await readTextFile(filePath);
  if (!raw) return false;
  const accountKey = getAccountKey(platform, username);
  const usernameLower = username.toLowerCase();

  let changed = false;
  const updated = raw.replace(/\[(White|Black)\s+"([^"]*)"\]/g, (match, tag, name) => {
    if ((name ?? "").toLowerCase() !== usernameLower) return match;
    changed = true;
    return `[${tag} "${accountKey}"]`;
  });

  if (!changed) return false;
  await writeTextFile(filePath, updated, { append: false });
  return true;
}
