import { Button, Group, Modal, SegmentedControl, Select, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import FileInput from "@/components/FileInput";
import { activeProfileIdAtom, profilesAtom } from "@/state/atoms";
import {
  addEventGamesFromPgn,
  listManagedEvents,
  type ManagedEvent,
  type ManagedEventType,
  upsertManagedEvent,
} from "@/utils/managedEvents";
import { getProfileDbPath } from "@/utils/profileDb";
import { unwrap } from "@/utils/unwrap";

const PGN_EXTENSIONS = ["pgn"];

type EventMode = "existing" | "new";

function profileLabel(profile: { name: string; displayName?: string }) {
  const name = (profile.displayName ?? "").trim() || profile.name.trim();
  return name || profile.name;
}

export default function ImportGamesModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const profiles = useAtomValue(profilesAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);

  const [pgnFiles, setPgnFiles] = useState<string[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);

  const [eventMode, setEventMode] = useState<EventMode>("existing");
  const [existingEventId, setExistingEventId] = useState<string | null>(null);
  const [newEventName, setNewEventName] = useState("");
  const [newEventType, setNewEventType] = useState<ManagedEventType>("otb_tournament");
  const [useEvent, setUseEvent] = useState(false);
  const [createdEventId, setCreatedEventId] = useState<number | null>(null);

  const [isImporting, setIsImporting] = useState(false);
  const [importStep, setImportStep] = useState<{ index: number; total: number } | null>(null);

  const profileOptions = useMemo(
    () =>
      profiles.map((p) => ({
        value: p.id,
        label: profileLabel(p),
      })),
    [profiles],
  );

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  );

  useEffect(() => {
    if (!opened) return;
    // Default destination profile to the currently active one (if any).
    setSelectedProfileId((prev) => prev ?? activeProfileId ?? null);
  }, [opened, activeProfileId]);

  const { data: profileDbPath } = useQuery<string | null>({
    queryKey: ["profileDbPath", selectedProfileId],
    queryFn: async () => {
      if (!selectedProfileId) return null;
      return await getProfileDbPath(selectedProfileId);
    },
    enabled: opened && !!selectedProfileId,
    staleTime: Infinity,
  });

  const {
    data: managedEvents,
    isLoading: isLoadingEvents,
    error: managedEventsError,
  } = useQuery<ManagedEvent[]>({
    queryKey: ["managedEvents", profileDbPath],
    queryFn: async () => {
      if (!profileDbPath) return [];
      return await listManagedEvents(profileDbPath);
    },
    enabled: opened && !!profileDbPath,
    staleTime: 30_000,
  });

  const eventOptions = useMemo(() => {
    const items = (managedEvents ?? []).map((e) => ({
      value: String(e.id),
      label: (e.name ?? "").trim() || t("features.events.unnamedEvent", "Unnamed event"),
    }));
    return items;
  }, [managedEvents, t]);

  // Keep "existing event" selection in sync with the current list.
  useEffect(() => {
    if (!opened) return;
    if (eventMode !== "existing") return;
    if (!eventOptions.length) {
      setExistingEventId(null);
      return;
    }
    setExistingEventId((prev) => {
      if (prev && eventOptions.some((o) => o.value === prev)) return prev;
      return eventOptions[0]?.value ?? null;
    });
  }, [opened, eventMode, eventOptions]);

  const resetState = useCallback(() => {
    setPgnFiles([]);
    setSelectedProfileId(null);
    setEventMode("existing");
    setExistingEventId(null);
    setNewEventName("");
    setNewEventType("otb_tournament");
    setUseEvent(false);
    setCreatedEventId(null);
    setIsImporting(false);
    setImportStep(null);
  }, []);

  const handleClose = useCallback(() => {
    if (isImporting) return;
    onClose();
    resetState();
  }, [isImporting, onClose, resetState]);

  const handleSelectPgnFiles = useCallback(async () => {
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: t("common.pgnFiles", "PGN files"),
          extensions: PGN_EXTENSIONS,
        },
      ],
    });

    if (!selected) return;
    if (typeof selected === "string") {
      setPgnFiles([selected]);
      return;
    }
    if (Array.isArray(selected)) {
      setPgnFiles(selected.filter((p): p is string => typeof p === "string"));
    }
  }, [t]);

  const ensureProfileDb = useCallback(async () => {
    if (!profileDbPath || !selectedProfile) return;
    const dbExists = await exists(profileDbPath);
    if (dbExists) return;
    // Create the profile DB on-demand (useful if profiles exist but DB hasn't been created yet).
    unwrap(await commands.initProfileDb(profileDbPath, profileLabel(selectedProfile), null));
  }, [profileDbPath, selectedProfile]);

  const validate = useCallback((): string | null => {
    if (!selectedProfileId) return t("databases.import.validation.profileRequired");
    if (pgnFiles.length === 0) return t("databases.import.validation.pgnRequired");
    if (!profileDbPath) return t("databases.import.validation.profileDbMissing");
    if (!useEvent) return null;
    if (eventMode === "existing" && !existingEventId) return t("databases.import.validation.eventRequired");
    if (eventMode === "new" && newEventName.trim().length === 0)
      return t("databases.import.validation.eventNameRequired");
    return null;
  }, [selectedProfileId, pgnFiles.length, profileDbPath, useEvent, eventMode, existingEventId, newEventName, t]);

  useEffect(() => {
    if (!opened) return;
    if (!useEvent) {
      setCreatedEventId(null);
    }
  }, [opened, useEvent]);

  const prevProfileIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!opened) return;
    if (prevProfileIdRef.current !== selectedProfileId) {
      prevProfileIdRef.current = selectedProfileId;
      // If the destination profile changes, we can't safely reuse a created event id.
      setCreatedEventId(null);
    }
  }, [opened, selectedProfileId]);

  const handleImport = useCallback(async () => {
    const validationError = validate();
    if (validationError) {
      notifications.show({ title: t("common.error"), message: validationError, color: "red" });
      return;
    }
    if (!profileDbPath) return;

    setIsImporting(true);
    setImportStep({ index: 0, total: pgnFiles.length });

    try {
      await ensureProfileDb();

      if (useEvent && eventMode === "new") {
        // Create at most once per import run, and reuse for every selected PGN.
        if (!createdEventId) {
          const created = await upsertManagedEvent(profileDbPath, {
            name: newEventName.trim(),
            eventType: newEventType,
          });
          setCreatedEventId(created.id);
          await queryClient.invalidateQueries({ queryKey: ["managedEvents", profileDbPath] });
        }
      }

      let totalImported = 0;
      for (let i = 0; i < pgnFiles.length; i += 1) {
        setImportStep({ index: i + 1, total: pgnFiles.length });
        const pgn = await readTextFile(pgnFiles[i]);

        if (!useEvent) {
          unwrap(await commands.convertPgn(pgnFiles[i], profileDbPath, null, "", null));
          continue;
        }

        let eventId: number;
        if (eventMode === "existing") {
          const parsed = Number.parseInt(existingEventId ?? "", 10);
          if (!Number.isFinite(parsed)) {
            throw new Error(t("databases.import.validation.eventRequired"));
          }
          eventId = parsed;
        } else {
          if (!createdEventId) {
            throw new Error(t("databases.import.failedTitle"));
          }
          eventId = createdEventId;
        }

        totalImported += await addEventGamesFromPgn(profileDbPath, eventId, pgn);
      }

      notifications.show({
        title: t("common.success"),
        message: t("databases.import.successMessage", { count: totalImported }),
        color: "green",
      });

      onClose();
      resetState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifications.show({
        title: t("databases.import.failedTitle"),
        message,
        color: "red",
      });
    } finally {
      setIsImporting(false);
      setImportStep(null);
    }
  }, [
    validate,
    profileDbPath,
    pgnFiles,
    ensureProfileDb,
    useEvent,
    eventMode,
    existingEventId,
    createdEventId,
    newEventName,
    newEventType,
    queryClient,
    t,
    onClose,
    resetState,
  ]);

  const fileButtonText =
    pgnFiles.length > 0 ? t("common.multipleFiles", { count: pgnFiles.length }) : t("common.clickToSelectMultiplePGN");

  const profilePlaceholder =
    profileOptions.length > 0 ? t("databases.import.profilePlaceholder") : t("databases.import.noProfiles");

  const isEventSelectDisabled = !profileDbPath || isLoadingEvents || !!managedEventsError;

  return (
    <Modal opened={opened} onClose={handleClose} title={t("databases.import.title")} size="lg" centered>
      <Stack gap="md">
        <Select
          label={t("databases.import.profileLabel")}
          placeholder={profilePlaceholder}
          data={profileOptions}
          value={selectedProfileId}
          onChange={setSelectedProfileId}
          searchable
          disabled={isImporting || profileOptions.length === 0}
          withAsterisk
        />

        <FileInput
          label={t("databases.import.pgnLabel")}
          description={t("databases.import.pgnDescription")}
          filename={fileButtonText}
          onClick={handleSelectPgnFiles}
          disabled={isImporting}
          withAsterisk
        />

        {pgnFiles.length > 0 && (
          <Textarea
            label={t("databases.import.selectedFilesLabel")}
            value={pgnFiles.join("\n")}
            readOnly
            autosize
            minRows={3}
            maxRows={8}
          />
        )}

        <Stack gap="xs">
          <Text fw={500}>{t("databases.import.eventSectionLabel")}</Text>
          <SegmentedControl
            value={useEvent ? "on" : "off"}
            onChange={(v) => setUseEvent(v === "on")}
            data={[
              { value: "off", label: t("common.off") },
              { value: "on", label: t("common.on") },
            ]}
            disabled={isImporting}
          />

          {useEvent && (
            <>
              <SegmentedControl
                value={eventMode}
                onChange={(v) => setEventMode(v as EventMode)}
                data={[
                  { value: "existing", label: t("databases.import.eventModeExisting") },
                  { value: "new", label: t("databases.import.eventModeNew") },
                ]}
                disabled={isImporting}
              />

              {eventMode === "existing" ? (
                <Select
                  label={t("databases.import.eventSelectLabel")}
                  placeholder={
                    !profileDbPath
                      ? t("databases.import.eventSelectDisabledNoProfile")
                      : isLoadingEvents
                        ? t("common.loading")
                        : t("databases.import.eventSelectPlaceholder")
                  }
                  data={eventOptions}
                  value={existingEventId}
                  onChange={setExistingEventId}
                  disabled={isImporting || isEventSelectDisabled || eventOptions.length === 0}
                  withAsterisk
                />
              ) : (
                <Group grow align="flex-start">
                  <TextInput
                    label={t("databases.import.eventNameLabel")}
                    value={newEventName}
                    onChange={(e) => setNewEventName(e.currentTarget.value)}
                    disabled={isImporting}
                    withAsterisk
                  />
                  <Select
                    label={t("databases.import.eventTypeLabel")}
                    value={newEventType}
                    onChange={(v) => setNewEventType((v as ManagedEventType) ?? "otb_tournament")}
                    disabled={isImporting}
                    data={[
                      { value: "otb_tournament", label: t("databases.import.eventType.otb_tournament") },
                      { value: "online_tournament", label: t("databases.import.eventType.online_tournament") },
                      { value: "league", label: t("databases.import.eventType.league") },
                    ]}
                  />
                </Group>
              )}
            </>
          )}
        </Stack>

        {importStep && (
          <Text size="sm" c="dimmed">
            {t("databases.import.importingStep", { current: importStep.index, total: importStep.total })}
          </Text>
        )}

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={handleClose} disabled={isImporting}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button onClick={handleImport} loading={isImporting}>
            {t("databases.import.importButton")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
