import type { Piece } from "@lichess-org/chessground/types";
import { Box, Portal, ScrollArea, Stack } from "@mantine/core";
import { useHotkeys, useToggle } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { Platform } from "@tauri-apps/plugin-os";
import { makeSan } from "chessops/san";
import { useAtom, useAtomValue } from "jotai";
import { Suspense, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { loadDirectories } from "@/App";
import { commands } from "@/bindings/generated";
import MoveControls from "@/components/MoveControls";
import { ResponsiveSkeleton } from "@/components/ResponsiveSkeleton";
import { TreeStateContext } from "@/components/TreeStateContext";
import { useDebouncedAutoSave } from "@/features/boards/hooks/useDebouncedAutoSave";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import {
  activeTabAtom,
  autoSaveAtom,
  currentDbTypeAtom,
  currentLocalOptionsAtom,
  currentPracticeTabAtom,
  currentTabAtom,
  currentTabSelectedAtom,
  enginesAtom,
  lichessOptionsAtom,
  masterOptionsAtom,
  referenceDbAtom,
  tabEngineSettingsFamily,
  tabsAtom,
} from "@/state/atoms";
import { keyMapAtom } from "@/state/keybindings";
import { defaultPGN, getMoveText, getPGN } from "@/utils/chess";
import { parseSanOrUci, positionFromFen } from "@/utils/chessops";
import { createFile, isTempImportFile } from "@/utils/files";
import { formatDateToPGN } from "@/utils/format";
import { generatePuzzleVariantsFromTree, type PuzzleTreeNodeDto } from "@/utils/puzzleVariants";
import { reloadTab, saveTab, saveToFile, type Tab } from "@/utils/tabs";
import { getNodeAtPath, type TreeNode } from "@/utils/treeReducer";
import { buildVariantsTree as buildVariantsTreeBackend } from "@/utils/variantsBuilder";
import EditingCard from "./EditingCard";
import EvalListener from "./EvalListener";
import GameNotationWrapper from "./GameNotationWrapper";
import { PuzzleVariantsModal } from "./PuzzleVariantsModal";
import ResponsiveAnalysisPanels from "./ResponsiveAnalysisPanels";
import ResponsiveBoard from "./ResponsiveBoard";
import { VariantsActions } from "./VariantsActions";
import VariantsNotation from "./VariantsNotation";
import { VariantsTreeBuilderModal } from "./VariantsTreeBuilderModal";

function BoardVariants() {
  const { t } = useTranslation();
  const [editingMode, toggleEditingMode] = useToggle();
  const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null);
  const [viewPawnStructure, setViewPawnStructure] = useState(false);
  const [platform, setPlatform] = useState<Platform | null>(() => {
    if (typeof navigator === "undefined") return null;
    return /Android/i.test(navigator.userAgent) ? "android" : null;
  });
  const [currentTab, setCurrentTab] = useAtom(currentTabAtom);
  const [_tabs, setTabs] = useAtom(tabsAtom);
  const autoSave = useAtomValue(autoSaveAtom);
  const { data: dirs } = useQuery({ queryKey: ["dirs"], queryFn: loadDirectories, staleTime: Infinity });
  const documentDir = dirs?.documentDir ?? null;
  const boardRef = useRef<HTMLDivElement | null>(null);
  const activeTab = useAtomValue(activeTabAtom);

  const store = useContext(TreeStateContext)!;
  const isAndroid = platform === "android";

  // Declare treeBuilderRunning early so it can be used in useDebouncedAutoSave
  const [treeBuilderRunning, setTreeBuilderRunning] = useState(false);

  const dirty = useStore(store, (s) => s.dirty);

  const reset = useStore(store, (s) => s.reset);
  const clearShapes = useStore(store, (s) => s.clearShapes);
  const setStoreState = useStore(store, (s) => s.setState);
  const setStoreSave = useStore(store, (s) => s.save);
  const setHeaders = useStore(store, (s) => s.setHeaders);
  const boardOrientation = useStore(store, (s) => s.headers.orientation || "white");
  const is960 = useStore(store, (s) => s.headers.variant === "Chess960");
  const engines = useAtomValue(enginesAtom);
  const [dbType, setDbType] = useAtom(currentDbTypeAtom);
  const localOptions = useAtomValue(currentLocalOptionsAtom);
  const lichessOptions = useAtomValue(lichessOptionsAtom);
  const masterOptions = useAtomValue(masterOptionsAtom);
  const referenceDatabase = useAtomValue(referenceDbAtom);

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

  const saveFile = useCallback(
    async (showNotification = true) => {
      // Don't save during build variants
      if (treeBuilderRunning) {
        return;
      }

      try {
        if (
          currentTab?.source != null &&
          currentTab?.source?.type === "file" &&
          !isTempImportFile(currentTab?.source?.path)
        ) {
          await saveTab(currentTab, store, setTabs);
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
          const saved = await saveToFile({
            dir: documentDir,
            setCurrentTab,
            tab: currentTab,
            store,
            setTabs,
            isVariantsFile: true,
          });
          if (!saved) {
            return;
          }
          if (showNotification) {
            notifications.show({
              title: t("common.save"),
              message: t("common.fileSavedSuccessfully"),
              color: "green",
            });
          }
        }
      } catch (_error) {
        // Only show error if not during build variants
        if (!treeBuilderRunning && showNotification) {
          notifications.show({
            title: t("common.error"),
            message: t("common.failedToSaveFile"),
            color: "red",
          });
        }
      }
    },
    [setCurrentTab, currentTab, documentDir, store, setStoreSave, setTabs, treeBuilderRunning, t],
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

        const fileName =
          filePath
            .replace(/\.pgn$/, "")
            .split(/[/\\]/)
            .pop() || baseName;
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
    [store, boardOrientation, documentDir, getVariantBaseName, t],
  );

  const reloadBoard = useCallback(async () => {
    if (currentTab != null) {
      const state = await reloadTab(currentTab);

      if (state != null) {
        setStoreState(state);
      }
    }
  }, [currentTab, setStoreState]);

  // Disable auto-save during build variants to avoid errors
  useDebouncedAutoSave({
    store,
    enabled: autoSave && !treeBuilderRunning,
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

  const flipBoard = useCallback(() => {
    const currentHeaders = store.getState().headers;
    const newOrientation = currentHeaders.orientation === "black" ? "white" : "black";
    setHeaders({
      ...currentHeaders,
      orientation: newOrientation,
    });
  }, [setHeaders, store]);

  const keyMap = useAtomValue(keyMapAtom);

  useHotkeys([
    [keyMap.COPY_FEN.keys, copyFen],
    [keyMap.COPY_PGN.keys, copyPgn],
    [keyMap.FLIP_BOARD.keys, flipBoard],
  ]);

  const [currentTabSelected, setCurrentTabSelected] = useAtom(currentTabSelectedAtom);
  const practiceTabSelected = useAtomValue(currentPracticeTabAtom);
  const { layout } = useResponsiveLayout();
  const isMobileLayout = layout.chessBoard.layoutType === "mobile";
  const topBar = true;

  const showRepertoirePanels =
    currentTab?.source?.type === "file" &&
    (currentTab.source.metadata?.type === "repertoire" || currentTab.source.metadata?.type === "variants");
  const isPuzzle = currentTab?.source?.type === "file" && currentTab.source.metadata?.type === "puzzle";
  const practicing = currentTabSelected === "practice" && practiceTabSelected === "train";
  const [treeBuilderOpened, setTreeBuilderOpened] = useState(false);
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

      // Store the start node info for metadata update at the end
      const startFenForMetadata = startNode.fen;

      const attachDbCommentsForLine = async (
        lineMoves: Array<{
          value: string;
          source?: "db" | "engine";
          white?: number;
          black?: number;
          draws?: number;
          total?: number;
        }>,
      ) => {
        // Attach opening names to each created node as a comment.
        try {
          let path = [...startPath];

          // Get opening from start position if it exists
          let lastKnownOpening: string | null = null;
          try {
            const startNode = getNodeAtPath(store.getState().root, startPath);
            if (startNode) {
              const res = await commands.getOpeningFromFen(startNode.fen);
              if (res.status === "ok" && res.data) {
                lastKnownOpening = res.data;
              } else {
                const resInfo = await commands.getOpeningInfoFromFen(startNode.fen);
                if (resInfo.status === "ok" && resInfo.data) {
                  const { opening, variation } = resInfo.data;
                  lastKnownOpening = variation && variation.trim().length > 0 ? `${opening}: ${variation}` : opening;
                }
              }
              // Filter out empty/invalid openings
              if (
                lastKnownOpening === "" ||
                lastKnownOpening === "Empty Board" ||
                lastKnownOpening === "Starting Position"
              ) {
                lastKnownOpening = null;
              }
            }
          } catch {
            // Ignore opening lookup errors for start position
          }

          const ourSide = boardOrientation === "black" ? "black" : "white";

          for (const step of lineMoves) {
            if (treeBuilderCancelRef.current) break;

            const fresh = store.getState();
            const node = getNodeAtPath(fresh.root, path);
            if (!node) break;

            const [pos] = positionFromFen(node.fen);
            if (!pos || pos.isEnd()) break;

            const isOpponentMove = pos.turn !== ourSide;

            const parsed = parseSanOrUci(pos, step.value);
            if (!parsed) break;

            const san = makeSan(pos, parsed);
            if (!san || san === "--") break;

            const nextIdx = node.children.findIndex((c) => c.san === san);
            if (nextIdx < 0) break;

            // Calculate move number and format before moving
            const isBlackMove = node.halfMoves % 2 === 0;
            const moveNumber = Math.ceil((node.halfMoves + 1) / 2);
            const moveText = isBlackMove ? `${moveNumber}... ${san}` : `${moveNumber}. ${san}`;

            path = [...path, nextIdx];

            // Get the node after the move
            store.getState().goToMove(path);
            const curState = store.getState();
            const cur = getNodeAtPath(curState.root, curState.position);
            if (!cur) continue;

            // Try to get opening from current position
            let currentOpening: string | null = null;
            try {
              const res = await commands.getOpeningFromFen(cur.fen);
              if (res.status === "ok" && res.data) {
                currentOpening = res.data;
              } else {
                const resInfo = await commands.getOpeningInfoFromFen(cur.fen);
                if (resInfo.status === "ok" && resInfo.data) {
                  const { opening, variation } = resInfo.data;
                  currentOpening = variation && variation.trim().length > 0 ? `${opening}: ${variation}` : opening;
                }
              }
            } catch {
              // Ignore opening lookup errors
            }

            let comment: string | null = null;

            if (
              currentOpening &&
              currentOpening !== "" &&
              currentOpening !== "Empty Board" &&
              currentOpening !== "Starting Position"
            ) {
              // Current position has an opening name
              comment = `[${currentOpening}]`;
              lastKnownOpening = currentOpening;
            } else if (lastKnownOpening) {
              // Current position doesn't have an opening, but we have a previous one
              comment = `[${lastKnownOpening} - ${moveText}]`;
            }
            // If no opening at all, don't add a comment

            // Only attach comments on opponent moves (variant side).
            if (comment && isOpponentMove) {
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
      };

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

      let expandedAny = false;
      let lastAppliedPosition: number[] | null = null;

      // Stream progress from the backend: each event contains the current prefix line (moves)
      // so we can update the UI while the tree is still being generated.
      const unlistenProgress = listen("variants_builder_progress", (event: any) => {
        if (treeBuilderCancelRef.current) return;
        const payload = event?.payload as { startPath?: number[]; moves?: Array<{ value: string }> } | undefined;
        const payloadStartPath = payload?.startPath;
        const payloadMoves = payload?.moves;
        if (!payloadStartPath || !Array.isArray(payloadStartPath) || !payloadMoves || !Array.isArray(payloadMoves))
          return;

        const state = store.getState();
        state.goToMove([...payloadStartPath]);
        const moves = payloadMoves.map((m) => m.value);
        const beforePos = [...store.getState().position];
        state.makeMoves({ payload: moves, mainline: false, changeHeaders: false });
        const afterPos = [...store.getState().position];

        if (afterPos.length === beforePos.length) return;

        expandedAny = true;
        lastAppliedPosition = afterPos;
      });

      let res: Awaited<ReturnType<typeof buildVariantsTreeBackend>> | null = null;
      try {
        res = await buildVariantsTreeBackend({
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
      } finally {
        void unlistenProgress
          .then((fn) => fn())
          .catch(() => {
            // Ignore unlisten errors (e.g. listener already removed)
          });
      }

      if (treeBuilderCancelRef.current) return;

      if (!expandedAny) {
        // Fallback: if we didn't receive streaming events (or they were ignored),
        // apply the returned full lines as we did before.
        for (const line of res?.lines ?? []) {
          if (treeBuilderCancelRef.current) break;

          const state = store.getState();
          state.goToMove([...startPath]);

          const moves = line.moves.map((m) => m.value);

          const beforePos = [...store.getState().position];
          state.makeMoves({ payload: moves, mainline: false, changeHeaders: false });
          const afterPos = [...store.getState().position];

          if (afterPos.length === beforePos.length) {
            continue;
          }

          expandedAny = true;
          lastAppliedPosition = afterPos;

          // Yield to the UI so users can see the board advance as lines are applied.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));

          await attachDbCommentsForLine(line.moves);
        }
      } else {
        // If streaming already built the nodes, just attach opening comments from the final response.
        for (const line of res?.lines ?? []) {
          if (treeBuilderCancelRef.current) break;
          await attachDbCommentsForLine(line.moves);
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
        // Update metadata in .info file if this is a variants file
        // Check if this is a variants file - either from tab metadata or by checking the .info file
        const isVariantsFile =
          (currentTab?.source?.type === "file" && currentTab.source.metadata?.type === "variants") ||
          (currentTab?.source?.type === "file" && currentTab.source.path);

        if (isVariantsFile && currentTab?.source?.type === "file" && currentTab.source.path) {
          // Verify it's actually a variants file by checking the .info file
          const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
          const infoPath = currentTab.source.path.replace(".pgn", ".info");
          let isActuallyVariants = false;

          if (await exists(infoPath)) {
            try {
              const fileMetadata = JSON.parse(await readTextFile(infoPath)) as unknown;
              isActuallyVariants = (fileMetadata as any)?.type === "variants";
            } catch {
              // If parsing fails, assume it's not a variants file
            }
          }

          if (isActuallyVariants) {
            try {
              const { writeTextFile } = await import("@tauri-apps/plugin-fs");
              const { getOpening } = await import("@/utils/chess");
              const root = store.getState().root;

              let metadata: { type: string; tags: string[] } = {
                type: "variants",
                tags: [],
              };

              if (await exists(infoPath)) {
                try {
                  const existingContent = await readTextFile(infoPath);
                  const parsed = JSON.parse(existingContent) as any;
                  metadata = {
                    type: typeof parsed?.type === "string" ? parsed.type : "variants",
                    tags: Array.isArray(parsed?.tags)
                      ? parsed.tags.filter((t: unknown): t is string => typeof t === "string")
                      : [],
                  };
                } catch (_parseError) {
                  // If parsing fails, use default
                }
              }

              // Use the requested depth from the modal (not the calculated tree depth)
              const requestedDepth = treeBuilderDepth;

              // Use the start FEN and opening (where build variants started)
              // Use the stored startFenForMetadata from when build started
              const startFen = startFenForMetadata;

              // Get opening from the start position (where build variants began)
              const opening = await getOpening(root, startPath);

              // Get database info - format: "local -nombre-" or "lichess"
              const databaseName =
                dbType === "local" && localOptions.path
                  ? `local -${
                      localOptions.path
                        .split(/[/\\]/)
                        .pop()
                        ?.replace(/\.db3?$/i, "") || "unknown"
                    }`
                  : dbType === "local" && referenceDatabase
                    ? `local -${
                        referenceDatabase
                          .split(/[/\\]/)
                          .pop()
                          ?.replace(/\.db3?$/i, "") || "unknown"
                      }`
                    : dbType === "lch_all" || dbType === "lch_master"
                      ? "lichess"
                      : null;
              const engineName = selectedEngine?.name || null;
              const engineMs = treeBuilderEngineMs;
              const variantsCount = res?.lines?.length || 0;

              // Update tags - remove old metadata tags
              metadata.tags = (metadata.tags || []).filter(
                (tag) =>
                  !tag.startsWith("opening:") &&
                  !tag.startsWith("fen:") &&
                  !tag.startsWith("depth:") &&
                  !tag.startsWith("database:") &&
                  !tag.startsWith("engine:") &&
                  !tag.startsWith("engineMs:") &&
                  !tag.startsWith("variantsCount:"),
              );

              // Add new metadata tags
              if (opening) {
                metadata.tags.push(`opening:${opening}`);
              }
              if (startFen) {
                metadata.tags.push(`fen:${startFen}`);
              }
              // Use requested depth from modal
              if (requestedDepth > 0) {
                metadata.tags.push(`depth:${requestedDepth}`);
              }
              if (databaseName) {
                metadata.tags.push(`database:${databaseName}`);
              }
              if (engineName) {
                metadata.tags.push(`engine:${engineName}`);
              }
              if (engineMs > 0) {
                metadata.tags.push(`engineMs:${engineMs}`);
              }
              if (variantsCount > 0) {
                metadata.tags.push(`variantsCount:${variantsCount}`);
              }

              // Ensure metadata has correct structure
              metadata.type = "variants";
              if (!Array.isArray(metadata.tags)) {
                metadata.tags = [];
              }

              const metadataJson = JSON.stringify(metadata, null, 2);
              await writeTextFile(infoPath, metadataJson);
            } catch (_error) {}
          }
        }

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
    currentTab,
  ]);

  if (isMobileLayout) {
    return (
      <>
        {/* Disable EvalListener during build variants to avoid engine event loops */}
        {!treeBuilderRunning && <EvalListener />}
        <Box
          style={{
            paddingBottom: isAndroid ? "calc(var(--mantine-spacing-md) + env(safe-area-inset-bottom, 0px))" : undefined,
            minHeight: "100%",
            maxHeight: "100%",
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
          }}
        >
          <Stack gap="md" style={{ minHeight: 0 }}>
            <Box style={{ zIndex: 3 }}>
              <Suspense fallback={<ResponsiveSkeleton type="default" />}>
                <ResponsiveAnalysisPanels
                  currentTab={currentTabSelected}
                  onTabChange={(v) => setCurrentTabSelected(v || "info")}
                  isRepertoire={showRepertoirePanels}
                  isPuzzle={isPuzzle}
                  showSimulate
                  disableCollapse
                  renderAsSelect
                  unstyledContainer
                />
              </Suspense>
            </Box>

            <Box style={{ position: "relative", zIndex: 2, minHeight: 0 }}>
              <ResponsiveBoard
                practicing={practicing}
                dirty={dirty}
                editingMode={editingMode}
                toggleEditingMode={toggleEditingMode}
                boardRef={boardRef}
                saveFile={saveFile}
                copyPgn={copyPgn}
                reload={reloadBoard}
                addGame={addGame}
                topBar={topBar}
                showClock={false}
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
                toggleOrientation={flipBoard}
                disableVariations={false}
                currentTabSourceType={currentTab?.source?.type || undefined}
                hideMobileAnalysisPanel
              />
            </Box>

            <ScrollArea style={{ flex: 1 }} h="100%" offsetScrollbars>
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
                <VariantsNotation topBar={topBar} editingMode={editingMode} />
                <VariantsActions
                  treeBuilderRunning={treeBuilderRunning}
                  onOpenPuzzle={() => {
                    // Use treeBuilderDepth as the maximum depth for puzzles
                    // This ensures the puzzle depth matches the depth configured in build variants
                    const maxDepth = treeBuilderDepth;
                    if (maxDepth < 1) {
                      notifications.show({
                        title: t("common.error"),
                        message: t("errors.puzzleVariantsNeedSystemMove"),
                        color: "red",
                      });
                      return;
                    }
                    setMaxPuzzleDepth(maxDepth);
                    setPuzzleDepth(Math.min(puzzleDepth, maxDepth));
                    setPuzzleModalOpened(true);
                  }}
                  onOpenTreeBuilder={() => setTreeBuilderOpened(true)}
                  onCancelTreeBuilder={cancelTreeBuilder}
                />
              </GameNotationWrapper>
            </ScrollArea>
          </Stack>
        </Box>

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

  return (
    <>
      {/* Disable EvalListener during build variants to avoid engine event loops */}
      {!treeBuilderRunning && <EvalListener />}
      <Portal target="#left" style={{ height: "100%" }}>
        <ResponsiveBoard
          practicing={practicing}
          dirty={dirty}
          editingMode={editingMode}
          toggleEditingMode={toggleEditingMode}
          boardRef={boardRef}
          saveFile={saveFile}
          copyPgn={copyPgn}
          reload={reloadBoard}
          addGame={addGame}
          topBar={false}
          showClock={false}
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
          toggleOrientation={flipBoard}
          disableVariations={false}
          currentTabSourceType={currentTab?.source?.type || undefined}
        />
      </Portal>

      <Portal target="#topRight" style={{ height: "100%" }}>
        <ResponsiveAnalysisPanels
          currentTab={currentTabSelected}
          onTabChange={(v) => setCurrentTabSelected(v || "info")}
          isRepertoire={showRepertoirePanels}
          isPuzzle={isPuzzle}
          showSimulate
        />
      </Portal>

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
        <VariantsNotation topBar={topBar} editingMode={editingMode} />
        <MoveControls readOnly />
        <VariantsActions
          treeBuilderRunning={treeBuilderRunning}
          onOpenPuzzle={() => {
            // Use treeBuilderDepth as the maximum depth for puzzles
            // This ensures the puzzle depth matches the depth configured in build variants
            const maxDepth = treeBuilderDepth;
            if (maxDepth < 1) {
              notifications.show({
                title: t("common.error"),
                message: t("errors.puzzleVariantsNeedSystemMove"),
                color: "red",
              });
              return;
            }
            setMaxPuzzleDepth(maxDepth);
            setPuzzleDepth(Math.min(puzzleDepth, maxDepth));
            setPuzzleModalOpened(true);
          }}
          onOpenTreeBuilder={() => setTreeBuilderOpened(true)}
          onCancelTreeBuilder={cancelTreeBuilder}
        />
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
