import { invoke } from "@tauri-apps/api/core";

export type PuzzleTreeNodeDto = {
  fen: string;
  san?: string | null;
  children: PuzzleTreeNodeDto[];
};

export type GeneratePuzzleVariantsResponse = {
  pgn: string;
  count: number;
};

export async function generatePuzzleVariantsFromTree(params: {
  root: PuzzleTreeNodeDto;
  orientation: "white" | "black";
  selectedDepth: number;
}): Promise<GeneratePuzzleVariantsResponse> {
  const { root, orientation, selectedDepth } = params;
  return await invoke<GeneratePuzzleVariantsResponse>("generate_puzzle_variants_from_tree", {
    root,
    orientation,
    selectedDepth,
  });
}

