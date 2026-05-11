import { Group, Loader, Progress, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { TreeBuilderProgressState } from "./useVariantsBuilder";

type VariantsBuilderProgressProps = {
  progress: TreeBuilderProgressState;
};

export function VariantsBuilderProgress({ progress }: VariantsBuilderProgressProps) {
  const { t } = useTranslation();
  const phase = progress.phase === "idle" ? "starting" : progress.phase;

  return (
    <Stack gap={6}>
      <Group gap="xs" wrap="nowrap">
        <Loader size="xs" />
        <Text size="xs" c="dimmed">
          {t(`features.board.variants.treeBuilder.progress.${phase}`, {
            count: progress.appliedUpdates,
            depth: progress.lastMoveCount,
          })}
        </Text>
      </Group>
      <Progress value={100} animated striped size="xs" />
    </Stack>
  );
}
