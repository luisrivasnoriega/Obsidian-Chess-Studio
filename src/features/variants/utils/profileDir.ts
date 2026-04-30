import { join } from "@tauri-apps/api/path";
import { exists, mkdir } from "@tauri-apps/plugin-fs";
import { getDocumentDir } from "@/utils/documentDir";

const VARIANTS_ROOT = "variants";
const GLOBAL_VARIANTS_SCOPE = "global";

function sanitizePathSegment(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[<>:"/\\|?*]/g, "_")
    .replaceAll(/./g, (char) => (char.charCodeAt(0) < 0x20 ? "_" : char))
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}

function buildProfileScope(profileId: string | null | undefined): string {
  const normalized = profileId?.trim();
  if (!normalized) {
    return GLOBAL_VARIANTS_SCOPE;
  }
  return `profile_${sanitizePathSegment(normalized)}`;
}

export async function getVariantsDirectory(profileId: string | null | undefined): Promise<string> {
  const documentsDir = await getDocumentDir();
  const variantsDir = await join(documentsDir, VARIANTS_ROOT, buildProfileScope(profileId));
  if (!(await exists(variantsDir))) {
    await mkdir(variantsDir, { recursive: true });
  }
  return variantsDir;
}
