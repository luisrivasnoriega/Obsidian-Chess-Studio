import { invoke } from "@tauri-apps/api/core";
import type { PlayerStatsFilters } from "@/bindings/playerStats";

export type IntensityBreakdown = {
  calmCount: number;
  balancedCount: number;
  edgeCount: number;
  intenseCount: number;
  suddenCount: number;
  wildCount: number;
  giftedCount: number;
};

export async function getProfileIntensityBreakdown(input: { profileId: string; filters: PlayerStatsFilters }) {
  return await invoke<IntensityBreakdown>("get_profile_intensity_breakdown", {
    profileId: input.profileId,
    filters: input.filters,
  });
}
