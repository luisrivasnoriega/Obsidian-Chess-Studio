import { invoke } from "@tauri-apps/api/core";

export type VariantsTreeNodeDto = {
  fen: string;
  san?: string | null;
  children: VariantsTreeNodeDto[];
};

export type LichessGamesOptionsDto = {
  variant?: string;
  speeds?: string[];
  ratings?: number[];
  since?: string;
  until?: string;
  moves?: number;
  topGames?: number;
  recentGames?: number;
  player?: string;
  color: "white" | "black";
};

export type MasterGamesOptionsDto = {
  since?: string;
  until?: string;
  moves?: number;
  topGames?: number;
};

export type EngineRequestDto = {
  name: string;
  path: string;
  extraOptions: Array<{ name: string; value: string }>;
};

export type BuildVariantsMode = "engine" | "smart";

export type SmartConfigDto = {
  candidateMultiPv?: number;
  validationFullMoves?: number;
  validationPlies?: number;
  playableThresholdCp?: number;
  maxValidationOpponentBranches?: number;
  validationBeamWidth?: number;
};

export type VariantsSplitMode = "none" | "manual" | "auto";

export type BuildVariantsSplitConfigDto = {
  enabled: boolean;
  mode: VariantsSplitMode;
  splitAtPly?: number;
  maxSegments?: number;
  maxLinesPerSegment?: number;
};

export type MoveSpecDto = {
  value: string;
  source?: "db" | "engine" | "smart";
  white?: number;
  black?: number;
  draws?: number;
  total?: number;
};

export type LineDto = {
  moves: MoveSpecDto[];
};

export type VariantsSegmentStatsDto = {
  lineCount: number;
};

export type VariantsSegmentDto = {
  id: string;
  anchorPly: number;
  anchorFen: string;
  anchorPath: number[];
  title?: string;
  lines: LineDto[];
  stats: VariantsSegmentStatsDto;
};

export type BuildVariantsTreeRequest = {
  root: VariantsTreeNodeDto;
  startPath: number[];
  orientation: "white" | "black";
  is960: boolean;
  dbType: "local" | "lch_all" | "lch_master";
  localDbPath?: string | null;
  lichessOptions?: LichessGamesOptionsDto;
  masterOptions?: MasterGamesOptionsDto;
  lichessToken?: string | null;
  mode: BuildVariantsMode;
  smartConfig?: SmartConfigDto;
  engine?: EngineRequestDto | null;
  engineMs: number;
  coverage: number;
  minMoves: number;
  depth: number;
  splitConfig?: BuildVariantsSplitConfigDto;
};

export type BuildVariantsTreeResponse = {
  lines: LineDto[];
  segments?: VariantsSegmentDto[];
  warnings?: string[];
};

export async function buildVariantsTree(request: BuildVariantsTreeRequest): Promise<BuildVariantsTreeResponse> {
  return await invoke<BuildVariantsTreeResponse>("build_variants_tree", { request });
}
