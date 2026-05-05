import {
  ActionIcon,
  Center,
  Checkbox,
  Divider,
  Group,
  Input,
  Loader,
  MultiSelect,
  NumberInput,
  Select,
} from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { PuzzleDatabaseInfo } from "@/bindings";

interface PuzzleSettingsProps {
  puzzleDbs: PuzzleDatabaseInfo[];
  selectedDb: string | null;
  onDatabaseChange: (value: string | null) => void;
  onAddNew: () => void;
  onDelete: (dbPath: string) => void;
  loadingDatabases: boolean;
  loadingFilters: boolean;
  adaptiveOffset: number;
  onAdaptiveOffsetChange: (value: number) => void;
  hideRating: boolean;
  onHideRatingChange: (value: boolean) => void;
  inOrder: boolean;
  onInOrderChange: (value: boolean) => void;
  hasThemes: boolean;
  themes: string[];
  themesOptions: Array<{ group: string; items: Array<{ value: string; label: string }> }>;
  onThemesChange: (value: string[]) => void;
  hasOpeningTags: boolean;
  openingTags: string[];
  openingTagsOptions: Array<{ value: string; label: string }>;
  onOpeningTagsChange: (value: string[]) => void;
  sideToMove: "any" | "white" | "black";
  onSideToMoveChange: (value: "any" | "white" | "black") => void;
  isPuzzleVariantsMode?: boolean;
}

export const PuzzleSettings = ({
  puzzleDbs,
  selectedDb,
  onDatabaseChange,
  onAddNew,
  onDelete,
  loadingDatabases,
  loadingFilters,
  adaptiveOffset,
  onAdaptiveOffsetChange,
  hideRating,
  onHideRatingChange,
  inOrder,
  onInOrderChange,
  hasThemes,
  themes,
  themesOptions,
  onThemesChange,
  hasOpeningTags,
  openingTags,
  openingTagsOptions,
  onOpeningTagsChange,
  sideToMove,
  onSideToMoveChange,
  isPuzzleVariantsMode = false,
}: PuzzleSettingsProps) => {
  const { t } = useTranslation();

  const showThemeFilters = hasThemes || hasOpeningTags;
  const showAdvancedOptions = Boolean(selectedDb);

  const handleSelectChange = (value: string | null) => {
    if (value === "add") {
      onAddNew();
    } else {
      onDatabaseChange(value);
    }
  };

  const handleDelete = () => {
    if (selectedDb && selectedDb !== "add") {
      onDelete(selectedDb);
    }
  };

  return (
    <>
      <Group gap="xs" align="flex-end">
        <Select
          flex={1}
          rightSection={loadingDatabases ? <Loader size="xs" /> : undefined}
          disabled={loadingDatabases && puzzleDbs.length === 0}
          data={puzzleDbs
            .map((p) => ({
              label: p.title.split(".db3")[0],
              value: p.path,
            }))
            .concat({ label: `+ ${t("common.addNew")}`, value: "add" })}
          value={selectedDb}
          clearable={false}
          placeholder={t("features.puzzle.selectPuzzle")}
          onChange={handleSelectChange}
        />
        {selectedDb && selectedDb !== "add" && (
          <ActionIcon color="red" variant="subtle" onClick={handleDelete} title={t("common.delete")}>
            <IconX size={16} />
          </ActionIcon>
        )}
      </Group>
      {showAdvancedOptions && (
        <>
          <Divider my="sm" />
          {showThemeFilters && (
            <>
              {hasThemes && (
                <MultiSelect
                  label={t("features.puzzle.themes")}
                  rightSection={loadingFilters ? <Loader size="xs" /> : undefined}
                  disabled={loadingFilters}
                  data={themesOptions}
                  value={themes}
                  onChange={onThemesChange}
                  placeholder={t("features.puzzle.selectThemes")}
                  clearable
                  searchable
                />
              )}
              {hasOpeningTags && (
                <MultiSelect
                  label={t("features.puzzle.openingTags")}
                  rightSection={loadingFilters ? <Loader size="xs" /> : undefined}
                  disabled={loadingFilters}
                  data={openingTagsOptions}
                  value={openingTags}
                  onChange={onOpeningTagsChange}
                  placeholder={t("features.puzzle.selectOpeningTags")}
                  clearable
                  searchable
                />
              )}
            </>
          )}
          {showThemeFilters && <Divider my="sm" />}
          <Group align="end">
            <Select
              label={t("features.puzzle.sideToMove")}
              data={[
                { value: "any", label: t("features.puzzle.sideAny") },
                { value: "white", label: t("features.puzzle.sideWhite") },
                { value: "black", label: t("features.puzzle.sideBlack") },
              ]}
              value={sideToMove}
              onChange={(value) => onSideToMoveChange((value as "any" | "white" | "black") ?? "any")}
              allowDeselect={false}
              flex={1}
            />
            {!isPuzzleVariantsMode ? (
              <>
                <NumberInput
                  label={t("features.puzzle.adaptiveOffset")}
                  value={adaptiveOffset}
                  onChange={(value) =>
                    onAdaptiveOffsetChange(typeof value === "number" && Number.isFinite(value) ? value : 0)
                  }
                  min={-1000}
                  max={1000}
                  step={25}
                  clampBehavior="strict"
                  allowDecimal={false}
                  flex={1}
                />
                <Input.Wrapper label={t("features.puzzle.hideRating")}>
                  <Center>
                    <Checkbox
                      checked={hideRating}
                      onChange={(event) => onHideRatingChange(event.currentTarget.checked)}
                    />
                  </Center>
                </Input.Wrapper>
              </>
            ) : null}
            <Input.Wrapper label={t("features.puzzle.inOrder")}>
              <Center>
                <Checkbox checked={inOrder} onChange={(event) => onInOrderChange(event.currentTarget.checked)} />
              </Center>
            </Input.Wrapper>
          </Group>
        </>
      )}
    </>
  );
};
