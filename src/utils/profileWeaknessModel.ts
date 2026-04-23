import { invoke } from "@tauri-apps/api/core";
import type { ProfileWeaknessModel, ProfileWeaknessSignal, ProfileWeaknessSignalEvidence } from "@/bindings";
import type { PlayerStatsFilters } from "@/bindings/playerStats";

export type { ProfileWeaknessModel, ProfileWeaknessSignal, ProfileWeaknessSignalEvidence };

export async function getProfileWeaknessModel(input: {
  profileId: string;
  limit?: number | null;
  filters?: PlayerStatsFilters | null;
}) {
  return await invoke<ProfileWeaknessModel>("get_profile_weakness_model", {
    profileId: input.profileId,
    limit: input.limit ?? null,
    filters: input.filters ?? null,
  });
}
