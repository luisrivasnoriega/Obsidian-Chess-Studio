import type { MantineColor } from "@mantine/core";
import { parseUci } from "chessops";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import equal from "fast-deep-equal";
import { atom, type PrimitiveAtom } from "jotai";
import { atomFamily, atomWithStorage, createJSONStorage, loadable } from "jotai/utils";
import type { AtomFamily } from "jotai/vanilla/utils/atomFamily";
import type { SyncStorage } from "jotai/vanilla/utils/atomWithStorage";
import type { ReviewLog } from "ts-fsrs";
import { z } from "zod";
import type { BestMoves, GoMode } from "@/bindings";
import type { LocalOptions } from "@/components/panels/database/DatabasePanel";
import type { OpponentSettings } from "@/features/boards/components/BoardGame";
import { type Position, positionSchema } from "@/features/files/utils/opening";
import { positionFromFen, swapMove } from "@/utils/chessops";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { buildEngineVariationCacheKey } from "@/utils/engineCacheKey";
import { type Engine, type EngineSettings, engineSchema } from "@/utils/engines";
import {
  type LichessGamesOptions,
  lichessGamesOptionsSchema,
  type MasterGamesOptions,
  masterOptionsSchema,
} from "@/utils/lichess/explorer";
import type { MissingMove } from "@/utils/repertoire";
import { getWinChance, normalizeScore } from "@/utils/score";
import { genID, type Tab, tabSchema } from "@/utils/tabs";
import type { Session } from "../utils/session";
import { createAsyncZodStorage, createZodStorage, fileStorage } from "./utils";

const zodArray = <S>(itemSchema: z.ZodType<S>) => {
  const catchValue = {} as never;

  const res = z
    .array(itemSchema.catch(catchValue))
    .transform((a) => a.filter((o) => o !== catchValue))
    .catch([]);

  return res as z.ZodType<S[]>;
};

export const enginesAtom = atomWithStorage<Engine[]>(
  "engines/engines.json",
  [],
  createAsyncZodStorage(zodArray(engineSchema), fileStorage),
);

export const loadableEnginesAtom = loadable(enginesAtom);

// Tabs
export const tabsAtom = atomWithStorage<Tab[]>("tabs", [], createZodStorage(z.array(tabSchema), sessionStorage));

export const activeTabAtom = atomWithStorage<string | null>(
  "activeTab",
  null,
  createJSONStorage(() => sessionStorage),
);

export const currentTabAtom = atom(
  (get) => {
    const tabs = get(tabsAtom);
    const activeTab = get(activeTabAtom);
    return tabs.find((tab) => tab.value === activeTab);
  },
  (get, set, newValue: Tab | ((currentTab: Tab) => Tab)) => {
    const tabs = get(tabsAtom);
    const activeTab = get(activeTabAtom);
    const nextValue = typeof newValue === "function" ? newValue(get(currentTabAtom)!) : newValue;
    const newTabs = tabs.map((tab) => {
      if (tab.value === activeTab) {
        return nextValue;
      }
      return tab;
    });
    set(tabsAtom, newTabs);
  },
);

// Directories
export const storedDocumentDirAtom = atomWithStorage<string>("document-dir", "", undefined, { getOnInit: true });

// Settings

export const fontSizeAtom = atomWithStorage(
  "font-size",
  Number.parseInt(document.documentElement.style.fontSize, 10) || 100,
);

