CREATE TABLE IF NOT EXISTS checkout_report_states (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  checkout_id TEXT NOT NULL,
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (shop_id, checkout_id),
  FOREIGN KEY (shop_id, checkout_id) REFERENCES player_checkouts(shop_id, id)
);

CREATE TRIGGER IF NOT EXISTS shop_export_checkout_report_states_insert BEFORE INSERT ON checkout_report_states
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;

CREATE TRIGGER IF NOT EXISTS shop_export_checkout_report_states_update BEFORE UPDATE ON checkout_report_states
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;

CREATE TRIGGER IF NOT EXISTS shop_export_checkout_report_states_delete BEFORE DELETE ON checkout_report_states
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
