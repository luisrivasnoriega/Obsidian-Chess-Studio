-- Profile-only analysis/metrics tables for Obsidian Chess Studio
-- These tables store computed statistics derived from engine analysis runs.

-- One row per analyzed game (keyed by Games.ID).
-- Keep this table forward-compatible by storing additional computed stats in JSON.
CREATE TABLE IF NOT EXISTS GameAnalysisStats (
    GameID INTEGER PRIMARY KEY NOT NULL,
    Winner TEXT NOT NULL,           -- "white" | "black" | "draw" | "unknown"
    WinPhase TEXT NOT NULL,         -- "opening" | "middlegame" | "endgame" | "unknown"
    WinPly INTEGER,                 -- ply index where the game became decisively won
    ComputedAt TEXT NOT NULL,       -- ISO-8601 UTC timestamp
    Version INTEGER NOT NULL,       -- schema/calculation version for migration
    Extra TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (GameID) REFERENCES Games(ID) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS GameAnalysisStats_WinPhase_idx ON GameAnalysisStats(WinPhase);
