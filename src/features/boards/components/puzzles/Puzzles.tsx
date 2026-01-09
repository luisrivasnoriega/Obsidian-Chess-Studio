import { Divider, Grid, Paper, ScrollArea, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useAtom } from "jotai";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useTranslation } from "react-i18next";
import ChallengeHistory from "@/components/ChallengeHistory";
import GameNotation from "@/components/GameNotation";
import MoveControls from "@/components/MoveControls";
import { TreeStateContext } from "@/components/TreeStateContext";
import { usePuzzleDatabase, usePuzzleSession } from "@/features/boards/hooks";
import {
  hidePuzzleRatingAtom,
  inOrderPuzzlesAtom,
  jumpToNextPuzzleAtom,
  progressivePuzzlesAtom,
  puzzlePlayerRatingAtom,
} from "@/state/atoms";
import { commands } from "@/bindings";
import { positionFromFen } from "@/utils/chessops";
import { logger } from "@/utils/logger";
import { getAdaptivePuzzleRange, PUZZLE_DEBUG_LOGS } from "@/utils/puzzles";
import { debugNavLog } from "@/utils/debugNav";
import { unwrap } from "@/utils/unwrap";
import { getPuzzleDatabases } from "@/utils/puzzles";
import PuzzleBoard from "./PuzzleBoard";
import { PuzzleControls } from "./PuzzleControls";
import { PuzzleSettings } from "./PuzzleSettings";
import { PuzzleStatistics } from "./PuzzleStatistics";
import { PuzzleVariantsPanel } from "./PuzzleVariantsPanel";
import { AddPuzzle } from "./AddPuzzle";

