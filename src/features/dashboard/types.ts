import type { ChessComGame } from "@/utils/chess.com/api";
import type { GameRecord } from "@/utils/gameRecords";

export type ChessComGameWithEvent = ChessComGame & {
  eventId: number;
  eventName: string | null;
};

export type TimeControlCategory =
  | "ultra_bullet"
  | "bullet"
  | "blitz"
  | "rapid"
  | "classical"
  | "correspondence"
  | "daily";

export type GamesHistoryKind = "local" | "chesscom" | "lichess" | "chessbase";

export type DashboardGamesHistoryRow = {
  kind: GamesHistoryKind;
  gameKey: string;
  analysisGameId: string;
  externalUrl: string | null;
  opponent: string;
  color: "white" | "black";
  outcome: "win" | "loss" | "draw" | "unknown";
  pgn: string | null;
  initialFen: string | null;
  accuracy: number | null;
  acpl: number | null;
  estimatedElo: number | null;
  resistance: number | null;
  eloEstimatedBalanced: number | null;
  moves: number;
  timeControl: string | null;
  timeControlCategory: TimeControlCategory | null;
  timestampMs: number;
  eventId: number | null;
  eventName: string | null;
  isAnalyzed: boolean;
};

export type DashboardAnalyzeGameMeta = {
  playerColor: "white" | "black";
  profileId?: string;
  profileDbGameId?: string;
};

export type DashboardSingleAnalysisTarget =
  | { type: "local"; game: GameRecord }
  | { type: "chesscom"; game: ChessComGameWithEvent; meta: DashboardAnalyzeGameMeta }
  | { type: "lichess"; game: DashboardLichessGame; meta: DashboardAnalyzeGameMeta }
  | { type: "chessbase"; row: DashboardGamesHistoryRow; meta: DashboardAnalyzeGameMeta };

export interface DashboardLichessGame {
  id: string;
  players: {
    white: { user?: { name: string } };
    black: { user?: { name: string } };
  };
  speed: string;
  timeControl: string | null;
  createdAt: number;
  winner?: string;
  status: string;
  pgn?: string;
  lastFen: string;
  eventId: number;
  eventName: string | null;
}
