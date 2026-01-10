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
  Stack,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { IconEdit, IconEye, IconGitBranch, IconPlus, IconTrash } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { exists, readDir, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { useAtom, useSetAtom } from "jotai";
import { DataTable, type DataTableSortStatus } from "mantine-datatable";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadDirectories } from "@/App";
import GenericHeader, { type SortState } from "@/components/GenericHeader";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { processEntriesRecursively, type FileMetadata } from "@/features/files/utils/file";
import { createTab } from "@/utils/tabs";
import { createFile, openFile } from "@/utils/files";
import { notifications } from "@mantine/notifications";
import { defaultPGN, parsePGN } from "@/utils/chess";
import { VariantGridView } from "./components/VariantGridView";
import type { VariantInfo } from "./types";

async function loadVariants(): Promise<VariantInfo[]> {
  const dirs = await loadDirectories();
  const documentsDir = dirs.documentDir;
  if (!(await exists(documentsDir))) {
    return [];
  }

  const entries = await readDir(documentsDir);
  const allEntries = await processEntriesRecursively(documentsDir, entries);

  const variantFiles = allEntries
    .filter((entry): entry is FileMetadata => entry.type === "file")
    .filter((file) => file.metadata.type === "variants");

  const variants: VariantInfo[] = [];

  for (const file of variantFiles) {
    try {
      // Read the first game to extract information
      const { commands } = await import("@/bindings");
      const { unwrap } = await import("@/utils/unwrap");
      const count = unwrap(await commands.countPgnGames(file.path));
      if (count === 0) continue;

      const games = unwrap(await commands.readGames(file.path, 0, 0));
      const firstGame = games[0];
      const gameTree = await parsePGN(firstGame);

      const tags = file.metadata.tags || [];
      
      // Priority: metadata tags > PGN headers
      const openingTag = tags.find((tag) => tag.startsWith("opening:"))?.slice("opening:".length).trim();
      const fenTag = tags.find((tag) => tag.startsWith("fen:"))?.slice("fen:".length).trim();
      const depth = tags.find((tag) => tag.startsWith("depth:"))?.slice("depth:".length).trim() || null;
      const database = tags.find((tag) => tag.startsWith("database:"))?.slice("database:".length).trim() || null;
      const engine = tags.find((tag) => tag.startsWith("engine:"))?.slice("engine:".length).trim() || null;
      const engineMs = tags.find((tag) => tag.startsWith("engineMs:"))?.slice("engineMs:".length).trim() || null;
      const variantsCount = tags.find((tag) => tag.startsWith("variantsCount:"))?.slice("variantsCount:".length).trim() || null;
      const commentsTag = tags.find((tag) => tag.startsWith("comments:"))?.slice("comments:".length).trim() || null;
      const referencesTag = tags.find((tag) => tag.startsWith("references:"))?.slice("references:".length).trim() || null;
      const comments = commentsTag || referencesTag || null;

      // Fallback to PGN-derived headers if metadata tags don't exist
      const opening = openingTag || gameTree?.headers?.eco || null;
      const fen = fenTag || gameTree?.headers?.fen || null;

      variants.push({
        name: file.name,
        path: file.path,
        opening: opening || null,
        fen: fen || null,
        depth: depth ? Number.parseInt(depth, 10) : null,
        database: database || null,
        engine: engine || null,
        engineMs: engineMs ? Number.parseInt(engineMs, 10) : null,
        variantsCount: variantsCount ? Number.parseInt(variantsCount, 10) : null,
        comments: comments,
      });
    } catch (error) {
      console.error(`Error loading variant ${file.path}:`, error);
    }
  }

  return variants;
}

