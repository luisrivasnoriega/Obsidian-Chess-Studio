-- Drop indexes before bulk insert to maximize insert performance
-- The dedupe unique index (Games_Dedupe_UQ) is kept for duplicate prevention
-- All other indexes will be recreated after bulk insert completes

DROP INDEX IF EXISTS games_date_idx;
DROP INDEX IF EXISTS games_white_idx;
DROP INDEX IF EXISTS games_black_idx;
DROP INDEX IF EXISTS games_result_idx;
DROP INDEX IF EXISTS games_white_elo_idx;
DROP INDEX IF EXISTS games_black_elo_idx;
DROP INDEX IF EXISTS games_plycount_idx;
DROP INDEX IF EXISTS games_event_idx;
DROP INDEX IF EXISTS games_site_idx;
DROP INDEX IF EXISTS games_white_black_idx;
DROP INDEX IF EXISTS games_black_white_idx;
DROP INDEX IF EXISTS games_material_idx;
DROP INDEX IF EXISTS games_pawn_home_idx;
DROP INDEX IF EXISTS games_date_result_idx;
DROP INDEX IF EXISTS games_elo_composite_idx;

-- Additional query indexes (created post-sync) must also be dropped for fast bulk inserts
DROP INDEX IF EXISTS games_timecontrol_idx;
DROP INDEX IF EXISTS games_timecontrol_date_idx;
DROP INDEX IF EXISTS games_timecontrol_result_idx;

DROP INDEX IF EXISTS games_eco_idx;
DROP INDEX IF EXISTS games_eco_date_idx;
DROP INDEX IF EXISTS games_eco_result_idx;
DROP INDEX IF EXISTS games_eco_whiteelo_idx;
DROP INDEX IF EXISTS games_eco_blackelo_idx;

DROP INDEX IF EXISTS games_whiteelo_date_idx;
DROP INDEX IF EXISTS games_blackelo_date_idx;
DROP INDEX IF EXISTS games_whiteelo_result_idx;
DROP INDEX IF EXISTS games_blackelo_result_idx;
DROP INDEX IF EXISTS games_whiteelo_timecontrol_idx;
DROP INDEX IF EXISTS games_blackelo_timecontrol_idx;

DROP INDEX IF EXISTS games_whiteelo_eco_timecontrol_idx;
DROP INDEX IF EXISTS games_blackelo_eco_timecontrol_idx;
DROP INDEX IF EXISTS games_date_whiteelo_result_idx;
DROP INDEX IF EXISTS games_date_blackelo_result_idx;

DROP INDEX IF EXISTS games_siteid_date_idx;
DROP INDEX IF EXISTS games_siteid_timecontrol_idx;
DROP INDEX IF EXISTS games_siteid_result_idx;

DROP INDEX IF EXISTS games_round_idx;
DROP INDEX IF EXISTS games_round_date_idx;

DROP INDEX IF EXISTS games_utctime_idx;
DROP INDEX IF EXISTS games_date_utctime_idx;
