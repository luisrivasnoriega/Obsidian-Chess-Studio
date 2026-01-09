import type { Piece } from "@lichess-org/chessground/types";
import { makeSan } from "chessops/san";
import { Box, Portal } from "@mantine/core";
import { useHotkeys, useToggle } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { loadDirectories } from "@/App";
import MoveControls from "@/components/MoveControls";
import { TreeStateContext } from "@/components/TreeStateContext";
import { useDebouncedAutoSave } from "@/features/boards/hooks/useDebouncedAutoSave";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import {
  activeTabAtom,
  autoSaveAtom,
  currentPracticeTabAtom,
  currentDbTypeAtom,
  currentLocalOptionsAtom,
  currentTabAtom,
  currentTabSelectedAtom,
  enginesAtom,
  lichessOptionsAtom,
  masterOptionsAtom,
  referenceDbAtom,
  tabEngineSettingsFamily,
} from "@/state/atoms";
import { keyMapAtom } from "@/state/keybindings";
import { defaultPGN, getMoveText, getPGN } from "@/utils/chess";
import { parseSanOrUci, positionFromFen } from "@/utils/chessops";
import { createFile, isTempImportFile } from "@/utils/files";
import { formatDateToPGN } from "@/utils/format";
import { reloadTab, saveTab, saveToFile, type Tab } from "@/utils/tabs";
import { generatePuzzleVariantsFromTree, type PuzzleTreeNodeDto } from "@/utils/puzzleVariants";
import { buildVariantsTree as buildVariantsTreeBackend } from "@/utils/variantsBuilder";
import { getNodeAtPath, type TreeNode } from "@/utils/treeReducer";
import EditingCard from "./EditingCard";
import EvalListener from "./EvalListener";
import GameNotationWrapper from "./GameNotationWrapper";
import ResponsiveAnalysisPanels from "./ResponsiveAnalysisPanels";
import ResponsiveBoard from "./ResponsiveBoard";
import { PuzzleVariantsModal } from "./PuzzleVariantsModal";
import { VariantsActions } from "./VariantsActions";
import { VariantsTreeBuilderModal } from "./VariantsTreeBuilderModal";
import VariantsNotation from "./VariantsNotation";

