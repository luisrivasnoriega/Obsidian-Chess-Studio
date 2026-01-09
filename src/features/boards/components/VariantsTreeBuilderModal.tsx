import { Button, Group, Modal, NumberInput, SegmentedControl, Select, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

type EngineOption = { value: string; label: string };

type Props = {
  opened: boolean;
  onClose: () => void;

  dbType: "local" | "lch_all" | "lch_master";
  setDbType: (next: "local" | "lch_all" | "lch_master") => void;
  localDbLabel: string | null;

  treeBuilderMode: "engine" | "winrate";
  setTreeBuilderMode: (next: "engine" | "winrate") => void;

  engineOptions: EngineOption[];
  selectedEngineValue: string | null;
  setSelectedEngineValue: (next: string | null) => void;

  treeBuilderEngineMs: number;
  setTreeBuilderEngineMs: (next: number) => void;

  treeBuilderCoverage: number;
  setTreeBuilderCoverage: (next: number) => void;
  treeBuilderMinMoves: number;
  setTreeBuilderMinMoves: (next: number) => void;
  treeBuilderDepth: number;
  setTreeBuilderDepth: (next: number) => void;

  treeBuilderRunning: boolean;
  onRun: () => void;
  onCancel: () => void;
  runDisabled: boolean;
};

export function VariantsTreeBuilderModal(props: Props) {
  const { t } = useTranslation();
  const {
    opened,
    onClose,
    dbType,
    setDbType,
    localDbLabel,
    treeBuilderMode,
    setTreeBuilderMode,
    engineOptions,
    selectedEngineValue,
    setSelectedEngineValue,
    treeBuilderEngineMs,
    setTreeBuilderEngineMs,
    treeBuilderCoverage,
    setTreeBuilderCoverage,
    treeBuilderMinMoves,
    setTreeBuilderMinMoves,
    treeBuilderDepth,
    setTreeBuilderDepth,
    treeBuilderRunning,
    onRun,
    onCancel,
    runDisabled,
  } = props;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("features.board.variants.treeBuilder.title")}
      centered
      size="lg"
    >
      <Stack gap="md">
        <Stack gap="xs">
          <Text size="sm">{t("features.board.variants.treeBuilder.syncHint")}</Text>
          <SegmentedControl
            data={[
              { label: t("features.board.database.local"), value: "local" },
              { label: t("features.board.database.lichessAll"), value: "lch_all" },
              { label: t("features.board.database.lichessMaster"), value: "lch_master" },
            ]}
            value={dbType}
            onChange={(value) => setDbType(value as "local" | "lch_all" | "lch_master")}
            fullWidth
          />
          {dbType === "local" && (
            <Text size="xs" c="dimmed">
              {t("features.board.variants.treeBuilder.localDb")} {localDbLabel || "-"}
            </Text>
          )}
        </Stack>

        <Stack gap="xs">
          <Text size="sm">{t("features.board.variants.treeBuilder.mode")}</Text>
          <SegmentedControl
            data={[
              { label: t("features.board.variants.treeBuilder.engine"), value: "engine" },
              { label: t("features.board.variants.treeBuilder.winrate"), value: "winrate" },
            ]}
            value={treeBuilderMode}
            onChange={(value) => setTreeBuilderMode(value as "engine" | "winrate")}
            fullWidth
          />
          {treeBuilderMode === "engine" && (
            <Stack gap="xs">
              <Select
                data={engineOptions}
                value={selectedEngineValue}
                onChange={setSelectedEngineValue}
                placeholder={t("features.board.variants.treeBuilder.engineSelect")}
                disabled={!engineOptions.length}
                searchable
              />
              <NumberInput
                label={t("features.board.variants.treeBuilder.engineTime")}
                value={treeBuilderEngineMs}
                onChange={(value) => setTreeBuilderEngineMs(Number(value) || 0)}
                min={1}
              />
            </Stack>
          )}
        </Stack>

        <Stack gap="xs">
          <Text size="sm">{t("features.board.variants.treeBuilder.dbMoves")}</Text>
          <Group grow>
            <NumberInput
              label={t("features.board.variants.treeBuilder.coverage")}
              value={treeBuilderCoverage}
              onChange={(value) => setTreeBuilderCoverage(Number(value) || 0)}
              min={1}
              max={100}
            />
            <NumberInput
              label={t("features.board.variants.treeBuilder.minMoves")}
              value={treeBuilderMinMoves}
              onChange={(value) => setTreeBuilderMinMoves(Number(value) || 0)}
              min={1}
            />
          </Group>
        </Stack>

        <NumberInput
          label={t("features.board.variants.treeBuilder.depth")}
          value={treeBuilderDepth}
          onChange={(value) => setTreeBuilderDepth(Number(value) || 0)}
          min={1}
        />

        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            {t("features.board.variants.treeBuilder.sideNote")}
          </Text>
          <Button
            onClick={() => {
              if (treeBuilderRunning) {
                onCancel();
              } else {
                onClose();
                onRun();
              }
            }}
            disabled={runDisabled}
          >
            {treeBuilderRunning ? t("common.cancel") : t("features.board.variants.treeBuilder.run")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

