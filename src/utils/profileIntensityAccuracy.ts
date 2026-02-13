import { invoke } from "@tauri-apps/api/core";
import type { PlayerStatsFilters } from "@/bindings/playerStats";
import type { IntensityKey } from "@/utils/profileIntensityGames";

export type IntensityAccuracyBucket = {
  intensity: IntensityKey;
  avgAccuracy: number | null;
  count: number;
};

export async function getProfileIntensityAccuracy(input: { profileId: string; filters: PlayerStatsFilters }) {
  return await invoke<IntensityAccuracyBucket[]>("get_profile_intensity_accuracy", {
    profileId: input.profileId,
    filters: input.filters,
  });
}
