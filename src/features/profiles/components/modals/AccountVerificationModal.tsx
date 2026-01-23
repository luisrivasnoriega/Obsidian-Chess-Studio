import { Button, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export type AccountVerificationResult = {
  validated: boolean;
  username?: string;
  password?: string;
};

export function AccountVerificationModal({
  opened,
  onClose,
  platform,
  username,
  onValidate,
}: {
  opened: boolean;
  onClose: () => void;
  platform: "lichess" | "chesscom";
  username: string;
  onValidate: (result: AccountVerificationResult) => void;
}) {
  const { t } = useTranslation();
  const [verificationUsername, setVerificationUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!opened) {
      // Reset form when modal closes
      setVerificationUsername("");
      setPassword("");
      setLoading(false);
    }
  }, [opened]);

  const canSubmit = verificationUsername.trim().length > 0 && password.trim().length > 0;

  const handleSubmit = async () => {
    if (!canSubmit || loading) return;
    setLoading(true);
    try {
      onValidate({
        validated: true,
        username: verificationUsername.trim(),
        password: password.trim(),
      });
      onClose();
    } catch (error) {
      // Error handling is done in the parent
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    onValidate({ validated: false });
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={handleCancel}
      title={t("accounts.verification.title", { defaultValue: "Account Verification Required" })}
    >
      <Stack>
        <Text size="sm" c="dimmed">
          {t("accounts.verification.description", {
            defaultValue: "Enter credentials for Obsidian Premium users to verify this account:",
          })}
        </Text>
        <Text size="sm" fw={500}>
          {t("accounts.username", { defaultValue: "Username" })}: {username}
        </Text>
        <TextInput
          label={t("accounts.verification.verificationUsername", { defaultValue: "Obsidian Premium Username" })}
          placeholder={t("accounts.verification.verificationUsernamePlaceholder", {
            defaultValue: "Enter your Obsidian Premium username",
          })}
          value={verificationUsername}
          onChange={(e) => setVerificationUsername(e.currentTarget.value)}
          required
          disabled={loading}
        />
        <TextInput
          label={t("accounts.verification.password", { defaultValue: "Obsidian Premium Password" })}
          placeholder={t("accounts.verification.passwordPlaceholder", { defaultValue: "Enter your Obsidian Premium password" })}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          required
          disabled={loading}
        />
        <Button.Group>
          <Button variant="default" onClick={handleCancel} disabled={loading} style={{ flex: 1 }}>
            {t("common.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || loading} loading={loading} style={{ flex: 1 }}>
            {t("accounts.verification.validate", { defaultValue: "Validate" })}
          </Button>
        </Button.Group>
      </Stack>
    </Modal>
  );
}
