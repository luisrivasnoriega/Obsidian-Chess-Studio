import { Button, Group, Modal, NumberInput, Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";

type Props = {
  opened: boolean;
  onClose: () => void;
  puzzleDepth: number;
  maxPuzzleDepth: number;
  setPuzzleDepth: (next: number) => void;
  onGenerate: (depth: number) => void;
};

export function PuzzleVariantsModal(props: Props) {
  const { t } = useTranslation();
  const { opened, onClose, puzzleDepth, maxPuzzleDepth, setPuzzleDepth, onGenerate } = props;

  return (
    <Modal opened={opened} onClose={onClose} title={t("common.generatePuzzles")} centered size="sm">
      <Stack gap="md">
        <NumberInput
          label={t("puzzles.depthLabel")}
          description={t("puzzles.depthHelper", { max: maxPuzzleDepth })}
          value={puzzleDepth}
          onChange={(value) => setPuzzleDepth(Math.min(Math.max(1, Number(value) || 1), maxPuzzleDepth))}
          min={1}
          max={maxPuzzleDepth}
        />
        <Group justify="flex-end">
          <Button
            onClick={() => {
              if (puzzleDepth < 1 || puzzleDepth > maxPuzzleDepth) {
                notifications.show({
                  title: t("common.error"),
                  message: t("errors.puzzleDepthTooDeep", { max: maxPuzzleDepth }),
                  color: "red",
                });
                return;
              }
              onClose();
              onGenerate(puzzleDepth);
            }}
          >
            {t("common.generate")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

