-- Low-security card profiles have no assets or player login identities.
CREATE TABLE IF NOT EXISTS cashier_profiles (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  player_id TEXT NOT NULL,
  card_kind TEXT NOT NULL CHECK (card_kind IN ('type-a','felica')),
  card_uid TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, player_id),
  UNIQUE (shop_id, card_kind, card_uid),
  FOREIGN KEY (shop_id, player_id) REFERENCES players(shop_id, id)
);

CREATE TABLE IF NOT EXISTS cashier_payments (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  checkout_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('wechat','alipay','cash','other')),
  collected_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, checkout_id),
  FOREIGN KEY (shop_id, checkout_id) REFERENCES player_checkouts(shop_id, id)
);

CREATE TRIGGER IF NOT EXISTS cashier_no_asset_holdings_insert
BEFORE INSERT ON asset_holdings
WHEN EXISTS (SELECT 1 FROM cashier_profiles WHERE shop_id=NEW.shop_id AND player_id=NEW.player_id)
BEGIN SELECT RAISE(ABORT, 'CASHIER_PROFILE_RESTRICTED'); END;

CREATE TRIGGER IF NOT EXISTS cashier_no_asset_holdings_update
BEFORE UPDATE ON asset_holdings
WHEN EXISTS (SELECT 1 FROM cashier_profiles WHERE shop_id=NEW.shop_id AND player_id=NEW.player_id)
BEGIN SELECT RAISE(ABORT, 'CASHIER_PROFILE_RESTRICTED'); END;

CREATE TRIGGER IF NOT EXISTS cashier_no_player_identities_insert
BEFORE INSERT ON player_identities
WHEN EXISTS (SELECT 1 FROM cashier_profiles WHERE shop_id=NEW.shop_id AND player_id=NEW.player_id)
BEGIN SELECT RAISE(ABORT, 'CASHIER_PROFILE_RESTRICTED'); END;

CREATE TRIGGER IF NOT EXISTS cashier_no_player_identities_update
BEFORE UPDATE ON player_identities
WHEN EXISTS (SELECT 1 FROM cashier_profiles WHERE shop_id=NEW.shop_id AND player_id=NEW.player_id)
BEGIN SELECT RAISE(ABORT, 'CASHIER_PROFILE_RESTRICTED'); END;

CREATE TRIGGER IF NOT EXISTS cashier_no_player_sessions_insert
BEFORE INSERT ON player_sessions
WHEN EXISTS (SELECT 1 FROM cashier_profiles WHERE shop_id=NEW.shop_id AND player_id=NEW.player_id)
BEGIN SELECT RAISE(ABORT, 'CASHIER_PROFILE_RESTRICTED'); END;

CREATE TRIGGER IF NOT EXISTS cashier_no_player_sessions_update
BEFORE UPDATE ON player_sessions
WHEN EXISTS (SELECT 1 FROM cashier_profiles WHERE shop_id=NEW.shop_id AND player_id=NEW.player_id)
BEGIN SELECT RAISE(ABORT, 'CASHIER_PROFILE_RESTRICTED'); END;

CREATE TRIGGER IF NOT EXISTS cashier_profile_must_be_empty
BEFORE INSERT ON cashier_profiles
WHEN EXISTS (SELECT 1 FROM asset_holdings WHERE shop_id=NEW.shop_id AND player_id=NEW.player_id)
 OR EXISTS (SELECT 1 FROM player_identities WHERE shop_id=NEW.shop_id AND player_id=NEW.player_id)
 OR EXISTS (SELECT 1 FROM player_sessions WHERE shop_id=NEW.shop_id AND player_id=NEW.player_id)
BEGIN SELECT RAISE(ABORT, 'CASHIER_PROFILE_RESTRICTED'); END;
