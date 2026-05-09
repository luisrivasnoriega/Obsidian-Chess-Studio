import { Divider, Grid, Paper, ScrollArea, Stack, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import type { Platform } from "@tauri-apps/plugin-os";
import { useAtom } from "jotai";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { commands, getPuzzleDependentFiltersMetadata, getPuzzleFiltersMetadata } from "@/bindings";
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
  puzzleAdaptiveOffsetAtom,
  puzzlePlayerRatingAtom,
  puzzleSideToMoveAtom,
  puzzleUnsolvedOnlyDbAtom,
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
    isLoadingPuzzleDbs,
    setPuzzleDbs,
    selectedDb,
    setSelectedDb,
    setRatingRange,
    minRating,
    maxRating,
    generatePuzzle: generatePuzzleFromDb,
    clearPuzzleCache,
  } = usePuzzleDatabase();

  const { t } = useTranslation();
  const [addPuzzleModalOpened, setAddPuzzleModalOpened] = useState(false);

  const { puzzles, currentPuzzle, changeCompletion, addPuzzle, clearSession, selectPuzzle } = usePuzzleSession(id);

  // Local state
  const [adaptiveOffset, setAdaptiveOffset] = useAtom(puzzleAdaptiveOffsetAtom);
  const [hideRating, setHideRating] = useAtom(hidePuzzleRatingAtom);
  const [inOrder, setInOrder] = useAtom(inOrderPuzzlesAtom);
  const [jumpToNext, setJumpToNext] = useAtom(jumpToNextPuzzleAtom);
  const [puzzleUnsolvedOnlyDb, setPuzzleUnsolvedOnlyDb] = useAtom(puzzleUnsolvedOnlyDbAtom);
  const [playerRating] = useAtom(puzzlePlayerRatingAtom);
  const [puzzleSideToMove, setPuzzleSideToMove] = useAtom(puzzleSideToMoveAtom);

  const [showingSolution, setShowingSolution] = useState(false);
  const isShowingSolutionRef = useRef<boolean>(false);
  const autoStartedPuzzleVariantDbRef = useRef<string | null>(null);
  const [isGeneratingPuzzle, setIsGeneratingPuzzle] = useState(false);
  const [isLoadingFilterOptions, setIsLoadingFilterOptions] = useState(false);
  const [selectedDbIsPuzzleVariants, setSelectedDbIsPuzzleVariants] = useState(false);

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
  const isSolvingPuzzleVariants = Boolean(
    selectedDb && selectedDbIsPuzzleVariants && puzzleUnsolvedOnlyDb === selectedDb,
  );
  const turnToMove = useMemo(() => {
    if (!currentPuzzleData?.fen) return null;
    return positionFromFen(currentPuzzleData.fen)[0]?.turn ?? null;
  }, [currentPuzzleData?.fen]);

  useEffect(() => {
    let cancelled = false;
    const loadPuzzleVariantFlag = async () => {
      if (!selectedDb?.toLowerCase().endsWith(".pgn")) {
        setSelectedDbIsPuzzleVariants(false);
        return;
      }
      try {
        const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
        const metadataPath = selectedDb.replace(/\.pgn$/i, ".info");
        if (!(await exists(metadataPath))) {
          if (!cancelled) setSelectedDbIsPuzzleVariants(false);
          return;
        }
        const raw = await readTextFile(metadataPath);
        const metadata = JSON.parse(raw) as { type?: string; tags?: unknown };
        const tags = Array.isArray(metadata.tags)
          ? metadata.tags.filter((tag): tag is string => typeof tag === "string")
          : [];
        if (!cancelled) {
          setSelectedDbIsPuzzleVariants(metadata.type === "puzzle" && tags.includes("puzzle-variants"));
        }
      } catch {
        if (!cancelled) setSelectedDbIsPuzzleVariants(false);
      }
    };
    void loadPuzzleVariantFlag();
    return () => {
      cancelled = true;
    };
  }, [selectedDb]);

  const challengeItems = useMemo(
    () =>
      puzzles
        .map((p, index) => ({
          ...p,
          index,
          label: selectedDbIsPuzzleVariants ? undefined : p.rating.toString(),
        }))
        .filter((p) => p.completion !== "incomplete")
        .slice(-10),
    [puzzles, selectedDbIsPuzzleVariants],
  );

  const calculateAdaptiveRange = useCallback((): [number, number] => {
    const completedResults = puzzles
      .filter((puzzle) => puzzle.completion !== "incomplete")
      .map((puzzle) => puzzle.completion)
      .slice(-10);

    const safePlayerRating = Number.isFinite(playerRating) ? playerRating : 1500;
    const targetRating = safePlayerRating + adaptiveOffset;
    const range = getAdaptivePuzzleRange(targetRating, completedResults);

    // Clamp to database bounds
    let [min, max] = range;
    min = Math.max(minRating, Math.min(min, maxRating));
    max = Math.max(minRating, Math.min(max, maxRating));

    setRatingRange([min, max]);
    return [min, max];
  }, [adaptiveOffset, maxRating, minRating, playerRating, puzzles, setRatingRange]);

  // Event handlers
  const handleGeneratePuzzle = useCallback(async (): Promise<boolean> => {
    if (isGeneratingPuzzle) return false;
    if (!selectedDb) return false;

    const range = calculateAdaptiveRange();
    const effectiveSideToMove = selectedDbIsPuzzleVariants ? "any" : puzzleSideToMove;

    setIsGeneratingPuzzle(true);
    try {
      const puzzle = await generatePuzzleFromDb(
        selectedDb,
        range,
        inOrder,
        themes.length > 0 ? themes : undefined,
        openingTags.length > 0 ? openingTags : undefined,
        effectiveSideToMove,
      );
      addPuzzle(puzzle);
      return true;
    } catch {
      return false;
    } finally {
      setIsGeneratingPuzzle(false);
    }
  }, [
    addPuzzle,
    calculateAdaptiveRange,
    generatePuzzleFromDb,
    inOrder,
    isGeneratingPuzzle,
    openingTags,
    puzzleSideToMove,
    selectedDb,
    selectedDbIsPuzzleVariants,
    themes,
  ]);

  const handleSideToMoveChange = (value: "any" | "white" | "black") => {
    setPuzzleSideToMove(value);
    if (selectedDb) {
      clearPuzzleCache(selectedDb);
    }
  };

  useEffect(() => {
    autoStartedPuzzleVariantDbRef.current = null;
  }, []);

  useEffect(() => {
    if (!selectedDb || !isSolvingPuzzleVariants || isGeneratingPuzzle || isLoadingPuzzleDbs) return;

    const currentPuzzleSourcePath = currentPuzzleData?.source?.path ?? null;
    if (currentPuzzleSourcePath === selectedDb && currentPuzzleData?.completion === "incomplete") {
      autoStartedPuzzleVariantDbRef.current = selectedDb;
      return;
    }

    if (autoStartedPuzzleVariantDbRef.current === selectedDb) return;
    void handleGeneratePuzzle().finally(() => {
      autoStartedPuzzleVariantDbRef.current = selectedDb;
    });
  }, [
    currentPuzzleData?.completion,
    currentPuzzleData?.source?.path,
    handleGeneratePuzzle,
    isGeneratingPuzzle,
    isLoadingPuzzleDbs,
    isSolvingPuzzleVariants,
    selectedDb,
  ]);

  const getCurrentAdaptiveRange = useCallback((): [number, number] => {
    const completedResults = puzzles
      .filter((puzzle) => puzzle.completion !== "incomplete")
      .map((puzzle) => puzzle.completion)
      .slice(-10);

    const safePlayerRating = Number.isFinite(playerRating) ? playerRating : 1500;
    const targetRating = safePlayerRating + adaptiveOffset;
    const range = getAdaptivePuzzleRange(targetRating, completedResults);

    // Clamp to current active bounds.
    let [min, max] = range;
    min = Math.max(minRating, Math.min(min, maxRating));
    max = Math.max(minRating, Math.min(max, maxRating));
    return [min, max];
  }, [adaptiveOffset, maxRating, minRating, playerRating, puzzles]);

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
    if (!value || puzzleUnsolvedOnlyDb !== value) {
      setPuzzleUnsolvedOnlyDb(null);
    }
    // Reset filters when database changes
    setThemes([]);
    setOpeningTags([]);
  };

  useEffect(() => {
    if (!selectedDb || !puzzleUnsolvedOnlyDb) return;
    if (selectedDb !== puzzleUnsolvedOnlyDb) {
      setPuzzleUnsolvedOnlyDb(null);
    }
  }, [puzzleUnsolvedOnlyDb, selectedDb, setPuzzleUnsolvedOnlyDb]);

  const handleAdaptiveOffsetChange = (value: number) => {
    setAdaptiveOffset(value);
    if (selectedDb) {
      clearPuzzleCache(selectedDb);
    }
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
            getPuzzleDatabases(true).then((updatedPuzzleDbs) => {
              setPuzzleDbs(updatedPuzzleDbs);
            });
          });
          // Reload the list in the background to sync
          getPuzzleDatabases(true)
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

  // Load puzzle filter metadata (columns, options, rating range) when database changes.
  useEffect(() => {
    if (!selectedDb?.endsWith(".db3")) {
      setIsLoadingFilterOptions(false);
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
    setIsLoadingFilterOptions(true);

    // Use a flag to prevent multiple simultaneous loads
    let cancelled = false;

    const loadDatabaseInfo = async () => {
      try {
        // Normalize path for older persisted values that only stored file names.
        const { appDataDir, resolve } = await import("@tauri-apps/api/path");
        let dbPath = selectedDb;
        const looksLikePath = dbPath.includes("/") || dbPath.includes("\\") || dbPath.includes(":");
        if (!looksLikePath) {
          const appDataDirPath = await appDataDir();
          dbPath = await resolve(appDataDirPath, "puzzles", dbPath);
        }

        const metadataResult = await getPuzzleFiltersMetadata(dbPath);
        if (metadataResult.status === "error") {
          throw new Error(metadataResult.error);
        }
        const metadata = metadataResult.data;
        if (cancelled) return;

        const nextThemeOptions = (metadata.themes ?? [])
          .map((group) => ({
            group: group.group,
            items: (group.items ?? []).map((opt) => ({
              value: opt.value,
              label: opt.label,
            })),
          }))
          .filter((group) => group.items.length > 0);

        const nextOpeningTagOptions = (metadata.openingTags ?? []).map((opt) => ({
          value: opt.value,
          label: opt.label,
        }));

        setThemesOptions(nextThemeOptions);
        setOpeningTagsOptions(nextOpeningTagOptions);
        setHasThemes(Boolean(metadata.hasThemes) && nextThemeOptions.length > 0);
        setHasOpeningTags(Boolean(metadata.hasOpeningTags) && nextOpeningTagOptions.length > 0);

        if (metadata.ratingRange) {
          setRatingRange(metadata.ratingRange);
        }
      } catch (_error) {
        if (!cancelled) {
          setHasThemes(false);
          setHasOpeningTags(false);
          setThemesOptions([]);
          setOpeningTagsOptions([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingFilterOptions(false);
        }
      }
    };

    loadDatabaseInfo();

    return () => {
      cancelled = true;
    };
  }, [selectedDb, setRatingRange]);

  // Dependent filters:
  // - openingTags options depend on active themes + adaptive rating range
  // - themes options depend on active openingTags + adaptive rating range
  useEffect(() => {
    if (!selectedDb?.endsWith(".db3")) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      const loadDependentFilters = async () => {
        try {
          setIsLoadingFilterOptions(true);

          const { appDataDir, resolve } = await import("@tauri-apps/api/path");
          let dbPath = selectedDb;
          const looksLikePath = dbPath.includes("/") || dbPath.includes("\\") || dbPath.includes(":");
          if (!looksLikePath) {
            const appDataDirPath = await appDataDir();
            dbPath = await resolve(appDataDirPath, "puzzles", dbPath);
          }

          const [adaptiveMin, adaptiveMax] = getCurrentAdaptiveRange();
          const result = await getPuzzleDependentFiltersMetadata(
            dbPath,
            adaptiveMin,
            adaptiveMax,
            themes.length > 0 ? themes : null,
            openingTags.length > 0 ? openingTags : null,
            puzzleSideToMove === "any" ? null : puzzleSideToMove,
          );
          if (cancelled || result.status === "error") return;

          const metadata = result.data;
          const nextThemeOptions = (metadata.themes ?? [])
            .map((group) => ({
              group: group.group,
              items: (group.items ?? []).map((opt) => ({
                value: opt.value,
                label: opt.label,
              })),
            }))
            .filter((group) => group.items.length > 0);
          const nextOpeningTagOptions = (metadata.openingTags ?? []).map((opt) => ({
            value: opt.value,
            label: opt.label,
          }));

          setThemesOptions(nextThemeOptions);
          setOpeningTagsOptions(nextOpeningTagOptions);
          setHasThemes(Boolean(metadata.hasThemes) && nextThemeOptions.length > 0);
          setHasOpeningTags(Boolean(metadata.hasOpeningTags) && nextOpeningTagOptions.length > 0);

          // Keep selected filters valid against dependent option lists.
          const validThemes = new Set(nextThemeOptions.flatMap((group) => group.items.map((item) => item.value)));
          const validOpeningTags = new Set(nextOpeningTagOptions.map((item) => item.value));
          setThemes((prev) => {
            const next = prev.filter((value) => validThemes.has(value));
            if (next.length === prev.length && next.every((value, index) => value === prev[index])) {
              return prev;
            }
            return next;
          });
          setOpeningTags((prev) => {
            const next = prev.filter((value) => validOpeningTags.has(value));
            if (next.length === prev.length && next.every((value, index) => value === prev[index])) {
              return prev;
            }
            return next;
          });
        } catch {
          if (!cancelled) {
            setThemesOptions([]);
            setOpeningTagsOptions([]);
            setHasThemes(false);
            setHasOpeningTags(false);
          }
        } finally {
          if (!cancelled) {
            setIsLoadingFilterOptions(false);
          }
        }
      };

      void loadDependentFilters();
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedDb, themes, openingTags, puzzleSideToMove, getCurrentAdaptiveRange]);

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
              applyRating={!selectedDbIsPuzzleVariants}
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
                loadingDatabases={isLoadingPuzzleDbs}
                loadingFilters={isLoadingFilterOptions}
                adaptiveOffset={adaptiveOffset}
                onAdaptiveOffsetChange={handleAdaptiveOffsetChange}
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
                sideToMove={puzzleSideToMove}
                onSideToMoveChange={handleSideToMoveChange}
                isPuzzleVariantsMode={selectedDbIsPuzzleVariants}
              />
              <Divider my="sm" />

              <PuzzleControls
                selectedDb={selectedDb}
                onGeneratePuzzle={handleGeneratePuzzle}
                generatingPuzzle={isGeneratingPuzzle}
                onClearSession={handleClearSession}
                changeCompletion={changeCompletion}
                applyRating={!selectedDbIsPuzzleVariants}
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

              {!selectedDbIsPuzzleVariants ? <PuzzleStatistics currentPuzzle={currentPuzzleData} /> : null}
            </Paper>

            <Paper withBorder p="md">
              <PuzzleVariantsPanel selectedDb={selectedDb} sessionPuzzles={puzzles} />
              <Divider my="sm" />

              <ChallengeHistory
                challenges={challengeItems}
                current={currentPuzzle}
                select={handleSelectPuzzle}
                maxItems={10}
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
      <Grid h="100%" gap="md" style={{ flex: 1, minHeight: 0 }}>
        <Grid.Col span={{ base: 12, md: 3 }} style={{ minHeight: 0, display: "flex" }}>
          <Paper h="100%" w="100%" withBorder p="md" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            <ScrollArea h="100%" offsetScrollbars>
              <PuzzleSettings
                puzzleDbs={puzzleDbs}
                selectedDb={selectedDb}
                onDatabaseChange={handleDatabaseChange}
                onAddNew={handleAddNew}
                onDelete={handleDeletePuzzle}
                loadingDatabases={isLoadingPuzzleDbs}
                loadingFilters={isLoadingFilterOptions}
                adaptiveOffset={adaptiveOffset}
                onAdaptiveOffsetChange={handleAdaptiveOffsetChange}
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
                sideToMove={puzzleSideToMove}
                onSideToMoveChange={handleSideToMoveChange}
                isPuzzleVariantsMode={selectedDbIsPuzzleVariants}
              />
              <Divider my="sm" />

              <PuzzleControls
                selectedDb={selectedDb}
                onGeneratePuzzle={handleGeneratePuzzle}
                generatingPuzzle={isGeneratingPuzzle}
                onClearSession={handleClearSession}
                changeCompletion={changeCompletion}
                applyRating={!selectedDbIsPuzzleVariants}
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

              {!selectedDbIsPuzzleVariants ? <PuzzleStatistics currentPuzzle={currentPuzzleData} /> : null}
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
            applyRating={!selectedDbIsPuzzleVariants}
            generatePuzzle={handleGeneratePuzzle}
            db={selectedDb}
            jumpToNext={jumpToNext}
          />
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 3 }} style={{ minHeight: 0, display: "flex" }}>
          <Paper h="100%" w="100%" withBorder p="md" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            <ScrollArea h="100%" offsetScrollbars>
              <PuzzleVariantsPanel selectedDb={selectedDb} sessionPuzzles={puzzles} />
              <Divider my="sm" />

              <ChallengeHistory
                challenges={challengeItems}
                current={currentPuzzle}
                select={handleSelectPuzzle}
                maxItems={10}
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
