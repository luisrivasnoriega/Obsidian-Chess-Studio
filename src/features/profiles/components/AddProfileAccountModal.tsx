import { Alert, Button, Checkbox, Group, InputWrapper, Modal, Select, Stack, TextInput } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import GenericCard from "@/components/GenericCard";
import LichessLogo from "@/features/accounts/components/LichessLogo";
import type { Profile } from "@/state/atoms";

export type AddProfileAccountPayload = {
  profileId: string;
  website: "lichess" | "chesscom";
  username: string;
  withLogin: boolean;
};

export function AddProfileAccountModal({
  opened,
  onClose,
  profiles,
  defaultProfileId,
  onAdd,
}: {
  opened: boolean;
  onClose: () => void;
  profiles: Profile[];
  defaultProfileId: string | null;
  onAdd: (payload: AddProfileAccountPayload) => void;
}) {
  const { t } = useTranslation();
  const [profileId, setProfileId] = useState<string | null>(defaultProfileId);
  const [website, setWebsite] = useState<"lichess" | "chesscom">("lichess");
  const [username, setUsername] = useState("");
  const [withLogin, setWithLogin] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setProfileId(defaultProfileId);
    setWebsite("lichess");
    setUsername("");
    setWithLogin(false);
  }, [opened, defaultProfileId]);

  const profileOptions = useMemo(
    () => profiles.map((p) => ({ value: p.id, label: p.name })),
    [profiles],
  );

  const canSubmit = !!profileId && username.trim().length > 0;

  const submit = () => {
    if (!profileId) return;
    onAdd({
      profileId,
      website,
      username: username.trim(),
      withLogin: website === "lichess" ? withLogin : false,
    });
    onClose();
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t("accounts.addAccount", { defaultValue: "Add Account" })}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) submit();
        }}
      >
        <Stack>
          <Select
            label={t("profiles.profile", { defaultValue: "Profile" })}
            data={profileOptions}
            value={profileId}
            onChange={setProfileId}
            placeholder={t("profiles.selectProfile", { defaultValue: "Select profile" })}
            searchable
            required
          />

          <InputWrapper label={t("accounts.website", { defaultValue: "Website" })} required>
            <Group grow>
              <GenericCard
                id={"lichess"}
                isSelected={website === "lichess"}
                setSelected={() => setWebsite("lichess")}
                content={
                  <Group>
                    <LichessLogo />
                    Lichess
                  </Group>
                }
              />
              <GenericCard
                id={"chesscom"}
                isSelected={website === "chesscom"}
                setSelected={() => setWebsite("chesscom")}
                content={
                  <Group>
                    <img width={30} height={30} src="/chesscom.png" alt="chess.com" />
                    Chess.com
                  </Group>
                }
              />
            </Group>
            {website === "chesscom" && (
              <Alert mt="xs" color="yellow" icon={<IconInfoCircle size={16} />}>
                Due to limitations of the Chess.com Public API, the total games count may not include all game types. In
                particular, bot games are excluded from the downloadable archives and won&apos;t be reflected in the total
                count.
              </Alert>
            )}
          </InputWrapper>

          <TextInput
            label={t("accounts.username", { defaultValue: "Username" })}
            placeholder={t("accounts.enterUsername", { defaultValue: "Enter your username" })}
            required
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
          />

          {website === "lichess" && (
            <Checkbox
              label={t("accounts.loginWithBrowser", { defaultValue: "Login with browser" })}
              description={t("accounts.loginWithBrowserDesc", { defaultValue: "Allows faster game downloads" })}
              checked={withLogin}
              onChange={(e) => setWithLogin(e.currentTarget.checked)}
            />
          )}

          <Button mt="1rem" type="submit" disabled={!canSubmit}>
            {t("common.add", { defaultValue: "Add" })}
          </Button>
        </Stack>
      </form>
    </Modal>
  );
}

