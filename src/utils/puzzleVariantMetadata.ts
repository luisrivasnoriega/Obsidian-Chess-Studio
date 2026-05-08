export const PUZZLE_VARIANTS_TAG = "puzzle-variants";

const PROFILE_ID_TAG_PREFIX = "profileId:";
const VARIANT_PATH_TAG_PREFIX = "variantPath:";
const VARIANT_NAME_TAG_PREFIX = "variant:";
const DEPTH_TAG_PREFIX = "depth:";
const MAINLINE_TAG_PREFIX = "mainline:";
const COVERAGE_NODE_TAG_PREFIX = "coverageNode:";
const COVERAGE_TIER_TAG_PREFIX = "coverageTier:";

export type PuzzleVariantTagInfo = {
  profileId: string | null;
  variantPath: string | null;
  variantName: string | null;
  depth: number | null;
  mainline: string | null;
  coverageNode: string | null;
  coverageTier: "mainline" | "secondary" | "alternative" | null;
};

function tagValue(tags: string[], prefix: string): string | null {
  return (
    tags
      .find((tag) => tag.startsWith(prefix))
      ?.slice(prefix.length)
      .trim() || null
  );
}

function withoutPrefixedTags(tags: string[], prefixes: string[]): string[] {
  return tags.filter((tag) => !prefixes.some((prefix) => tag.startsWith(prefix)));
}

export function normalizePuzzleVariantRelativePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

export function getProfileRelativeVariantPath(variantsDir: string, variantPath: string): string {
  const root = variantsDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = variantPath.replace(/\\/g, "/");
  const rootLower = root.toLowerCase();
  const targetLower = target.toLowerCase();
  if (targetLower.startsWith(`${rootLower}/`)) {
    return normalizePuzzleVariantRelativePath(target.slice(root.length + 1));
  }
  return normalizePuzzleVariantRelativePath(target.split("/").filter(Boolean).pop() ?? target);
}

export function buildPuzzleVariantSourceTags(input: {
  profileId: string | null | undefined;
  variantsDir: string | null | undefined;
  variantPath: string | null | undefined;
}): string[] {
  const tags: string[] = [];
  const profileId = input.profileId?.trim();
  if (profileId) {
    tags.push(`${PROFILE_ID_TAG_PREFIX}${profileId}`);
  }

  const variantsDir = input.variantsDir?.trim();
  const variantPath = input.variantPath?.trim();
  if (variantsDir && variantPath) {
    const relativePath = getProfileRelativeVariantPath(variantsDir, variantPath);
    if (relativePath) {
      tags.push(`${VARIANT_PATH_TAG_PREFIX}${relativePath}`);
    }
  }

  return tags;
}

export function ensurePuzzleVariantProfileTags(tags: string[], profileId: string): string[] {
  const next = withoutPrefixedTags(tags, [PROFILE_ID_TAG_PREFIX]);
  const normalizedProfileId = profileId.trim();
  if (normalizedProfileId) {
    next.push(`${PROFILE_ID_TAG_PREFIX}${normalizedProfileId}`);
  }
  if (!next.includes(PUZZLE_VARIANTS_TAG)) {
    next.unshift(PUZZLE_VARIANTS_TAG);
  }
  return next;
}

export function parsePuzzleVariantTags(tags: string[]): PuzzleVariantTagInfo {
  const depthRaw = tagValue(tags, DEPTH_TAG_PREFIX);
  const depth = depthRaw ? Number.parseInt(depthRaw, 10) : null;
  const coverageTierRaw = tagValue(tags, COVERAGE_TIER_TAG_PREFIX)?.toLowerCase() ?? null;
  const coverageTier =
    coverageTierRaw === "mainline" || coverageTierRaw === "secondary" || coverageTierRaw === "alternative"
      ? coverageTierRaw
      : null;

  return {
    profileId: tagValue(tags, PROFILE_ID_TAG_PREFIX),
    variantPath: tagValue(tags, VARIANT_PATH_TAG_PREFIX),
    variantName: tagValue(tags, VARIANT_NAME_TAG_PREFIX),
    depth: depthRaw && Number.isFinite(depth) ? depth : null,
    mainline: tagValue(tags, MAINLINE_TAG_PREFIX),
    coverageNode: tagValue(tags, COVERAGE_NODE_TAG_PREFIX),
    coverageTier,
  };
}

export function puzzleVariantMatchesProfile(tags: string[], activeProfileId: string | null | undefined): boolean {
  const normalizedActiveProfileId = activeProfileId?.trim();
  if (!normalizedActiveProfileId) return true;

  const { profileId } = parsePuzzleVariantTags(tags);
  return !profileId || profileId === normalizedActiveProfileId;
}
