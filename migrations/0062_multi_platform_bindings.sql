-- Allow multiple verified platform identities per user and provider within a shop.

DROP TRIGGER IF EXISTS platform_binding_owner_insert;
DROP TRIGGER IF EXISTS platform_binding_owner_update;
DROP TRIGGER IF EXISTS shop_export_shop_platform_bindings_insert;
DROP TRIGGER IF EXISTS shop_export_shop_platform_bindings_update;
DROP TRIGGER IF EXISTS shop_export_shop_platform_bindings_delete;
DROP TRIGGER IF EXISTS shop_import_target_shop_platform_bindings_insert;
DROP TRIGGER IF EXISTS shop_import_target_shop_platform_bindings_update;
DROP TRIGGER IF EXISTS shop_import_target_shop_platform_bindings_delete;

ALTER TABLE shop_platform_bindings RENAME TO shop_platform_bindings__old;

CREATE TABLE shop_platform_bindings (
  shop_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(shop_id, provider, subject),
  FOREIGN KEY(shop_id, user_id) REFERENCES shop_player_accounts(shop_id, user_id) ON DELETE CASCADE
);

INSERT INTO shop_platform_bindings(shop_id, user_id, provider, subject, verified_at)
  SELECT shop_id, user_id, provider, subject, verified_at FROM shop_platform_bindings__old;

DROP TABLE shop_platform_bindings__old;

CREATE INDEX IF NOT EXISTS idx_shop_platform_bindings_user
  ON shop_platform_bindings(shop_id, user_id, provider, subject);

CREATE TRIGGER IF NOT EXISTS platform_binding_owner_insert
BEFORE INSERT ON shop_platform_bindings
WHEN NOT EXISTS (SELECT 1 FROM shop_player_accounts a JOIN player_identities i
 ON i.shop_id=a.shop_id AND i.player_id=a.player_id
 WHERE a.shop_id=NEW.shop_id AND a.user_id=NEW.user_id AND i.provider=NEW.provider AND i.subject=NEW.subject)
BEGIN
 SELECT RAISE(ABORT,'platform binding identity belongs to another player');
END;

CREATE TRIGGER IF NOT EXISTS platform_binding_owner_update
BEFORE UPDATE OF provider,subject,user_id ON shop_platform_bindings
WHEN NOT EXISTS (SELECT 1 FROM shop_player_accounts a JOIN player_identities i
 ON i.shop_id=a.shop_id AND i.player_id=a.player_id
 WHERE a.shop_id=NEW.shop_id AND a.user_id=NEW.user_id AND i.provider=NEW.provider AND i.subject=NEW.subject)
BEGIN
 SELECT RAISE(ABORT,'platform binding identity belongs to another player');
END;

CREATE TRIGGER IF NOT EXISTS shop_export_shop_platform_bindings_insert BEFORE INSERT ON shop_platform_bindings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;

CREATE TRIGGER IF NOT EXISTS shop_export_shop_platform_bindings_update BEFORE UPDATE ON shop_platform_bindings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;

CREATE TRIGGER IF NOT EXISTS shop_export_shop_platform_bindings_delete BEFORE DELETE ON shop_platform_bindings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;

CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_platform_bindings_insert
AFTER INSERT ON shop_platform_bindings BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;

CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_platform_bindings_update
AFTER UPDATE ON shop_platform_bindings BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;

CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_platform_bindings_delete
AFTER DELETE ON shop_platform_bindings BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
