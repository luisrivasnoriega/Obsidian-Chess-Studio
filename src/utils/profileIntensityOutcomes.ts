import { invoke } from "@tauri-apps/api/core";
import type { PlayerStatsFilters } from "@/bindings/playerStats";

export type IntensityOutcomeBucket = {
  intensity: "calm" | "balanced" | "edge" | "intense" | "sudden" | "wild" | "gifted";
  won: number;
  drawn: number;
  lost: number;
};

export async function getProfileIntensityOutcomes(input: { profileId: string; filters: PlayerStatsFilters }) {
  return await invoke<IntensityOutcomeBucket[]>("get_profile_intensity_outcomes", {
    profileId: input.profileId,
    filters: input.filters,
  });
}