export const moveNotationTypeAtom = atomWithStorage<"letters" | "symbols" | "letters-translated">("letters", "symbols");
export const moveMethodAtom = atomWithStorage<"drag" | "select" | "both">("move-method", "both");
export const spellCheckAtom = atomWithStorage<boolean>("spell-check", false);
export const moveInputAtom = atomWithStorage<boolean>("move-input", false);
export const showDestsAtom = atomWithStorage<boolean>("show-dests", true);
export const snapArrowsAtom = atomWithStorage<boolean>("snap-dests", true);
export const showArrowsAtom = atomWithStorage<boolean>("show-arrows", true);
export const showConsecutiveArrowsAtom = atomWithStorage<boolean>("show-consecutive-arrows", true);
export const eraseDrawablesOnClickAtom = atomWithStorage<boolean>("erase-drawables-on-click", false);
export const autoPromoteAtom = atomWithStorage<boolean>("auto-promote", false);
export const autoSaveAtom = atomWithStorage<boolean>("auto-save", true);
export const previewBoardOnHoverAtom = atomWithStorage<boolean>("preview-board-on-hover", true);
export const enableBoardScrollAtom = atomWithStorage<boolean>("board-scroll", true);
export const showCoordinatesAtom = atomWithStorage<"none" | "inside" | "all">("coordinates-mode", "inside", undefined, {
  getOnInit: true,
});
export const soundCollectionAtom = atomWithStorage<string>("sound-collection", "standard", undefined, {
  getOnInit: true,
});

export const soundVolumeAtom = atomWithStorage<number>("sound-volume", 0.8, undefined, {
  getOnInit: true,
});

export const pieceSetAtom = atomWithStorage<string>("piece-set", "staunty");
export const boardImageAtom = atomWithStorage<string>("board-image", "gray.svg");
export const blindfoldAtom = atomWithStorage<boolean>("blindfold-mode", false);
export const welcomeCardImageAtom = atomWithStorage<string | null>("welcome-card-image", null);
export const sidebarExpandedAtom = atomWithStorage<boolean>("sidebar-expanded", false, undefined, {
  getOnInit: true,
});
// Legacy primary color atom for backward compatibility
export const primaryColorAtom = atomWithStorage<MantineColor>("mantine-primary-color", "blue");
export const sessionsAtom = atomWithStorage<Session[]>("sessions", []);

