import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Code,
  Group,
  Loader,
  Modal,
  NumberInput,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import {
  IconChevronDown,
  IconChevronRight,
  IconEdit,
  IconEye,
  IconFileExport,
  IconFileImport,
  IconGitBranch,
  IconPlus,
  IconPuzzle,
  IconRefresh,
  IconShieldCheck,
  IconTrash,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { join } from "@tauri-apps/api/path";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, readDir, readTextFile, remove, rename, writeTextFile } from "@tauri-apps/plugin-fs";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { DataTable, type DataTableSortStatus } from "mantine-datatable";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import GenericHeader from "@/components/GenericHeader";
import {
  createDefaultFileInfoMetadata,
  type FileMetadata,
  normalizeFileInfoMetadata,
  processEntriesRecursively,
} from "@/features/files/utils/file";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { activeProfileIdAtom, activeTabAtom, tabsAtom } from "@/state/atoms";
import { defaultPGN, getMoveText, parsePGN } from "@/utils/chess";
import { getDocumentDir } from "@/utils/documentDir";
import { createFile, openFile, readInfoMetadata, writeInfoMetadata } from "@/utils/files";
import { formatDateToPGN } from "@/utils/format";
import { generatePuzzleVariantsFromTree, type PuzzleTreeNodeDto } from "@/utils/puzzleVariants";
import type { TreeNode } from "@/utils/treeReducer";
import { PuzzleVariantsModal } from "../boards/components/PuzzleVariantsModal";
import { VariantGridView } from "./components/VariantGridView";
import type { VariantInfo } from "./types";
import { cleanupVariantLinksAfterDelete, repairVariantLinks } from "./utils/links";
import { getVariantsDirectory } from "./utils/profileDir";

type VariantTreeNode = {
  key: string;
  variant: VariantInfo;
  children: VariantTreeNode[];
};

type VariantTableRow = VariantInfo & {
  key: string;
  variant: VariantInfo;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
};

type VariantValidationMoveOccurrence = {
  variantName: string;
  variantPath: string;
  line: string;
};

type VariantValidationConflict = {
  fen: string;
  moves: Array<{
    san: string;
    occurrences: VariantValidationMoveOccurrence[];
  }>;
};

type VariantValidationReport = {
  targetVariantName: string;
  activeColor: "white" | "black";
  checkedVariants: number;
  checkedPositions: number;
  conflicts: VariantValidationConflict[];
  skippedVariants: string[];
  orientationMismatches: string[];
};

type VariantsPackageEntry = {
  relativePath: string;
  pgn: string;
  info: unknown;
};

type VariantsPackageFile = {
  schema: "ocs-variants-package";
  version: 1;
  exportedAt: string;
  variants: VariantsPackageEntry[];
};

const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
}

function resolveLinkedPath(ownerPath: string, linkPath: string): string {
  if (ABSOLUTE_PATH_RE.test(linkPath)) return normalizePath(linkPath);
  const ownerDir = ownerPath.replace(/[\\/][^\\/]+$/, "");
  const candidate = `${ownerDir}/${linkPath}`;
  return normalizePath(candidate);
}

function relativePath(fromDir: string, toPath: string): string {
  const rootRaw = fromDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const targetRaw = toPath.replace(/\\/g, "/");
  const rootLower = rootRaw.toLowerCase();
  const targetLower = targetRaw.toLowerCase();
  if (targetLower.startsWith(`${rootLower}/`)) {
    return targetRaw.slice(rootRaw.length + 1);
  }
  return getFileName(toPath);
}

function parentDir(path: string): string {
  const match = path.match(/^(.*)[\\/][^\\/]+$/);
  return match?.[1] ?? path;
}

function sanitizePackageRelativePath(input: string): string | null {
  const normalized = input.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!normalized || ABSOLUTE_PATH_RE.test(normalized) || normalized.includes("\0")) {
    return null;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  const candidate = segments.join("/");
  if (!candidate.toLowerCase().endsWith(".pgn")) {
    return null;
  }
  return candidate;
}

