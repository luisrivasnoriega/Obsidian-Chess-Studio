import { Button, Group, Modal, Stack, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { importOnlineTournament } from "@/utils/db";

export default function AddOnlineTournament({
  opened,
  onClose,
  onImported,
  setLoading,
}: {
  opened: boolean;
  onClose: () => void;
  onImported: () => void;
  setLoading: (loading: boolean) => void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const closeAndReset = () => {
    setUrl("");
    setName("");
    onClose();
  };

  const handleImport = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      notifications.show({
        title: t("common.error"),
        message: t("features.databases.onlineTournament.missingUrl"),
        color: "red",
      });
      return;
    }

    setSubmitting(true);
    setLoading(true);
    try {
      await importOnlineTournament({
        url: trimmedUrl,
        title: name.trim() ? name.trim() : null,
        description: null,
      });
      notifications.show({
        title: t("common.success"),
        message: t("features.databases.onlineTournament.success"),
        color: "green",
      });
      onImported();
      closeAndReset();
    } catch (error) {
      notifications.show({
        title: t("common.error"),
        message: error instanceof Error ? error.message : String(error),
        color: "red",
      });
    } finally {
      setLoading(false);
      setSubmitting(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={closeAndReset}
      title={t("features.databases.onlineTournament.title")}
      withinPortal={false}
    >
      <Stack>
        <TextInput
          label={t("features.databases.onlineTournament.urlLabel")}
          placeholder={t("features.databases.onlineTournament.urlPlaceholder")}
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          autoFocus
        />
        <TextInput
          label={t("features.databases.onlineTournament.nameLabel")}
          placeholder={t("features.databases.onlineTournament.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={closeAndReset} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleImport} loading={submitting}>
            {t("features.databases.onlineTournament.import")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
