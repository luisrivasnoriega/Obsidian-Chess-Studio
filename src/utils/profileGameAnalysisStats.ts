import { invoke } from "@tauri-apps/api/core";
import type { MoveAnalysis } from "@/bindings";

export async function saveProfileGameAnalysisStats(input: {
  profileId: string;
  gameId: number;
  initialFen: string;
  moves: string[];
  analysis: MoveAnalysis[];
}) {
  await invoke("save_profile_game_analysis_stats", {
    profileId: input.profileId,
    gameId: input.gameId,
    initialFen: input.initialFen,
    moves: input.moves,
    analysis: input.analysis,
  });
}

