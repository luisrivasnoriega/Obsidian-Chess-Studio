import { Anchor, Button, Code, CopyButton, Group, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export default function ErrorComponent({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <Stack p="md">
      <Title>{t("error.title")}</Title>
      {error instanceof Error ? (
        <>
          <Text>
            <b>{error.name}:</b> {error.message}
          </Text>
          <Code>{error.stack}</Code>
          {error.cause}
        </>
      ) : (
        <Text>
          <b>{t("error.unexpectedError")}</b> {JSON.stringify(error)}
        </Text>
      )}
      <Group>
        {error instanceof Error && (
          <CopyButton value={`${error.message}\n${error.stack}`}>
            {({ copied, copy }) => (
              <Button color={copied ? "teal" : undefined} onClick={copy}>
                {copied ? t("common.copied") : t("error.copyStackTrace")}
              </Button>
            )}
          </CopyButton>
        )}
        <Button onClick={() => navigate({ to: "/" }).then(() => window.location.reload())}>{t("common.reload")}</Button>
      </Group>

      <Text>
        {t("error.reportPrompt")}{" "}
        <Anchor
          href="https://github.com/luisrivasnoriega/Obsidian-Chess-Studio/issues/new?template=bug_report.yml"
          target="_blank"
        >
          Github
        </Anchor>
      </Text>
    </Stack>
  );
}
