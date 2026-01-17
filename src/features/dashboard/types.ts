import type { ChessComGame } from "@/utils/chess.com/api";

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
