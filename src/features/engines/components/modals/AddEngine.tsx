import {
  Alert,
  Box,
  Button,
  Center,
  Group,
  Image,
  Loader,
  Modal,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Tabs,
  Text,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { IconAlertCircle, IconDatabase, IconTrophy, IconX } from "@tabler/icons-react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { useAtom } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, events } from "@/bindings";
import ProgressButton from "@/components/ProgressButton";
import { enginesAtom } from "@/state/atoms";
import { type LocalEngine, type RemoteEngine, requiredEngineSettings, useDefaultEngines } from "@/utils/engines";
import { usePlatform } from "@/utils/files";
import { unwrap } from "@/utils/unwrap";
import EngineForm from "../EngineForm";

function AddEngine({ opened, setOpened }: { opened: boolean; setOpened: (opened: boolean) => void }) {
  const { t } = useTranslation();

  const [allEngines, setEngines] = useAtom(enginesAtom);
  const engines = allEngines.filter((e): e is LocalEngine => e.type === "local");

  const { os } = usePlatform();

  const { defaultEngines, error, isLoading } = useDefaultEngines(os, opened);

  const form = useForm<LocalEngine>({
    initialValues: {
      type: "local",
      version: "",
      name: "",
      path: "",
      image: "",
      elo: undefined,
    },

    validate: {
      name: (value) => {
        if (!value) return t("common.requireName");
        if (engines.find((e) => e.name === value)) return t("common.nameAlreadyUsed");
      },
      path: (value) => {
        if (!value) return t("common.requirePath");
      },
    },
  });

  return (
    <Modal opened={opened} onClose={() => setOpened(false)} title={t("features.engines.add.title")}>
      <Tabs defaultValue="download">
        <Tabs.List>
          <Tabs.Tab value="download">{t("common.download")}</Tabs.Tab>
          <Tabs.Tab value="cloud">{t("features.engines.add.cloud")}</Tabs.Tab>
          <Tabs.Tab value="local">{t("common.local")}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="download" pt="xs">
          {isLoading && (
            <Center>
              <Loader />
            </Center>
          )}
          <ScrollArea.Autosize mah={500} offsetScrollbars>
            <Stack>
              {defaultEngines?.map((engine, i) => (
                <EngineCard
                  // @ts-expect-error
                  engine={engine}
                  engineId={i}
                  closeModal={() => setOpened(false)}
                  key={engine.name}
                />
              ))}
              {error && (
                <Alert icon={<IconAlertCircle size="1rem" />} title={t("common.error")} color="red">
                  {t("features.engines.add.errorFetch")}
                </Alert>
              )}
            </Stack>
          </ScrollArea.Autosize>
        </Tabs.Panel>
        <Tabs.Panel value="cloud" pt="xs">
          <Stack>
            <CloudCard
              engine={{
                name: "ChessDB",
                type: "chessdb",
                url: "https://chessdb.cn",
              }}
            />
            <CloudCard
              engine={{
                name: "Lichess Cloud",
                type: "lichess",
                url: "https://lichess.org",
              }}
            />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="local" pt="xs">
          <EngineForm
            submitLabel={t("common.add")}
            form={form}
            onSubmit={(values: LocalEngine) => {
              setEngines(async (prev) => [...(await prev), values]);
              setOpened(false);
            }}
          />
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

function CloudCard({ engine }: { engine: RemoteEngine }) {
  const { t } = useTranslation();

  const [allEngines, setEngines] = useAtom(enginesAtom);
  const isInstalled = allEngines.find((e) => e.type === engine.type) !== undefined;

  return (
    <Paper withBorder radius="md" p={0} key={engine.name}>
      <Group wrap="nowrap" gap={0} grow>
        <Box p="md" flex={1}>
          <Text tt="uppercase" c="dimmed" fw={700} size="xs">
            {t("common.engine")}
          </Text>
          <Text fw="bold">{engine.name}</Text>
          <Text size="xs" c="dimmed" mb="xs">
            {engine.url}
          </Text>
          <Button
            disabled={isInstalled}
            fullWidth
            onClick={() => {
              setEngines(async (prev) => [
                ...(await prev),
                {
                  ...engine,
                  type: engine.type,
                  loaded: true,
                  settings: [
                    {
                      name: "MultiPV",
                      value: "1",
                    },
                  ],
                },
              ]);
            }}
          >
            {t("common.add")}
          </Button>
        </Box>
      </Group>
    </Paper>
  );
}

function EngineCard({
  engine,
  engineId,
  closeModal,
}: {
  engine: LocalEngine;
  engineId: number;
  closeModal: () => void;
}) {
  const { t } = useTranslation();

  const [inProgress, setInProgress] = useState<boolean>(false);
  const [allEngines, setEngines] = useAtom(enginesAtom);
  const engines = allEngines.filter((e): e is LocalEngine => e.type === "local");
  const isInstalled = engines.some((e) => e.name === engine.name);
  const { os } = usePlatform();

  const startDownloadToast = useCallback(
    (downloadId: string, title: string) => {
      const notificationId = `engine-download-${downloadId}`;
      const baseTitle = t("features.engines.download.inProgressTitle");

      notifications.show({
        id: notificationId,
        title: baseTitle,
        message: (
          <Stack gap={6}>
            <Text size="sm">{t("features.engines.download.inProgressMessage", { name: title })}</Text>
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
          title: finished ? t("features.engines.download.completedTitle") : baseTitle,
          message: (
            <Stack gap={6}>
              <Text size="sm">
                {finished
                  ? t("features.engines.download.completedMessage", { name: title })
                  : rawProgress >= 0
                    ? t("features.engines.download.progressMessage", {
                        name: title,
                        progress: Math.round(progressValue),
                      })
                    : t("features.engines.download.progressUnknown", { name: title })}
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
    },
    [t],
  );

  const installEngine = useCallback(
    async (id: number) => {
      setInProgress(true);

      try {
        let enginePath: string;
        const isAndroid = os === "android" || (engine as unknown as { os?: string }).os === "android";

        if (engine.installMethod === "bundled") {
          // On Android, bundled engines are resolved by the backend (prefer nativeLibraryDir `lib*.so`).
          // Treat the engine path as a logical identifier instead of a filesystem path.
          if (isAndroid) {
            enginePath = engine.path;
          } else {
            // Use bundled engine from app resources (resource_dir) on desktop targets.
            const { resourceDir } = await import("@tauri-apps/api/path");
            const resourceDirPath = await resourceDir();
            enginePath = await join(resourceDirPath, engine.path);

            // Verify it exists
            if (!(await exists(enginePath))) {
              throw new Error(t("features.engines.add.bundledEngineNotFound"));
            }

            // Verify it's a file, not a directory
            const meta = unwrap(await commands.getFileMetadata(enginePath));
            if (meta.is_dir) {
              throw new Error(t("features.engines.add.enginePathIsDirectory", { path: enginePath }));
            }

            // Set executable (though it should already be from resources, this ensures it)
            unwrap(await commands.setFileAsExecutable(enginePath));
          }
        } else if (engine.installMethod === "download") {
          const url = engine.downloadLink;
          if (!url) throw new Error("Download link not found");

          const downloadId = `engine_${id}`;
          const title = `${engine.name} ${engine.version}`.trim();
          const { notificationId, stop } = startDownloadToast(downloadId, title);
          closeModal();
          try {
            enginePath = await invoke<string>("download_engine", {
              engineId: id,
              url,
              engineRelPath: engine.path,
            });
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            notifications.update({
              id: notificationId,
              title: t("features.engines.download.failedTitle"),
              message,
              color: "red",
              loading: false,
              autoClose: 10000,
              withCloseButton: true,
            });

            const err = new Error(message);
            (err as unknown as { ocsToastHandled?: boolean }).ocsToastHandled = true;
            throw err;
          } finally {
            stop();
          }

          const meta = unwrap(await commands.getFileMetadata(enginePath));
          if (meta.is_dir) {
            throw new Error(t("features.engines.add.enginePathIsDirectory", { path: enginePath }));
          }
        } else if (engine.installMethod === "brew") {
          const brewPackage = engine.brewPackage;
          if (!brewPackage) throw new Error("Brew package name not found");

          const result = unwrap(await commands.installPackage("brew", brewPackage));
          if (!result.success) {
            throw new Error(`Brew installation failed: ${result.stderr}`);
          }
          enginePath = engine.path;
        } else if (engine.installMethod === "package") {
          const packageCommand = engine.packageCommand;
          if (!packageCommand) throw new Error("Package command not found");

          const [manager, ...args] = packageCommand.split(" ");
          const packageName = args[args.length - 1];

          const result = unwrap(await commands.installPackage(manager.replace("sudo", "").trim(), packageName));
          if (!result.success) {
            throw new Error(`Package installation failed: ${result.stderr}`);
          }
          enginePath = engine.path;
        } else {
          throw new Error(`Unsupported installation method: ${engine.installMethod}`);
        }

        let config: {
          name: string;
          options: { type: string; value: { name: string; default?: string | number | boolean | null } }[];
        } | null = null;
        try {
          config = unwrap(await commands.getEngineConfig(enginePath)) as unknown as typeof config;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("Engine timeout")) {
            notifications.show({
              title: t("common.warning"),
              message: t("features.engines.add.engineConfigTimeoutInstalled"),
              color: "yellow",
            });
            config = { name: engine.name, options: [] };
          } else {
            throw e;
          }
        }

        setEngines(async (prev) => [
          ...(await prev),
          {
            ...engine,
            type: "local" as const,
            path: enginePath,
            loaded: true,
            settings:
              config && config.options.length > 0
                ? config.options
                    .filter((o) => requiredEngineSettings.includes(o.value.name))
                    .map((o) => {
                      let defaultValue: string | number | boolean = "";
                      switch (o.type) {
                        case "check":
                          defaultValue = o.value.default ?? false;
                          break;
                        case "spin":
                          defaultValue = Number(o.value.default ?? 0);
                          break;
                        case "combo":
                        case "string":
                          defaultValue = o.value.default ?? "";
                          break;
                        default:
                          defaultValue = "";
                      }
                      return {
                        name: o.value.name,
                        value: defaultValue,
                      };
                    })
                : [
                    { name: "MultiPV", value: "1" },
                    { name: "Threads", value: 1 },
                    { name: "Hash", value: 64 },
                  ],
          },
        ]);
      } catch (error) {
        const handled =
          error != null &&
          typeof error === "object" &&
          "ocsToastHandled" in (error as Record<string, unknown>) &&
          (error as Record<string, unknown>).ocsToastHandled === true;
        if (handled) {
          return;
        }
        notifications.show({
          title: t("common.error"),
          message: error instanceof Error ? error.message : String(error),
          color: "red",
          icon: <IconX />,
        });
      } finally {
        setInProgress(false);
      }
    },
    [engine, setEngines, t, os, closeModal, startDownloadToast],
  );

  const getInstallText = () => {
    switch (engine.installMethod) {
      case "brew":
        return `brew install ${engine.brewPackage}`;
      case "package":
        return engine.packageCommand || "Install via package manager";
      case "bundled":
        return t("features.engines.add.bundled");
      default:
        return t("units.bytes", { bytes: engine.downloadSize ?? 0 });
    }
  };

  const getInstallActionLabel = () => {
    switch (engine.installMethod) {
      case "brew":
        return `${t("common.install")} (Brew)`;
      case "package":
        return `${t("common.install")} (Package)`;
      case "bundled":
        return t("common.install");
      default:
        return t("common.install");
    }
  };

  const getProgressLabel = () => {
    switch (engine.installMethod) {
      case "brew":
      case "package":
        return "Installing...";
      case "bundled":
        return "Installing...";
      default:
        return t("common.downloading");
    }
  };

  return (
    <Paper withBorder radius="md" p={0} key={engine.name}>
      <Group wrap="nowrap" gap={0} grow>
        {engine.image && (
          <Box w="2rem" px="xs">
            <Image src={engine.image} alt={engine.name} fit="contain" />
          </Box>
        )}
        <Box p="md" flex={1}>
          <Text tt="uppercase" c="dimmed" fw={700} size="xs">
            {t("common.engine")}
          </Text>
          <Text fw="bold" mb="xs">
            {engine.name} {engine.version}
          </Text>
          <Group wrap="nowrap" gap="xs">
            <IconTrophy size="1rem" />
            <Text size="xs">{`${engine.elo} ELO`}</Text>
          </Group>
          <Group wrap="nowrap" gap="xs" mb="xs">
            <IconDatabase size="1rem" />
            <Text size="xs">{getInstallText()}</Text>
          </Group>
          <ProgressButton
            id={`engine_${engineId}`}
            progressEvent={events.downloadProgress}
            initInstalled={isInstalled}
            stopInProgressOnFinished={false}
            completeOnFinished={false}
            labels={{
              completed: t("common.installed"),
              action: getInstallActionLabel(),
              inProgress: getProgressLabel(),
              finalizing: t("common.extracting"),
            }}
            onClick={() => installEngine(engineId)}
            inProgress={inProgress}
            setInProgress={setInProgress}
          />
        </Box>
      </Group>
    </Paper>
  );
}

export default AddEngine;
