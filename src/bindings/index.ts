import { invoke } from "@tauri-apps/api/core";
import type {
  AnalysisOptions,
  BestMoves as BestMovesT,
  DatabaseInfo as DatabaseInfoT,
  EngineOption,
  GameQueryJs,
  GoMode,
  MoveAnalysis,
  Puzzle,
  Result,
  Score as ScoreT,
  ScoreValue as ScoreValueT,
} from "./generated";

export * from "./generated";
export type ScoreValue = ScoreValueT | { type: "dtz"; value: number };
export type Score = Omit<ScoreT, "value"> & { value: ScoreValue };
export type BestMoves = Omit<BestMovesT, "score"> & {
  score: Score;
};

export type StrategicProfile = "solid" | "positional" | "dynamic" | "attacking" | "conversion";

export type StrategicRiskFlag =
  | "materialInvestment"
  | "undefendedLandingSquare"
  | "lowDepthCandidate"
  | "forcedTacticalLine"
  | "mateRisk"
  | "unstableScore"
  | "wdlDrop";

export type StrategicMotif =
  | "damagedPawnStructure"
  | "weakPawnPressure"
  | "spaceGain"
  | "openFilePressure"
  | "centralKingPressure"
  | "pieceRestriction"
  | "wingClamp"
  | "outpostControl"
  | "colorComplexPressure"
  | "prophylaxis"
  | "favorableTrade"
  | "passedPawnConversion"
  | "initiativeSacrifice"
  | "counterplay"
  | "kingNet"
  | "pieceCoordination"
  | "tensionManagement";

export type HumanStrategicConfig = {
  maxEngineDropCp: number;
  maxAbsoluteDisadvantageCp: number;
  lastResortDisadvantageCp: number;
  minStrategicScore: number;
  highConvictionThreshold: number;
  profile?: StrategicProfile | null;
};

export type HumanStrategicRequest = {
  fen: string;
  moves: string[];
  candidates: BestMoves[];
  config?: HumanStrategicConfig;
};

export type HumanStrategicSelection = {
  selectedUci: string;
  selectedSan: string;
  selectedEngineCp: number;
  selectedEngineDropCp: number;
  selectedStrategicScore: number;
  selectedIsLastResort: boolean;
  bestEngineUci: string;
  bestEngineCp: number;
  candidates: HumanStrategicCandidate[];
};

export type HumanStrategicCandidate = {
  uci: string;
  san: string;
  pvUciLine: string[];
  engineRank: number | bigint;
  engineCp: number;
  engineDropCp: number;
  strategicScore: number;
  macroStrategicScore: number;
  finalScore: number;
  passesGuardrail: boolean;
  isLastResort: boolean;
  riskFlags: StrategicRiskFlag[];
  motifs: StrategicMotif[];
};

export type HumanStrategicAxisNarrative = {
  axis: string;
  score: number;
  explanation: string;
};

export type HumanMoveNarrative = {
  ply: number;
  sideToMove: string;
  playedUci: string;
  playedSan: string;
  engineBestUci: string | null;
  engineBestSan: string | null;
  strategicChoiceUci: string | null;
  strategicChoiceSan: string | null;
  verdict: string;
  evalBeforeCp: number | null;
  evalAfterCp: number | null;
  cpLoss: number | null;
  playedStrategicScore: number | null;
  playedMotifs: string[];
  strategicAxes: HumanStrategicAxisNarrative[];
  strategicPlan: string;
  commentShort: string;
  commentLong: string;
  suggestedVariationUci: string[];
  suggestedVariationSan: string[];
};

export type HumanStrategicGameSummary = {
  bestCount: number;
  greatCount: number;
  practicalCount: number;
  interestingCount: number;
  dubiousCount: number;
  mistakeCount: number;
  blunderCount: number;
  topThemes: string[];
};

export type HumanAnnotatedGameReport = {
  annotatedPgn: string;
  narratives: HumanMoveNarrative[];
  summary: HumanStrategicGameSummary;
  analysis: MoveAnalysis[];
};

export type HumanStrategicLiveRequest = {
  fen: string;
  moves: string[];
  candidates: BestMoves[];
  config?: HumanStrategicConfig | null;
  maxVariationPlies?: number | null;
  maxLines?: number | null;
};

