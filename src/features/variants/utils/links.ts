import { join } from "@tauri-apps/api/path";
import { exists, readDir } from "@tauri-apps/plugin-fs";
import { type FileMetadata, processEntriesRecursively } from "@/features/files/utils/file";
import { readInfoMetadata, writeInfoMetadata } from "@/utils/files";
import type { VariantLinkRef } from "../types";

function isAbsolutePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function linkIdentityKey(link: VariantLinkRef): string {
  return `${normalizePath(link.path)}|${link.anchorPly}|${link.anchorPath.join(".")}|${link.label ?? ""}`;
}

function dedupeChildLinks(links: VariantLinkRef[]): VariantLinkRef[] {
  const out: VariantLinkRef[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const key = linkIdentityKey(link);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(link);
  }
  return out;
}

async function resolveLinkedPath(ownerFilePath: string, linkPath: string): Promise<string> {
  if (isAbsolutePath(linkPath)) {
    return linkPath;
  }
  const ownerDir = ownerFilePath.replace(/[\\/][^\\/]+$/, "");
  return join(ownerDir, linkPath);
}

async function listVariantFiles(documentDir: string): Promise<FileMetadata[]> {
  if (!(await exists(documentDir))) {
    return [];
  }
  const entries = await readDir(documentDir);
  const all = await processEntriesRecursively(documentDir, entries);
  return all
    .filter((entry): entry is FileMetadata => entry.type === "file")
    .filter((entry) => entry.metadata.type === "variants");
}

export async function cleanupVariantLinksAfterDelete(
  deletedVariantPath: string,
  documentDir: string,
): Promise<{ updatedFiles: number; removedLinks: number }> {
  const variants = await listVariantFiles(documentDir);
  const deletedNorm = normalizePath(deletedVariantPath);
  let updatedFiles = 0;
  let removedLinks = 0;

  for (const variant of variants) {
    if (normalizePath(variant.path) === deletedNorm) {
      continue;
    }

    const metadata = await readInfoMetadata(variant.path, "variants");
    if (metadata.type !== "variants") {
      continue;
    }

    let changed = false;

    const parent = metadata.links?.parent;
    if (parent) {
      const parentPath = await resolveLinkedPath(variant.path, parent.path);
      if (normalizePath(parentPath) === deletedNorm) {
        metadata.links = {
          ...(metadata.links ?? {}),
          parent: undefined,
        };
        changed = true;
        removedLinks += 1;
      }
    }

    const children = Array.isArray(metadata.links?.children) ? metadata.links.children : [];
    if (children.length > 0) {
      const kept: VariantLinkRef[] = [];
      for (const child of children) {
        const childPath = await resolveLinkedPath(variant.path, child.path);
        if (normalizePath(childPath) === deletedNorm) {
          removedLinks += 1;
          changed = true;
          continue;
        }
        kept.push(child);
      }
      const deduped = dedupeChildLinks(kept);
      if (deduped.length !== children.length) {
        changed = true;
        removedLinks += children.length - deduped.length;
      }
      metadata.links = {
        ...(metadata.links ?? {}),
        children: deduped,
      };
    }

    if (changed) {
      await writeInfoMetadata(variant.path, metadata);
      updatedFiles += 1;
    }
  }

  return { updatedFiles, removedLinks };
}