function BoardVariants() {
  const { t } = useTranslation();
  const [editingMode, toggleEditingMode] = useToggle();
  const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null);
  const [viewPawnStructure, setViewPawnStructure] = useState(false);
  const [currentTab, setCurrentTab] = useAtom(currentTabAtom);
  const autoSave = useAtomValue(autoSaveAtom);
  const { data: dirs } = useQuery({ queryKey: ["dirs"], queryFn: loadDirectories, staleTime: Infinity });
  const documentDir = dirs?.documentDir ?? null;
  const boardRef = useRef<HTMLDivElement | null>(null);
  const activeTab = useAtomValue(activeTabAtom);

  const store = useContext(TreeStateContext)!;

  const dirty = useStore(store, (s) => s.dirty);

  const reset = useStore(store, (s) => s.reset);
  const clearShapes = useStore(store, (s) => s.clearShapes);
  const setStoreState = useStore(store, (s) => s.setState);
  const setStoreSave = useStore(store, (s) => s.save);
  const boardOrientation = useStore(store, (s) => s.headers.orientation || "white");
  const is960 = useStore(store, (s) => s.headers.variant === "Chess960");
  const engines = useAtomValue(enginesAtom);
  const [dbType, setDbType] = useAtom(currentDbTypeAtom);
  const localOptions = useAtomValue(currentLocalOptionsAtom);
  const lichessOptions = useAtomValue(lichessOptionsAtom);
  const masterOptions = useAtomValue(masterOptionsAtom);
  const referenceDatabase = useAtomValue(referenceDbAtom);

  const saveFile = useCallback(
    async (showNotification = true) => {
      try {
        if (
          currentTab?.source != null &&
          currentTab?.source?.type === "file" &&
          !isTempImportFile(currentTab?.source?.path)
        ) {
          await saveTab(currentTab, store);
          setStoreSave();
          if (showNotification) {
            notifications.show({
              title: t("common.save"),
              message: t("common.fileSavedSuccessfully"),
              color: "green",
            });
          }
        } else {
          if (!documentDir) {
            notifications.show({
              title: t("common.error"),
              message: t("errors.missingFilePath"),
              color: "red",
            });
            return;
          }
          await saveToFile({
            dir: documentDir,
            setCurrentTab,
            tab: currentTab,
            store,
          });
          if (showNotification) {
            notifications.show({
              title: t("common.save"),
              message: t("common.fileSavedSuccessfully"),
              color: "green",
            });
          }
        }
      } catch {
        notifications.show({
          title: t("common.error"),
          message: t("common.failedToSaveFile"),
          color: "red",
        });
      }
    },
    [setCurrentTab, currentTab, documentDir, store, setStoreSave, t],
  );

  // Generate puzzles from variants
  const getFenTurn = useCallback((fen: string): "white" | "black" | null => {
    const parts = fen.trim().split(/\s+/);
    const turn = parts[1];
    if (turn === "w") return "white";
    if (turn === "b") return "black";
    return null;
  }, []);

  // Max depth must match the same "start at MY branching node" rule as generatePuzzles.
  const getMaxPuzzleMoveDepth = useCallback(
    (root: TreeNode, puzzleColor: "white" | "black"): number => {
      const memo = new WeakMap<TreeNode, number>();

      const maxFromNode = (node: TreeNode): number => {
        const cached = memo.get(node);
        if (cached != null) return cached;

        const turn = getFenTurn(node.fen);
        if (!turn || node.children.length === 0) {
          memo.set(node, 0);
          return 0;
        }

        const add = turn === puzzleColor ? 1 : 0;
        let best = 0;
        for (const child of node.children) {
          if (!child.san) continue;
          best = Math.max(best, add + maxFromNode(child));
        }

        memo.set(node, best);
        return best;
      };

      const traverse = (node: TreeNode): number => {
        const turn = getFenTurn(node.fen);
        const childrenWithSan = node.children.filter((c) => c.san);
        const hasVariations = childrenWithSan.length > 1;

        let best = 0;

        // Only nodes where MY SIDE branches are valid puzzle start points
        if (turn && turn === puzzleColor && hasVariations) {
          best = Math.max(best, maxFromNode(node));
        }

        for (const child of childrenWithSan) {
          best = Math.max(best, traverse(child));
        }

        return best;
      };

      return traverse(root);
    },
    [getFenTurn],
  );

  const getVariantBaseName = useCallback(() => {
    if (currentTab?.source?.type === "file" && currentTab.source.path) {
      const parts = currentTab.source.path.split(/[/\\]/);
      const name = parts.pop() ?? "puzzles";
      return name.replace(/\.pgn$/i, "") || "puzzles";
    }
    return "puzzles";
  }, [currentTab?.source]);

  const generatePuzzles = useCallback(
    async (selectedDepth: number) => {
      try {
        const root = store.getState().root;

        const puzzleColor: "white" | "black" = boardOrientation === "black" ? "black" : "white";

        const maxDepth = getMaxPuzzleMoveDepth(root, puzzleColor);
        if (selectedDepth < 1 || selectedDepth > maxDepth) {
          notifications.show({
            title: t("common.error"),
            message: t("errors.puzzleDepthTooDeep", { max: maxDepth }),
            color: "red",
          });
          return;
        }

        if (!documentDir) {
          notifications.show({
            title: t("common.error"),
            message: t("errors.missingFilePath"),
            color: "red",
          });
          return;
        }

        const variantName = getVariantBaseName();
        const baseName = `puzzle-variants-${variantName}-d${selectedDepth}-${formatDateToPGN(new Date())}`;
        const filePath = await save({
          defaultPath: `${documentDir}/${baseName}.pgn`,
          filters: [{ name: "PGN", extensions: ["pgn"] }],
        });

        if (!filePath) return;

        const fileName = filePath.replace(/\.pgn$/, "").split(/[/\\]/).pop() || baseName;
        const tags = ["puzzle-variants", `variant:${variantName}`, `depth:${selectedDepth}`];

        const mainlineNodes: TreeNode[] = [];
        let currentNode = root;
        const maxMainlinePlies = 80;
        while (mainlineNodes.length < maxMainlinePlies && currentNode.children.length > 0) {
          const child = currentNode.children.find((c) => c.san) ?? currentNode.children[0];
          if (!child?.san) break;
          mainlineNodes.push(child);
          currentNode = child;
        }

        const mainline = mainlineNodes
          .map((move, index) =>
            getMoveText(move, {
              glyphs: false,
              comments: false,
              extraMarkups: false,
              isFirst: index === 0 || move.halfMoves % 2 === 0,
            }),
          )
          .join("")
          .trim();

        if (mainline) {
          tags.push(`mainline:${mainline}`);
        }

        const toDto = (node: TreeNode): PuzzleTreeNodeDto => ({
          fen: node.fen,
          san: node.san ?? null,
          children: node.children.map(toDto),
        });

        const result = await generatePuzzleVariantsFromTree({
          root: toDto(root),
          orientation: puzzleColor,
          selectedDepth,
        });

        const puzzlesPGN = result.pgn;

        await createFile({
          filename: fileName,
          filetype: "puzzle",
          tags,
          pgn: puzzlesPGN,
          dir: documentDir,
        });

        try {
          window.dispatchEvent(new Event("puzzles:updated"));
          window.dispatchEvent(new Event("puzzle-variants:updated"));
        } catch {}

        notifications.show({
          title: t("common.save"),
          message: t("common.puzzlesGeneratedSuccessfully", { count: result.count }),
          color: "green",
        });
      } catch {
        notifications.show({
          title: t("common.error"),
          message: t("common.failedToGeneratePuzzles"),
          color: "red",
        });
      }
    },
    [store, boardOrientation, documentDir, getMaxPuzzleMoveDepth, getVariantBaseName, t],
  );

  const reloadBoard = useCallback(async () => {
    if (currentTab != null) {
      const state = await reloadTab(currentTab);

      if (state != null) {
        setStoreState(state);
      }
    }
  }, [currentTab, setStoreState]);

  useDebouncedAutoSave({
    store,
    enabled: autoSave,
    isFileTab: currentTab?.source?.type === "file",
    save: () => saveFile(false),
  });

  const filePath = currentTab?.source?.type === "file" ? currentTab.source.path : undefined;

  const addGame = useCallback(() => {
    if (!filePath) {
      notifications.show({
        title: t("common.error"),
        message: t("errors.missingFilePath"),
        color: "red",
      });
      return;
    }

    setCurrentTab((prev: Tab) => {
      if (prev.source?.type === "file") {
        prev.gameNumber = prev.source.numGames;
        prev.source.numGames += 1;
        return { ...prev };
      }

      return prev;
    });
    reset();
    writeTextFile(filePath, `\n\n${defaultPGN()}\n\n`, {
      append: true,
    });
  }, [setCurrentTab, reset, filePath, t]);

  const copyFen = useCallback(async () => {
    try {
      const currentNode = getNodeAtPath(store.getState().root, store.getState().position);
      await navigator.clipboard.writeText(currentNode.fen);
      notifications.show({
        title: t("keybindings.copyFen"),
        message: t("common.copiedFenToClipboard"),
        color: "green",
      });
    } catch {
      notifications.show({
        title: t("common.error"),
        message: t("errors.failedToCopyFen"),
        color: "red",
      });
    }
  }, [store, t]);

  const copyPgn = useCallback(async () => {
    try {
      const { root, headers } = store.getState();
      const pgn = getPGN(root, {
        headers: headers,
        comments: true,
        extraMarkups: true,
        glyphs: true,
        variations: true,
      });
      await navigator.clipboard.writeText(pgn);
      notifications.show({
        title: t("keybindings.copyPgn"),
        message: t("common.copiedPgnToClipboard"),
        color: "green",
      });
    } catch {
      notifications.show({
        title: t("common.error"),
        message: t("errors.failedToCopyPgn"),
        color: "red",
      });
    }
  }, [store, t]);

  const keyMap = useAtomValue(keyMapAtom);

  useHotkeys([
    [keyMap.COPY_FEN.keys, copyFen],
    [keyMap.COPY_PGN.keys, copyPgn],
  ]);

  const [currentTabSelected, setCurrentTabSelected] = useAtom(currentTabSelectedAtom);
  const practiceTabSelected = useAtomValue(currentPracticeTabAtom);
  const { layout } = useResponsiveLayout();
  const isMobileLayout = layout.chessBoard.layoutType === "mobile";
  const topBar = true;

  const isRepertoire = currentTab?.source?.type === "file" && currentTab.source.metadata?.type === "repertoire";
  const isPuzzle = currentTab?.source?.type === "file" && currentTab.source.metadata?.type === "puzzle";
  const practicing = currentTabSelected === "practice" && practiceTabSelected === "train";
  const [treeBuilderOpened, setTreeBuilderOpened] = useState(false);
  const [treeBuilderRunning, setTreeBuilderRunning] = useState(false);
  const [treeBuilderMode, setTreeBuilderMode] = useState<"engine" | "winrate">("engine");
  const [treeBuilderDepth, setTreeBuilderDepth] = useState(8);
  const [treeBuilderCoverage, setTreeBuilderCoverage] = useState(90);
  const [treeBuilderMinMoves, setTreeBuilderMinMoves] = useState(2);
  const [treeBuilderEngineMs, setTreeBuilderEngineMs] = useState(800);
  const [puzzleModalOpened, setPuzzleModalOpened] = useState(false);
  const [puzzleDepth, setPuzzleDepth] = useState(1);
  const [maxPuzzleDepth, setMaxPuzzleDepth] = useState(1);
  const [selectedEngineKey, setSelectedEngineKey] = useState<string | null>(null);
  const loadedEngines = engines.filter((engine) => engine.loaded && engine.type === "local");
  const treeBuilderCancelRef = useRef(false);
  const selectedEngine =
    loadedEngines.find((engine) => (engine.type === "local" ? engine.path : engine.url) === selectedEngineKey) ??
    loadedEngines[0] ??
    null;
  const [selectedEngineSettings] = useAtom(
    tabEngineSettingsFamily({
      tab: activeTab ?? "analysis",
      engineName: selectedEngine?.name ?? "",
      defaultSettings: selectedEngine?.settings ?? undefined,
      defaultGo: selectedEngine?.go ?? undefined,
    }),
  );

  useEffect(() => {
    if (!loadedEngines.length) {
      setSelectedEngineKey(null);
      return;
    }
    const nextKey = selectedEngine
      ? selectedEngine.type === "local"
        ? selectedEngine.path
        : selectedEngine.url
      : null;
    if (!nextKey || !loadedEngines.some((engine) => (engine.type === "local" ? engine.path : engine.url) === nextKey)) {
      setSelectedEngineKey(loadedEngines[0].type === "local" ? loadedEngines[0].path : loadedEngines[0].url);
    }
  }, [loadedEngines, selectedEngine]);

  const engineOptions = loadedEngines.map((engine) => ({
    value: engine.type === "local" ? engine.path : engine.url,
    label: engine.name,
  }));

  const cancelTreeBuilder = useCallback(() => {
    treeBuilderCancelRef.current = true;
  }, []);

  const buildVariantsTree = useCallback(async () => {
    if (treeBuilderRunning) return;
    setTreeBuilderRunning(true);
    treeBuilderCancelRef.current = false;

    try {
      if (dbType === "local" && !localOptions.path && !referenceDatabase) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.treeBuilder.missingDb"),
          color: "red",
        });
        return;
      }

      const startPath = [...store.getState().position];
      const startNode = getNodeAtPath(store.getState().root, startPath);
      if (!startNode?.fen) {
        throw new Error(t("errors.missingPosition"));
      }

      const toDto = (node: TreeNode): { fen: string; san?: string | null; children: any[] } => ({
        fen: node.fen,
        san: node.san ?? null,
        children: node.children.map(toDto),
      });

      const engineExtraOptions =
        selectedEngineSettings?.settings?.map((s) => ({
          name: s.name,
          value: s.value?.toString() ?? "",
        })) ?? [];

      const localDbPath = localOptions.path ?? referenceDatabase ?? null;

      const toIso = (value: unknown) => {
        if (value == null) return undefined;
        if (value instanceof Date) return value.toISOString();
        if (typeof value === "string") return value;
        return undefined;
      };

      const lichessOptionsDto = {
        ...(lichessOptions as any),
        since: toIso((lichessOptions as any)?.since),
        until: toIso((lichessOptions as any)?.until),
      };

      const masterOptionsDto = {
        ...(masterOptions as any),
        since: toIso((masterOptions as any)?.since),
        until: toIso((masterOptions as any)?.until),
      };

      const res = await buildVariantsTreeBackend({
        root: toDto(store.getState().root),
        startPath,
        orientation: boardOrientation === "black" ? "black" : "white",
        is960,
        dbType,
        localDbPath,
        lichessOptions: lichessOptionsDto as any,
        masterOptions: masterOptionsDto as any,
        mode: treeBuilderMode,
        engine:
          selectedEngine && selectedEngine.type === "local"
            ? {
                name: selectedEngine.name,
                path: selectedEngine.path,
                extraOptions: engineExtraOptions,
              }
            : null,
        engineMs: treeBuilderEngineMs,
        coverage: treeBuilderCoverage,
        minMoves: treeBuilderMinMoves,
        depth: treeBuilderDepth,
      });

      if (treeBuilderCancelRef.current) return;

      let expandedAny = false;
      let lastAppliedPosition: number[] | null = null;

      for (const line of res.lines) {
        if (treeBuilderCancelRef.current) break;

        const state = store.getState();
        state.goToMove([...startPath]);

        const moves = line.moves.map((m) => m.value);

        const beforePos = [...store.getState().position];
        state.makeMoves({ payload: moves, mainline: false, changeHeaders: false });
        const afterPos = [...store.getState().position];

        if (afterPos.length === beforePos.length) {
          // eslint-disable-next-line no-console
          console.warn("buildVariantsTree: could not apply line", { moves, startPath });
          continue;
        }

        expandedAny = true;
        lastAppliedPosition = afterPos;

        // Yield to the UI so users can see the board advance as lines are applied.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        // Attach DB stats to each created node as a comment.
        try {
          let path = [...startPath];

          for (const step of line.moves) {
            if (treeBuilderCancelRef.current) break;

            const fresh = store.getState();
            const node = getNodeAtPath(fresh.root, path);
            if (!node) break;

            const [pos] = positionFromFen(node.fen);
            if (!pos || pos.isEnd()) break;

            const parsed = parseSanOrUci(pos, step.value);
            if (!parsed) break;

            const san = makeSan(pos, parsed);
            if (!san || san === "--") break;

            const nextIdx = node.children.findIndex((c) => c.san === san);
            if (nextIdx < 0) break;

            path = [...path, nextIdx];

            if (step.source === "db" && step.total && step.white != null && step.black != null && step.draws != null) {
              const pct = (n: number) => `${((n / step.total!) * 100).toFixed(1)}%`;
              const comment = `DB: ${step.total} games | White ${pct(step.white)} Draw ${pct(step.draws)} Black ${pct(step.black)}`;

              store.getState().goToMove(path);
              const curState = store.getState();
              const cur = getNodeAtPath(curState.root, curState.position);

              const prev = (cur?.comment ?? "").trim();
              if (!prev) {
                store.getState().setComment(comment);
              } else if (!prev.includes(comment)) {
                store.getState().setComment(`${prev}\n${comment}`);
              }
            }
          }
        } catch {
          // Ignore comment attach errors
        }
      }

      if (lastAppliedPosition) {
        store.getState().goToMove(lastAppliedPosition);
      } else {
        store.getState().goToMove([...startPath]);
      }

      if (!treeBuilderCancelRef.current && !expandedAny) {
        notifications.show({
          title: t("common.error"),
          message: t("features.board.variants.treeBuilder.noProgress"),
          color: "red",
        });
      }

      if (!treeBuilderCancelRef.current) {
        notifications.show({
          title: t("common.success"),
          message: t("features.board.variants.treeBuilder.done"),
          color: "green",
        });
      }
    } catch (error) {
      const message =
        typeof error === "string"
          ? error
          : error && typeof error === "object" && "message" in error && typeof (error as any).message === "string"
            ? (error as any).message
            : error instanceof Error
              ? error.message
              : error && typeof error === "object"
                ? JSON.stringify(error)
                : t("errors.unknownError");

      // eslint-disable-next-line no-console
      console.error("buildVariantsTree failed", error);

      notifications.show({
        title: t("common.error"),
        message,
        color: "red",
      });
    } finally {
      setTreeBuilderRunning(false);
    }
  }, [
    boardOrientation,
    dbType,
    is960,
    lichessOptions,
    localOptions.path,
    masterOptions,
    referenceDatabase,
    selectedEngine,
    selectedEngineSettings?.settings,
    store,
    t,
    treeBuilderCoverage,
    treeBuilderDepth,
    treeBuilderEngineMs,
    treeBuilderMinMoves,
    treeBuilderMode,
    treeBuilderRunning,
  ]);

  return (
    <>
      <EvalListener />
      {isMobileLayout ? (
        <Box style={{ width: "100%", flex: 1, overflow: "hidden" }}>
          <ResponsiveBoard
            practicing={practicing}
            dirty={dirty}
            editingMode={editingMode}
            toggleEditingMode={toggleEditingMode}
            boardRef={boardRef}
            saveFile={saveFile}
            reload={reloadBoard}
            addGame={addGame}
            topBar={topBar}
            editingCard={
              editingMode ? (
                <EditingCard
                  boardRef={boardRef}
                  setEditingMode={toggleEditingMode}
                  selectedPiece={selectedPiece}
                  setSelectedPiece={setSelectedPiece}
                />
              ) : undefined
            }
            viewPawnStructure={viewPawnStructure}
            setViewPawnStructure={setViewPawnStructure}
            selectedPiece={selectedPiece}
            setSelectedPiece={setSelectedPiece}
            canTakeBack={false}
            changeTabType={() => setCurrentTab((prev: Tab) => ({ ...prev, type: "play" }))}
            currentTabType="analysis"
            clearShapes={clearShapes}
            disableVariations={false}
            currentTabSourceType={currentTab?.source?.type || undefined}
          />
        </Box>
      ) : (
        <>
          <Portal target="#left" style={{ height: "100%" }}>
            <ResponsiveBoard
              practicing={practicing}
              dirty={dirty}
              editingMode={editingMode}
              toggleEditingMode={toggleEditingMode}
              boardRef={boardRef}
              saveFile={saveFile}
              reload={reloadBoard}
              addGame={addGame}
              topBar={false}
              editingCard={
                editingMode ? (
                  <EditingCard
                    boardRef={boardRef}
                    setEditingMode={toggleEditingMode}
                    selectedPiece={selectedPiece}
                    setSelectedPiece={setSelectedPiece}
                  />
                ) : undefined
              }
              viewPawnStructure={viewPawnStructure}
              setViewPawnStructure={setViewPawnStructure}
              selectedPiece={selectedPiece}
              setSelectedPiece={setSelectedPiece}
              canTakeBack={false}
              changeTabType={() => setCurrentTab((prev: Tab) => ({ ...prev, type: "play" }))}
              currentTabType="analysis"
              clearShapes={clearShapes}
              disableVariations={false}
              currentTabSourceType={currentTab?.source?.type || undefined}
            />
          </Portal>

          <Portal target="#topRight" style={{ height: "100%" }}>
            <ResponsiveAnalysisPanels
              currentTab={currentTabSelected}
              onTabChange={(v) => setCurrentTabSelected(v || "info")}
              isRepertoire={isRepertoire}
              isPuzzle={isPuzzle}
            />
          </Portal>
        </>
      )}

      <GameNotationWrapper
        topBar
        editingMode={editingMode}
        editingCard={
          <EditingCard
            boardRef={boardRef}
            setEditingMode={toggleEditingMode}
            selectedPiece={selectedPiece}
            setSelectedPiece={setSelectedPiece}
          />
        }
      >
        <>
          <VariantsNotation topBar={topBar} editingMode={editingMode} />
          <MoveControls readOnly />
          <VariantsActions
            treeBuilderRunning={treeBuilderRunning}
            onOpenPuzzle={() => {
              const puzzleColor: "white" | "black" = boardOrientation === "black" ? "black" : "white";
              const depth = Math.max(1, getMaxPuzzleMoveDepth(store.getState().root, puzzleColor));
              setMaxPuzzleDepth(depth);
              setPuzzleDepth(Math.min(puzzleDepth, depth));
              setPuzzleModalOpened(true);
            }}
            onOpenTreeBuilder={() => setTreeBuilderOpened(true)}
            onCancelTreeBuilder={cancelTreeBuilder}
          />
        </>
      </GameNotationWrapper>

      <PuzzleVariantsModal
        opened={puzzleModalOpened}
        onClose={() => setPuzzleModalOpened(false)}
        puzzleDepth={puzzleDepth}
        maxPuzzleDepth={maxPuzzleDepth}
        setPuzzleDepth={setPuzzleDepth}
        onGenerate={(depth) => void generatePuzzles(depth)}
      />

      <VariantsTreeBuilderModal
        opened={treeBuilderOpened}
        onClose={() => setTreeBuilderOpened(false)}
        dbType={dbType}
        setDbType={setDbType}
        localDbLabel={referenceDatabase}
        treeBuilderMode={treeBuilderMode}
        setTreeBuilderMode={setTreeBuilderMode}
        engineOptions={engineOptions}
        selectedEngineValue={
          selectedEngine ? (selectedEngine.type === "local" ? selectedEngine.path : selectedEngine.url) : null
        }
        setSelectedEngineValue={setSelectedEngineKey}
        treeBuilderEngineMs={treeBuilderEngineMs}
        setTreeBuilderEngineMs={setTreeBuilderEngineMs}
        treeBuilderCoverage={treeBuilderCoverage}
        setTreeBuilderCoverage={setTreeBuilderCoverage}
        treeBuilderMinMoves={treeBuilderMinMoves}
        setTreeBuilderMinMoves={setTreeBuilderMinMoves}
        treeBuilderDepth={treeBuilderDepth}
        setTreeBuilderDepth={setTreeBuilderDepth}
        treeBuilderRunning={treeBuilderRunning}
        onRun={() => void buildVariantsTree()}
        onCancel={cancelTreeBuilder}
        runDisabled={!treeBuilderRunning && treeBuilderMode === "engine" && !selectedEngine}
      />
    </>
  );
}

export default BoardVariants;
