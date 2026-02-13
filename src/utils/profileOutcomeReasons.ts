import { invoke } from "@tauri-apps/api/core";
import type { PlayerStatsFilters } from "@/bindings/playerStats";

export type OutcomeReasonBreakdown = {
  wonCheckmateCount: number;
  wonTimeoutCount: number;
  wonAbandonCount: number;
  wonResignForfeitCount: number;
  lostCheckmateCount: number;
  lostTimeoutCount: number;
  lostAbandonCount: number;
  lostResignForfeitCount: number;
  drawnAgreementCount: number;
  drawnFiftyMoveRuleCount: number;
  drawnTimeoutVsInsufficientMaterialCount: number;
  drawnInsufficientMaterialCount: number;
  drawnRepetitionCount: number;
  drawnStalemateCount: number;
};

export async function getProfileOutcomeReasonBreakdown(input: { profileId: string; filters: PlayerStatsFilters }) {
  return await invoke<OutcomeReasonBreakdown>("get_profile_outcome_reason_breakdown", {
    profileId: input.profileId,
    filters: input.filters,
  });
}
