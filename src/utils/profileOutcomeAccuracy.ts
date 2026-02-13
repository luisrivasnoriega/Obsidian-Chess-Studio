import { invoke } from "@tauri-apps/api/core";
import type { PlayerStatsFilters } from "@/bindings/playerStats";

export type OutcomeAccuracyStats = {
  wonAvgAccuracy: number | null;
  drawnAvgAccuracy: number | null;
  lostAvgAccuracy: number | null;
  wonCount: number;
  drawnCount: number;
  lostCount: number;
};

export async function getProfileOutcomeAccuracy(input: { profileId: string; filters: PlayerStatsFilters }) {
  return await invoke<OutcomeAccuracyStats>("get_profile_outcome_accuracy", {
    profileId: input.profileId,
    filters: input.filters,
  });
}
