import {
  Alert,
  Box,
  Button,
  Center,
  Divider,
  Group,
  Loader,
  Modal,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { IconAlertCircle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir, appDataDir, basename, resolve } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
import { type Dispatch, type SetStateAction, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, events, type PuzzleDatabaseInfo } from "@/bindings";
import FileInput from "@/components/FileInput";
import ProgressButton from "@/components/ProgressButton";
import { getDefaultPuzzleDatabases } from "@/utils/db";
import { capitalize } from "@/utils/format";
import { getPuzzleDatabases } from "@/utils/puzzles";

export function AddPuzzle({
  puzzleDbs,
  opened,
  setOpened,
  setPuzzleDbs,
}: {
  puzzleDbs: PuzzleDatabaseInfo[];
  opened: boolean;
  setOpened: (opened: boolean) => void;
  setPuzzleDbs: Dispatch<SetStateAction<PuzzleDatabaseInfo[]>>;
}) {
  const { t } = useTranslation();
  const {
    data: dbs,
    error,
    isLoading,
  } = useQuery({
    queryKey: ["default_puzzle_databases"],
    queryFn: getDefaultPuzzleDatabases,
    staleTime: Infinity,
  });
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  async function importPuzzleFile(path: string, title: string, description?: string) {
    let importSourcePath = path;
    let tempImportPath: string | null = null;

    try {
      setImporting(true);
      setImportError(null);

      // On Android, the dialog plugin returns `content://` / `file://` URIs instead of
      // a normal filesystem path. Read the selected file through the fs plugin and
      // persist it into app cache first so the Rust backend can open it with std::fs::File.
      if (path.startsWith("content://") || path.startsWith("file://")) {
        const cacheDir = await appCacheDir();
        const selectedName = await basename(path).catch(() => "puzzle-import");
        const extensionMatch = selectedName.match(/(\.[^.]+(?:\.[^.]+)?)$/);
        const extension = extensionMatch?.[1] ?? "";
        tempImportPath = await resolve(
          cacheDir,
          `puzzle-import-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`,
        );
        const fileBytes = await readFile(path);
        await writeFile(tempImportPath, fileBytes);
        importSourcePath = tempImportPath;
      }

      const dbPath = await resolve(await appDataDir(), "puzzles", `${title}.db3`);

      const result = await commands.importPuzzleFile(importSourcePath, dbPath, title, description ?? null);
      if (result.status === "error") {
        throw new Error(result.error);
      }

      setPuzzleDbs(await getPuzzleDatabases(true));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : t("errors.failedToImportPuzzleFile");
      setImportError(message);
    } finally {
      if (tempImportPath) {
        await remove(tempImportPath).catch(() => {});
      }
      setImporting(false);
    }
  }

  const form = useForm<{ title: string; description: string; file: string; filename: string }>({
    initialValues: {
      title: "",
      description: "",
      file: "",
      filename: "",
    },

    validate: {
      title: (value) => {
        if (!value) return t("common.requireName");
        if (puzzleDbs.find((e) => e.title === `${value}.db3`)) return t("common.nameAlreadyUsed");
      },
      file: (value) => {
        if (!value) return t("common.requirePath");
      },
    },
  });

  return (
    <Modal opened={opened} onClose={() => setOpened(false)} title={t("features.puzzle.add.title")}>
      <Tabs defaultValue="web">
        <Tabs.List>
          <Tabs.Tab value="web">{t("features.databases.add.web")}</Tabs.Tab>
          <Tabs.Tab value="local">{t("common.local")}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="web" pt="xs">
          {isLoading && (
            <Center>
              <Loader />
            </Center>
          )}
          <ScrollArea.Autosize mah={500} offsetScrollbars>
            <Stack>
              {dbs?.map((db, i) => (
                <PuzzleDbCard
                  puzzleDb={db}
                  databaseId={i}
                  key={`puzzle-db-${db.title}-${i}`}
                  setPuzzleDbs={setPuzzleDbs}
                  closeModal={() => setOpened(false)}
                  initInstalled={puzzleDbs.some((e) => e.title === `${db.title}.db3`)}
                />
              ))}
              {error && (
                <Alert icon={<IconAlertCircle size="1rem" />} title={t("common.error")} color="red">
                  {t("features.databases.add.errorFetch")}
                </Alert>
              )}
            </Stack>
          </ScrollArea.Autosize>
        </Tabs.Panel>
        <Tabs.Panel value="local" pt="xs">
          <form
            onSubmit={form.onSubmit(async (values) => {
              await importPuzzleFile(values.file, values.title, values.description);
              if (!importError) {
                setOpened(false);
                form.reset();
              }
            })}
          >
            <TextInput label={t("common.name")} withAsterisk {...form.getInputProps("title")} />

            <TextInput label={t("common.description")} {...form.getInputProps("description")} />

            <FileInput
              label={t("features.files.fileType.puzzle")}
              description={t("features.databases.add.clickToSelectPGN")}
              onClick={async () => {
                const selected = await open({
                  multiple: false,
                  filters: [
                    {
                      name: "Puzzle files",
                      extensions: ["pgn", "pgn.zst", "csv", "csv.zst", "db", "db3"],
                    },
                  ],
                });
                if (!selected) return;
                const selectedPath = Array.isArray(selected) ? selected[0] : selected;
                if (typeof selectedPath !== "string") return;

                form.setFieldValue("file", selectedPath);
                const filename = await basename(selectedPath).catch(
                  () => selectedPath.split(/(\\|\/)/g).pop() || selectedPath,
                );
                if (filename) {
                  form.setFieldValue("filename", filename);
                  if (!form.values.title) {
                    const nameWithoutExt = filename.replace(/\.(pgn|csv|db|db3)(.zst)?$/i, "");
                    form.setFieldValue("title", capitalize(nameWithoutExt.replaceAll(/[_-]/g, " ")));
                  }
                }
              }}
              filename={form.values.filename || null}
              {...form.getInputProps("file")}
            />

            {importError && (
              <Alert icon={<IconAlertCircle size="1rem" />} title={t("common.error")} color="red" mt="md">
                {importError}
              </Alert>
            )}

            <Button fullWidth mt="xl" type="submit" loading={importing}>
              {importing ? t("common.importing") : t("common.import")}
            </Button>
          </form>
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

function PuzzleDbCard({
  setPuzzleDbs,
  puzzleDb,
  databaseId,
  initInstalled,
  closeModal,
}: {
  setPuzzleDbs: Dispatch<SetStateAction<PuzzleDatabaseInfo[]>>;
  puzzleDb: PuzzleDatabaseInfo & { downloadLink: string };
  databaseId: number;
  initInstalled: boolean;
  closeModal: () => void;
}) {
  const { t } = useTranslation();
  const [inProgress, setInProgress] = useState<boolean>(false);

  function startDownloadToast(downloadId: string, title: string) {
    const notificationId = `puzzle-download-${downloadId}`;
    const baseTitle = t("puzzles.download.inProgressTitle");

    notifications.show({
      id: notificationId,
      title: baseTitle,
      message: (
        <Stack gap={6}>
          <Text size="sm">{t("puzzles.download.inProgressMessage", { name: title })}</Text>
          <Progress value={0} animated striped />
        </Stack>
      ),
      loading: true,
      autoClose: false,
      withCloseButton: false,
    });

    let unlistenFn: (() => void) | null = null;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      unlistenFn?.();
    };

    const unlistenPromise = events.downloadProgress.listen((e) => {
      if (e.payload.id !== downloadId) return;

      const rawProgress = e.payload.progress;
      const progressValue = rawProgress >= 0 ? Math.max(0, Math.min(100, rawProgress)) : 0;
      const finished = e.payload.finished;

      notifications.update({
        id: notificationId,
        title: finished ? t("puzzles.download.completedTitle") : baseTitle,
        message: (
          <Stack gap={6}>
            <Text size="sm">
              {finished
                ? t("puzzles.download.completedMessage", { name: title })
                : rawProgress >= 0
                  ? t("puzzles.download.progressMessage", { name: title, progress: Math.round(progressValue) })
                  : t("puzzles.download.progressUnknown", { name: title })}
            </Text>
            <Progress value={progressValue} animated striped />
          </Stack>
        ),
        loading: !finished,
        autoClose: finished ? 4000 : false,
        withCloseButton: finished,
        color: finished ? "green" : undefined,
      });

      if (finished) {
        stop();
      }
    });

    unlistenPromise.then((f) => {
      unlistenFn = f;
    });

    return { notificationId, stop };
  }

  async function downloadDatabase(id: number, url: string, name: string, description: string) {
    const downloadId = `puzzle_db_${id}`;
    const { notificationId, stop } = startDownloadToast(downloadId, name);

    try {
      closeModal();
      setInProgress(true);
      await invoke("download_puzzle_database", {
        databaseId: id,
        url,
        title: name,
        description: description || null,
      });
      setPuzzleDbs(await getPuzzleDatabases(true));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifications.update({
        id: notificationId,
        title: t("puzzles.download.failedTitle"),
        message,
        color: "red",
        loading: false,
        autoClose: 10000,
        withCloseButton: true,
      });
    } finally {
      stop();
      setInProgress(false);
    }
  }

  return (
    <Paper withBorder radius="md" p={0} key={puzzleDb.title}>
      <Group wrap="nowrap" gap={0} grow>
        <Box p="md" flex={1}>
          <Text tt="uppercase" c="dimmed" fw={700} size="xs">
            {t("features.databases.add.title").toUpperCase()}
          </Text>
          <Text fw="bold" mb="xs">
            {puzzleDb.title}
          </Text>

          <Text size="xs" c="dimmed">
            {puzzleDb.description}
          </Text>
          <Divider />
          <Group wrap="nowrap" grow my="md">
            <Stack gap={0} align="center">
              <Text tt="uppercase" c="dimmed" fw={700} size="xs">
                {t("common.size").toUpperCase()}
              </Text>
              <Text size="xs">{t("units.bytes", { bytes: puzzleDb.storageSize })}</Text>
            </Stack>
            <Stack gap={0} align="center">
              <Text tt="uppercase" c="dimmed" fw={700} size="xs">
                {t("features.files.fileType.puzzle").toUpperCase()}
              </Text>
              <Text size="xs">{t("units.count", { count: puzzleDb.puzzleCount })}</Text>
            </Stack>
          </Group>
          <ProgressButton
            id={`puzzle_db_${databaseId}`}
            progressEvent={events.downloadProgress}
            initInstalled={initInstalled}
            labels={{
              completed: t("common.installed"),
              action: t("common.install"),
              inProgress: t("common.downloading"),
              finalizing: t("common.extracting"),
            }}
            onClick={() =>
              downloadDatabase(databaseId, puzzleDb.downloadLink || "", puzzleDb.title, puzzleDb.description)
            }
            inProgress={inProgress}
            setInProgress={setInProgress}
          />
        </Box>
      </Group>
    </Paper>
  );
}

export default AddPuzzle;
