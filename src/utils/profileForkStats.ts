import { invoke } from "@tauri-apps/api/core";
import type { PlayerStatsFilters } from "@/bindings/playerStats";

export type ForkStats = {
  foundCount: number;
  missedCount: number;
  foundPawnCount: number;
  foundKnightCount: number;
  foundBishopCount: number;
  foundRookCount: number;
  foundQueenCount: number;
  foundKingCount: number;
  missedPawnCount: number;
  missedKnightCount: number;
  missedBishopCount: number;
  missedRookCount: number;
  missedQueenCount: number;
  missedKingCount: number;
  allowedPawnCount: number;
  allowedKnightCount: number;
  allowedBishopCount: number;
  allowedRookCount: number;
  allowedQueenCount: number;
  allowedKingCount: number;
};

export type ForkPiece = "pawn" | "knight" | "bishop" | "rook" | "queen" | "king";

export type ForkPuzzleGeneration = {
  count: number;
  pgn: string;
};

export type MissedForkGameRow = {
  gameId: number;
  date: string | null;
  site: string;
  white: string;
  black: string;
  result: string | null;
  ply: number;
  piece: string;
  engineLineComment: string | null;
};

export async function getProfileForkStats(input: { profileId: string; filters: PlayerStatsFilters }) {
  return await invoke<ForkStats>("get_profile_fork_stats", {
    profileId: input.profileId,
    filters: input.filters,
  });
}

export async function generateProfileMissedForkPuzzles(input: {
  profileId: string;
  filters: PlayerStatsFilters;
  piece?: ForkPiece | null;
}) {
  return await invoke<ForkPuzzleGeneration>("generate_profile_missed_fork_puzzles", {
    profileId: input.profileId,
    filters: input.filters,
    piece: input.piece ?? null,
  });
}

export async function getProfileMissedForkGames(input: {
  profileId: string;
  filters: PlayerStatsFilters;
  piece: ForkPiece;
  limit: number;
  offset: number;
}) {
  return await invoke<MissedForkGameRow[]>("get_profile_missed_fork_games", {
    profileId: input.profileId,
    filters: input.filters,
    piece: input.piece,
    limit: input.limit,
    offset: input.offset,
  });
}