export async function repairVariantLinks(
  documentDir: string,
): Promise<{ updatedFiles: number; removedLinks: number; addedLinks: number }> {
  const variants = await listVariantFiles(documentDir);
  const variantsByPath = new Map<string, FileMetadata>();
  for (const variant of variants) {
    variantsByPath.set(normalizePath(variant.path), variant);
  }

  const metadataByPath = new Map<string, Awaited<ReturnType<typeof readInfoMetadata>>>();
  const changedPaths = new Set<string>();
  let removedLinks = 0;
  let addedLinks = 0;

  for (const variant of variants) {
    const metadata = await readInfoMetadata(variant.path, "variants");
    metadataByPath.set(normalizePath(variant.path), metadata);
  }

  // Pass 1: remove broken/self links and dedupe child links.
  for (const variant of variants) {
    const key = normalizePath(variant.path);
    const metadata = metadataByPath.get(key);
    if (!metadata || metadata.type !== "variants") {
      continue;
    }

    let changed = false;

    const parent = metadata.links?.parent;
    if (parent) {
      const parentAbs = await resolveLinkedPath(variant.path, parent.path);
      const parentNorm = normalizePath(parentAbs);
      const selfRef = parentNorm === key;
      const missing = !variantsByPath.has(parentNorm);
      if (selfRef || missing) {
        metadata.links = {
          ...(metadata.links ?? {}),
          parent: undefined,
        };
        removedLinks += 1;
        changed = true;
      }
    }

    const children = Array.isArray(metadata.links?.children) ? metadata.links.children : [];
    if (children.length > 0) {
      const kept: VariantLinkRef[] = [];
      for (const child of children) {
        const childAbs = await resolveLinkedPath(variant.path, child.path);
        const childNorm = normalizePath(childAbs);
        const selfRef = childNorm === key;
        const missing = !variantsByPath.has(childNorm);
        if (selfRef || missing) {
          removedLinks += 1;
          changed = true;
          continue;
        }
        kept.push(child);
      }
      const deduped = dedupeChildLinks(kept);
      if (deduped.length !== children.length) {
        removedLinks += children.length - deduped.length;
        changed = true;
      }
      metadata.links = {
        ...(metadata.links ?? {}),
        children: deduped,
      };
    }

    if (changed) {
      changedPaths.add(key);
    }
  }

  // Pass 2: enforce reciprocal links.
  for (const variant of variants) {
    const parentKey = normalizePath(variant.path);
    const parentMeta = metadataByPath.get(parentKey);
    if (!parentMeta || parentMeta.type !== "variants") {
      continue;
    }

    const parentName = variant.name;
    const parentRelativePath = variant.path.split(/[/\\]/).pop() ?? variant.path;
    const children = Array.isArray(parentMeta.links?.children) ? parentMeta.links.children : [];

    for (const childLink of children) {
      const childAbs = await resolveLinkedPath(variant.path, childLink.path);
      const childKey = normalizePath(childAbs);
      const childMeta = metadataByPath.get(childKey);
      if (!childMeta || childMeta.type !== "variants") {
        continue;
      }

      const childVariant = variantsByPath.get(childKey);
      const childRelativePath = childVariant?.path.split(/[/\\]/).pop() ?? childAbs;
      const childName = childVariant?.name ?? childLink.name;

      const childParent = childMeta.links?.parent;
      let childNeedsUpdate = false;
      if (!childParent) {
        childNeedsUpdate = true;
      } else {
        const resolvedCurrentParent = await resolveLinkedPath(childVariant?.path ?? childAbs, childParent.path);
        if (normalizePath(resolvedCurrentParent) !== parentKey) {
          childNeedsUpdate = true;
        }
      }

      if (childNeedsUpdate) {
        childMeta.links = {
          ...(childMeta.links ?? {}),
          parent: {
            path: parentRelativePath,
            name: parentName,
            anchorFen: childLink.anchorFen,
            anchorPath: [...childLink.anchorPath],
            anchorPly: childLink.anchorPly,
            label: childLink.label,
          },
        };
        changedPaths.add(childKey);
        addedLinks += 1;
      }

      const parentChildren = Array.isArray(parentMeta.links?.children) ? parentMeta.links.children : [];
      let alreadyPresent = false;
      for (const existing of parentChildren) {
        const existingAbs = await resolveLinkedPath(variant.path, existing.path);
        if (
          normalizePath(existingAbs) === childKey &&
          existing.anchorPly === childLink.anchorPly &&
          existing.anchorPath.join(".") === childLink.anchorPath.join(".")
        ) {
          alreadyPresent = true;
          break;
        }
      }
      if (!alreadyPresent) {
        parentChildren.push({
          path: childRelativePath,
          name: childName,
          anchorFen: childLink.anchorFen,
          anchorPath: [...childLink.anchorPath],
          anchorPly: childLink.anchorPly,
          label: childLink.label,
        });
        parentMeta.links = {
          ...(parentMeta.links ?? {}),
          children: dedupeChildLinks(parentChildren),
        };
        changedPaths.add(parentKey);
        addedLinks += 1;
      }
    }
  }

  // Pass 3: ensure every parent reference exists in the parent's children list.
  for (const childVariant of variants) {
    const childKey = normalizePath(childVariant.path);
    const childMeta = metadataByPath.get(childKey);
    if (!childMeta || childMeta.type !== "variants") {
      continue;
    }
    const parentLink = childMeta.links?.parent;
    if (!parentLink) {
      continue;
    }

    const parentAbs = await resolveLinkedPath(childVariant.path, parentLink.path);
    const parentKey = normalizePath(parentAbs);
    const parentVariant = variantsByPath.get(parentKey);
    const parentMeta = metadataByPath.get(parentKey);
    if (!parentVariant || !parentMeta || parentMeta.type !== "variants") {
      continue;
    }

    const childRelativePath = childVariant.path.split(/[/\\]/).pop() ?? childVariant.path;
    const parentChildren = Array.isArray(parentMeta.links?.children) ? parentMeta.links.children : [];
    let alreadyPresent = false;
    for (const existing of parentChildren) {
      const existingAbs = await resolveLinkedPath(parentVariant.path, existing.path);
      if (
        normalizePath(existingAbs) === childKey &&
        existing.anchorPly === parentLink.anchorPly &&
        existing.anchorPath.join(".") === parentLink.anchorPath.join(".")
      ) {
        alreadyPresent = true;
        break;
      }
    }

    if (!alreadyPresent) {
      parentChildren.push({
        path: childRelativePath,
        name: childVariant.name,
        anchorFen: parentLink.anchorFen,
        anchorPath: [...parentLink.anchorPath],
        anchorPly: parentLink.anchorPly,
        label: parentLink.label,
      });
      parentMeta.links = {
        ...(parentMeta.links ?? {}),
        children: dedupeChildLinks(parentChildren),
      };
      changedPaths.add(parentKey);
      addedLinks += 1;
    }
  }

  for (const changedPath of changedPaths) {
    const metadata = metadataByPath.get(changedPath);
    const variant = variantsByPath.get(changedPath);
    if (!metadata || !variant) {
      continue;
    }
    await writeInfoMetadata(variant.path, metadata);
  }

  return { updatedFiles: changedPaths.size, removedLinks, addedLinks };
}
