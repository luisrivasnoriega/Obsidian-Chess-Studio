import { invoke } from "@tauri-apps/api/core";
import type { PlayerStatsFilters } from "@/bindings/playerStats";

export type PhaseAccuracyBucket = {
  phase: "opening" | "middlegame" | "endgame";
  avgAccuracy: number | null;
  count: number;
};

export async function getProfilePhaseAccuracy(input: { profileId: string; filters: PlayerStatsFilters }) {
  return await invoke<PhaseAccuracyBucket[]>("get_profile_phase_accuracy", {
    profileId: input.profileId,
    filters: input.filters,
  });
}