export type Profile = {
  id: string;
  name: string;
  fideId?: string;
  displayName?: string;
  lichessToken?: string;
  hasPremiumAccess?: boolean;
  premiumUsername?: string;
  premiumValidatedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export const profilesAtom = atomWithStorage<Profile[]>("profiles", [], undefined, { getOnInit: true });
export const activeProfileIdAtom = atomWithStorage<string | null>("activeProfileId", null, undefined, {
  getOnInit: true,
});

const profilesPageSortSchema = z.object({
  field: z.enum(["name", "lastActivity"]),
  direction: z.enum(["asc", "desc"]),
});

const profilesPageUiStateSchema = z.object({
  profileQuery: z.string(),
  detailsTab: z.enum(["database", "overview", "ratings", "openings", "stats", "pawnStructures"]),
  profilesPage: z.number().int().min(1),
  sortBy: profilesPageSortSchema,
});

export type ProfilesPageUiState = z.infer<typeof profilesPageUiStateSchema>;

export const defaultProfilesPageUiState: ProfilesPageUiState = {
  profileQuery: "",
  detailsTab: "database",
  profilesPage: 1,
  sortBy: {
    field: "lastActivity",
    direction: "desc",
  },
};

export const profilesPageUiStateAtom = atomWithStorage<ProfilesPageUiState>(
  "profiles-page-ui-state",
  defaultProfilesPageUiState,
  createZodStorage(profilesPageUiStateSchema, sessionStorage),
  { getOnInit: true },
);

const profileStatsUiStateSchema = z.object({
  platform: z.enum(["all", "Chess.com", "Lichess"]),
  timeControl: z.enum(["any", "ultra_bullet", "bullet", "blitz", "rapid", "classical", "correspondence", "daily"]),
  opponentEloBucket: z.string(),
  dateRange: z.enum(["7d", "30d", "90d", "1y", "all"]).nullable(),
  groupBy: z.enum(["phase", "outcomeAccuracy", "outcomeReason", "intensity", "weakness"]),
  tacticalFilter: z.enum(["none", "forks"]),
});

export type ProfileStatsUiState = z.infer<typeof profileStatsUiStateSchema>;

export const defaultProfileStatsUiState: ProfileStatsUiState = {
  platform: "all",
  timeControl: "any",
  opponentEloBucket: "all",
  dateRange: "all",
  groupBy: "phase",
  tacticalFilter: "none",
};

const profileStatsUiStateByProfileSchema = z.record(z.string(), profileStatsUiStateSchema).catch({});

export const profileStatsUiStateByProfileAtom = atomWithStorage<Record<string, ProfileStatsUiState>>(
  "profile-stats-ui-by-profile",
  {},
  createZodStorage(profileStatsUiStateByProfileSchema, sessionStorage),
  { getOnInit: true },
);

const profilePawnStructuresUiStateSchema = z.object({
  pawnMoveFilter: z.number().int().min(1).max(50),
  pawnColorFilter: z.enum(["white", "black", "any"]),
  pawnStructureMode: z.enum(["player", "both"]),
  pawnMotifFilters: z.array(z.string()),
  pawnNamedStructureFilters: z.array(z.string()),
  pawnSortBy: z.enum(["frequency", "winRate"]),
  platform: z.enum(["all", "Chess.com", "Lichess"]),
  timeControl: z.enum(["any", "ultra_bullet", "bullet", "blitz", "rapid", "classical", "correspondence", "daily"]),
  opponentEloBucket: z.string(),
  dateRange: z.enum(["7d", "30d", "90d", "1y", "all"]).nullable(),
});

export type ProfilePawnStructuresUiState = z.infer<typeof profilePawnStructuresUiStateSchema>;

export const defaultProfilePawnStructuresUiState: ProfilePawnStructuresUiState = {
  pawnMoveFilter: 10,
  pawnColorFilter: "white",
  pawnStructureMode: "player",
  pawnMotifFilters: [],
  pawnNamedStructureFilters: [],
  pawnSortBy: "frequency",
  platform: "all",
  timeControl: "any",
  opponentEloBucket: "all",
  dateRange: "90d",
};

const profilePawnStructuresUiStateByProfileSchema = z.record(z.string(), profilePawnStructuresUiStateSchema).catch({});

export const profilePawnStructuresUiStateByProfileAtom = atomWithStorage<Record<string, ProfilePawnStructuresUiState>>(
  "profile-pawn-structures-ui-by-profile",
  {},
  createZodStorage(profilePawnStructuresUiStateByProfileSchema, sessionStorage),
  { getOnInit: true },
);

const dashboardOpeningAccuracyTimeControlSchema = z.enum([
  "ultra_bullet",
  "bullet",
  "blitz",
  "rapid",
  "classical",
  "correspondence",
  "daily",
]);

const dashboardOpeningAccuracyPreferencesSchema = z.object({
  timeControlCategories: z.array(dashboardOpeningAccuracyTimeControlSchema).catch([]),
  sortMode: z.enum(["accuracy", "frequency", "winRate"]).catch("accuracy"),
});

export type DashboardOpeningAccuracyPreferences = z.infer<typeof dashboardOpeningAccuracyPreferencesSchema>;

export const defaultDashboardOpeningAccuracyPreferences: DashboardOpeningAccuracyPreferences = {
  timeControlCategories: [],
  sortMode: "accuracy",
};

const dashboardOpeningAccuracyPreferencesByProfileSchema = z
  .record(z.string(), dashboardOpeningAccuracyPreferencesSchema)
  .catch({});

export const dashboardOpeningAccuracyPreferencesByProfileAtom = atomWithStorage<
  Record<string, DashboardOpeningAccuracyPreferences>
>(
  "dashboard-opening-accuracy-preferences-by-profile",
  {},
  createZodStorage(dashboardOpeningAccuracyPreferencesByProfileSchema, localStorage),
  { getOnInit: true },
);

export const activeProfileHasPremiumAccessAtom = atom((get) => {
  const activeProfileId = get(activeProfileIdAtom);
  if (!activeProfileId) return false;
  const profiles = get(profilesAtom);
  return profiles.some((profile) => profile.id === activeProfileId && profile.hasPremiumAccess === true);
});

export const activeProfilePremiumUsernameAtom = atom((get) => {
  const activeProfileId = get(activeProfileIdAtom);
  if (!activeProfileId) return null;
  const profiles = get(profilesAtom);
  const profile = profiles.find((item) => item.id === activeProfileId);
  const username = profile?.premiumUsername?.trim();
  return username && username.length > 0 ? username : null;
});

export const orionPlanApiKeyAtom = atom<string>("");
export const orionPlanProviderSignatureAtom = atomWithStorage<string>("orion-plan-provider-signature", "", undefined, {
  getOnInit: true,
});

// Database

export const referenceDbAtom = atomWithStorage<string | null>("reference-database", null);

export const selectedPuzzleDbAtom = atomWithStorage<string | null>("puzzle-db", null);
export const puzzleUnsolvedOnlyDbAtom = atomWithStorage<string | null>(
  "puzzle-unsolved-only-db",
  null,
  createJSONStorage(() => sessionStorage),
  { getOnInit: true },
);

export const selectedDatabaseAtom = atomWithStorage<SuccessDatabaseInfo | null>(
  "database-view",
  null,
  createJSONStorage(() => sessionStorage),
);

// Opening Report

export const percentageCoverageAtom = atomWithStorage<number>("percentage-coverage", 95);

type TabMap<T> = Record<string, T>;

export const minimumGamesAtom = atomWithStorage<number>("minimum-games", 5);

// Practice/Repertoire Training

export type PracticeAnimationSpeed = "disabled" | "very-fast" | "fast" | "normal" | "slow" | "very-slow";

export const practiceAnimationSpeedAtom = atomWithStorage<PracticeAnimationSpeed>("practice-animation-speed", "normal");

export const missingMovesAtom = atomWithStorage<TabMap<MissingMove[] | null>>(
  "missing-moves",
  {},
  createJSONStorage(() => sessionStorage),
);

function tabValue<T extends object | string | boolean | number | null | undefined>(
  family: AtomFamily<string, PrimitiveAtom<T>>,
) {
  return atom(
    (get) => {
      const tab = get(currentTabAtom);
      if (!tab) {
        const newTab: Tab = {
          name: "New Tab",
          value: genID(),
          type: "new",
        };
        const atom = family(newTab.value);
        return get(atom);
      }

      const atom = family(tab.value);
      return get(atom);
    },
    (get, set, newValue: T | ((currentValue: T) => T)) => {
      const tab = get(currentTabAtom);
      if (!tab) {
        const newTab: Tab = {
          name: "New Tab",
          value: genID(),
          type: "new",
        };
        const nextValue = typeof newValue === "function" ? newValue(get(tabValue(family)) as T) : newValue;
        const atom = family(newTab.value);
        set(atom, nextValue);
        return;
      }

      const nextValue = typeof newValue === "function" ? newValue(get(tabValue(family)) as T) : newValue;
      const atom = family(tab.value);
      set(atom, nextValue);
    },
  );
}

// Puzzles
export const hidePuzzleRatingAtom = atomWithStorage<boolean>("hide-puzzle-rating", false);
export const progressivePuzzlesAtom = atomWithStorage<boolean>("progressive-puzzles", false);
export const jumpToNextPuzzleAtom = atomWithStorage<"off" | "success" | "success-and-failure">(
  "puzzle-jump-next",
  "success",
);
export const puzzleRatingRangeAtom = atomWithStorage<[number, number]>("puzzle-ratings", [1000, 1500]);
export const puzzleAdaptiveOffsetAtom = atomWithStorage<number>("puzzle-adaptive-offset", 0);
export const inOrderPuzzlesAtom = atomWithStorage<boolean>("puzzle-in-order", false);
export const puzzleSideToMoveAtom = atomWithStorage<"any" | "white" | "black">("puzzle-side-to-move", "any");
export const puzzlePlayerRatingAtom = atomWithStorage<number>("puzzle-player-rating", 1500);
export const maxPuzzlePlayerRatingAtom = atomWithStorage<number>("puzzle-max-player-rating", 1500);

// CP / WDL

export const reportTypeAtom = atom<"CP" | "WDL">("CP");

export const scoreTypeFamily = atomFamily((_engine: string) => atom<"cp" | "wdl">("cp"));

export const coverageEngineAnalysisActiveAtom = atom(false);
export const boardInteractionActiveAtom = atom(false);

// Per tab settings

const threatFamily = atomFamily((_tab: string) => atom(false));
export const currentThreatAtom = tabValue(threatFamily);

const evalOpenFamily = atomFamily((_tab: string) => atom(true));
export const currentEvalOpenAtom = tabValue(evalOpenFamily);

const invisibleFamily = atomFamily((_tab: string) => atom(false));
export const currentInvisibleAtom = tabValue(invisibleFamily);

const tabFamily = atomFamily((_tab: string) => atom("info"));
export const currentTabSelectedAtom = tabValue(tabFamily);

const localOptionsFamily = atomFamily((_tab: string) =>
  atom<LocalOptions>({
    path: null,
    type: "exact",
    fen: "",
    players: [],
    color: "any",
    result: "any",
  }),
);
export const currentLocalOptionsAtom = tabValue(localOptionsFamily);

export const lichessOptionsAtom = atomWithStorage<LichessGamesOptions>(
  "lichess-all-options",
  {
    ratings: [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500],
    speeds: ["bullet", "blitz", "rapid", "classical", "correspondence"],
    color: "white",
  },
  createZodStorage(lichessGamesOptionsSchema, localStorage),
  {
    getOnInit: true,
  },
);

export const masterOptionsAtom = atomWithStorage<MasterGamesOptions>(
  "lichess-master-options",
  {},
  createZodStorage(masterOptionsSchema, localStorage),
  {
    getOnInit: true,
  },
);

const dbTypeFamily = atomFamily((_tab: string) => atom<"local" | "lch_all" | "lch_master">("local"));
export const currentDbTypeAtom = tabValue(dbTypeFamily);

const dbTabFamily = atomFamily((_tab: string) => atom("stats"));
export const currentDbTabAtom = tabValue(dbTabFamily);

// Default analysis sub-tab inside AnalysisPanel.
// Previously this was "engines", but UX-wise it's more useful to start on the Report view.
const analysisTabFamily = atomFamily((_tab: string) => atom("report"));
export const currentAnalysisTabAtom = tabValue(analysisTabFamily);

const practiceTabFamily = atomFamily((_tab: string) => atom("train"));
export const currentPracticeTabAtom = tabValue(practiceTabFamily);

const expandedEnginesFamily = atomFamily((_tab: string) => atom<string[] | undefined>(undefined));
export const currentExpandedEnginesAtom = tabValue(expandedEnginesFamily);

const pgnOptionsFamily = atomFamily((_tab: string) =>
  atom({
    comments: true,
    glyphs: true,
    variations: true,
    extraMarkups: true,
  }),
);
export const currentPgnOptionsAtom = tabValue(pgnOptionsFamily);

const currentPuzzleFamily = atomFamily((_tab: string) => atom(0));
export const currentPuzzleAtom = tabValue(currentPuzzleFamily);

// Game

export type GameState = "settingUp" | "playing" | "gameOver";
const gameStateFamily = atomFamily((_tab: string) => atom<GameState>("settingUp"));
export const currentGameStateAtom = tabValue(gameStateFamily);

const playersFamily = atomFamily((_tab: string) =>
  atom<{
    white: OpponentSettings;
    black: OpponentSettings;
  }>({ white: {} as OpponentSettings, black: {} as OpponentSettings }),
);
export const currentPlayersAtom = tabValue(playersFamily);

// Practice

const reviewLogSchema = z
  .object({
    fen: z.string(),
  })
  .passthrough();

const practiceDataSchema = z.object({
  positions: positionSchema.array(),
  logs: reviewLogSchema.array(),
});

export type PracticeData = {
  positions: Position[];
  logs: (ReviewLog & { fen: string })[];
};

export const deckAtomFamily = atomFamily(
  ({ file, game }: { file: string; game: number }) =>
    atomWithStorage<PracticeData>(
      `deck-${file}-${game}`,
      {
        positions: [],
        logs: [],
      },
      createZodStorage(practiceDataSchema, localStorage) as any as SyncStorage<PracticeData>, // TODO: fix types
    ),

  (a, b) => a.file === b.file && a.game === b.game,
);

export const engineMovesFamily = atomFamily(
  ({ tab, engine }: { tab: string; engine: string }) => atom<Map<string, BestMoves[]>>(new Map()),
  (a, b) => a.tab === b.tab && a.engine === b.engine,
);

export const engineProgressFamily = atomFamily(
  ({ tab, engine }: { tab: string; engine: string }) => atom<number>(0),
  (a, b) => a.tab === b.tab && a.engine === b.engine,
);

// returns the best moves of each engine for the current position
export const bestMovesFamily = atomFamily(
  ({ fen, gameMoves }: { fen: string; gameMoves: string[] }) =>
    atom<Map<number, { pv: string[]; winChance: number }[]>>((get) => {
      const tab = get(activeTabAtom);
      if (!tab) return new Map();
      const engines = get(loadableEnginesAtom);
      if (!(engines.state === "hasData")) return new Map();
      const bestMoves = new Map<number, { pv: string[]; winChance: number }[]>();

      // Perf: compute the final position once (not once per engine).
      const [basePos] = positionFromFen(fen);
      let finalFen = INITIAL_FEN;
      let finalTurn: "white" | "black" = "white";
      if (basePos) {
        for (const move of gameMoves) {
          const m = parseUci(move);
          if (!m) break;
          basePos.play(m);
        }
        finalFen = makeFen(basePos.toSetup());
        finalTurn = basePos.turn;
      }
      const threatKey = buildEngineVariationCacheKey(swapMove(finalFen), []);
      const currentKey = buildEngineVariationCacheKey(fen, gameMoves);

      let n = 0;
      for (const engine of engines.data.filter((e) => e.loaded)) {
        const engineMoves = get(engineMovesFamily({ tab, engine: engine.name }));
        const moves = engineMoves.get(threatKey) || engineMoves.get(currentKey);
        if (moves && moves.length > 0) {
          const bestWinChange = getWinChance(normalizeScore(moves[0].score.value, finalTurn));
          bestMoves.set(
            n,
            moves.reduce<{ pv: string[]; winChance: number }[]>((acc, m) => {
              const winChance = getWinChance(normalizeScore(m.score.value, finalTurn));
              if (bestWinChange - winChance < 10) {
                acc.push({ pv: m.uciMoves, winChance });
              }
              return acc;
            }, []),
          );
        }
        n++;
      }
      return bestMoves;
    }),
  (a, b) => a.fen === b.fen && equal(a.gameMoves, b.gameMoves),
);
const BEST_MOVES_FAMILY_MAX_AGE_MS = 10 * 60 * 1000;
bestMovesFamily.setShouldRemove((createdAt) => Date.now() - createdAt > BEST_MOVES_FAMILY_MAX_AGE_MS);

export const tabEngineSettingsFamily = atomFamily(
  ({
    tab,
    engineName,
    defaultSettings,
    defaultGo,
  }: {
    tab: string;
    engineName: string;
    defaultSettings?: EngineSettings;
    defaultGo?: GoMode;
  }) => {
    return atom<{
      enabled: boolean;
      settings: EngineSettings;
      go: GoMode;
      synced: boolean;
    }>({
      enabled: false,
      settings: defaultSettings || [],
      go: defaultGo || { t: "Infinite" },
      synced: true,
    });
  },
  (a, b) => a.tab === b.tab && a.engineName === b.engineName,
);

export const activeEngineAnalysisAtom = loadable(
  atom(async (get) => {
    const tab = get(activeTabAtom);
    if (!tab) return null;

    const engines = await get(enginesAtom);
    for (const engine of engines.filter((entry) => entry.loaded)) {
      const settingsAtom = tabEngineSettingsFamily({
        tab,
        engineName: engine.name,
        defaultSettings: engine.type === "local" ? engine.settings || [] : undefined,
        defaultGo: engine.go ?? undefined,
      });

      if (get(settingsAtom).enabled) {
        return {
          engineName: engine.name,
          moves: get(engineMovesFamily({ tab, engine: engine.name })),
        };
      }
    }

    return null;
  }),
);

export const allEnabledAtom = loadable(
  atom(async (get) => {
    const engines = await get(enginesAtom);

    const v = engines
      .filter((e) => e.loaded)
      .every((engine) => {
        const atom = tabEngineSettingsFamily({
          tab: get(activeTabAtom)!,
          engineName: engine.name,
          defaultSettings: engine.type === "local" ? engine.settings || [] : undefined,
          defaultGo: engine.go ?? undefined,
        });
        return get(atom).enabled;
      });

    return v;
  }),
);

export const enableAllAtom = atom(null, (get, set, value: boolean) => {
  const engines = get(loadableEnginesAtom);
  if (!(engines.state === "hasData")) return;

  for (const engine of engines.data.filter((e) => e.loaded)) {
    const atom = tabEngineSettingsFamily({
      tab: get(activeTabAtom)!,
      engineName: engine.name,
      defaultSettings: engine.type === "local" ? engine.settings || [] : undefined,
      defaultGo: engine.go ?? undefined,
    });
    set(atom, { ...get(atom), enabled: value });
  }
});

export function cleanupTabScopedAtoms(tabId: string, engineNames: string[] = []) {
  if (!tabId) return;

  threatFamily.remove(tabId);
  evalOpenFamily.remove(tabId);
  invisibleFamily.remove(tabId);
  tabFamily.remove(tabId);
  localOptionsFamily.remove(tabId);
  dbTypeFamily.remove(tabId);
  dbTabFamily.remove(tabId);
  analysisTabFamily.remove(tabId);
  practiceTabFamily.remove(tabId);
  expandedEnginesFamily.remove(tabId);
  pgnOptionsFamily.remove(tabId);
  currentPuzzleFamily.remove(tabId);
  gameStateFamily.remove(tabId);
  playersFamily.remove(tabId);

  // Always remove all engine-scoped atom families for this tab, even if the caller
  // doesn't have an up-to-date engine list.
  for (const param of Array.from(engineMovesFamily.getParams())) {
    if (param.tab === tabId) {
      engineMovesFamily.remove(param);
    }
  }

  for (const param of Array.from(engineProgressFamily.getParams())) {
    if (param.tab === tabId) {
      engineProgressFamily.remove(param);
    }
  }

  for (const param of Array.from(tabEngineSettingsFamily.getParams())) {
    if (param.tab === tabId) {
      tabEngineSettingsFamily.remove(param);
    }
  }

  // Backward-compatible explicit cleanup for callers providing engine names.
  for (const engineName of engineNames) {
    engineMovesFamily.remove({ tab: tabId, engine: engineName });
    engineProgressFamily.remove({ tab: tabId, engine: engineName });
    tabEngineSettingsFamily.remove({
      tab: tabId,
      engineName,
    });
  }
}
