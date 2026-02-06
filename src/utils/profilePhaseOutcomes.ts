import { invoke } from "@tauri-apps/api/core";
import type { PlayerStatsFilters } from "@/bindings/playerStats";

export type PhaseOutcomeBucket = {
  phase: "opening" | "middlegame" | "endgame" | "unknown";
  won: number;
  drawn: number;
  lost: number;
};

export async function getProfilePhaseOutcomes(input: { profileId: string; filters: PlayerStatsFilters }) {
  return await invoke<PhaseOutcomeBucket[]>("get_profile_phase_outcomes", {
    profileId: input.profileId,
    filters: input.filters,
  });
}

