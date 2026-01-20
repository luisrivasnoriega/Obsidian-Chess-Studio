-- Additional indexes for Games table to optimize queries by:
-- - TimeControl (bullet, blitz, rapid, etc.)
-- - Opening (ECO codes)
-- - Opponent level (ELO ranges with various filters)
-- - Platform (via SiteID, which already has index but adding composites)

-- TimeControl indexes (critical for filtering by game speed)
CREATE INDEX IF NOT EXISTS games_timecontrol_idx ON Games(TimeControl);
CREATE INDEX IF NOT EXISTS games_timecontrol_date_idx ON Games(TimeControl, Date);
CREATE INDEX IF NOT EXISTS games_timecontrol_result_idx ON Games(TimeControl, Result);

-- Opening (ECO) indexes (critical for opening analysis)
CREATE INDEX IF NOT EXISTS games_eco_idx ON Games(ECO);
CREATE INDEX IF NOT EXISTS games_eco_date_idx ON Games(ECO, Date);
CREATE INDEX IF NOT EXISTS games_eco_result_idx ON Games(ECO, Result);
CREATE INDEX IF NOT EXISTS games_eco_whiteelo_idx ON Games(ECO, WhiteElo);
CREATE INDEX IF NOT EXISTS games_eco_blackelo_idx ON Games(ECO, BlackElo);

-- Opponent level indexes (ELO-based queries with various filters)
-- For queries like "games against opponents in ELO range X-Y"
CREATE INDEX IF NOT EXISTS games_whiteelo_date_idx ON Games(WhiteElo, Date);
CREATE INDEX IF NOT EXISTS games_blackelo_date_idx ON Games(BlackElo, Date);
CREATE INDEX IF NOT EXISTS games_whiteelo_result_idx ON Games(WhiteElo, Result);
CREATE INDEX IF NOT EXISTS games_blackelo_result_idx ON Games(BlackElo, Result);
CREATE INDEX IF NOT EXISTS games_whiteelo_timecontrol_idx ON Games(WhiteElo, TimeControl);
CREATE INDEX IF NOT EXISTS games_blackelo_timecontrol_idx ON Games(BlackElo, TimeControl);

-- Composite indexes for complex queries (opponent level + opening + time control)
CREATE INDEX IF NOT EXISTS games_whiteelo_eco_timecontrol_idx ON Games(WhiteElo, ECO, TimeControl);
CREATE INDEX IF NOT EXISTS games_blackelo_eco_timecontrol_idx ON Games(BlackElo, ECO, TimeControl);
CREATE INDEX IF NOT EXISTS games_date_whiteelo_result_idx ON Games(Date, WhiteElo, Result);
CREATE INDEX IF NOT EXISTS games_date_blackelo_result_idx ON Games(Date, BlackElo, Result);

-- Platform queries (via SiteID - already indexed, but adding composites for common patterns)
CREATE INDEX IF NOT EXISTS games_siteid_date_idx ON Games(SiteID, Date);
CREATE INDEX IF NOT EXISTS games_siteid_timecontrol_idx ON Games(SiteID, TimeControl);
CREATE INDEX IF NOT EXISTS games_siteid_result_idx ON Games(SiteID, Result);

-- Round index (for tournament/round-based queries)
CREATE INDEX IF NOT EXISTS games_round_idx ON Games(Round);
CREATE INDEX IF NOT EXISTS games_round_date_idx ON Games(Round, Date);

-- UTCTime index (for precise time-based queries)
CREATE INDEX IF NOT EXISTS games_utctime_idx ON Games(UTCTime);
CREATE INDEX IF NOT EXISTS games_date_utctime_idx ON Games(Date, UTCTime);
