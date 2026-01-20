-- Create a unique index to prevent duplicate games from being inserted.
-- Matches the same criteria used by delete_duplicates.sql
CREATE UNIQUE INDEX IF NOT EXISTS Games_Dedupe_UQ
ON Games (EventID, SiteID, Round, WhiteID, BlackID, Moves, Date, UTCTime);

