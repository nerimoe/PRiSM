-- Membership is independent of external platform identity. Existing account/player IDs remain unchanged.
ALTER TABLE shop_billing_settings ADD COLUMN identity_binding_required INTEGER NOT NULL DEFAULT 1 CHECK(identity_binding_required IN (0,1));
ALTER TABLE qq_binding_codes RENAME TO platform_binding_codes;
ALTER TABLE shop_player_accounts RENAME TO legacy_shop_player_accounts;
CREATE TABLE shop_player_accounts (
 shop_id TEXT NOT NULL REFERENCES shops(id), user_id TEXT NOT NULL REFERENCES users(id),
 player_id TEXT NOT NULL, verified_at TEXT NOT NULL,
 PRIMARY KEY(shop_id,user_id), UNIQUE(shop_id,player_id),
 FOREIGN KEY(shop_id,player_id) REFERENCES players(shop_id,id)
);
INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at)
 SELECT shop_id,user_id,player_id,verified_at FROM legacy_shop_player_accounts;
CREATE TABLE shop_platform_bindings (
 shop_id TEXT NOT NULL, user_id TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, verified_at TEXT NOT NULL,
 PRIMARY KEY(shop_id,provider,subject), UNIQUE(shop_id,user_id,provider),
 FOREIGN KEY(shop_id,user_id) REFERENCES shop_player_accounts(shop_id,user_id) ON DELETE CASCADE
);
INSERT INTO shop_platform_bindings(shop_id,user_id,provider,subject,verified_at)
 SELECT shop_id,user_id,'qq',qq,verified_at FROM legacy_shop_player_accounts;
DROP TABLE legacy_shop_player_accounts;
-- A verified binding must point at the same player as its account membership.
CREATE TRIGGER platform_binding_owner_insert
BEFORE INSERT ON shop_platform_bindings
WHEN NOT EXISTS (SELECT 1 FROM shop_player_accounts a JOIN player_identities i
 ON i.shop_id=a.shop_id AND i.player_id=a.player_id
 WHERE a.shop_id=NEW.shop_id AND a.user_id=NEW.user_id AND i.provider=NEW.provider AND i.subject=NEW.subject)
BEGIN
 SELECT RAISE(ABORT,'platform binding identity belongs to another player');
END;
CREATE TRIGGER platform_binding_owner_update
BEFORE UPDATE OF provider,subject,user_id ON shop_platform_bindings
WHEN NOT EXISTS (SELECT 1 FROM shop_player_accounts a JOIN player_identities i
 ON i.shop_id=a.shop_id AND i.player_id=a.player_id
 WHERE a.shop_id=NEW.shop_id AND a.user_id=NEW.user_id AND i.provider=NEW.provider AND i.subject=NEW.subject)
BEGIN
 SELECT RAISE(ABORT,'platform binding identity belongs to another player');
END;
