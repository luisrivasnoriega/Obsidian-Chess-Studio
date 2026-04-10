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
  mode: "engine" | "winrate";
  engine?: EngineRequestDto | null;
  engineMs: number;
  coverage: number;
  minMoves: number;
  depth: number;
};

export type BuildVariantsTreeResponse = {
  lines: Array<{
    moves: Array<{
      value: string;
      source?: "db" | "engine";
      white?: number;
      black?: number;
      draws?: number;
      total?: number;
    }>;
  }>;
};

export async function buildVariantsTree(request: BuildVariantsTreeRequest): Promise<BuildVariantsTreeResponse> {
  return await invoke<BuildVariantsTreeResponse>("build_variants_tree", { request });
}
