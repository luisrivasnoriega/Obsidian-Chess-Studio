import { invoke } from "@tauri-apps/api/core";
import type { PlayerStatsFilters } from "@/bindings/playerStats";

export type IntensityKey = "calm" | "balanced" | "edge" | "intense" | "sudden" | "wild" | "gifted";

export type IntensityGameRow = {
  gameId: number;
  date: string | null;
  site: string;
  white: string;
  black: string;
  result: string | null;
  intensity: IntensityKey;
};

export async function getProfileIntensityGames(input: {
  profileId: string;
  filters: PlayerStatsFilters;
  intensity: IntensityKey;
  limit: number;
  offset: number;
}) {
  return await invoke<IntensityGameRow[]>("get_profile_intensity_games", {
    profileId: input.profileId,
    filters: input.filters,
    intensity: input.intensity,
    limit: input.limit,
    offset: input.offset,
  });
}
