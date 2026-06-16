import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { makeSan } from "chessops/san";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings/generated";
import {
  activeProfileIdAtom,
  activeTabAtom,
  currentAnalysisTabAtom,
  currentDbTypeAtom,
  currentLocalOptionsAtom,
  enginesAtom,
  lichessOptionsAtom,
  masterOptionsAtom,
  profilesAtom,
  referenceDbAtom,
  tabEngineSettingsFamily,
} from "@/state/atoms";
import type { TreeStore } from "@/state/store/tree";
import { parseSanOrUci, positionFromFen } from "@/utils/chessops";
import { getDatabases } from "@/utils/db";
import type { LocalEngine } from "@/utils/engines";
import { readInfoMetadata, writeInfoMetadata } from "@/utils/files";
import type { LichessGamesOptions, MasterGamesOptions } from "@/utils/lichess/explorer";
import type { Tab } from "@/utils/tabs";
import { getNodeAtPath, type TreeNode } from "@/utils/treeReducer";
import {
  type BuildVariantsMode,
  buildVariantsTree as buildVariantsTreeBackend,
  type LichessGamesOptionsDto,
  type MasterGamesOptionsDto,
  type MoveSpecDto,
  type VariantsTreeNodeDto,
} from "@/utils/variantsBuilder";
import {
  normalizeTreeBuilderWarnings,
  shouldShowTreeBuilderDone,
  translateTreeBuilderWarning,
} from "./treeBuilderNotifications";
import type { VariantsAnalysisMainTab, VariantsDbType } from "./types";

type UseVariantsBuilderArgs = {
  store: TreeStore;
  currentTab: Tab | undefined;
  boardOrientation: string;
  is960: boolean;
};

type VariantsBuilderProgressPayload = {
  startPath?: number[];
  moves?: Array<{ value: string }>;
  phase?: TreeBuilderProgressPhase;
};

export type TreeBuilderProgressPhase = "idle" | "starting" | "engine" | "smart" | "database" | "applying" | "finishing";

export type TreeBuilderProgressState = {
  phase: TreeBuilderProgressPhase;
  appliedUpdates: number;
  lastMoveCount: number;
};

const idleTreeBuilderProgress: TreeBuilderProgressState = {
  phase: "idle",
  appliedUpdates: 0,
  lastMoveCount: 0,
};

function normalizeTreeBuilderPhase(value: unknown): TreeBuilderProgressPhase | null {
  if (
    value === "starting" ||
    value === "engine" ||
    value === "smart" ||
    value === "database" ||
    value === "applying" ||
    value === "finishing"
  ) {
    return value;
  }
  return null;
}

