import { Divider, Grid, Paper, ScrollArea, Stack, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import type { Platform } from "@tauri-apps/plugin-os";
import { useAtom } from "jotai";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { commands } from "@/bindings";
import ChallengeHistory from "@/components/ChallengeHistory";
import GameNotation from "@/components/GameNotation";
import MoveControls from "@/components/MoveControls";
import { TreeStateContext } from "@/components/TreeStateContext";
import { usePuzzleDatabase, usePuzzleSession } from "@/features/boards/hooks";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import {
  hidePuzzleRatingAtom,
  inOrderPuzzlesAtom,
  jumpToNextPuzzleAtom,
  progressivePuzzlesAtom,
  puzzlePlayerRatingAtom,
} from "@/state/atoms";
import { positionFromFen } from "@/utils/chessops";
import { getAdaptivePuzzleRange, getPuzzleDatabases } from "@/utils/puzzles";
import { AddPuzzle } from "./AddPuzzle";
import PuzzleBoard from "./PuzzleBoard";
import { PuzzleControls } from "./PuzzleControls";
import { PuzzleSettings } from "./PuzzleSettings";
import { PuzzleStatistics } from "./PuzzleStatistics";
import { PuzzleVariantsPanel } from "./PuzzleVariantsPanel";

function Puzzles({ id }: { id: string }) {
  const store = useContext(TreeStateContext);
  if (!store) throw new Error("TreeStateContext not found");
  const reset = useStore(store, (s) => s.reset);
  const { layout } = useResponsiveLayout();
  const isMobileLayout = layout.chessBoard.layoutType === "mobile";
  const [platform, setPlatform] = useState<Platform | null>(() => {
    if (typeof navigator === "undefined") return null;
    return /Android/i.test(navigator.userAgent) ? "android" : null;
  });
  const isAndroid = platform === "android";

  // Custom hooks for state management
  const {
    puzzleDbs,
    setPuzzleDbs,
    selectedDb,
    setSelectedDb,
    ratingRange,
    setRatingRange,
    dbRatingRange,
    minRating,
    maxRating,
    generatePuzzle: generatePuzzleFromDb,
    clearPuzzleCache,
  } = usePuzzleDatabase();

  const { t } = useTranslation();
  const [addPuzzleModalOpened, setAddPuzzleModalOpened] = useState(false);

  const { puzzles, currentPuzzle, changeCompletion, addPuzzle, clearSession, selectPuzzle } = usePuzzleSession(id);

  // Local state
  const [progressive, setProgressive] = useAtom(progressivePuzzlesAtom);
  const [hideRating, setHideRating] = useAtom(hidePuzzleRatingAtom);
  const [inOrder, setInOrder] = useAtom(inOrderPuzzlesAtom);
  const [jumpToNext, setJumpToNext] = useAtom(jumpToNextPuzzleAtom);
  const [playerRating] = useAtom(puzzlePlayerRatingAtom);

  const [showingSolution, setShowingSolution] = useState(false);
  const isShowingSolutionRef = useRef<boolean>(false);
  const [isGeneratingPuzzle, setIsGeneratingPuzzle] = useState(false);

  // Filter states
  const [hasThemes, setHasThemes] = useState(false);
  const [hasOpeningTags, setHasOpeningTags] = useState(false);
  const [themes, setThemes] = useState<string[]>([]);
  const [openingTags, setOpeningTags] = useState<string[]>([]);
  const [themesOptions, setThemesOptions] = useState<
    Array<{ group: string; items: Array<{ value: string; label: string }> }>
  >([]);
  const [openingTagsOptions, setOpeningTagsOptions] = useState<Array<{ value: string; label: string }>>([]);

  const updateShowingSolution = (isShowing: boolean) => {
    setShowingSolution(isShowing);
    isShowingSolutionRef.current = isShowing;
  };

  // Computed values
  const currentPuzzleData = puzzles?.[currentPuzzle];
  const turnToMove = useMemo(() => {
    if (!currentPuzzleData?.fen) return null;
    return positionFromFen(currentPuzzleData.fen)[0]?.turn ?? null;
  }, [currentPuzzleData?.fen]);

  // Event handlers
  const handleGeneratePuzzle = async () => {
    if (isGeneratingPuzzle) return;
    if (!selectedDb) return;

    let range = ratingRange;
    if (progressive && minRating !== maxRating) {
      range = calculateProgressiveRange();
    }

    setIsGeneratingPuzzle(true);
    try {
      const puzzle = await generatePuzzleFromDb(
        selectedDb,
        range,
        inOrder,
        themes.length > 0 ? themes : undefined,
        openingTags.length > 0 ? openingTags : undefined,
      );
      addPuzzle(puzzle);
    } catch {
    } finally {
      setIsGeneratingPuzzle(false);
    }
  };

  const calculateProgressiveRange = (): [number, number] => {
    const completedResults = puzzles
      .filter((puzzle) => puzzle.completion !== "incomplete")
      .map((puzzle) => puzzle.completion)
      .slice(-10);

    const range = getAdaptivePuzzleRange(playerRating, completedResults);

    // Clamp to database bounds
    let [min, max] = range;
    min = Math.max(minRating, Math.min(min, maxRating));
    max = Math.max(minRating, Math.min(max, maxRating));

    setRatingRange([min, max]);
    return [min, max];
  };

  const handleClearSession = () => {
    clearSession();
    if (selectedDb) {
      clearPuzzleCache(selectedDb);
    }
    reset();
  };

  const handleSelectPuzzle = (index: number) => {
    updateShowingSolution(false);
    selectPuzzle(index);
  };

  const handleDatabaseChange = (value: string | null) => {
    setSelectedDb(value);
    // Reset filters when database changes
    setThemes([]);
    setOpeningTags([]);
  };

  const handleAddNew = useCallback(() => {
    setAddPuzzleModalOpened(true);
  }, []);

  const handleDeletePuzzle = useCallback(
    (dbPath: string) => {
      modals.openConfirmModal({
        title: t("features.databases.delete.title"),
        withCloseButton: false,
        children: (
          <>
            <Text>{t("features.databases.delete.message")}</Text>
            <Text>{t("common.cannotUndo")}</Text>
          </>
        ),
        labels: { confirm: t("common.remove"), cancel: t("common.cancel") },
        confirmProps: { color: "red" },
        onConfirm: async () => {
          // Optimistic update: remove the puzzle database from the list immediately
          setPuzzleDbs((prev) => prev.filter((db) => db.path !== dbPath));
          // If the deleted puzzle database was selected, clear the selection
          if (selectedDb === dbPath) {
            setSelectedDb(null);
          }
          // Delete the file in the background
          commands.deleteDatabase(dbPath).catch((_error) => {
            // If it fails, reload the list to restore state
            getPuzzleDatabases().then((updatedPuzzleDbs) => {
              setPuzzleDbs(updatedPuzzleDbs);
            });
          });
          // Reload the list in the background to sync
          getPuzzleDatabases()
            .then((updatedPuzzleDbs) => {
              setPuzzleDbs(updatedPuzzleDbs);
            })
            .catch(() => {});
          // Notify other components
          window.dispatchEvent(new Event("puzzles:updated"));
        },
      });
    },
    [selectedDb, setSelectedDb, setPuzzleDbs, t],
  );

  // Load database column info and distinct values when database changes
  useEffect(() => {
    if (!selectedDb || !selectedDb.endsWith(".db3")) {
      setHasThemes(false);
      setHasOpeningTags(false);
      setThemesOptions([]);
      setOpeningTagsOptions([]);
      return;
    }

    // Reset immediately so we don't show stale filters from the previously selected database
    // while the new database metadata is loading.
    setHasThemes(false);
    setHasOpeningTags(false);
    setThemesOptions([]);
    setOpeningTagsOptions([]);

    // Use a flag to prevent multiple simultaneous loads
    let cancelled = false;

    const loadDatabaseInfo = async () => {
      try {
        // First verify the file exists before attempting to load info
        const { exists } = await import("@tauri-apps/plugin-fs");
        const { appDataDir, resolve } = await import("@tauri-apps/api/path");
        // `selectedDb` is usually stored as an absolute path; but older state can still hold
        // just the filename. Handle both.
        let dbPath = selectedDb;
        const looksLikePath = dbPath.includes("/") || dbPath.includes("\\") || dbPath.includes(":");
        if (!looksLikePath) {
          const appDataDirPath = await appDataDir();
          dbPath = await resolve(appDataDirPath, "puzzles", dbPath);
        }

        const fileExists = await exists(dbPath);
        if (!fileExists) {
          setHasThemes(false);
          setHasOpeningTags(false);
          setThemesOptions([]);
          setOpeningTagsOptions([]);
          return;
        }

        // Check schema first; only fetch distinct values when those columns exist.
        const columnsResult = await commands.checkPuzzleDbColumns(dbPath).catch((err) => {
          // Silently handle "file not found" or "file is empty" errors
          const errorMsg = err instanceof Error ? err.message : String(err);
          if (errorMsg.includes("does not exist") || errorMsg.includes("is empty")) {
            return { status: "error" as const, error: errorMsg };
          }
          throw err;
        });

        if (cancelled) return;

        if (columnsResult.status === "ok") {
          const [hasThemesCol, hasOpeningTagsCol] = columnsResult.data;

          const [themesResult, tagsResult] = await Promise.all([
            hasThemesCol
              ? commands.getPuzzleThemes(dbPath).catch(() => ({ status: "error" as const, error: "" }))
              : Promise.resolve({ status: "ok" as const, data: [] }),
            hasOpeningTagsCol
              ? commands.getPuzzleOpeningTags(dbPath).catch(() => ({ status: "error" as const, error: "" }))
              : Promise.resolve({ status: "ok" as const, data: [] }),
          ]);

          if (cancelled) return;

          if (hasThemesCol && themesResult.status === "ok") {
            // Backend returns ThemeGroup[] with group and items, convert to format for MultiSelect
            const themesData = themesResult.data as unknown as Array<{
              group: string;
              items: Array<{ value: string; label: string }>;
            }>;
            const nextThemeOptions = themesData
              .map((group) => ({
                group: group.group,
                items: group.items.map((opt) => ({
                  value: opt.value,
                  label: opt.label,
                })),
              }))
              .filter((group) => group.items.length > 0);
            setThemesOptions(nextThemeOptions);
            setHasThemes(nextThemeOptions.length > 0);
          } else {
            setThemesOptions([]);
            setHasThemes(false);
          }

          if (hasOpeningTagsCol && tagsResult.status === "ok") {
            // Backend returns OpeningTagOption[] with value and label, convert to format for MultiSelect
            const tagsData = tagsResult.data as unknown as Array<{ value: string; label: string }>;
            const nextOpeningTagOptions = tagsData.map((opt) => ({
              value: opt.value,
              label: opt.label,
            }));
            setOpeningTagsOptions(nextOpeningTagOptions);
            setHasOpeningTags(nextOpeningTagOptions.length > 0);
          } else {
            setOpeningTagsOptions([]);
            setHasOpeningTags(false);
          }
        } else {
          // Database doesn't exist or is empty - silently handle this
          setHasThemes(false);
          setHasOpeningTags(false);
          setThemesOptions([]);
          setOpeningTagsOptions([]);
        }
      } catch (_error) {
        if (!cancelled) {
          setHasThemes(false);
          setHasOpeningTags(false);
          setThemesOptions([]);
          setOpeningTagsOptions([]);
        }
      }
    };

    loadDatabaseInfo();

    return () => {
      cancelled = true;
    };
  }, [selectedDb]);

  useEffect(() => {
    let cancelled = false;
    void import("@tauri-apps/plugin-os")
      .then((m) => m.platform())
      .then((p) => {
        if (!cancelled) setPlatform(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Android-only responsive fix:
  // The 3-column Grid stacks into multiple full-height sections on small screens, making the lower panels unreachable.
  if (isMobileLayout && isAndroid) {
    return (
      <>
        <ScrollArea h="100%" offsetScrollbars>
          <Stack
            gap="md"
            p="md"
            style={{ paddingBottom: "calc(var(--mantine-spacing-md) + env(safe-area-inset-bottom, 0px))" }}
          >
            <PuzzleBoard
              key={currentPuzzle}
              puzzles={puzzles}
              currentPuzzle={currentPuzzle}
              changeCompletion={changeCompletion}
              generatePuzzle={handleGeneratePuzzle}
              db={selectedDb}
              jumpToNext={jumpToNext}
            />

            <Paper withBorder p="md">
              <PuzzleSettings
                puzzleDbs={puzzleDbs}
                selectedDb={selectedDb}
                onDatabaseChange={handleDatabaseChange}
                onAddNew={handleAddNew}
                onDelete={handleDeletePuzzle}
                ratingRange={ratingRange}
                onRatingRangeChange={setRatingRange}
                minRating={minRating}
                maxRating={maxRating}
                dbRatingRange={dbRatingRange}
                progressive={progressive}
                onProgressiveChange={setProgressive}
                hideRating={hideRating}
                onHideRatingChange={setHideRating}
                inOrder={inOrder}
                onInOrderChange={setInOrder}
                hasThemes={hasThemes}
                themes={themes}
                themesOptions={themesOptions}
                onThemesChange={setThemes}
                hasOpeningTags={hasOpeningTags}
                openingTags={openingTags}
                openingTagsOptions={openingTagsOptions}
                onOpeningTagsChange={setOpeningTags}
              />
              <Divider my="sm" />

              <PuzzleControls
                selectedDb={selectedDb}
                onGeneratePuzzle={handleGeneratePuzzle}
                generatingPuzzle={isGeneratingPuzzle}
                onClearSession={handleClearSession}
                changeCompletion={changeCompletion}
                currentPuzzle={currentPuzzleData}
                puzzles={puzzles}
                jumpToNext={jumpToNext}
                onJumpToNextChange={setJumpToNext}
                turnToMove={turnToMove}
                showingSolution={showingSolution}
                updateShowingSolution={updateShowingSolution}
                isShowingSolutionRef={isShowingSolutionRef}
              />
              <Divider my="sm" />

              <PuzzleStatistics currentPuzzle={currentPuzzleData} />
            </Paper>

            <Paper withBorder p="md">
              <PuzzleVariantsPanel selectedDb={selectedDb} />
              <Divider my="sm" />

              <ChallengeHistory
                challenges={puzzles.map((p) => ({
                  ...p,
                  label: p.rating.toString(),
                }))}
                current={currentPuzzle}
                select={handleSelectPuzzle}
              />
              <Divider my="sm" />

              <GameNotation initialVariationState="variations" />
              <MoveControls readOnly />
            </Paper>
          </Stack>
        </ScrollArea>

        <AddPuzzle
          puzzleDbs={puzzleDbs}
          opened={addPuzzleModalOpened}
          setOpened={setAddPuzzleModalOpened}
          setPuzzleDbs={setPuzzleDbs}
        />
      </>
    );
  }

  return (
    <>
      <Grid h="100%" gutter="md" style={{ flex: 1, minHeight: 0 }}>
        <Grid.Col span={{ base: 12, md: 3 }} style={{ minHeight: 0, display: "flex" }}>
          <Paper h="100%" w="100%" withBorder p="md" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            <ScrollArea h="100%" offsetScrollbars>
              <PuzzleSettings
                puzzleDbs={puzzleDbs}
                selectedDb={selectedDb}
                onDatabaseChange={handleDatabaseChange}
                onAddNew={handleAddNew}
                onDelete={handleDeletePuzzle}
                ratingRange={ratingRange}
                onRatingRangeChange={setRatingRange}
                minRating={minRating}
                maxRating={maxRating}
                dbRatingRange={dbRatingRange}
                progressive={progressive}
                onProgressiveChange={setProgressive}
                hideRating={hideRating}
                onHideRatingChange={setHideRating}
                inOrder={inOrder}
                onInOrderChange={setInOrder}
                hasThemes={hasThemes}
                themes={themes}
                themesOptions={themesOptions}
                onThemesChange={setThemes}
                hasOpeningTags={hasOpeningTags}
                openingTags={openingTags}
                openingTagsOptions={openingTagsOptions}
                onOpeningTagsChange={setOpeningTags}
              />
              <Divider my="sm" />

              <PuzzleControls
                selectedDb={selectedDb}
                onGeneratePuzzle={handleGeneratePuzzle}
                generatingPuzzle={isGeneratingPuzzle}
                onClearSession={handleClearSession}
                changeCompletion={changeCompletion}
                currentPuzzle={currentPuzzleData}
                puzzles={puzzles}
                jumpToNext={jumpToNext}
                onJumpToNextChange={setJumpToNext}
                turnToMove={turnToMove}
                showingSolution={showingSolution}
                updateShowingSolution={updateShowingSolution}
                isShowingSolutionRef={isShowingSolutionRef}
              />
              <Divider my="sm" />

              <PuzzleStatistics currentPuzzle={currentPuzzleData} />
            </ScrollArea>
          </Paper>
        </Grid.Col>

        <Grid.Col
          span={{ base: 12, md: 6 }}
          style={{ minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <PuzzleBoard
            key={currentPuzzle}
            puzzles={puzzles}
            currentPuzzle={currentPuzzle}
            changeCompletion={changeCompletion}
            generatePuzzle={handleGeneratePuzzle}
            db={selectedDb}
            jumpToNext={jumpToNext}
          />
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 3 }} style={{ minHeight: 0, display: "flex" }}>
          <Paper h="100%" w="100%" withBorder p="md" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            <ScrollArea h="100%" offsetScrollbars>
              <PuzzleVariantsPanel selectedDb={selectedDb} />
              <Divider my="sm" />

              <ChallengeHistory
                challenges={puzzles.map((p) => ({
                  ...p,
                  label: p.rating.toString(),
                }))}
                current={currentPuzzle}
                select={handleSelectPuzzle}
              />
              <Divider my="sm" />

              <GameNotation initialVariationState="variations" />
              <MoveControls readOnly />
            </ScrollArea>
          </Paper>
        </Grid.Col>
      </Grid>

      <AddPuzzle
        puzzleDbs={puzzleDbs}
        opened={addPuzzleModalOpened}
        setOpened={setAddPuzzleModalOpened}
        setPuzzleDbs={setPuzzleDbs}
      />
    </>
  );
}

export default Puzzles;
