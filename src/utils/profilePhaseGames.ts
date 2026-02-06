import { invoke } from "@tauri-apps/api/core";
import type { PlayerStatsFilters } from "@/bindings/playerStats";

export type PhaseGameRow = {
  gameId: number;
  date?: string | null;
  site: string;
  white: string;
  black: string;
  result?: string | null;
  winPhase: "opening" | "middlegame" | "endgame";
};

export async function getProfilePhaseGames(input: {
  profileId: string;
  filters: PlayerStatsFilters;
  phase: "opening" | "middlegame" | "endgame";
  limit: number;
  offset: number;
}) {
  return await invoke<PhaseGameRow[]>("get_profile_phase_games", {
    profileId: input.profileId,
    filters: input.filters,
    phase: input.phase,
    limit: input.limit,
    offset: input.offset,
  });
}
