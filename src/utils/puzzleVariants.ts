import { invoke } from "@tauri-apps/api/core";

export type PuzzleTreeNodeDto = {
  fen: string;
  san?: string | null;
  openingName?: string | null;
  children: PuzzleTreeNodeDto[];
};

export type GeneratePuzzleVariantsResponse = {
  pgn: string;
  count: number;
};

export type CoveragePuzzleTier = "mainline" | "secondary" | "alternative";

export type CoveragePuzzleTierFilter = CoveragePuzzleTier | "all";

export type CoveragePuzzleGeneration = {
  tier: CoveragePuzzleTier;
  pgn: string;
  count: number;
};

export type GeneratePuzzleVariantsFromCoverageNodeResponse = {
  results: CoveragePuzzleGeneration[];
  emptyTiers: CoveragePuzzleTier[];
  ecoVariant: string | null;
};

export async function generatePuzzleVariantsFromTree(params: {
  root: PuzzleTreeNodeDto;
  orientation: "white" | "black";
  selectedDepth: number;
  allowedStartKeys?: string[];
}): Promise<GeneratePuzzleVariantsResponse> {
  const { root, orientation, selectedDepth, allowedStartKeys } = params;
  return await invoke<GeneratePuzzleVariantsResponse>("generate_puzzle_variants_from_tree", {
    root,
    orientation,
    selectedDepth,
    allowedStartKeys,
  });
}

export async function generatePuzzleVariantsFromCoverageNode(params: {
  graphRoot: unknown;
  actionNodeId: string;
  orientation: "white" | "black";
  selectedDepth: number;
  tierFilter: CoveragePuzzleTierFilter;
  includeLowSample: boolean;
}): Promise<GeneratePuzzleVariantsFromCoverageNodeResponse> {
  return await invoke<GeneratePuzzleVariantsFromCoverageNodeResponse>("generate_puzzle_variants_from_coverage_node", {
    request: params,
  });
}
