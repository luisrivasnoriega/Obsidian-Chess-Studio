import { Button, Group, Select, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PlayerSearchInput } from "@/features/databases/components/PlayerSearchInput";
import { type Profile, profilesAtom } from "@/state/atoms";
import { getProfileDbPath } from "@/utils/profileDb";

export default function MergeTab({ databaseFile, databaseTitle }: { databaseFile: string; databaseTitle: string }) {
  const { t } = useTranslation();
  const profiles = useAtomValue(profilesAtom);
  const [profileId, setProfileId] = useState<string | null>(profiles[0]?.id ?? null);
  const [playerId, setPlayerId] = useState<number | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const profileOptions = useMemo(() => {
    return profiles.map((p: Profile) => ({ value: p.id, label: p.displayName || p.name }));
  }, [profiles]);

  const canSubmit = !!profileId && playerId != null;

  const handleMerge = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const profileDbPath = await getProfileDbPath(profileId!);
      const inserted = await invoke<number>("merge_profile_event_from_db_player", {
        profileDbFile: profileDbPath,
        sourceDbFile: databaseFile,
        playerId,
        eventName: databaseTitle,
      });
      notifications.show({
        title: t("common.success"),
        message: t("features.databases.merge.success", { count: inserted }),
        color: "green",
      });
    } catch (error) {
      notifications.show({
        title: t("common.error"),
        message: error instanceof Error ? error.message : String(error),
        color: "red",
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (profileOptions.length === 0) {
    return <Text size="sm">{t("features.databases.merge.noProfiles")}</Text>;
  }

  return (
    <Stack gap="sm" h="100%">
      <Select
        label={t("features.databases.merge.profile")}
        data={profileOptions}
        value={profileId}
        onChange={(v) => setProfileId(v)}
        allowDeselect={false}
        comboboxProps={{ withinPortal: false }}
      />

      <PlayerSearchInput
        label={t("features.databases.merge.player")}
        file={databaseFile}
        value={playerId}
        setValue={setPlayerId}
      />

      <Group justify="flex-end" mt="xs">
        <Button onClick={handleMerge} disabled={!canSubmit} loading={submitting}>
          {t("features.databases.merge.confirm")}
        </Button>
      </Group>
    </Stack>
  );
}
