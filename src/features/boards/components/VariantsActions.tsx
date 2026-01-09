import { Button } from "@mantine/core";
import { IconGitBranch, IconPuzzle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

type Props = {
  treeBuilderRunning: boolean;
  onOpenPuzzle: () => void;
  onOpenTreeBuilder: () => void;
  onCancelTreeBuilder: () => void;
};

export function VariantsActions(props: Props) {
  const { t } = useTranslation();
  const { treeBuilderRunning, onOpenPuzzle, onOpenTreeBuilder, onCancelTreeBuilder } = props;

  return (
    <>
      <Button leftSection={<IconPuzzle size={18} />} onClick={onOpenPuzzle} variant="light" fullWidth mt="xs">
        {t("common.generatePuzzles")}
      </Button>
      <Button
        leftSection={<IconGitBranch size={18} />}
        onClick={() => {
          if (treeBuilderRunning) {
            onCancelTreeBuilder();
            return;
          }
          onOpenTreeBuilder();
        }}
        variant="light"
        fullWidth
        mt="xs"
      >
        {treeBuilderRunning ? t("common.cancel") : t("features.board.variants.treeBuilder.button")}
      </Button>
    </>
  );
}

