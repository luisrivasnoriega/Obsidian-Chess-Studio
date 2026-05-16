import { Anchor, Button, Code, Group, Paper, ScrollArea, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    const lines = [`${error.name}: ${error.message}`];
    if (error.stack) {
      lines.push("", error.stack);
    }
    if (error.cause) {
      lines.push("", "Cause:", formatUnknownError(error.cause));
    }
    return lines.join("\n");
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

export default function ErrorComponent({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const details = useMemo(() => formatUnknownError(error), [error]);

  const copyDetails = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Stack p="md" maw={960}>
      <Title>{t("error.title")}</Title>
      {error instanceof Error ? (
        <Text>
          <b>{error.name}:</b> {error.message}
        </Text>
      ) : (
        <Text>
          <b>{t("error.unexpectedError")}</b> {JSON.stringify(error)}
        </Text>
      )}
      <Group>
        <Button onClick={() => navigate({ to: "/" }).then(() => window.location.reload())}>{t("common.reload")}</Button>
        <Button variant="default" onClick={copyDetails}>
          {copied ? t("error.copied") : t("error.copyStackTrace")}
        </Button>
      </Group>

      <Paper withBorder p="sm">
        <Group justify="space-between" mb="xs">
          <Text fw={600}>{t("error.stackTrace")}</Text>
        </Group>
        <ScrollArea h={320} type="auto">
          <Code block>{details}</Code>
        </ScrollArea>
      </Paper>

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