function toIso(value: Date | string | undefined) {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function toLichessOptionsDto(options: LichessGamesOptions): LichessGamesOptionsDto {
  return {
    ...options,
    since: toIso(options.since),
    until: toIso(options.until),
  };
}

function toMasterOptionsDto(options: MasterGamesOptions): MasterGamesOptionsDto {
  return {
    ...options,
    since: toIso(options.since),
    until: toIso(options.until),
  };
}

function errorMessage(error: unknown, fallback: string) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function useVariantsBuilder({ store, currentTab, boardOrientation, is960 }: UseVariantsBuilderArgs) {
  const { t } = useTranslation();
  const activeTab = useAtomValue(activeTabAtom);
  const engines = useAtomValue(enginesAtom);
  const [dbType, setDbType] = useAtom(currentDbTypeAtom);
  const [localOptions, setLocalOptions] = useAtom(currentLocalOptionsAtom);
  const lichessOptions = useAtomValue(lichessOptionsAtom);
  const masterOptions = useAtomValue(masterOptionsAtom);
  const referenceDatabase = useAtomValue(referenceDbAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const profiles = useAtomValue(profilesAtom);
  const lichessAuthToken =
    profiles.find((profile) => profile.id === activeProfileId)?.lichessToken?.trim() || undefined;

  const [treeBuilderRunning, setTreeBuilderRunning] = useState(false);
  const [treeBuilderOpened, setTreeBuilderOpened] = useState(false);
  const [treeBuilderDepth, setTreeBuilderDepth] = useState(2);
  const [treeBuilderCoverage, setTreeBuilderCoverage] = useState(90);
  const [treeBuilderMinMoves, setTreeBuilderMinMoves] = useState(2);
  const [treeBuilderEngineMs, setTreeBuilderEngineMs] = useState(800);
  const [treeBuilderMode, setTreeBuilderMode] = useState<BuildVariantsMode>("engine");
  const [treeBuilderProgress, setTreeBuilderProgress] = useState<TreeBuilderProgressState>(idleTreeBuilderProgress);
  const [selectedEngineKey, setSelectedEngineKey] = useState<string | null>(null);
  const [analysisMainTab, setAnalysisMainTab] = useState<VariantsAnalysisMainTab>("engines");
  const treeBuilderCancelRef = useRef(false);

  const loadedEngines = useMemo(
    () => engines.filter((engine): engine is LocalEngine => Boolean(engine.loaded) && engine.type === "local"),
    [engines],
  );
  const selectedEngine = useMemo(
    () => loadedEngines.find((engine) => engine.path === selectedEngineKey) ?? loadedEngines[0] ?? null,
    [loadedEngines, selectedEngineKey],
  );
  const [selectedEngineSettings, setSelectedEngineSettings] = useAtom(
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

    const nextKey = selectedEngine?.path ?? null;
    if (!nextKey || !loadedEngines.some((engine) => engine.path === nextKey)) {
      setSelectedEngineKey(loadedEngines[0].path);
    }
  }, [loadedEngines, selectedEngine]);

  const engineOptions = useMemo(
    () =>
      loadedEngines.map((engine) => ({
        value: engine.path,
        label: engine.name,
      })),
    [loadedEngines],
  );

  const { data: databases = [] } = useQuery({
    queryKey: ["databases"],
    queryFn: getDatabases,
  });

  const localDatabaseOptions = useMemo(
    () =>
      databases
        .filter((database) => database.type === "success")
        .map((database) => ({
          value: database.file,
          label: database.title,
        })),
    [databases],
  );

  useEffect(() => {
    if (dbType !== "local") return;
    if (localOptions.path) return;
    if (localDatabaseOptions.length === 0) return;
    setLocalOptions((prev) => ({ ...prev, path: localDatabaseOptions[0].value }));
  }, [dbType, localDatabaseOptions, localOptions.path, setLocalOptions]);

  const [, setCurrentAnalysisTab] = useAtom(currentAnalysisTabAtom);
  useEffect(() => {
    if (
      analysisMainTab === "practice" ||
      analysisMainTab === "build" ||
      analysisMainTab === "graph" ||
      analysisMainTab === "annotate" ||
      analysisMainTab === "info"
    ) {
      return;
    }
    setCurrentAnalysisTab(analysisMainTab);
  }, [analysisMainTab, setCurrentAnalysisTab]);

  const readEngineSettingNumber = useCallback(
    (name: string, fallback = 1) => {
      const raw = selectedEngineSettings.settings.find((setting) => setting.name === name)?.value;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    },
    [selectedEngineSettings.settings],
  );

  const updateEngineSettingNumber = useCallback(
    (name: string, value: number) => {
      const normalized = String(Math.max(1, Number(value) || 1));
      setSelectedEngineSettings((prev) => ({
        ...prev,
        settings: prev.settings.map((setting) => (setting.name === name ? { ...setting, value: normalized } : setting)),
      }));
    },
    [setSelectedEngineSettings],
  );

  const cancelTreeBuilder = useCallback(() => {
    treeBuilderCancelRef.current = true;
    void commands.killEngines("variants-builder-backend").catch(() => {
      // Ignore kill errors while cancelling build variants.
    });
  }, []);

  useEffect(() => {
    return () => {
      void commands.killEngines("variants-builder-backend").catch(() => {
        // Ignore cleanup errors on unmount.
      });
    };
  }, []);

  const buildVariantsTree = useCallback(async () => {
    if (treeBuilderRunning) return;
    setTreeBuilderRunning(true);
    setTreeBuilderProgress({
      phase: "starting",
      appliedUpdates: 0,
      lastMoveCount: 0,
    });
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

      const startFenForMetadata = startNode.fen;

      const attachDbCommentsForLine = async (lineMoves: MoveSpecDto[]) => {
        try {
          let path = [...startPath];
          let lastKnownOpening: string | null = null;

          try {
            const startTreeNode = getNodeAtPath(store.getState().root, startPath);
            if (startTreeNode) {
              const res = await commands.getOpeningFromFen(startTreeNode.fen);
              if (res.status === "ok" && res.data) {
                lastKnownOpening = res.data;
              } else {
                const resInfo = await commands.getOpeningInfoFromFen(startTreeNode.fen);
                if (resInfo.status === "ok" && resInfo.data) {
                  const { opening, variation } = resInfo.data;
                  lastKnownOpening = variation && variation.trim().length > 0 ? `${opening}: ${variation}` : opening;
                }
              }

              if (
                lastKnownOpening === "" ||
                lastKnownOpening === "Empty Board" ||
                lastKnownOpening === "Starting Position"
              ) {
                lastKnownOpening = null;
              }
            }
          } catch {
            // Ignore opening lookup errors for the start position.
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

            const nextIdx = node.children.findIndex((candidate) => candidate.san === san);
            if (nextIdx < 0) break;

            const isBlackMove = node.halfMoves % 2 === 0;
            const moveNumber = Math.ceil((node.halfMoves + 1) / 2);
            const moveText = isBlackMove ? `${moveNumber}... ${san}` : `${moveNumber}. ${san}`;

            path = [...path, nextIdx];
            store.getState().goToMove(path);
            const curState = store.getState();
            const cur = getNodeAtPath(curState.root, curState.position);
            if (!cur) continue;

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
              // Ignore opening lookup errors.
            }

            let comment: string | null = null;
            if (
              currentOpening &&
              currentOpening !== "" &&
              currentOpening !== "Empty Board" &&
              currentOpening !== "Starting Position"
            ) {
              comment = `[${currentOpening}]`;
              lastKnownOpening = currentOpening;
            } else if (lastKnownOpening) {
              comment = `[${lastKnownOpening} - ${moveText}]`;
            }

            if (comment && isOpponentMove) {
              const prev = (cur.comment ?? "").trim();
              if (!prev) {
                store.getState().setComment(comment);
              } else if (!prev.includes(comment)) {
                store.getState().setComment(`${prev}\n${comment}`);
              }
            }
          }
        } catch {
          // Ignore comment attach errors.
        }
      };

      const toDto = (node: TreeNode): VariantsTreeNodeDto => ({
        fen: node.fen,
        san: node.san ?? null,
        children: node.children.map(toDto),
      });

      const engineExtraOptions =
        selectedEngineSettings.settings.map((setting) => ({
          name: setting.name,
          value: setting.value?.toString() ?? "",
        })) ?? [];
      const localDbPath = localOptions.path ?? referenceDatabase ?? null;
      const lichessOptionsDto = toLichessOptionsDto(lichessOptions);
      const masterOptionsDto = toMasterOptionsDto(masterOptions);
      let expandedAny = false;
      let lastAppliedPosition: number[] | null = null;

      const unlistenProgress = await listen<VariantsBuilderProgressPayload>("variants_builder_progress", (event) => {
        if (treeBuilderCancelRef.current) return;
        const phase = normalizeTreeBuilderPhase(event.payload?.phase);
        if (phase) {
          setTreeBuilderProgress((prev) => ({
            ...prev,
            phase,
          }));
        }

        const payloadStartPath = event.payload?.startPath;
        const payloadMoves = event.payload?.moves;
        if (!payloadStartPath || !Array.isArray(payloadStartPath) || !payloadMoves || !Array.isArray(payloadMoves)) {
          return;
        }
        if (payloadMoves.length === 0) {
          return;
        }

        const state = store.getState();
        state.goToMove([...payloadStartPath]);
        const moves = payloadMoves.map((move) => move.value);
        const beforePos = [...store.getState().position];
        state.makeMoves({ payload: moves, mainline: false, changeHeaders: false });
        const afterPos = [...store.getState().position];

        if (afterPos.length === beforePos.length) return;

        expandedAny = true;
        lastAppliedPosition = afterPos;
        setTreeBuilderProgress((prev) => ({
          phase: phase ?? "applying",
          appliedUpdates: prev.appliedUpdates + 1,
          lastMoveCount: moves.length,
        }));
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
          lichessOptions: lichessOptionsDto,
          masterOptions: masterOptionsDto,
          lichessToken: lichessAuthToken ?? null,
          mode: treeBuilderMode,
          engine: selectedEngine
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
          forceRebuild: false,
          splitConfig: {
            enabled: false,
            mode: "none",
          },
        });
      } finally {
        unlistenProgress();
      }

      if (treeBuilderCancelRef.current) return;

      for (const line of res?.lines ?? []) {
        if (treeBuilderCancelRef.current) break;

        const state = store.getState();
        state.goToMove([...startPath]);
        const moves = line.moves.map((move) => move.value);
        const beforePos = [...store.getState().position];
        state.makeMoves({ payload: moves, mainline: false, changeHeaders: false });
        const afterPos = [...store.getState().position];

        if (afterPos.length === beforePos.length) {
          continue;
        }

        expandedAny = true;
        lastAppliedPosition = afterPos;
        setTreeBuilderProgress((prev) => ({
          phase: "applying",
          appliedUpdates: prev.appliedUpdates + 1,
          lastMoveCount: moves.length,
        }));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await attachDbCommentsForLine(line.moves);
      }

      if (lastAppliedPosition) {
        store.getState().goToMove(lastAppliedPosition);
      } else {
        store.getState().goToMove([...startPath]);
      }

      const backendWarnings = normalizeTreeBuilderWarnings(res?.warnings);

      if (!treeBuilderCancelRef.current) {
        if (currentTab?.source?.type === "file" && currentTab.source.path) {
          try {
            const { getOpening } = await import("@/utils/chess");
            const root = store.getState().root;
            const parentFilePath = currentTab.source.path;
            const metadata = await readInfoMetadata(parentFilePath, "variants");

            if (metadata.type === "variants") {
              const opening = await getOpening(root, startPath);
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

              if (opening) {
                metadata.tags.push(`opening:${opening}`);
              }
              if (startFenForMetadata) {
                metadata.tags.push(`fen:${startFenForMetadata}`);
              }
              if (treeBuilderDepth > 0) {
                metadata.tags.push(`depth:${treeBuilderDepth}`);
              }
              if (databaseName) {
                metadata.tags.push(`database:${databaseName}`);
              }
              if (selectedEngine?.name) {
                metadata.tags.push(`engine:${selectedEngine.name}`);
              }
              if (treeBuilderEngineMs > 0) {
                metadata.tags.push(`engineMs:${treeBuilderEngineMs}`);
              }
              if ((res?.lines?.length || 0) > 0) {
                metadata.tags.push(`variantsCount:${res?.lines?.length || 0}`);
              }

              metadata.type = "variants";
              if (!Array.isArray(metadata.tags)) {
                metadata.tags = [];
              }
              await writeInfoMetadata(parentFilePath, metadata);
              try {
                window.dispatchEvent(new Event("variants:links-updated"));
              } catch {}
            }
          } catch {
            // Ignore metadata update errors for variants files.
          }
        }

        if (backendWarnings.length > 0) {
          notifications.show({
            title: t("common.warning"),
            message: translateTreeBuilderWarning(backendWarnings[0], t),
            color: "yellow",
          });
        }

        if (!expandedAny) {
          if (backendWarnings.length === 0) {
            notifications.show({
              title: t("common.warning"),
              message: t("features.board.variants.treeBuilder.noNewVariants"),
              color: "yellow",
            });
          }
          return;
        }

        if (!shouldShowTreeBuilderDone(expandedAny)) {
          return;
        }

        notifications.show({
          title: t("common.success"),
          message: t("features.board.variants.treeBuilder.done"),
          color: "green",
        });
      }
    } catch (error) {
      notifications.show({
        title: t("common.error"),
        message: errorMessage(error, t("errors.unknownError")),
        color: "red",
      });
    } finally {
      try {
        await commands.killEngines("variants-builder-backend");
      } catch {
        // Ignore cleanup errors after build variants.
      }
      setTreeBuilderRunning(false);
      setTreeBuilderProgress(idleTreeBuilderProgress);
    }
  }, [
    boardOrientation,
    currentTab,
    dbType,
    is960,
    lichessAuthToken,
    lichessOptions,
    localOptions.path,
    masterOptions,
    referenceDatabase,
    selectedEngine,
    selectedEngineSettings.settings,
    store,
    t,
    treeBuilderCoverage,
    treeBuilderDepth,
    treeBuilderEngineMs,
    treeBuilderMinMoves,
    treeBuilderMode,
    treeBuilderRunning,
  ]);

  return {
    analysisMainTab,
    setAnalysisMainTab,
    dbType: dbType as VariantsDbType,
    setDbType,
    localOptions,
    setLocalOptions,
    referenceDatabase,
    localDatabaseOptions,
    treeBuilderRunning,
    treeBuilderOpened,
    setTreeBuilderOpened,
    treeBuilderDepth,
    setTreeBuilderDepth,
    treeBuilderCoverage,
    setTreeBuilderCoverage,
    treeBuilderMinMoves,
    setTreeBuilderMinMoves,
    treeBuilderEngineMs,
    setTreeBuilderEngineMs,
    treeBuilderMode,
    treeBuilderProgress,
    setTreeBuilderMode,
    engineOptions,
    selectedEngine,
    selectedEngineValue: selectedEngine?.path ?? null,
    setSelectedEngineKey,
    selectedEngineSettings,
    readEngineSettingNumber,
    updateEngineSettingNumber,
    loadedEngines,
    cancelTreeBuilder,
    buildVariantsTree,
    runDisabled: !treeBuilderRunning && !selectedEngine,
  };
}

export type VariantsBuilderModel = ReturnType<typeof useVariantsBuilder>;