function Puzzles({ id }: { id: string }) {
  const store = useContext(TreeStateContext);
  if (!store) throw new Error("TreeStateContext not found");
  const reset = useStore(store, (s) => s.reset);

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

  useEffect(() => {
    debugNavLog("puzzles:mount", { id, selectedDb, puzzleDbs: puzzleDbs.length });
    return () => debugNavLog("puzzles:unmount", { id });
  }, [id, puzzleDbs.length, selectedDb]);

  const { puzzles, currentPuzzle, changeCompletion, addPuzzle, clearSession, selectPuzzle } = usePuzzleSession(id);

  // Local state
  const [progressive, setProgressive] = useAtom(progressivePuzzlesAtom);
  const [hideRating, setHideRating] = useAtom(hidePuzzleRatingAtom);
  const [inOrder, setInOrder] = useAtom(inOrderPuzzlesAtom);
  const [jumpToNext, setJumpToNext] = useAtom(jumpToNextPuzzleAtom);
  const [playerRating] = useAtom(puzzlePlayerRatingAtom);

  const [showingSolution, setShowingSolution] = useState(false);
  const isShowingSolutionRef = useRef<boolean>(false);

  // Filter states
  const [hasThemes, setHasThemes] = useState(false);
  const [hasOpeningTags, setHasOpeningTags] = useState(false);
  const [themes, setThemes] = useState<string[]>([]);
  const [openingTags, setOpeningTags] = useState<string[]>([]);
  const [themesOptions, setThemesOptions] = useState<Array<{ group: string; items: Array<{ value: string; label: string }> }>>([]);
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
    if (!selectedDb) return;

    let range = ratingRange;
    if (progressive && minRating !== maxRating) {
      range = calculateProgressiveRange();
    }

    PUZZLE_DEBUG_LOGS &&
      logger.debug("Generating puzzle:", {
        db: selectedDb,
        range,
        progressive,
        inOrder,
        playerRating,
      });

    try {
      const puzzle = await generatePuzzleFromDb(
        selectedDb,
        range,
        inOrder,
        themes.length > 0 ? themes : undefined,
        openingTags.length > 0 ? openingTags : undefined,
      );
      PUZZLE_DEBUG_LOGS &&
        logger.debug("Generated puzzle:", {
          fen: puzzle.fen,
          rating: puzzle.rating,
          moves: puzzle.moves,
        });
      addPuzzle(puzzle);
    } catch (error) {
      logger.error("Failed to generate puzzle:", error);
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

    PUZZLE_DEBUG_LOGS &&
      logger.debug("Adaptive range calculation:", {
        playerRating,
        recentResults: completedResults,
        originalRange: range,
        clampedRange: [min, max],
        dbBounds: [minRating, maxRating],
      });

    setRatingRange([min, max]);
    return [min, max];
  };

  const handleClearSession = () => {
    PUZZLE_DEBUG_LOGS && logger.debug("Clearing puzzle session");
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
    PUZZLE_DEBUG_LOGS && logger.debug("Database changed:", value);
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
          // Actualización optimista: remover el puzzle de la lista inmediatamente
          setPuzzleDbs((prev) => prev.filter((db) => db.path !== dbPath));
          // Si el puzzle eliminado era el seleccionado, limpiar la selección
          if (selectedDb === dbPath) {
            setSelectedDb(null);
          }
          // Eliminar el archivo en segundo plano
          commands.deleteDatabase(dbPath).catch((error) => {
            logger.error("Failed to delete puzzle database:", error);
            // Si falla, recargar la lista para restaurar el estado
            getPuzzleDatabases().then((updatedPuzzleDbs) => {
              setPuzzleDbs(updatedPuzzleDbs);
            });
          });
          // Recargar la lista en segundo plano para sincronizar
          getPuzzleDatabases()
            .then((updatedPuzzleDbs) => {
              setPuzzleDbs(updatedPuzzleDbs);
            })
            .catch((error) => {
              logger.error("Failed to reload puzzle databases:", error);
            });
          // Notificar a otros componentes
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

    // Use a flag to prevent multiple simultaneous loads
    let cancelled = false;

    const loadDatabaseInfo = async () => {
      try {
        PUZZLE_DEBUG_LOGS && logger.debug("Loading database info for:", selectedDb);
        
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
          PUZZLE_DEBUG_LOGS && logger.debug("Database file does not exist yet:", dbPath);
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

        PUZZLE_DEBUG_LOGS && logger.debug("Columns result:", columnsResult);
        if (columnsResult.status === "ok") {
          const [hasThemesCol, hasOpeningTagsCol] = columnsResult.data;
          PUZZLE_DEBUG_LOGS && logger.debug("Has themes:", hasThemesCol, "Has opening tags:", hasOpeningTagsCol);
          setHasThemes(hasThemesCol);
          setHasOpeningTags(hasOpeningTagsCol);

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
            PUZZLE_DEBUG_LOGS && logger.debug("Themes groups count:", themesResult.data.length);
            // Backend returns ThemeGroup[] with group and items, convert to format for MultiSelect
            const themesData = themesResult.data as unknown as Array<{ group: string; items: Array<{ value: string; label: string }> }>;
            setThemesOptions(
              themesData.map((group) => ({
                group: group.group,
                items: group.items.map((opt) => ({
                  value: opt.value,
                  label: opt.label,
                })),
              })),
            );
          } else {
            setThemesOptions([]);
          }

          if (hasOpeningTagsCol && tagsResult.status === "ok") {
            PUZZLE_DEBUG_LOGS && logger.debug("Opening tags options count:", tagsResult.data.length);
            // Backend returns OpeningTagOption[] with value and label, convert to format for MultiSelect
            const tagsData = tagsResult.data as unknown as Array<{ value: string; label: string }>;
            setOpeningTagsOptions(
              tagsData.map((opt) => ({
                value: opt.value,
                label: opt.label,
              })),
            );
          } else {
            setOpeningTagsOptions([]);
          }
        } else {
          // Database doesn't exist or is empty - silently handle this
          PUZZLE_DEBUG_LOGS && logger.debug("Columns check failed (database may not be installed):", columnsResult.error);
          setHasThemes(false);
          setHasOpeningTags(false);
          setThemesOptions([]);
          setOpeningTagsOptions([]);
        }
      } catch (error) {
        if (!cancelled) {
          // Only log non-expected errors (file not found/empty are expected if DB not installed)
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (!errorMsg.includes("does not exist") && !errorMsg.includes("is empty")) {
            logger.error("Failed to load database column info:", error);
          }
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