export default function VariantsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tabs, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const { layout } = useResponsiveLayout();

  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "table">("table");
  const [sortStatus, setSortStatus] = useState<DataTableSortStatus<VariantInfo>>({
    columnAccessor: "name",
    direction: "asc",
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Calculate responsive grid columns
  const isMobile = layout.files?.layoutType === "mobile" || false;
  const gridCols = isMobile ? 1 : { base: 1, md: 2, lg: 3 };

  const {
    data: variants = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["variants"],
    queryFn: loadVariants,
  });

  const [createNewModalOpened, { open: openCreateNewModal, close: closeCreateNewModal }] = useDisclosure(false);
  const [editCommentsModalOpened, { open: openEditCommentsModal, close: closeEditCommentsModal }] =
    useDisclosure(false);
  const [selectedVariantForComments, setSelectedVariantForComments] = useState<VariantInfo | null>(null);

  const createNewForm = useForm({
    initialValues: {
      name: "",
    },
    validate: {
      name: (value) => (value.trim().length === 0 ? t("features.variants.nameRequired", { defaultValue: "Name is required" }) : null),
    },
  });

  const commentsForm = useForm({
    initialValues: {
      comments: "",
    },
  });

  const handleCreateNew = useCallback(async () => {
    try {
      const dirs = await loadDirectories();
      const documentsDir = dirs.documentDir;

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
          message: t("features.variants.invalidName", { defaultValue: "Invalid file name. Please use only valid characters." }),
          color: "red",
        });
        return;
      }

      console.log("Creating variant file:", { filename, dir: documentsDir });
      const result = await createFile({
        filename,
        filetype: "variants",
        dir: documentsDir,
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
      const errorMessage = error instanceof Error 
        ? error.message 
        : String(error) || t("features.variants.createError", { defaultValue: "Failed to create variant" });
      notifications.show({
        title: t("common.error"),
        message: errorMessage,
        color: "red",
      });
    }
  }, [createNewForm, setTabs, setActiveTab, navigate, closeCreateNewModal, refetch, t]);

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
      commentsForm.setFieldValue("comments", variant.comments || "");
      openEditCommentsModal();
    },
    [commentsForm, openEditCommentsModal],
  );

  const handleSaveComments = useCallback(async () => {
    if (!selectedVariantForComments) return;

    try {
      const infoPath = selectedVariantForComments.path.replace(".pgn", ".info");
      const metadata = JSON.parse(await readTextFile(infoPath));
      
      // Remove old comments/references tags
      metadata.tags = (metadata.tags || []).filter(
        (tag: string) => !tag.startsWith("comments:") && !tag.startsWith("references:"),
      );

      // Add new comments tag if not empty
      if (commentsForm.values.comments.trim()) {
        metadata.tags.push(`comments:${commentsForm.values.comments.trim()}`);
      }

      await writeTextFile(infoPath, JSON.stringify(metadata, null, 2));

      notifications.show({
        title: t("common.success"),
        message: t("features.variants.commentsSaved", { defaultValue: "Comments saved successfully" }),
        color: "green",
      });
      await refetch();
      closeEditCommentsModal();
    } catch (error) {
      notifications.show({
        title: t("common.error"),
        message: t("features.variants.commentsSaveError", { defaultValue: "Failed to save comments" }),
        color: "red",
      });
    }
  }, [closeEditCommentsModal, commentsForm.values.comments, refetch, selectedVariantForComments, t]);

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
            notifications.show({
              title: t("common.success"),
              message: t("features.variants.deleted", { defaultValue: "Variant deleted successfully" }),
              color: "green",
            });
            await refetch();
          } catch (error) {
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

  const filteredAndSorted = useMemo(() => {
    let filtered = variants;

    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(
        (v) =>
          v.name.toLowerCase().includes(searchLower) ||
          (v.opening && v.opening.toLowerCase().includes(searchLower)) ||
          (v.database && v.database.toLowerCase().includes(searchLower)) ||
          (v.engine && v.engine.toLowerCase().includes(searchLower)) ||
          (v.comments && v.comments.toLowerCase().includes(searchLower)) ||
          (v.engineMs !== null && String(v.engineMs).includes(searchLower)) ||
          (v.variantsCount !== null && String(v.variantsCount).includes(searchLower)),
      );
    }

    const sorted = [...filtered].sort((a, b) => {
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
    });

    return sorted;
  }, [variants, search, sortStatus]);

  const paginatedVariants = useMemo(() => {
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    return filteredAndSorted.slice(start, end);
  }, [filteredAndSorted, page, pageSize]);

  const columns = [
    {
      accessor: "name",
      title: t("features.variants.name", { defaultValue: "Name" }),
      sortable: true,
      render: (variant: VariantInfo) => (
        <Group wrap="nowrap" gap="sm">
          <IconGitBranch size="1.2rem" style={{ flexShrink: 0 }} />
          <Box miw={0} style={{ flex: 1 }}>
            <Text fw={600} size="sm" truncate>
              {variant.name}
            </Text>
          </Box>
        </Group>
      ),
    },
    {
      accessor: "opening",
      title: t("features.variants.opening", { defaultValue: "Opening" }),
      sortable: true,
      render: (variant: VariantInfo) =>
        variant.opening ? (
          <Text size="sm" truncate style={{ maxWidth: 250 }}>
            {variant.opening}
          </Text>
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
      render: (variant: VariantInfo) =>
        variant.fen ? (
          <Code
            fz="xs"
            style={{ maxWidth: 300, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {variant.fen}
          </Code>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "depth",
      title: t("features.variants.depth", { defaultValue: "Depth" }),
      sortable: true,
      render: (variant: VariantInfo) =>
        variant.depth !== null ? (
          <Badge variant="light" size="sm">
            {variant.depth}
          </Badge>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "database",
      title: t("features.variants.database", { defaultValue: "Database" }),
      sortable: true,
      render: (variant: VariantInfo) =>
        variant.database ? (
          <Text size="sm" truncate style={{ maxWidth: 200 }}>
            {variant.database}
          </Text>
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
      render: (variant: VariantInfo) =>
        variant.engine ? (
          <Badge variant="outline" size="sm" style={{ textTransform: "none" }}>
            {variant.engine}
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
      render: (variant: VariantInfo) =>
        variant.engineMs !== null ? (
          <Text size="sm">
            {variant.engineMs}
          </Text>
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
      render: (variant: VariantInfo) =>
        variant.variantsCount !== null ? (
          <Badge variant="light" color="blue" size="sm">
            {variant.variantsCount}
          </Badge>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            -
          </Text>
        ),
    },
    {
      accessor: "comments",
      title: t("features.variants.comments", { defaultValue: "Comments / References" }),
      sortable: true,
      render: (variant: VariantInfo) =>
        variant.comments ? (
          <Text size="sm" truncate style={{ maxWidth: 300 }}>
            {variant.comments}
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
      render: (variant: VariantInfo) => (
        <Group gap="xs" justify="flex-end">
          <Tooltip label={t("common.view", { defaultValue: "View" })}>
            <ActionIcon variant="subtle" color="blue" onClick={() => handleEdit(variant)}>
              <IconEye size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("features.variants.editComments", { defaultValue: "Edit Comments / References" })}>
            <ActionIcon variant="subtle" color="grape" onClick={() => handleEditComments(variant)}>
              <IconEdit size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("common.delete", { defaultValue: "Delete" })}>
            <ActionIcon variant="subtle" color="red" onClick={() => handleDelete(variant)}>
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
          { value: "opening", label: t("features.variants.opening", { defaultValue: "Opening" }) },
          { value: "depth", label: t("features.variants.depth", { defaultValue: "Depth" }) },
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
          <Button
            size="xs"
            leftSection={<IconPlus size="1rem" />}
            onClick={openCreateNewModal}
          >
            {t("features.variants.createNew", { defaultValue: "Create New" })}
          </Button>
        }
      />
      <Box px="md" pb="md" style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {viewMode === "grid" ? (
          <VariantGridView
            variants={filteredAndSorted}
            isLoading={isLoading}
            onEdit={(variant) => void handleEdit(variant)}
            onDelete={handleDelete}
            onEditComments={handleEditComments}
            gridCols={gridCols}
          />
        ) : filteredAndSorted.length === 0 ? (
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
            records={paginatedVariants}
            columns={columns}
            sortStatus={sortStatus}
            onSortStatusChange={setSortStatus}
            withTableBorder
            highlightOnHover
            striped
            minHeight={200}
            noRecordsText={t("common.noRecordsFound", { defaultValue: "No records found" })}
            style={{ flex: 1 }}
            totalRecords={filteredAndSorted.length}
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