export type HumanStrategicLiveLine = {
  uci: string;
  san: string;
  engineRank: number;
  engineCp: number;
  engineDropCp: number;
  strategicScore: number;
  finalScore: number;
  isSelected: boolean;
  isEngineBest: boolean;
  motifs: StrategicMotif[];
  strategicAxes: HumanStrategicAxisNarrative[];
  strategicPlan: string;
  commentShort: string;
  commentLong: string;
  suggestedVariationUci: string[];
  suggestedVariationSan: string[];
};

export type HumanStrategicLiveResponse = {
  selectedUci: string;
  selectedSan: string;
  bestEngineUci: string;
  bestEngineSan: string;
  lines: HumanStrategicLiveLine[];
};

export type HumanGameAnalysisRequest = {
  id: string;
  engine: string;
  goMode: GoMode;
  options: AnalysisOptions;
  uciOptions: EngineOption[];
  originalPgn?: string | null;
  strategicVariationMaxPlies?: number | null;
};

export type DatabaseInfo =
  | (DatabaseInfoT & {
      type: "success";
      file: string;
      downloadLink?: string;
      filter?: GameQuery;
    })
  | {
      type: "error";
      file: string;
      filename: string;
      error: string;
      indexed: boolean;
    };

export type GameQuery = GameQueryJs;

export async function pickHumanStrategicMove(
  request: HumanStrategicRequest,
): Promise<Result<HumanStrategicSelection, string>> {
  try {
    return {
      status: "ok",
      data: await invoke("pick_human_strategic_move", { request }),
    };
  } catch (e) {
    if (e instanceof Error) throw e;
    return { status: "error", error: e as any };
  }
}

export async function analyzeGameHumanStrategicReport(
  request: HumanGameAnalysisRequest,
): Promise<Result<HumanAnnotatedGameReport, string>> {
  try {
    return {
      status: "ok",
      data: await invoke("analyze_game_human_report", { request }),
    };
  } catch (e) {
    if (e instanceof Error) throw e;
    return { status: "error", error: e as any };
  }
}

export async function buildHumanStrategicLiveReport(
  request: HumanStrategicLiveRequest,
): Promise<Result<HumanStrategicLiveResponse, string>> {
  try {
    return {
      status: "ok",
      data: await invoke("build_human_strategic_live_report", { request }),
    };
  } catch (e) {
    if (e instanceof Error) throw e;
    return { status: "error", error: e as any };
  }
}

export type PuzzleFiltersMetadata = {
  ratingRange: [number, number] | null;
  hasThemes: boolean;
  hasOpeningTags: boolean;
  themes: Array<{ group: string; items: Array<{ value: string; label: string }> }>;
  openingTags: Array<{ value: string; label: string }>;
};

export async function getPuzzleBatch(
  file: string,
  minRating: number,
  maxRating: number,
  random: boolean,
  themes: string[] | null,
  openingTags: string[] | null,
  sideToMove: string | null,
  count: number,
): Promise<Result<Puzzle[], string>> {
  try {
    return {
      status: "ok",
      data: await invoke("get_puzzle_batch", {
        file,
        minRating,
        maxRating,
        random,
        themes,
        openingTags,
        sideToMove,
        count,
      }),
    };
  } catch (e) {
    if (e instanceof Error) throw e;
    return { status: "error", error: e as any };
  }
}

export async function getPuzzleFiltersMetadata(file: string): Promise<Result<PuzzleFiltersMetadata, string>> {
  try {
    return {
      status: "ok",
      data: await invoke("get_puzzle_filters_metadata", { file }),
    };
  } catch (e) {
    if (e instanceof Error) throw e;
    return { status: "error", error: e as any };
  }
}

export async function getPuzzleDependentFiltersMetadata(
  file: string,
  minRating: number,
  maxRating: number,
  themes: string[] | null,
  openingTags: string[] | null,
  sideToMove: string | null,
): Promise<Result<PuzzleFiltersMetadata, string>> {
  try {
    return {
      status: "ok",
      data: await invoke("get_puzzle_dependent_filters_metadata", {
        file,
        minRating,
        maxRating,
        themes,
        openingTags,
        sideToMove,
      }),
    };
  } catch (e) {
    if (e instanceof Error) throw e;
    return { status: "error", error: e as any };
  }
}
