-- Export rows are read directly. Only lock, progress and allowance metadata is stored.
CREATE TABLE shop_data_export_allowances (
 shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 month TEXT NOT NULL, extra INTEGER NOT NULL DEFAULT 0 CHECK(extra BETWEEN 0 AND 100),
 import_extra INTEGER NOT NULL DEFAULT 0 CHECK(import_extra BETWEEN 0 AND 100),
 updated_by TEXT REFERENCES users(id) ON DELETE SET NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(shop_id,month)
);
CREATE TABLE shop_data_exports (
 id TEXT PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 scope TEXT NOT NULL CHECK(scope IN ('business','configuration')),
 month TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','completed','cancelled','failed')),
 cursor INTEGER NOT NULL DEFAULT 0, reading INTEGER NOT NULL DEFAULT 0 CHECK(reading IN (0,1)), row_cursor TEXT NOT NULL DEFAULT '[]', page_rows INTEGER NOT NULL DEFAULT 64, counts_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX shop_data_exports_month ON shop_data_exports(shop_id,month);
CREATE INDEX shop_data_exports_lock ON shop_data_exports(shop_id,status,expires_at);
CREATE TRIGGER shop_data_export_start BEFORE INSERT ON shop_data_exports BEGIN
 SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED') WHERE EXISTS(SELECT 1 FROM shop_data_exports WHERE shop_id=NEW.shop_id AND status='active'
   AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 SELECT RAISE(ABORT,'SHOP_EXPORT_BUSY') WHERE EXISTS(SELECT 1 FROM operation_locks WHERE shop_id=NEW.shop_id
   AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 SELECT RAISE(ABORT,'SHOP_EXPORT_QUOTA') WHERE (SELECT COUNT(*) FROM shop_data_exports WHERE shop_id=NEW.shop_id AND month=NEW.month)>=
   1+COALESCE((SELECT extra FROM shop_data_export_allowances WHERE shop_id=NEW.shop_id AND month=NEW.month),0)
  ;
END;
CREATE TRIGGER shop_export_staff_users_insert BEFORE INSERT ON staff_users
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_staff_users_update BEFORE UPDATE ON staff_users
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_staff_users_delete BEFORE DELETE ON staff_users
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_admin_sessions_insert BEFORE INSERT ON admin_sessions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_admin_sessions_update BEFORE UPDATE ON admin_sessions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_admin_sessions_delete BEFORE DELETE ON admin_sessions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_api_tokens_insert BEFORE INSERT ON api_tokens
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_api_tokens_update BEFORE UPDATE ON api_tokens
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_api_tokens_delete BEFORE DELETE ON api_tokens
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_app_settings_insert BEFORE INSERT ON app_settings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_app_settings_update BEFORE UPDATE ON app_settings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_app_settings_delete BEFORE DELETE ON app_settings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_players_insert BEFORE INSERT ON players
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_players_update BEFORE UPDATE ON players
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_players_delete BEFORE DELETE ON players
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_player_identities_insert BEFORE INSERT ON player_identities
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_player_identities_update BEFORE UPDATE ON player_identities
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_player_identities_delete BEFORE DELETE ON player_identities
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_player_sessions_insert BEFORE INSERT ON player_sessions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_player_sessions_update BEFORE UPDATE ON player_sessions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_player_sessions_delete BEFORE DELETE ON player_sessions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_asset_definitions_insert BEFORE INSERT ON asset_definitions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_asset_definitions_update BEFORE UPDATE ON asset_definitions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_asset_definitions_delete BEFORE DELETE ON asset_definitions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_effects_insert BEFORE INSERT ON pricing_effects
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_effects_update BEFORE UPDATE ON pricing_effects
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_effects_delete BEFORE DELETE ON pricing_effects
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_sessions_insert BEFORE INSERT ON sessions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_sessions_update BEFORE UPDATE ON sessions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_sessions_delete BEFORE DELETE ON sessions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_asset_holdings_insert BEFORE INSERT ON asset_holdings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_asset_holdings_update BEFORE UPDATE ON asset_holdings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_asset_holdings_delete BEFORE DELETE ON asset_holdings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_asset_transactions_insert BEFORE INSERT ON asset_transactions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_asset_transactions_update BEFORE UPDATE ON asset_transactions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_asset_transactions_delete BEFORE DELETE ON asset_transactions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_asset_ledger_entries_insert BEFORE INSERT ON asset_ledger_entries
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_asset_ledger_entries_update BEFORE UPDATE ON asset_ledger_entries
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_asset_ledger_entries_delete BEFORE DELETE ON asset_ledger_entries
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_redeem_codes_insert BEFORE INSERT ON redeem_codes
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_redeem_codes_update BEFORE UPDATE ON redeem_codes
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_redeem_codes_delete BEFORE DELETE ON redeem_codes
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_presents_insert BEFORE INSERT ON presents
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_presents_update BEFORE UPDATE ON presents
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_presents_delete BEFORE DELETE ON presents
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_redeem_records_insert BEFORE INSERT ON redeem_records
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_redeem_records_update BEFORE UPDATE ON redeem_records
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_redeem_records_delete BEFORE DELETE ON redeem_records
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_commands_insert BEFORE INSERT ON device_commands
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_commands_update BEFORE UPDATE ON device_commands
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_commands_delete BEFORE DELETE ON device_commands
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_states_insert BEFORE INSERT ON device_states
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_states_update BEFORE UPDATE ON device_states
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_device_states_delete BEFORE DELETE ON device_states
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_settlements_insert BEFORE INSERT ON settlements
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_settlements_update BEFORE UPDATE ON settlements
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_settlements_delete BEFORE DELETE ON settlements
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_settlement_charge_items_insert BEFORE INSERT ON settlement_charge_items
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_settlement_charge_items_update BEFORE UPDATE ON settlement_charge_items
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_settlement_charge_items_delete BEFORE DELETE ON settlement_charge_items
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_settlement_adjustments_insert BEFORE INSERT ON settlement_adjustments
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_settlement_adjustments_update BEFORE UPDATE ON settlement_adjustments
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_settlement_adjustments_delete BEFORE DELETE ON settlement_adjustments
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_history_entries_insert BEFORE INSERT ON pricing_history_entries
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_history_entries_update BEFORE UPDATE ON pricing_history_entries
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_history_entries_delete BEFORE DELETE ON pricing_history_entries
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_configs_insert BEFORE INSERT ON pricing_configs
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_configs_update BEFORE UPDATE ON pricing_configs
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_configs_delete BEFORE DELETE ON pricing_configs
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_business_items_insert BEFORE INSERT ON business_items
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_business_items_update BEFORE UPDATE ON business_items
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_business_items_delete BEFORE DELETE ON business_items
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_business_item_orders_insert BEFORE INSERT ON business_item_orders
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_business_item_orders_update BEFORE UPDATE ON business_item_orders
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_business_item_orders_delete BEFORE DELETE ON business_item_orders
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_machine_connections_insert BEFORE INSERT ON machine_connections
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_machine_connections_update BEFORE UPDATE ON machine_connections
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_machine_connections_delete BEFORE DELETE ON machine_connections
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_cap_history_entries_insert BEFORE INSERT ON pricing_cap_history_entries
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_cap_history_entries_update BEFORE UPDATE ON pricing_cap_history_entries
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_cap_history_entries_delete BEFORE DELETE ON pricing_cap_history_entries
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_operation_locks_insert BEFORE INSERT ON operation_locks
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_operation_locks_update BEFORE UPDATE ON operation_locks
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_operation_locks_delete BEFORE DELETE ON operation_locks
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_player_checkouts_insert BEFORE INSERT ON player_checkouts
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_player_checkouts_update BEFORE UPDATE ON player_checkouts
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_player_checkouts_delete BEFORE DELETE ON player_checkouts
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_config_versions_insert BEFORE INSERT ON pricing_config_versions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_config_versions_update BEFORE UPDATE ON pricing_config_versions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_config_versions_delete BEFORE DELETE ON pricing_config_versions
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_releases_insert BEFORE INSERT ON pricing_releases
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_releases_update BEFORE UPDATE ON pricing_releases
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_releases_delete BEFORE DELETE ON pricing_releases
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_release_heads_insert BEFORE INSERT ON pricing_release_heads
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_release_heads_update BEFORE UPDATE ON pricing_release_heads
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_pricing_release_heads_delete BEFORE DELETE ON pricing_release_heads
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_session_pricing_releases_insert BEFORE INSERT ON session_pricing_releases
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_session_pricing_releases_update BEFORE UPDATE ON session_pricing_releases
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_session_pricing_releases_delete BEFORE DELETE ON session_pricing_releases
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_cashier_profiles_insert BEFORE INSERT ON cashier_profiles
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_cashier_profiles_update BEFORE UPDATE ON cashier_profiles
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_cashier_profiles_delete BEFORE DELETE ON cashier_profiles
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_cashier_payments_insert BEFORE INSERT ON cashier_payments
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_cashier_payments_update BEFORE UPDATE ON cashier_payments
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_cashier_payments_delete BEFORE DELETE ON cashier_payments
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_checkout_timelines_insert BEFORE INSERT ON checkout_timelines
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_checkout_timelines_update BEFORE UPDATE ON checkout_timelines
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_checkout_timelines_delete BEFORE DELETE ON checkout_timelines
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_player_operations_insert BEFORE INSERT ON player_operations
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id) AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_player_operations_update BEFORE UPDATE ON player_operations
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id) AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_player_operations_delete BEFORE DELETE ON player_operations
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id) AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_billing_settings_insert BEFORE INSERT ON shop_billing_settings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_billing_settings_update BEFORE UPDATE ON shop_billing_settings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_billing_settings_delete BEFORE DELETE ON shop_billing_settings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_player_accounts_insert BEFORE INSERT ON shop_player_accounts
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_player_accounts_update BEFORE UPDATE ON shop_player_accounts
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_player_accounts_delete BEFORE DELETE ON shop_player_accounts
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_staff_accounts_insert BEFORE INSERT ON shop_staff_accounts
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_staff_accounts_update BEFORE UPDATE ON shop_staff_accounts
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_staff_accounts_delete BEFORE DELETE ON shop_staff_accounts
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_members_insert BEFORE INSERT ON shop_members
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_members_update BEFORE UPDATE ON shop_members
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_members_delete BEFORE DELETE ON shop_members
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_platform_bindings_insert BEFORE INSERT ON shop_platform_bindings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_platform_bindings_update BEFORE UPDATE ON shop_platform_bindings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_platform_bindings_delete BEFORE DELETE ON shop_platform_bindings
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_platform_binding_codes_insert BEFORE INSERT ON platform_binding_codes
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_platform_binding_codes_update BEFORE UPDATE ON platform_binding_codes
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_platform_binding_codes_delete BEFORE DELETE ON platform_binding_codes
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_imported_accounts_insert BEFORE INSERT ON shop_imported_accounts
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_imported_accounts_update BEFORE UPDATE ON shop_imported_accounts
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shop_imported_accounts_delete BEFORE DELETE ON shop_imported_accounts
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_machines_insert BEFORE INSERT ON machines
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_machines_update BEFORE UPDATE ON machines
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_machines_delete BEFORE DELETE ON machines
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_mahjong_seats_insert BEFORE INSERT ON mahjong_seats
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_mahjong_seats_update BEFORE UPDATE ON mahjong_seats
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_mahjong_seats_delete BEFORE DELETE ON mahjong_seats
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_live_activity_tokens_insert BEFORE INSERT ON live_activity_tokens
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_live_activity_tokens_update BEFORE UPDATE ON live_activity_tokens
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_live_activity_tokens_delete BEFORE DELETE ON live_activity_tokens
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shops_insert BEFORE INSERT ON shops
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shops_update BEFORE UPDATE ON shops
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.id OR e.shop_id=NEW.id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_shops_delete BEFORE DELETE ON shops
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_auth_identities_insert BEFORE INSERT ON auth_identities
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (EXISTS(SELECT 1 FROM shop_members m WHERE m.shop_id=e.shop_id AND m.user_id=NEW.user_id)
    OR EXISTS(SELECT 1 FROM shop_player_accounts a WHERE a.shop_id=e.shop_id AND a.user_id=NEW.user_id)
    OR EXISTS(SELECT 1 FROM shop_staff_accounts a WHERE a.shop_id=e.shop_id AND a.user_id=NEW.user_id)
    OR EXISTS(SELECT 1 FROM player_identities i WHERE i.shop_id=e.shop_id AND i.provider='web-account' AND i.subject=NEW.user_id))
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_auth_identities_update BEFORE UPDATE ON auth_identities
 WHEN (OLD.user_id IS NOT NEW.user_id OR OLD.provider IS NOT NEW.provider OR OLD.provider_subject IS NOT NEW.provider_subject) AND EXISTS(SELECT 1 FROM shop_data_exports e WHERE (EXISTS(SELECT 1 FROM shop_members m WHERE m.shop_id=e.shop_id AND m.user_id=OLD.user_id)
    OR EXISTS(SELECT 1 FROM shop_player_accounts a WHERE a.shop_id=e.shop_id AND a.user_id=OLD.user_id)
    OR EXISTS(SELECT 1 FROM shop_staff_accounts a WHERE a.shop_id=e.shop_id AND a.user_id=OLD.user_id)
    OR EXISTS(SELECT 1 FROM player_identities i WHERE i.shop_id=e.shop_id AND i.provider='web-account' AND i.subject=OLD.user_id) OR EXISTS(SELECT 1 FROM shop_members m WHERE m.shop_id=e.shop_id AND m.user_id=NEW.user_id)
    OR EXISTS(SELECT 1 FROM shop_player_accounts a WHERE a.shop_id=e.shop_id AND a.user_id=NEW.user_id)
    OR EXISTS(SELECT 1 FROM shop_staff_accounts a WHERE a.shop_id=e.shop_id AND a.user_id=NEW.user_id)
    OR EXISTS(SELECT 1 FROM player_identities i WHERE i.shop_id=e.shop_id AND i.provider='web-account' AND i.subject=NEW.user_id))
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_auth_identities_delete BEFORE DELETE ON auth_identities
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (EXISTS(SELECT 1 FROM shop_members m WHERE m.shop_id=e.shop_id AND m.user_id=OLD.user_id)
    OR EXISTS(SELECT 1 FROM shop_player_accounts a WHERE a.shop_id=e.shop_id AND a.user_id=OLD.user_id)
    OR EXISTS(SELECT 1 FROM shop_staff_accounts a WHERE a.shop_id=e.shop_id AND a.user_id=OLD.user_id)
    OR EXISTS(SELECT 1 FROM player_identities i WHERE i.shop_id=e.shop_id AND i.provider='web-account' AND i.subject=OLD.user_id))
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
DELETE FROM shop_data_jobs WHERE kind='export';
CREATE TABLE shop_data_import_attempts (
 id TEXT PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 user_id TEXT REFERENCES users(id) ON DELETE SET NULL, month TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX shop_data_import_attempts_month ON shop_data_import_attempts(shop_id,month);
CREATE TRIGGER shop_data_import_limit BEFORE INSERT ON shop_data_import_attempts BEGIN
 SELECT RAISE(ABORT,'SHOP_IMPORT_QUOTA') WHERE (SELECT COUNT(*) FROM shop_data_import_attempts WHERE shop_id=NEW.shop_id AND month=NEW.month)>=
   1+COALESCE((SELECT import_extra FROM shop_data_export_allowances WHERE shop_id=NEW.shop_id AND month=NEW.month),0)
  ;
END;
