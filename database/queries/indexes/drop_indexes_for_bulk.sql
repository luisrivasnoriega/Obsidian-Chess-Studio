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
