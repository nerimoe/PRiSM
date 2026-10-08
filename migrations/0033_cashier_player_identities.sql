-- Identity/account links do not change cashier payment mode or grant assets.
-- Preserve existing profiles, players, sessions, balances and payment history.
DROP TRIGGER IF EXISTS cashier_no_player_identities_insert;
DROP TRIGGER IF EXISTS cashier_no_player_identities_update;
DROP TRIGGER IF EXISTS cashier_no_player_sessions_insert;
DROP TRIGGER IF EXISTS cashier_no_player_sessions_update;
DROP TRIGGER IF EXISTS cashier_profile_must_be_empty;
CREATE TRIGGER cashier_profile_must_be_empty
BEFORE INSERT ON cashier_profiles
WHEN EXISTS (SELECT 1 FROM asset_holdings WHERE shop_id=NEW.shop_id AND player_id=NEW.player_id)
BEGIN SELECT RAISE(ABORT, 'CASHIER_PROFILE_RESTRICTED'); END;
