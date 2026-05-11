import { Button, Group, NumberInput, ScrollArea, SegmentedControl, Select, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { BuildVariantsMode } from "@/utils/variantsBuilder";
import type { VariantsBuilderModel } from "./useVariantsBuilder";
import type { VariantsPuzzleGeneration } from "./useVariantsPuzzleGeneration";
import { VariantsBuilderProgress } from "./VariantsBuilderProgress";

type VariantsBuildPanelProps = {
  builder: VariantsBuilderModel;
  currentFen: string;
  puzzles: VariantsPuzzleGeneration;
};

export function VariantsBuildPanel({ builder, currentFen, puzzles }: VariantsBuildPanelProps) {
  const { t } = useTranslation();

  return (
    <ScrollArea h="100%" offsetScrollbars>
      <Stack gap="sm" pb="xs">
        <Group justify="space-between">
          <Text fw={700}>{t("features.board.variants.treeBuilder.title")}</Text>
          <Text size="xs" c="dimmed">
            {builder.treeBuilderRunning ? t("common.loading") : t("features.board.variants.treeBuilder.sideNote")}
          </Text>
        </Group>
        {builder.treeBuilderRunning && <VariantsBuilderProgress progress={builder.treeBuilderProgress} />}

        <Stack gap="xs">
          <Text size="sm" fw={700}>
            {t("features.board.tabs.database")}
          </Text>
          <SegmentedControl
            data={[
              { label: t("features.board.database.local"), value: "local" },
              { label: t("features.board.database.lichessAll"), value: "lch_all" },
              { label: t("features.board.database.lichessMaster"), value: "lch_master" },
            ]}
            value={builder.dbType}
            onChange={(value) => builder.setDbType(value as "local" | "lch_all" | "lch_master")}
            fullWidth
          />
          {builder.dbType === "local" && (
            <Select
              data={builder.localDatabaseOptions}
              value={builder.localOptions.path ?? builder.referenceDatabase ?? null}
              onChange={(value) => {
                builder.setLocalOptions((prev) => ({
                  ...prev,
                  path: value ?? null,
                  fen: currentFen || prev.fen,
                }));
              }}
              placeholder={t("features.board.database.selectDatabase")}
              searchable
              clearable={false}
              disabled={!builder.localDatabaseOptions.length}
            />
          )}
        </Stack>

        <Stack gap="xs">
          <Text size="sm" fw={700}>
            {t("features.board.variants.treeBuilder.mode")}
          </Text>
          <SegmentedControl
            data={[
              { label: t("features.board.variants.treeBuilder.engine"), value: "engine" },
              { label: t("features.board.variants.treeBuilder.smart"), value: "smart" },
            ]}
            value={builder.treeBuilderMode}
            onChange={(value) => builder.setTreeBuilderMode(value as BuildVariantsMode)}
            fullWidth
          />
        </Stack>

        <Stack gap="xs">
          <Text size="sm" fw={700}>
            {t("common.engine")}
          </Text>
          <Select
            data={builder.engineOptions}
            value={builder.selectedEngineValue}
            onChange={builder.setSelectedEngineKey}
            placeholder={t("features.board.variants.treeBuilder.engineSelect")}
            disabled={!builder.engineOptions.length}
            searchable
          />
          <Group grow>
            <NumberInput
              label={t("features.board.variants.treeBuilder.engineTime")}
              value={builder.treeBuilderEngineMs}
              onChange={(value) => builder.setTreeBuilderEngineMs(Number(value) || 0)}
              min={1}
            />
            <NumberInput
              label={t("features.engines.settings.numOfCores")}
              value={builder.readEngineSettingNumber("Threads")}
              onChange={(value) => builder.updateEngineSettingNumber("Threads", Number(value) || 1)}
              min={1}
              disabled={!builder.selectedEngineSettings.settings.some((setting) => setting.name === "Threads")}
            />
            <NumberInput
              label={t("features.engines.settings.sizeOfHash")}
              value={builder.readEngineSettingNumber("Hash")}
              onChange={(value) => builder.updateEngineSettingNumber("Hash", Number(value) || 1)}
              min={1}
              disabled={!builder.selectedEngineSettings.settings.some((setting) => setting.name === "Hash")}
            />
          </Group>
        </Stack>

        <Stack gap="xs">
          <Text size="sm" fw={700}>
            {t("features.board.variants.treeBuilder.dbMoves")}
          </Text>
          <Group grow>
            <NumberInput
              label={t("features.board.variants.treeBuilder.coverage")}
              value={builder.treeBuilderCoverage}
              onChange={(value) => builder.setTreeBuilderCoverage(Number(value) || 0)}
              min={1}
              max={100}
            />
            <NumberInput
              label={t("features.board.variants.treeBuilder.minMoves")}
              value={builder.treeBuilderMinMoves}
              onChange={(value) => builder.setTreeBuilderMinMoves(Number(value) || 0)}
              min={1}
            />
            <NumberInput
              label={t("features.board.variants.treeBuilder.depth")}
              value={builder.treeBuilderDepth}
              onChange={(value) => builder.setTreeBuilderDepth(Number(value) || 0)}
              min={1}
            />
          </Group>
        </Stack>

        <Group justify="space-between" mt="xs">
          <Button variant="default" onClick={() => puzzles.openPuzzleModal(builder.treeBuilderDepth)}>
            {t("common.generatePuzzles")}
          </Button>
          <Button
            onClick={() => {
              if (builder.treeBuilderRunning) {
                builder.cancelTreeBuilder();
              } else {
                void builder.buildVariantsTree();
              }
            }}
            disabled={builder.runDisabled}
          >
            {builder.treeBuilderRunning ? t("common.cancel") : t("features.board.variants.treeBuilder.run")}
          </Button>
        </Group>
      </Stack>
    </ScrollArea>
  );
}