function sanitizeFileStem(input: string): string {
  const cleaned = input.replace(/[<>:"/\\|?*]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "puzzles";
}

function normalizeFenKey(fen: string): string {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) {
    return fen.trim();
  }
  return `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]}`;
}

function fenTurnColor(fen: string): "white" | "black" {
  const parts = fen.trim().split(/\s+/);
  return parts[1] === "b" ? "black" : "white";
}

async function loadVariants(variantsDir: string): Promise<VariantInfo[]> {
  const scanDirs = [variantsDir];
  const allEntries: Array<FileMetadata> = [];
  for (const dir of scanDirs) {
    if (!(await exists(dir))) {
      continue;
    }
    const entries = await readDir(dir);
    const resolved = await processEntriesRecursively(dir, entries);
    allEntries.push(...resolved.filter((entry): entry is FileMetadata => entry.type === "file"));
  }

  if (allEntries.length === 0) {
    return [];
  }
  const seenPaths = new Set<string>();
  const variantFiles = allEntries.filter((file) => {
    if (file.metadata.type !== "variants") {
      return false;
    }
    const key = file.path.replace(/\\/g, "/").toLowerCase();
    if (seenPaths.has(key)) {
      return false;
    }
    seenPaths.add(key);
    return true;
  });

  const variants: VariantInfo[] = [];

  for (const file of variantFiles) {
    try {
      let gameTree: Awaited<ReturnType<typeof parsePGN>> | null = null;
      try {
        // Read the first game to extract richer metadata.
        // If PGN is empty/corrupt, keep the variant visible via .info metadata.
        const { commands } = await import("@/bindings");
        const { unwrap } = await import("@/utils/unwrap");
        const count = unwrap(await commands.countPgnGames(file.path));
        if (count > 0) {
          const games = unwrap(await commands.readGames(file.path, 0, 0));
          const firstGame = games[0];
          if (firstGame) {
            gameTree = await parsePGN(firstGame);
          }
        }
      } catch {
        // Keep metadata-only fallback.
      }

      const tags = file.metadata.tags || [];

      // Priority: metadata tags > PGN headers
      const openingTag = tags
        .find((tag) => tag.startsWith("opening:"))
        ?.slice("opening:".length)
        .trim();
      const priorityTag = tags
        .find((tag) => tag.startsWith("priority:"))
        ?.slice("priority:".length)
        .trim();
      const fenTag = tags
        .find((tag) => tag.startsWith("fen:"))
        ?.slice("fen:".length)
        .trim();
      const depth =
        tags
          .find((tag) => tag.startsWith("depth:"))
          ?.slice("depth:".length)
          .trim() || null;
      const database =
        tags
          .find((tag) => tag.startsWith("database:"))
          ?.slice("database:".length)
          .trim() || null;
      const engine =
        tags
          .find((tag) => tag.startsWith("engine:"))
          ?.slice("engine:".length)
          .trim() || null;
      const engineMs =
        tags
          .find((tag) => tag.startsWith("engineMs:"))
          ?.slice("engineMs:".length)
          .trim() || null;
      const variantsCount =
        tags
          .find((tag) => tag.startsWith("variantsCount:"))
          ?.slice("variantsCount:".length)
          .trim() || null;
      const commentsTag =
        tags
          .find((tag) => tag.startsWith("comments:"))
          ?.slice("comments:".length)
          .trim() || null;
      const referencesTag =
        tags
          .find((tag) => tag.startsWith("references:"))
          ?.slice("references:".length)
          .trim() || null;
      const comments = commentsTag || referencesTag || null;
      const parentLink = file.metadata.type === "variants" ? (file.metadata.links?.parent ?? null) : null;
      const childLinks =
        file.metadata.type === "variants" && Array.isArray(file.metadata.links?.children)
          ? file.metadata.links.children
          : [];

      // Fallback to PGN-derived headers if metadata tags don't exist
      const opening = openingTag || gameTree?.headers?.eco || null;
      const fen = fenTag || gameTree?.headers?.fen || null;

      const parsedPriority = priorityTag ? Number.parseInt(priorityTag, 10) : Number.NaN;

      variants.push({
        name: file.name,
        path: file.path,
        priority: Number.isFinite(parsedPriority) ? parsedPriority : null,
        opening: opening || null,
        fen: fen || null,
        depth: depth ? Number.parseInt(depth, 10) : null,
        database: database || null,
        engine: engine || null,
        engineMs: engineMs ? Number.parseInt(engineMs, 10) : null,
        variantsCount: variantsCount ? Number.parseInt(variantsCount, 10) : null,
        comments: comments,
        parentLink,
        childLinks,
      });
    } catch (error) {
      console.error(`Error loading variant ${file.path}:`, error);
    }
  }

  return variants;
}

export default function VariantsPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [_tabs, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const { layout } = useResponsiveLayout();

  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "table">("table");
  const [repairingLinks, setRepairingLinks] = useState(false);
  const [sortStatus, setSortStatus] = useState<DataTableSortStatus<VariantInfo>>({
    columnAccessor: "name",
    direction: "asc",
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [transferBusy, setTransferBusy] = useState(false);
  const [puzzleModalOpened, setPuzzleModalOpened] = useState(false);
  const [puzzleDepth, setPuzzleDepth] = useState(1);
  const [maxPuzzleDepth, setMaxPuzzleDepth] = useState(24);
  const [puzzleTargetKey, setPuzzleTargetKey] = useState<string | null>(null);
  const [generatingPuzzles, setGeneratingPuzzles] = useState(false);
  const [validatingVariants, setValidatingVariants] = useState(false);
  const [validationReport, setValidationReport] = useState<VariantValidationReport | null>(null);
  const [validationModalOpened, setValidationModalOpened] = useState(false);

  // Calculate responsive grid columns
  const isMobile = layout.files?.layoutType === "mobile" || false;
  const gridCols = isMobile ? 1 : { base: 1, md: 2, lg: 3 };

  const {
    data: variants = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["variants", activeProfileId ?? "global"],
    queryFn: async () => loadVariants(await getVariantsDirectory(activeProfileId)),
    staleTime: 0,
    gcTime: 60_000,
    refetchOnMount: "always",
    refetchOnReconnect: true,
  });

  useEffect(() => {
    if (location.pathname === "/variants") {
      void refetch();
    }
  }, [location.pathname, refetch]);

  useEffect(() => {
    const onVariantsUpdated = () => {
      void refetch();
    };
    window.addEventListener("variants:links-updated", onVariantsUpdated);
    window.addEventListener("variants:updated", onVariantsUpdated);
    return () => {
      window.removeEventListener("variants:links-updated", onVariantsUpdated);
      window.removeEventListener("variants:updated", onVariantsUpdated);
    };
  }, [refetch]);

  const [createNewModalOpened, { open: openCreateNewModal, close: closeCreateNewModal }] = useDisclosure(false);
  const [editCommentsModalOpened, { open: openEditCommentsModal, close: closeEditCommentsModal }] =
    useDisclosure(false);
  const [selectedVariantForComments, setSelectedVariantForComments] = useState<VariantInfo | null>(null);

  const createNewForm = useForm({
    initialValues: {
      name: "",
    },
    validate: {
      name: (value) =>
        value.trim().length === 0 ? t("features.variants.nameRequired", { defaultValue: "Name is required" }) : null,
    },
  });

  const commentsForm = useForm({
    initialValues: {
      name: "",
      priority: null as number | null,
      opening: "",
      comments: "",
    },
  });

  const handleExportToFile = useCallback(async () => {
    if (!activeProfileId || transferBusy) return;
    try {
      setTransferBusy(true);
      const variantsDir = await getVariantsDirectory(activeProfileId);
      const entries = await readDir(variantsDir);
      const allEntries = await processEntriesRecursively(variantsDir, entries);
      const variantFiles = allEntries.filter(
        (entry): entry is FileMetadata => entry.type === "file" && entry.metadata.type === "variants",
      );

      const payloadVariants: VariantsPackageEntry[] = [];
      for (const variantFile of variantFiles) {
        const pgn = await readTextFile(variantFile.path);
        const metadata = await readInfoMetadata(variantFile.path, "variants");
        payloadVariants.push({
          relativePath: relativePath(variantsDir, variantFile.path).replace(/\\/g, "/"),
          pgn,
          info: metadata,
        });
      }

      const pkg: VariantsPackageFile = {
        schema: "ocs-variants-package",
        version: 1,
        exportedAt: new Date().toISOString(),
        variants: payloadVariants,
      };

      const defaultName = `variants-${activeProfileId}-${new Date().toISOString().slice(0, 10)}.ocs-variants.json`;
      const destination = await save({
        defaultPath: defaultName,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!destination) {
        return;
      }

      await writeTextFile(destination, JSON.stringify(pkg, null, 2));
      notifications.show({
        title: t("common.success"),
        message: t("features.variants.exportToFileDone", {
          defaultValue: "Variants package exported. Variants: {{variants}}.",
          variants: payloadVariants.length,
        }),
        color: "green",
      });
    } catch (error) {
      notifications.show({
        title: t("common.error"),
        message:
          error instanceof Error
            ? error.message
            : t("features.variants.exportToFileFailed", {
                defaultValue: "Failed to export variants package.",
              }),
        color: "red",
      });
    } finally {
      setTransferBusy(false);
    }
  }, [activeProfileId, t, transferBusy]);

  const handleImportFromFile = useCallback(async () => {
    if (!activeProfileId || transferBusy) return;
    try {
      setTransferBusy(true);
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      const sourceFile = Array.isArray(selected) ? selected[0] : selected;
      if (!sourceFile || typeof sourceFile !== "string") {
        return;
      }

      const raw = await readTextFile(sourceFile);
      const parsed = JSON.parse(raw) as Partial<VariantsPackageFile> | null;
      if (
        !parsed ||
        parsed.schema !== "ocs-variants-package" ||
        parsed.version !== 1 ||
        !Array.isArray(parsed.variants)
      ) {
        throw new Error(
          t("features.variants.invalidVariantsPackage", {
            defaultValue: "Invalid variants package format.",
          }),
        );
      }

      const variantsDir = await getVariantsDirectory(activeProfileId);
      await mkdir(variantsDir, { recursive: true });

      let importedVariants = 0;
      let overwrittenVariants = 0;
      let skippedVariants = 0;

      for (const entry of parsed.variants) {
        if (!entry || typeof entry !== "object") {
          skippedVariants += 1;
          continue;
        }

        const record = entry as Partial<VariantsPackageEntry>;
        const cleanRelativePath =
          typeof record.relativePath === "string" ? sanitizePackageRelativePath(record.relativePath) : null;
        if (!cleanRelativePath || typeof record.pgn !== "string") {
          skippedVariants += 1;
          continue;
        }

        const targetPgn = await join(variantsDir, cleanRelativePath);
        await mkdir(parentDir(targetPgn), { recursive: true });
        if (await exists(targetPgn)) {
          overwrittenVariants += 1;
        }
        await writeTextFile(targetPgn, record.pgn);

        const infoMetadata = normalizeFileInfoMetadata(record.info, "variants");
        const normalizedInfo = {
          ...createDefaultFileInfoMetadata("variants"),
          ...infoMetadata,
          type: "variants" as const,
        };
        const targetInfo = targetPgn.replace(".pgn", ".info");
        await writeTextFile(targetInfo, JSON.stringify(normalizedInfo, null, 2));
        importedVariants += 1;
      }

      await repairVariantLinks(variantsDir);
      try {
        window.dispatchEvent(new Event("variants:links-updated"));
        window.dispatchEvent(new Event("variants:updated"));
      } catch {}
      await refetch();

      notifications.show({
        title: t("common.success"),
        message: t("features.variants.importFromFileDone", {
          defaultValue:
            "Variants package imported. Imported: {{imported}}, overwritten: {{overwritten}}, skipped: {{skipped}}.",
          imported: importedVariants,
          overwritten: overwrittenVariants,
          skipped: skippedVariants,
        }),
        color: "green",
      });
    } catch (error) {
      notifications.show({
        title: t("common.error"),
        message:
          error instanceof Error
            ? error.message
            : t("features.variants.importFromFileFailed", {
                defaultValue: "Failed to import variants package.",
              }),
        color: "red",
      });
    } finally {
      setTransferBusy(false);
    }
  }, [activeProfileId, refetch, t, transferBusy]);

  const handleCreateNew = useCallback(async () => {
    try {
      const variantsDir = await getVariantsDirectory(activeProfileId);

      let filename = createNewForm.values.name.trim();

      if (!filename) {
        notifications.show({
          title: t("common.error"),
          message: t("features.variants.nameRequired", { defaultValue: "Name is required" }),
          color: "red",
        });
        return;
      }

      // Sanitize filename: remove invalid characters for file names
      filename = filename.replace(/[<>:"/\\|?*]/g, "").trim();

      if (!filename) {
        notifications.show({
          title: t("common.error"),
          message: t("features.variants.invalidName", {
            defaultValue: "Invalid file name. Please use only valid characters.",
          }),
          color: "red",
        });
        return;
      }

      console.log("Creating variant file:", { filename, dir: variantsDir, profileId: activeProfileId });
      const result = await createFile({
        filename,
        filetype: "variants",
        dir: variantsDir,
        pgn: defaultPGN(),
      });

      console.log("Create file result:", { isOk: result.isOk, isErr: result.isErr });

      if (result.isOk) {
        console.log("File created successfully:", result.value.path);
        await openFile(result.value.path, setTabs, setActiveTab);
        navigate({ to: "/analysis" });
        closeCreateNewModal();
        createNewForm.reset();
        await refetch();
      } else {
        const error = result.error;
        console.error("Create file error details:", { error, type: typeof error, isError: error instanceof Error });

        let errorMessage: string;
        if (error instanceof Error) {
          errorMessage = error.message || error.toString();
        } else if (error) {
          errorMessage = String(error);
        } else {
          errorMessage = t("features.variants.createError", { defaultValue: "Failed to create variant" });
        }

        notifications.show({
          title: t("common.error"),
          message: errorMessage,
          color: "red",
        });
      }
    } catch (error) {
      console.error("Unexpected error creating variant:", error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : String(error) || t("features.variants.createError", { defaultValue: "Failed to create variant" });
      notifications.show({
        title: t("common.error"),
        message: errorMessage,
        color: "red",
      });
    }
  }, [activeProfileId, createNewForm, setTabs, setActiveTab, navigate, closeCreateNewModal, refetch, t]);

  const handleEdit = useCallback(
    async (variant: VariantInfo) => {
      await openFile(variant.path, setTabs, setActiveTab);
      navigate({ to: "/analysis" });
    },
    [navigate, setActiveTab, setTabs],
  );

  const handleEditComments = useCallback(
    (variant: VariantInfo) => {
      setSelectedVariantForComments(variant);
      commentsForm.setFieldValue("name", variant.name || "");
      commentsForm.setFieldValue("priority", variant.priority ?? null);
      commentsForm.setFieldValue("opening", variant.opening || "");
      commentsForm.setFieldValue("comments", variant.comments || "");
      openEditCommentsModal();
    },
    [commentsForm, openEditCommentsModal],
  );

  const handleSaveComments = useCallback(async () => {
    if (!selectedVariantForComments) return;

    try {
      const requestedName = commentsForm.values.name.trim();
      if (!requestedName) {
        notifications.show({
          title: t("common.error"),
          message: t("features.variants.nameRequired", { defaultValue: "Name is required" }),
          color: "red",
        });
        return;
      }

      const sanitizedName = requestedName.replace(/[<>:"/\\|?*]/g, "").trim();
      if (!sanitizedName) {
        notifications.show({
          title: t("common.error"),
          message: t("features.variants.invalidName", {
            defaultValue: "Invalid file name. Please use only valid characters.",
          }),
          color: "red",
        });
        return;
      }

      const priorityRaw = commentsForm.values.priority;
      const priorityValue =
        priorityRaw === null || priorityRaw === undefined || Number.isNaN(Number(priorityRaw))
          ? null
          : Number(priorityRaw);
      if (priorityValue !== null && (!Number.isInteger(priorityValue) || priorityValue < 1 || priorityValue > 4)) {
        notifications.show({
          title: t("common.error"),
          message: t("features.variants.priorityInvalid", { defaultValue: "Priority must be between 1 and 4." }),
          color: "red",
        });
        return;
      }

      const currentPath = selectedVariantForComments.path;
      const renamedPath = currentPath.replace(/[^\\/]+\.pgn$/i, `${sanitizedName}.pgn`);
      let finalPath = currentPath;
      const renamed = sanitizedName !== selectedVariantForComments.name;

      if (renamed) {
        if (await exists(renamedPath)) {
          notifications.show({
            title: t("common.error"),
            message: t("errors.fileAlreadyExists", { defaultValue: "File already exists" }),
            color: "red",
          });
          return;
        }
        const currentInfoPath = currentPath.replace(".pgn", ".info");
        const renamedInfoPath = renamedPath.replace(".pgn", ".info");
        await rename(currentPath, renamedPath);
        if (await exists(currentInfoPath)) {
          await rename(currentInfoPath, renamedInfoPath);
        }
        finalPath = renamedPath;
      }

      const metadata = await readInfoMetadata(finalPath, "variants");

      // Remove old comments/references tags
      metadata.tags = (metadata.tags || []).filter(
        (tag: string) =>
          !tag.startsWith("opening:") &&
          !tag.startsWith("priority:") &&
          !tag.startsWith("comments:") &&
          !tag.startsWith("references:"),
      );

      // Add opening tag if not empty
      if (commentsForm.values.opening.trim()) {
        metadata.tags.push(`opening:${commentsForm.values.opening.trim()}`);
      }
      if (priorityValue !== null) {
        metadata.tags.push(`priority:${priorityValue}`);
      }

      // Add new comments tag if not empty
      if (commentsForm.values.comments.trim()) {
        metadata.tags.push(`comments:${commentsForm.values.comments.trim()}`);
      }

      await writeInfoMetadata(finalPath, metadata);

      if (renamed) {
        const variantsDir = await getVariantsDirectory(activeProfileId);
        await repairVariantLinks(variantsDir);
      }
      try {
        window.dispatchEvent(new Event("variants:links-updated"));
        window.dispatchEvent(new Event("variants:updated"));
      } catch {}

      notifications.show({
        title: t("common.success"),
        message: t("features.variants.commentsSaved", { defaultValue: "Comments saved successfully" }),
        color: "green",
      });
      await refetch();
      closeEditCommentsModal();
    } catch (_error) {
      notifications.show({
        title: t("common.error"),
        message: t("features.variants.commentsSaveError", { defaultValue: "Failed to save comments" }),
        color: "red",
      });
    }
  }, [
    activeProfileId,
    closeEditCommentsModal,
    commentsForm.values.comments,
    commentsForm.values.name,
    commentsForm.values.priority,
    commentsForm.values.opening,
    refetch,
    selectedVariantForComments,
    t,
  ]);

  const handleDelete = useCallback(
    (variant: VariantInfo) => {
      modals.openConfirmModal({
        title: t("common.delete"),
        children: (
          <Text size="sm">
            {t("features.variants.deleteConfirm", { defaultValue: "Are you sure you want to delete this variant?" })}
            <br />
            <Text component="span" fw={700}>
              {variant.name}
            </Text>
          </Text>
        ),
        labels: { confirm: t("common.delete"), cancel: t("common.cancel") },
        confirmProps: { color: "red" },
        onConfirm: async () => {
          try {
            await remove(variant.path);
            // Also delete the .info file if it exists
            const infoPath = variant.path.replace(".pgn", ".info");
            if (await exists(infoPath)) {
              await remove(infoPath);
            }
            try {
              const variantDir = variant.path.replace(/[\\/][^\\/]+$/, "");
              const report = await cleanupVariantLinksAfterDelete(variant.path, variantDir);
              if (report.updatedFiles > 0 || report.removedLinks > 0) {
                try {
                  window.dispatchEvent(new Event("variants:links-updated"));
                } catch {}
              }
            } catch {
              // Ignore link cleanup errors during delete.
            }
            notifications.show({
              title: t("common.success"),
              message: t("features.variants.deleted", { defaultValue: "Variant deleted successfully" }),
              color: "green",
            });
            await refetch();
          } catch (_error) {
            notifications.show({
              title: t("common.error"),
              message: t("features.variants.deleteError", { defaultValue: "Failed to delete variant" }),
              color: "red",
            });
          }
        },
      });
    },
    [refetch, t],
  );

  const handleRepairLinks = useCallback(async () => {
    try {
      setRepairingLinks(true);
      const variantsDir = await getVariantsDirectory(activeProfileId);
      const report = await repairVariantLinks(variantsDir);
      try {
        window.dispatchEvent(new Event("variants:links-updated"));
      } catch {}
      await refetch();

      notifications.show({
        title: t("common.success"),
        message: t("features.variants.repairLinksDone", {
          defaultValue: "Links repaired. Updated: {{updated}}, added: {{added}}, removed: {{removed}}.",
          updated: report.updatedFiles,
          added: report.addedLinks,
          removed: report.removedLinks,
        }),
        color: "green",
      });
    } catch {
      notifications.show({
        title: t("common.error"),
        message: t("features.variants.repairLinksFailed", { defaultValue: "Failed to repair variant links." }),
        color: "red",
      });
    } finally {
      setRepairingLinks(false);
    }
  }, [activeProfileId, refetch, t]);

  const sortVariants = useCallback(
    (a: VariantInfo, b: VariantInfo) => {
      const { columnAccessor, direction } = sortStatus;
      const aValue = a[columnAccessor as keyof VariantInfo];
      const bValue = b[columnAccessor as keyof VariantInfo];

      let comparison = 0;
      if (aValue === null && bValue === null) {
        comparison = 0;
      } else if (aValue === null) {
        comparison = 1;
      } else if (bValue === null) {
        comparison = -1;
      } else if (typeof aValue === "number" && typeof bValue === "number") {
        comparison = aValue - bValue;
      } else {
        comparison = String(aValue).localeCompare(String(bValue));
      }

      return direction === "asc" ? comparison : -comparison;
    },
    [sortStatus],
  );

  const variantTreeRoots = useMemo(() => {
    const variantByKey = new Map<string, VariantInfo>();
    const variantByFileName = new Map<string, VariantInfo[]>();
    for (const variant of variants) {
      const key = normalizePath(variant.path);
      variantByKey.set(key, variant);
      const fileName = getFileName(variant.path).toLowerCase();
      const list = variantByFileName.get(fileName) ?? [];
      list.push(variant);
      variantByFileName.set(fileName, list);
    }

    const resolveVariant = (owner: VariantInfo, rawPath: string, fallbackName?: string | null): VariantInfo | null => {
      const resolved = resolveLinkedPath(owner.path, rawPath);
      const direct = variantByKey.get(resolved);
      if (direct) return direct;
      const byPathFileName = variantByFileName.get(getFileName(rawPath).toLowerCase());
      if (byPathFileName?.length) return byPathFileName[0] ?? null;
      if (fallbackName) {
        const byNameFileName = variantByFileName.get(fallbackName.toLowerCase());
        if (byNameFileName?.length) return byNameFileName[0] ?? null;
      }
      return null;
    };

    const childrenByParent = new Map<string, Set<string>>();
    const parentByChild = new Map<string, string>();
    for (const variant of variants) {
      const selfKey = normalizePath(variant.path);

      if (variant.parentLink?.path) {
        const parentVariant = resolveVariant(variant, variant.parentLink.path, variant.parentLink.name);
        if (parentVariant) {
          const parentKey = normalizePath(parentVariant.path);
          if (parentKey !== selfKey) {
            parentByChild.set(selfKey, parentKey);
            const children = childrenByParent.get(parentKey) ?? new Set<string>();
            children.add(selfKey);
            childrenByParent.set(parentKey, children);
          }
        }
      }

      for (const childLink of variant.childLinks ?? []) {
        if (!childLink.path) continue;
        const childVariant = resolveVariant(variant, childLink.path, childLink.name);
        if (!childVariant) continue;
        const childKey = normalizePath(childVariant.path);
        if (childKey === selfKey) continue;
        const children = childrenByParent.get(selfKey) ?? new Set<string>();
        children.add(childKey);
        childrenByParent.set(selfKey, children);
        if (!parentByChild.has(childKey)) {
          parentByChild.set(childKey, selfKey);
        }
      }
    }

    const searchLower = search.trim().toLowerCase();
    const selfMatches = new Map<string, boolean>();
    for (const variant of variants) {
      const key = normalizePath(variant.path);
      if (!searchLower) {
        selfMatches.set(key, true);
        continue;
      }
      const matches =
        variant.name.toLowerCase().includes(searchLower) ||
        variant.opening?.toLowerCase().includes(searchLower) ||
        variant.database?.toLowerCase().includes(searchLower) ||
        variant.engine?.toLowerCase().includes(searchLower) ||
        variant.parentLink?.name?.toLowerCase().includes(searchLower) ||
        variant.childLinks?.some(
          (link) => link.name.toLowerCase().includes(searchLower) || link.label?.toLowerCase().includes(searchLower),
        ) ||
        variant.comments?.toLowerCase().includes(searchLower) ||
        (variant.engineMs !== null && String(variant.engineMs).includes(searchLower)) ||
        (variant.variantsCount !== null && String(variant.variantsCount).includes(searchLower));
      selfMatches.set(key, !!matches);
    }

    const visibilityMemo = new Map<string, boolean>();
    const stack = new Set<string>();
    const hasVisibleSubtree = (key: string): boolean => {
      if (visibilityMemo.has(key)) return visibilityMemo.get(key)!;
      if (stack.has(key)) return false;
      stack.add(key);
      const ownMatch = selfMatches.get(key) ?? false;
      let childMatch = false;
      const childKeys = Array.from(childrenByParent.get(key) ?? []);
      for (const childKey of childKeys) {
        if (hasVisibleSubtree(childKey)) {
          childMatch = true;
          break;
        }
      }
      stack.delete(key);
      const visible = ownMatch || childMatch;
      visibilityMemo.set(key, visible);
      return visible;
    };

    const buildNode = (key: string, lineage: Set<string>): VariantTreeNode | null => {
      if (lineage.has(key)) return null;
      if (!hasVisibleSubtree(key)) return null;
      const variant = variantByKey.get(key);
      if (!variant) return null;
      const nextLineage = new Set(lineage);
      nextLineage.add(key);
      const childKeys = Array.from(childrenByParent.get(key) ?? []).filter(
        (childKey) => parentByChild.get(childKey) === key,
      );
      const sortedChildren = childKeys
        .map((childKey) => buildNode(childKey, nextLineage))
        .filter((child): child is VariantTreeNode => !!child)
        .sort((a, b) => sortVariants(a.variant, b.variant));
      return {
        key,
        variant,
        children: sortedChildren,
      };
    };

    const rootKeys = variants.map((variant) => normalizePath(variant.path)).filter((key) => !parentByChild.has(key));

    const roots = rootKeys
      .map((key) => buildNode(key, new Set<string>()))
      .filter((node): node is VariantTreeNode => !!node)
      .sort((a, b) => sortVariants(a.variant, b.variant));

    const seen = new Set<string>();
    const markSeen = (node: VariantTreeNode) => {
      if (seen.has(node.key)) return;
      seen.add(node.key);
      for (const child of node.children) {
        markSeen(child);
      }
    };
    for (const root of roots) {
      markSeen(root);
    }
    for (const variant of variants) {
      const key = normalizePath(variant.path);
      if (seen.has(key)) continue;
      const detached = buildNode(key, new Set<string>());
      if (!detached) continue;
      roots.push(detached);
      markSeen(detached);
    }

    return roots;
  }, [variants, search, sortVariants]);

  const variantLinkGraph = useMemo(() => {
    const variantByKey = new Map<string, VariantInfo>();
    const variantByFileName = new Map<string, VariantInfo[]>();

    for (const variant of variants) {
      const key = normalizePath(variant.path);
      variantByKey.set(key, variant);
      const fileName = getFileName(variant.path).toLowerCase();
      const list = variantByFileName.get(fileName) ?? [];
      list.push(variant);
      variantByFileName.set(fileName, list);
    }

    const resolveVariant = (owner: VariantInfo, rawPath: string, fallbackName?: string | null): VariantInfo | null => {
      const resolved = resolveLinkedPath(owner.path, rawPath);
      const direct = variantByKey.get(resolved);
      if (direct) return direct;
      const byPathFileName = variantByFileName.get(getFileName(rawPath).toLowerCase());
      if (byPathFileName?.length) return byPathFileName[0] ?? null;
      if (fallbackName) {
        const byNameFileName = variantByFileName.get(fallbackName.toLowerCase());
        if (byNameFileName?.length) return byNameFileName[0] ?? null;
      }
      return null;
    };

    const childrenByParent = new Map<string, Set<string>>();
    const parentByChild = new Map<string, string>();

    for (const variant of variants) {
      const selfKey = normalizePath(variant.path);

      if (variant.parentLink?.path) {
        const parentVariant = resolveVariant(variant, variant.parentLink.path, variant.parentLink.name);
        if (parentVariant) {
          const parentKey = normalizePath(parentVariant.path);
          if (parentKey !== selfKey) {
            parentByChild.set(selfKey, parentKey);
            const children = childrenByParent.get(parentKey) ?? new Set<string>();
            children.add(selfKey);
            childrenByParent.set(parentKey, children);
          }
        }
      }

      for (const childLink of variant.childLinks ?? []) {
        if (!childLink.path) continue;
        const childVariant = resolveVariant(variant, childLink.path, childLink.name);
        if (!childVariant) continue;
        const childKey = normalizePath(childVariant.path);
        if (childKey === selfKey) continue;
        const children = childrenByParent.get(selfKey) ?? new Set<string>();
        children.add(childKey);
        childrenByParent.set(selfKey, children);
        if (!parentByChild.has(childKey)) {
          parentByChild.set(childKey, selfKey);
        }
      }
    }

    return {
      variantByKey,
      childrenByParent,
      parentByChild,
    };
  }, [variants]);

  const collectSubtreeKeys = useCallback(
    (rootKey: string) => {
      const out: string[] = [];
      const visited = new Set<string>();

      const walk = (currentKey: string) => {
        if (visited.has(currentKey)) return;
        visited.add(currentKey);
        out.push(currentKey);

        const childKeys = Array.from(variantLinkGraph.childrenByParent.get(currentKey) ?? []).filter(
          (childKey) => variantLinkGraph.parentByChild.get(childKey) === currentKey,
        );
        for (const childKey of childKeys) {
          walk(childKey);
        }
      };

      walk(rootKey);
      return out;
    },
    [variantLinkGraph],
  );

  const handleOpenGeneratePuzzles = useCallback((row: VariantTableRow) => {
    setPuzzleTargetKey(row.key);
    setMaxPuzzleDepth(24);
    const initialDepth = row.variant.depth && row.variant.depth > 0 ? Math.min(row.variant.depth, 24) : 1;
    setPuzzleDepth(initialDepth);
    setPuzzleModalOpened(true);
  }, []);

  const generatePuzzlesForVariantTree = useCallback(
    async (selectedDepth: number) => {
      if (!puzzleTargetKey || generatingPuzzles) return;
      setGeneratingPuzzles(true);

      try {
        const documentDir = await getDocumentDir();
        if (!documentDir) {
          notifications.show({
            title: t("common.error"),
            message: t("errors.missingFilePath"),
            color: "red",
          });
          return;
        }

        const { commands } = await import("@/bindings");
        const { unwrap } = await import("@/utils/unwrap");

        const targetVariant = variantLinkGraph.variantByKey.get(puzzleTargetKey);
        if (!targetVariant) {
          notifications.show({
            title: t("common.error"),
            message: t("common.noRecordsFound", { defaultValue: "No records found" }),
            color: "red",
          });
          return;
        }

        const subtreeKeys = collectSubtreeKeys(puzzleTargetKey);

        let totalPuzzles = 0;
        let generatedFromVariants = 0;
        let failedVariants = 0;

        for (let variantIndex = 0; variantIndex < subtreeKeys.length; variantIndex += 1) {
          const key = subtreeKeys[variantIndex];
          const variant = variantLinkGraph.variantByKey.get(key);
          if (!variant) continue;

          try {
            const count = unwrap(await commands.countPgnGames(variant.path));
            if (count <= 0) {
              failedVariants += 1;
              continue;
            }

            const games = unwrap(await commands.readGames(variant.path, 0, 0));
            const firstGame = games[0];
            if (!firstGame) {
              failedVariants += 1;
              continue;
            }

            const tree = await parsePGN(firstGame);
            const orientation: "white" | "black" = tree.headers.orientation === "black" ? "black" : "white";

            const toDto = (node: TreeNode): PuzzleTreeNodeDto => ({
              fen: node.fen,
              san: node.san ?? null,
              children: node.children.map(toDto),
            });

            const result = await generatePuzzleVariantsFromTree({
              root: toDto(tree.root),
              orientation,
              selectedDepth,
            });

            const now = formatDateToPGN(new Date());
            const fileStem = sanitizeFileStem(`${variant.name}-puzzles-d${selectedDepth}-${now}-${variantIndex + 1}`);

            const mainlineNodes: TreeNode[] = [];
            let currentNode: TreeNode = tree.root;
            const maxMainlinePlies = 80;
            while (mainlineNodes.length < maxMainlinePlies && currentNode.children.length > 0) {
              const child = currentNode.children.find((c) => c.san) ?? currentNode.children[0];
              if (!child?.san) break;
              mainlineNodes.push(child);
              currentNode = child;
            }

            const mainline = mainlineNodes
              .map((move, index) =>
                getMoveText(move, {
                  glyphs: false,
                  comments: false,
                  extraMarkups: false,
                  isFirst: index === 0 || move.halfMoves % 2 === 0,
                }),
              )
              .join("")
              .trim();

            const tags = ["puzzle-variants", `variant:${variant.name}`, `depth:${selectedDepth}`];
            if (mainline) {
              tags.push(`mainline:${mainline}`);
            }

            const createResult = await createFile({
              filename: fileStem,
              filetype: "puzzle",
              tags,
              pgn: result.pgn,
              dir: documentDir,
            });
            if (createResult.isErr) {
              failedVariants += 1;
              continue;
            }

            totalPuzzles += result.count;
            generatedFromVariants += 1;
          } catch {
            failedVariants += 1;
          }
        }

        try {
          window.dispatchEvent(new Event("puzzles:updated"));
          window.dispatchEvent(new Event("puzzle-variants:updated"));
        } catch {}

        notifications.show({
          title: generatedFromVariants > 0 ? t("common.success") : t("common.error"),
          message: t("features.variants.generatePuzzlesDone", {
            defaultValue: "Generated {{puzzles}} puzzles from {{variants}} variants (failed: {{failed}}).",
            puzzles: totalPuzzles,
            variants: generatedFromVariants,
            failed: failedVariants,
          }),
          color: generatedFromVariants > 0 ? "green" : "red",
        });
      } catch {
        notifications.show({
          title: t("common.error"),
          message: t("common.failedToGeneratePuzzles"),
          color: "red",
        });
      } finally {
        setGeneratingPuzzles(false);
        setPuzzleTargetKey(null);
      }
    },
    [collectSubtreeKeys, generatingPuzzles, puzzleTargetKey, t, variantLinkGraph],
  );

  const handleValidateVariantTree = useCallback(
    async (row: VariantTableRow) => {
      if (validatingVariants) return;
      setValidatingVariants(true);
      setValidationReport(null);
      try {
        const { commands } = await import("@/bindings");
        const { unwrap } = await import("@/utils/unwrap");

        let familyRootKey = row.key;
        const visitedRoots = new Set<string>();
        while (!visitedRoots.has(familyRootKey)) {
          visitedRoots.add(familyRootKey);
          const parentKey = variantLinkGraph.parentByChild.get(familyRootKey);
          if (!parentKey) break;
          familyRootKey = parentKey;
        }

        const subtreeKeys = collectSubtreeKeys(familyRootKey);
        if (subtreeKeys.length === 0) {
          notifications.show({
            title: t("common.error"),
            message: t("common.noRecordsFound", { defaultValue: "No records found" }),
            color: "red",
          });
          return;
        }

        const targetVariant = variantLinkGraph.variantByKey.get(familyRootKey);
        if (!targetVariant) {
          notifications.show({
            title: t("common.error"),
            message: t("common.noRecordsFound", { defaultValue: "No records found" }),
            color: "red",
          });
          return;
        }

        const fenMoves = new Map<string, Map<string, VariantValidationMoveOccurrence[]>>();
        const skippedVariants: string[] = [];
        const orientationMismatches: string[] = [];
        let activeColor: "white" | "black" | null = null;
        let checkedVariants = 0;

        for (const key of subtreeKeys) {
          const variant = variantLinkGraph.variantByKey.get(key);
          if (!variant) continue;

          try {
            const count = unwrap(await commands.countPgnGames(variant.path));
            if (count <= 0) {
              skippedVariants.push(variant.name);
              continue;
            }
            const games = unwrap(await commands.readGames(variant.path, 0, 0));
            const firstGame = games[0];
            if (!firstGame) {
              skippedVariants.push(variant.name);
              continue;
            }

            const tree = await parsePGN(firstGame);
            const variantOrientation: "white" | "black" = tree.headers.orientation === "black" ? "black" : "white";
            if (!activeColor) {
              activeColor = variantOrientation;
            } else if (activeColor !== variantOrientation) {
              orientationMismatches.push(`${variant.name} (${variantOrientation})`);
            }
            checkedVariants += 1;

            const pathMoves: string[] = [];
            const walk = (node: TreeNode) => {
              const sideToMove = fenTurnColor(node.fen);
              for (const child of node.children) {
                const childSan = child.san?.trim();
                if (!childSan) {
                  pathMoves.push("?");
                  walk(child);
                  pathMoves.pop();
                  continue;
                }

                pathMoves.push(childSan);
                if (activeColor && sideToMove === activeColor) {
                  const fenKey = normalizeFenKey(node.fen);
                  const movesMap = fenMoves.get(fenKey) ?? new Map<string, VariantValidationMoveOccurrence[]>();
                  const moveOcc = movesMap.get(childSan) ?? [];
                  moveOcc.push({
                    variantName: variant.name,
                    variantPath: variant.path,
                    line: pathMoves.join(" "),
                  });
                  movesMap.set(childSan, moveOcc);
                  fenMoves.set(fenKey, movesMap);
                }
                walk(child);
                pathMoves.pop();
              }
            };

            walk(tree.root);
          } catch {
            skippedVariants.push(variant.name);
          }
        }

        if (!activeColor) {
          notifications.show({
            title: t("common.error"),
            message: t("common.noRecordsFound", { defaultValue: "No records found" }),
            color: "red",
          });
          return;
        }

        const conflicts: VariantValidationConflict[] = [];
        for (const [fen, movesMap] of fenMoves.entries()) {
          if (movesMap.size <= 1) continue;
          const moves = Array.from(movesMap.entries())
            .map(([san, occurrences]) => ({
              san,
              occurrences,
            }))
            .sort((a, b) => a.san.localeCompare(b.san));
          conflicts.push({
            fen,
            moves,
          });
        }
        conflicts.sort((a, b) => a.fen.localeCompare(b.fen));

        setValidationReport({
          targetVariantName: targetVariant.name,
          activeColor,
          checkedVariants,
          checkedPositions: fenMoves.size,
          conflicts,
          skippedVariants,
          orientationMismatches,
        });
        setValidationModalOpened(true);

        notifications.show({
          title: conflicts.length > 0 ? t("common.warning") : t("common.success"),
          message:
            conflicts.length > 0
              ? t("features.variants.validationConflictsFound", {
                  defaultValue: "Detected {{count}} contradictions in active-side moves.",
                  count: conflicts.length,
                })
              : t("features.variants.validationNoConflicts", {
                  defaultValue: "No contradictions found for active-side moves.",
                }),
          color: conflicts.length > 0 ? "yellow" : "green",
        });
      } finally {
        setValidatingVariants(false);
      }
    },
    [collectSubtreeKeys, t, validatingVariants, variantLinkGraph],
  );

  const variantTableRows = useMemo(() => {
    const rows: VariantTableRow[] = [];
    const forceExpand = search.trim().length > 0;
    const walk = (node: VariantTreeNode, depth: number) => {
      const hasChildren = node.children.length > 0;
      const expanded = forceExpand || expandedKeys.has(node.key);
      rows.push({
        ...node.variant,
        key: node.key,
        variant: node.variant,
        depth,
        hasChildren,
        expanded,
      });
      if (!hasChildren || !expanded) return;
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    };
    for (const root of variantTreeRoots) {
      walk(root, 0);
    }
    return rows;
  }, [variantTreeRoots, expandedKeys, search]);

  const visibleTreeVariants = useMemo(() => {
    const out: VariantInfo[] = [];
    const walk = (node: VariantTreeNode) => {
      out.push(node.variant);
      for (const child of node.children) {
        walk(child);
      }
    };
    for (const root of variantTreeRoots) {
      walk(root);
    }
    return out;
  }, [variantTreeRoots]);

  const paginatedRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    return variantTableRows.slice(start, end);
  }, [variantTableRows, page, pageSize]);

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(variantTableRows.length / pageSize));
    if (page > maxPage) {
      setPage(maxPage);
    }
  }, [variantTableRows.length, page, pageSize]);

  const toggleRow = (rowKey: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) {
        next.delete(rowKey);
      } else {
        next.add(rowKey);
      }
      return next;
    });
  };

  const columns = [
    {
      accessor: "name",
      title: t("features.variants.name", { defaultValue: "Name" }),
      sortable: true,
      render: (row: VariantTableRow) => (
        <Group wrap="nowrap" gap="sm">
          <Group wrap="nowrap" gap={6} style={{ marginLeft: row.depth * 16 }}>
            {row.hasChildren ? (
              <ActionIcon variant="subtle" size="sm" color="gray" onClick={() => toggleRow(row.key)}>
                {row.expanded ? <IconChevronDown size="0.9rem" /> : <IconChevronRight size="0.9rem" />}
              </ActionIcon>
            ) : (
              <Box w={22} />
            )}
            <IconGitBranch size="1.2rem" style={{ flexShrink: 0 }} />
          </Group>
          <Box miw={0} style={{ flex: 1 }}>
            <Text fw={600} size="sm" truncate>
              {row.variant.name}
            </Text>
          </Box>
        </Group>
      ),
    },
    {
      accessor: "opening",
      title: t("features.variants.opening", { defaultValue: "Opening" }),
      sortable: true,
      render: (row: VariantTableRow) =>
        row.variant.opening ? (
          <Text size="sm" truncate style={{ maxWidth: 250 }}>
            {row.variant.opening}
          </Text>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "priority",
      title: t("features.variants.priority", { defaultValue: "Priority" }),
      sortable: true,
      render: (row: VariantTableRow) =>
        row.variant.priority !== null ? (
          <Badge variant="light" color="indigo" size="sm">
            {row.variant.priority}
          </Badge>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "fen",
      title: t("features.variants.fen", { defaultValue: "FEN" }),
      sortable: true,
      render: (row: VariantTableRow) =>
        row.variant.fen ? (
          <Code
            fz="xs"
            style={{
              maxWidth: 300,
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.variant.fen}
          </Code>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "engine",
      title: t("features.variants.engine", { defaultValue: "Engine" }),
      sortable: true,
      render: (row: VariantTableRow) =>
        row.variant.engine ? (
          <Badge variant="outline" size="sm" style={{ textTransform: "none" }}>
            {row.variant.engine}
          </Badge>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "engineMs",
      title: t("features.variants.engineMs", { defaultValue: "Engine Time (ms)" }),
      sortable: true,
      render: (row: VariantTableRow) =>
        row.variant.engineMs !== null ? (
          <Text size="sm">{row.variant.engineMs}</Text>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "variantsCount",
      title: t("features.variants.variantsCount", { defaultValue: "Variants" }),
      sortable: true,
      render: (row: VariantTableRow) =>
        row.variant.variantsCount !== null ? (
          <Badge variant="light" color="blue" size="sm">
            {row.variant.variantsCount}
          </Badge>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "links",
      title: t("features.variants.links", { defaultValue: "Links" }),
      sortable: false,
      render: (row: VariantTableRow) => (
        <Group gap={6} wrap="wrap">
          {row.variant.parentLink ? (
            <Badge variant="outline" color="teal" size="sm">
              {t("features.variants.parentLink", { defaultValue: "Parent" })}
            </Badge>
          ) : null}
          {(row.variant.childLinks?.length ?? 0) > 0 ? (
            <Badge variant="light" color="cyan" size="sm">
              {t("features.variants.childLinks", { defaultValue: "Children" })}: {row.variant.childLinks?.length ?? 0}
            </Badge>
          ) : null}
          {!row.variant.parentLink && (row.variant.childLinks?.length ?? 0) === 0 ? (
            <Text size="sm" c="dimmed" fs="italic">
              -
            </Text>
          ) : null}
        </Group>
      ),
    },
    {
      accessor: "comments",
      title: t("features.variants.comments", { defaultValue: "Comments / References" }),
      sortable: true,
      render: (row: VariantTableRow) =>
        row.variant.comments ? (
          <Text size="sm" truncate style={{ maxWidth: 300 }}>
            {row.variant.comments}
          </Text>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "actions",
      title: t("common.actions", { defaultValue: "Actions" }),
      textAlign: "right" as const,
      render: (row: VariantTableRow) => (
        <Group gap="xs" justify="flex-end">
          <Tooltip label={t("features.variants.validateConsistency", { defaultValue: "Validate consistency" })}>
            <ActionIcon
              variant="subtle"
              color="teal"
              onClick={() => void handleValidateVariantTree(row)}
              disabled={validatingVariants}
            >
              <IconShieldCheck size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("common.generatePuzzles", { defaultValue: "Generate Puzzles" })}>
            <ActionIcon
              variant="subtle"
              color="yellow"
              onClick={() => handleOpenGeneratePuzzles(row)}
              disabled={generatingPuzzles}
            >
              <IconPuzzle size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("common.view", { defaultValue: "View" })}>
            <ActionIcon variant="subtle" color="blue" onClick={() => handleEdit(row.variant)}>
              <IconEye size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("features.variants.editComments", { defaultValue: "Edit Comments / References" })}>
            <ActionIcon variant="subtle" color="grape" onClick={() => handleEditComments(row.variant)}>
              <IconEdit size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("common.delete", { defaultValue: "Delete" })}>
            <ActionIcon variant="subtle" color="red" onClick={() => handleDelete(row.variant)}>
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      ),
    },
  ];

  return (
    <Stack gap={0} h="100%">
      <GenericHeader
        title={t("features.variants.title", { defaultValue: "Variants" })}
        folder="variants"
        searchPlaceholder={t("features.variants.searchPlaceholder", { defaultValue: "Search variants..." })}
        query={search}
        setQuery={setSearch}
        sortOptions={[
          { value: "name", label: t("features.variants.name", { defaultValue: "Name" }) },
          { value: "priority", label: t("features.variants.priority", { defaultValue: "Priority" }) },
          { value: "opening", label: t("features.variants.opening", { defaultValue: "Opening" }) },
        ]}
        currentSort={
          sortStatus.columnAccessor
            ? {
                field: sortStatus.columnAccessor,
                direction: sortStatus.direction === "asc" ? "asc" : "desc",
              }
            : undefined
        }
        onSortChange={(sortBy) => {
          setSortStatus({
            columnAccessor: sortBy.field as keyof VariantInfo,
            direction: sortBy.direction === "asc" ? "asc" : "desc",
          });
        }}
        viewMode={viewMode}
        setViewMode={setViewMode}
        pageKey="variants"
        actions={
          <Group gap="xs">
            <Button
              size="xs"
              variant="default"
              leftSection={<IconFileImport size="1rem" />}
              onClick={() => void handleImportFromFile()}
              disabled={!activeProfileId}
              loading={transferBusy}
            >
              {t("features.variants.importFromFile", { defaultValue: "Import variants file" })}
            </Button>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconFileExport size="1rem" />}
              onClick={() => void handleExportToFile()}
              disabled={!activeProfileId}
              loading={transferBusy}
            >
              {t("features.variants.exportToFile", { defaultValue: "Export variants file" })}
            </Button>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconRefresh size="1rem" />}
              loading={repairingLinks}
              onClick={() => void handleRepairLinks()}
            >
              {t("features.variants.repairLinks", { defaultValue: "Repair links" })}
            </Button>
            <Button size="xs" leftSection={<IconPlus size="1rem" />} onClick={openCreateNewModal}>
              {t("features.variants.createNew", { defaultValue: "Create New" })}
            </Button>
          </Group>
        }
      />
      <Box px="md" pb="md" style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {viewMode === "grid" ? (
          <VariantGridView
            variants={visibleTreeVariants}
            isLoading={isLoading}
            onEdit={(variant) => void handleEdit(variant)}
            onDelete={handleDelete}
            onEditComments={handleEditComments}
            gridCols={gridCols}
          />
        ) : isLoading ? (
          <Center h="100%">
            <Stack align="center" gap="xs">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">
                {t("common.loading")}
              </Text>
            </Stack>
          </Center>
        ) : variantTableRows.length === 0 ? (
          <Center h="100%">
            <Alert
              title={t("common.noRecordsFound", { defaultValue: "No records found" })}
              color="gray"
              variant="light"
              icon={<IconGitBranch size={20} />}
            >
              {variants.length === 0
                ? t("features.variants.empty", {
                    defaultValue: "No variants found. Create a new variant to get started.",
                  })
                : t("features.variants.noResults", {
                    defaultValue: "No variants match your search criteria.",
                  })}
            </Alert>
          </Center>
        ) : (
          <DataTable
            records={paginatedRows}
            columns={columns}
            sortStatus={sortStatus as DataTableSortStatus<VariantTableRow>}
            onSortStatusChange={(status) => setSortStatus(status as DataTableSortStatus<VariantInfo>)}
            withTableBorder
            highlightOnHover
            striped
            minHeight={200}
            noRecordsText={t("common.noRecordsFound", { defaultValue: "No records found" })}
            style={{ flex: 1 }}
            totalRecords={variantTableRows.length}
            recordsPerPage={pageSize}
            page={page}
            onPageChange={(p) => {
              setPage(p);
              // Scroll to top when page changes
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            onRecordsPerPageChange={(size) => {
              setPageSize(size);
              setPage(1); // Reset to first page when page size changes
            }}
            recordsPerPageOptions={[10, 25, 50, 100]}
          />
        )}
      </Box>

      <PuzzleVariantsModal
        opened={puzzleModalOpened}
        onClose={() => setPuzzleModalOpened(false)}
        puzzleDepth={puzzleDepth}
        maxPuzzleDepth={maxPuzzleDepth}
        setPuzzleDepth={setPuzzleDepth}
        onGenerate={(depth) => void generatePuzzlesForVariantTree(depth)}
      />

      <Modal
        opened={validationModalOpened}
        onClose={() => setValidationModalOpened(false)}
        title={t("features.variants.validationReportTitle", { defaultValue: "Variants consistency report" })}
        size="xl"
      >
        {validationReport ? (
          <Stack gap="sm">
            <Text size="sm">
              {t("features.variants.validationSummary", {
                defaultValue:
                  "Variant: {{variant}} | Active side: {{color}} | Variants checked: {{variants}} | Positions checked: {{positions}} | Contradictions: {{conflicts}}",
                variant: validationReport.targetVariantName,
                color: validationReport.activeColor,
                variants: validationReport.checkedVariants,
                positions: validationReport.checkedPositions,
                conflicts: validationReport.conflicts.length,
              })}
            </Text>

            {validationReport.orientationMismatches.length > 0 ? (
              <Alert color="yellow" variant="light">
                <Text size="sm" fw={600}>
                  {t("features.variants.validationOrientationMismatch", {
                    defaultValue: "Orientation mismatch detected in:",
                  })}
                </Text>
                <Text size="sm">{validationReport.orientationMismatches.join(", ")}</Text>
              </Alert>
            ) : null}

            {validationReport.skippedVariants.length > 0 ? (
              <Alert color="gray" variant="light">
                <Text size="sm" fw={600}>
                  {t("features.variants.validationSkipped", {
                    defaultValue: "Variants skipped (no readable PGN):",
                  })}
                </Text>
                <Text size="sm">{validationReport.skippedVariants.join(", ")}</Text>
              </Alert>
            ) : null}

            {validationReport.conflicts.length === 0 ? (
              <Alert color="green" variant="light">
                {t("features.variants.validationNoConflicts", {
                  defaultValue: "No contradictions found for active-side moves.",
                })}
              </Alert>
            ) : (
              <Stack gap="xs" style={{ maxHeight: 460, overflowY: "auto", paddingRight: 4 }}>
                {validationReport.conflicts.map((conflict) => (
                  <Alert key={conflict.fen} color="red" variant="light">
                    <Stack gap={4}>
                      <Text size="sm" fw={700}>
                        {t("features.variants.validationFen", { defaultValue: "FEN" })}: <Code>{conflict.fen}</Code>
                      </Text>
                      {conflict.moves.map((move) => (
                        <Box key={`${conflict.fen}-${move.san}`}>
                          <Text size="sm" fw={600}>
                            {t("features.variants.validationMove", { defaultValue: "Move" })}: {move.san}
                          </Text>
                          {move.occurrences.map((occurrence, index) => (
                            <Text key={`${occurrence.variantPath}-${index}`} size="xs" c="dimmed">
                              {occurrence.variantName} {"->"} {occurrence.line}
                            </Text>
                          ))}
                        </Box>
                      ))}
                    </Stack>
                  </Alert>
                ))}
              </Stack>
            )}
          </Stack>
        ) : null}
      </Modal>

      <Modal
        opened={createNewModalOpened}
        onClose={closeCreateNewModal}
        title={t("features.variants.createNew", { defaultValue: "Create New Variant" })}
      >
        <form onSubmit={createNewForm.onSubmit(handleCreateNew)}>
          <Stack>
            <TextInput
              label={t("features.variants.name", { defaultValue: "Name" })}
              placeholder={t("features.variants.namePlaceholder", { defaultValue: "Enter variant name..." })}
              {...createNewForm.getInputProps("name")}
              required
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={closeCreateNewModal}>
                {t("common.cancel")}
              </Button>
              <Button type="submit">{t("common.create")}</Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <Modal
        opened={editCommentsModalOpened}
        onClose={closeEditCommentsModal}
        title={t("features.variants.editComments", { defaultValue: "Edit Comments / References" })}
      >
        <form onSubmit={commentsForm.onSubmit(handleSaveComments)}>
          <Stack>
            <TextInput
              label={t("features.variants.name", { defaultValue: "Name" })}
              placeholder={t("features.variants.namePlaceholder", { defaultValue: "Enter variant name..." })}
              {...commentsForm.getInputProps("name")}
              required
            />
            <NumberInput
              label={t("features.variants.priority", { defaultValue: "Priority" })}
              placeholder={t("features.variants.priorityPlaceholder", { defaultValue: "Set priority (1-4)" })}
              min={1}
              max={4}
              allowDecimal={false}
              {...commentsForm.getInputProps("priority")}
            />
            <TextInput
              label={t("features.variants.opening", { defaultValue: "Opening" })}
              placeholder={t("features.variants.openingPlaceholder", { defaultValue: "Enter opening name..." })}
              {...commentsForm.getInputProps("opening")}
            />
            <Textarea
              label={t("features.variants.comments", { defaultValue: "Comments / References" })}
              placeholder={t("features.variants.commentsPlaceholder", {
                defaultValue: "Add your comments or references here...",
              })}
              {...commentsForm.getInputProps("comments")}
              autosize
              minRows={4}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={closeEditCommentsModal}>
                {t("common.cancel")}
              </Button>
              <Button type="submit">{t("features.variants.saveComments", { defaultValue: "Save Comments" })}</Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
