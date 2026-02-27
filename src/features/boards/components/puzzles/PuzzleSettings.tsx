import { ActionIcon, Center, Checkbox, Divider, Group, Input, MultiSelect, RangeSlider, Select } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { PuzzleDatabaseInfo } from "@/bindings";

interface PuzzleSettingsProps {
  puzzleDbs: PuzzleDatabaseInfo[];
  selectedDb: string | null;
  onDatabaseChange: (value: string | null) => void;
  onAddNew: () => void;
  onDelete: (dbPath: string) => void;
  ratingRange: [number, number];
  onRatingRangeChange: (value: [number, number]) => void;
  minRating: number;
  maxRating: number;
  dbRatingRange: [number, number] | null;
  progressive: boolean;
  onProgressiveChange: (value: boolean) => void;
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
}

export const PuzzleSettings = ({
  puzzleDbs,
  selectedDb,
  onDatabaseChange,
  onAddNew,
  onDelete,
  ratingRange,
  onRatingRangeChange,
  minRating,
  maxRating,
  dbRatingRange,
  progressive,
  onProgressiveChange,
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
}: PuzzleSettingsProps) => {
  const { t } = useTranslation();

  const isProgressiveDisabled = !dbRatingRange || (dbRatingRange && dbRatingRange[0] === dbRatingRange[1]);
  const isProgressiveChecked = dbRatingRange && dbRatingRange[0] === dbRatingRange[1] ? false : progressive;
  const showThemeFilters = hasThemes || hasOpeningTags;
  const hasUsefulRatingRange = Boolean(dbRatingRange && dbRatingRange[0] !== dbRatingRange[1]);
  const showRatingOptions = hasUsefulRatingRange;
  const showAdvancedOptions = Boolean(selectedDb) && (showThemeFilters || showRatingOptions);

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
          {showThemeFilters && showRatingOptions && <Divider my="sm" />}
          {showRatingOptions && (
            <Group>
              <Input.Wrapper label={t("features.puzzle.ratingRange")} flex={1}>
                <RangeSlider
                  min={minRating}
                  max={maxRating}
                  value={ratingRange}
                  onChange={onRatingRangeChange}
                  disabled={progressive || !dbRatingRange || (dbRatingRange && dbRatingRange[0] === dbRatingRange[1])}
                />
                {!dbRatingRange && selectedDb && (
                  <div style={{ fontSize: "0.75rem", color: "var(--mantine-color-dimmed)", marginTop: "4px" }}>
                    {t("features.puzzle.loadingRatingRange")}
                  </div>
                )}
              </Input.Wrapper>
              <Input.Wrapper label={t("features.puzzle.progressive")}>
                <Center>
                  <Checkbox
                    checked={isProgressiveChecked}
                    onChange={(event) => onProgressiveChange(event.currentTarget.checked)}
                    disabled={isProgressiveDisabled}
                  />
                </Center>
              </Input.Wrapper>
              <Input.Wrapper label={t("features.puzzle.hideRating")}>
                <Center>
                  <Checkbox
                    checked={hideRating}
                    onChange={(event) => onHideRatingChange(event.currentTarget.checked)}
                  />
                </Center>
              </Input.Wrapper>
              <Input.Wrapper label={t("features.puzzle.inOrder")}>
                <Center>
                  <Checkbox checked={inOrder} onChange={(event) => onInOrderChange(event.currentTarget.checked)} />
                </Center>
              </Input.Wrapper>
            </Group>
          )}
        </>
      )}
    </>
  );
};
