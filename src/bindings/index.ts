import { invoke } from "@tauri-apps/api/core";
import type {
  BestMoves as BestMovesT,
  DatabaseInfo as DatabaseInfoT,
  GameQueryJs,
  Puzzle,
  Result,
  Score as ScoreT,
  ScoreValue as ScoreValueT,
} from "./generated";

export * from "./generated";
export type ScoreValue = ScoreValueT | { type: "dtz"; value: number };
export type Score = Omit<ScoreT, "value"> & { value: ScoreValue };
export type BestMoves = Omit<BestMovesT, "score"> & {
  score: Score;
};

export type DatabaseInfo =
  | (DatabaseInfoT & {
      type: "success";
      file: string;
      downloadLink?: string;
      filter?: GameQuery;
    })
  | {
      type: "error";
      file: string;
      filename: string;
      error: string;
      indexed: boolean;
    };

export type GameQuery = GameQueryJs;

export async function getPuzzleBatch(
  file: string,
  minRating: number,
  maxRating: number,
  random: boolean,
  themes: string[] | null,
  openingTags: string[] | null,
  count: number,
): Promise<Result<Puzzle[], string>> {
  try {
    return {
      status: "ok",
      data: await invoke("get_puzzle_batch", {
        file,
        minRating,
        maxRating,
        random,
        themes,
        openingTags,
        count,
      }),
    };
  } catch (e) {
    if (e instanceof Error) throw e;
    return { status: "error", error: e as any };
  }
}
