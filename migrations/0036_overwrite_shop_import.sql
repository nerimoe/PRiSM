-- Invalidate ONLY staged imports awaiting confirmation; business rows are never changed.
-- No revision row is written during normal operation without a ready import.
-- Ignore login-use and unchanged device-heartbeat timestamps, which are not business changes.
CREATE INDEX IF NOT EXISTS shop_data_jobs_target ON shop_data_jobs(shop_id,kind,status);
CREATE TRIGGER IF NOT EXISTS shop_import_target_admin_sessions_insert
AFTER INSERT ON admin_sessions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_admin_sessions_update
AFTER UPDATE ON admin_sessions
 WHEN NEW.shop_id IS NOT OLD.shop_id
   OR NEW.id IS NOT OLD.id
   OR NEW.staff_user_id IS NOT OLD.staff_user_id
   OR NEW.token_hash IS NOT OLD.token_hash
   OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_admin_sessions_delete
AFTER DELETE ON admin_sessions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_api_tokens_insert
AFTER INSERT ON api_tokens BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_api_tokens_update
AFTER UPDATE ON api_tokens
 WHEN NEW.shop_id IS NOT OLD.shop_id
   OR NEW.id IS NOT OLD.id
   OR NEW.label IS NOT OLD.label
   OR NEW.role IS NOT OLD.role
   OR NEW.token_prefix IS NOT OLD.token_prefix
   OR NEW.token_hash IS NOT OLD.token_hash
   OR NEW.status IS NOT OLD.status
   OR NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_api_tokens_delete
AFTER DELETE ON api_tokens BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_app_settings_insert
AFTER INSERT ON app_settings BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_app_settings_update
AFTER UPDATE ON app_settings BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_app_settings_delete
AFTER DELETE ON app_settings BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_asset_definitions_insert
AFTER INSERT ON asset_definitions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_asset_definitions_update
AFTER UPDATE ON asset_definitions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_asset_definitions_delete
AFTER DELETE ON asset_definitions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_asset_holdings_insert
AFTER INSERT ON asset_holdings BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_asset_holdings_update
AFTER UPDATE ON asset_holdings BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_asset_holdings_delete
AFTER DELETE ON asset_holdings BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_asset_ledger_entries_insert
AFTER INSERT ON asset_ledger_entries BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_asset_ledger_entries_update
AFTER UPDATE ON asset_ledger_entries BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_asset_ledger_entries_delete
AFTER DELETE ON asset_ledger_entries BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_asset_transactions_insert
AFTER INSERT ON asset_transactions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_asset_transactions_update
AFTER UPDATE ON asset_transactions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_asset_transactions_delete
AFTER DELETE ON asset_transactions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_business_item_orders_insert
AFTER INSERT ON business_item_orders BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_business_item_orders_update
AFTER UPDATE ON business_item_orders BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_business_item_orders_delete
AFTER DELETE ON business_item_orders BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_business_items_insert
AFTER INSERT ON business_items BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_business_items_update
AFTER UPDATE ON business_items BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_business_items_delete
AFTER DELETE ON business_items BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_cashier_payments_insert
AFTER INSERT ON cashier_payments BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_cashier_payments_update
AFTER UPDATE ON cashier_payments BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_cashier_payments_delete
AFTER DELETE ON cashier_payments BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_cashier_profiles_insert
AFTER INSERT ON cashier_profiles BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_cashier_profiles_update
AFTER UPDATE ON cashier_profiles BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_cashier_profiles_delete
AFTER DELETE ON cashier_profiles BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_checkout_report_states_insert
AFTER INSERT ON checkout_report_states BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_checkout_report_states_update
AFTER UPDATE ON checkout_report_states BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_checkout_report_states_delete
AFTER DELETE ON checkout_report_states BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_checkout_timelines_insert
AFTER INSERT ON checkout_timelines BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_checkout_timelines_update
AFTER UPDATE ON checkout_timelines BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_checkout_timelines_delete
AFTER DELETE ON checkout_timelines BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_commands_insert
AFTER INSERT ON device_commands BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_commands_update
AFTER UPDATE ON device_commands BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_commands_delete
AFTER DELETE ON device_commands BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_states_insert
AFTER INSERT ON device_states BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_states_update
AFTER UPDATE ON device_states
 WHEN NEW.shop_id IS NOT OLD.shop_id
   OR NEW.device_id IS NOT OLD.device_id
   OR NEW.type IS NOT OLD.type
   OR NEW.target_kind IS NOT OLD.target_kind
   OR NEW.executor_kind IS NOT OLD.executor_kind
   OR NEW.label IS NOT OLD.label
   OR NEW.status IS NOT OLD.status
   OR NEW.state IS NOT OLD.state
   OR NEW.metadata_json IS NOT OLD.metadata_json
BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_device_states_delete
AFTER DELETE ON device_states BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_machine_connections_insert
AFTER INSERT ON machine_connections BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_machine_connections_update
AFTER UPDATE ON machine_connections
 WHEN NEW.shop_id IS NOT OLD.shop_id
   OR NEW.machine_id IS NOT OLD.machine_id
   OR NEW.status IS NOT OLD.status
   OR NEW.capabilities_json IS NOT OLD.capabilities_json
BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_machine_connections_delete
AFTER DELETE ON machine_connections BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_machines_insert
AFTER INSERT ON machines BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_machines_update
AFTER UPDATE ON machines BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_machines_delete
AFTER DELETE ON machines BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_mahjong_seats_insert
AFTER INSERT ON mahjong_seats BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_mahjong_seats_update
AFTER UPDATE ON mahjong_seats BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_mahjong_seats_delete
AFTER DELETE ON mahjong_seats BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_player_checkouts_insert
AFTER INSERT ON player_checkouts BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_player_checkouts_update
AFTER UPDATE ON player_checkouts BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_player_checkouts_delete
AFTER DELETE ON player_checkouts BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_player_identities_insert
AFTER INSERT ON player_identities BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_player_identities_update
AFTER UPDATE ON player_identities BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_player_identities_delete
AFTER DELETE ON player_identities BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_player_sessions_insert
AFTER INSERT ON player_sessions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_player_sessions_update
AFTER UPDATE ON player_sessions
 WHEN NEW.shop_id IS NOT OLD.shop_id
   OR NEW.id IS NOT OLD.id
   OR NEW.player_id IS NOT OLD.player_id
   OR NEW.token_hash IS NOT OLD.token_hash
   OR NEW.expires_at IS NOT OLD.expires_at
   OR NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_player_sessions_delete
AFTER DELETE ON player_sessions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_players_insert
AFTER INSERT ON players BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_players_update
AFTER UPDATE ON players BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_players_delete
AFTER DELETE ON players BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_presents_insert
AFTER INSERT ON presents BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_presents_update
AFTER UPDATE ON presents BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_presents_delete
AFTER DELETE ON presents BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_cap_history_entries_insert
AFTER INSERT ON pricing_cap_history_entries BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_cap_history_entries_update
AFTER UPDATE ON pricing_cap_history_entries BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_cap_history_entries_delete
AFTER DELETE ON pricing_cap_history_entries BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_config_versions_insert
AFTER INSERT ON pricing_config_versions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_config_versions_update
AFTER UPDATE ON pricing_config_versions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_config_versions_delete
AFTER DELETE ON pricing_config_versions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_configs_insert
AFTER INSERT ON pricing_configs BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_configs_update
AFTER UPDATE ON pricing_configs BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_configs_delete
AFTER DELETE ON pricing_configs BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_effects_insert
AFTER INSERT ON pricing_effects BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_effects_update
AFTER UPDATE ON pricing_effects BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_effects_delete
AFTER DELETE ON pricing_effects BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_history_entries_insert
AFTER INSERT ON pricing_history_entries BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_history_entries_update
AFTER UPDATE ON pricing_history_entries BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_history_entries_delete
AFTER DELETE ON pricing_history_entries BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_release_heads_insert
AFTER INSERT ON pricing_release_heads BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_release_heads_update
AFTER UPDATE ON pricing_release_heads BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_release_heads_delete
AFTER DELETE ON pricing_release_heads BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_releases_insert
AFTER INSERT ON pricing_releases BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_releases_update
AFTER UPDATE ON pricing_releases BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_pricing_releases_delete
AFTER DELETE ON pricing_releases BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_redeem_codes_insert
AFTER INSERT ON redeem_codes BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_redeem_codes_update
AFTER UPDATE ON redeem_codes BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_redeem_codes_delete
AFTER DELETE ON redeem_codes BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_redeem_records_insert
AFTER INSERT ON redeem_records BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_redeem_records_update
AFTER UPDATE ON redeem_records BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_redeem_records_delete
AFTER DELETE ON redeem_records BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_session_pricing_releases_insert
AFTER INSERT ON session_pricing_releases BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_session_pricing_releases_update
AFTER UPDATE ON session_pricing_releases BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_session_pricing_releases_delete
AFTER DELETE ON session_pricing_releases BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_sessions_insert
AFTER INSERT ON sessions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_sessions_update
AFTER UPDATE ON sessions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_sessions_delete
AFTER DELETE ON sessions BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_settlement_adjustments_insert
AFTER INSERT ON settlement_adjustments BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_settlement_adjustments_update
AFTER UPDATE ON settlement_adjustments BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_settlement_adjustments_delete
AFTER DELETE ON settlement_adjustments BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_settlement_charge_items_insert
AFTER INSERT ON settlement_charge_items BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_settlement_charge_items_update
AFTER UPDATE ON settlement_charge_items BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_settlement_charge_items_delete
AFTER DELETE ON settlement_charge_items BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_settlements_insert
AFTER INSERT ON settlements BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_settlements_update
AFTER UPDATE ON settlements BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_settlements_delete
AFTER DELETE ON settlements BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_billing_settings_insert
AFTER INSERT ON shop_billing_settings BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_billing_settings_update
AFTER UPDATE ON shop_billing_settings BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_billing_settings_delete
AFTER DELETE ON shop_billing_settings BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_imported_accounts_insert
AFTER INSERT ON shop_imported_accounts BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_imported_accounts_update
AFTER UPDATE ON shop_imported_accounts BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_imported_accounts_delete
AFTER DELETE ON shop_imported_accounts BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_members_insert
AFTER INSERT ON shop_members BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_members_update
AFTER UPDATE ON shop_members BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_members_delete
AFTER DELETE ON shop_members BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
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
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_player_accounts_insert
AFTER INSERT ON shop_player_accounts BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_player_accounts_update
AFTER UPDATE ON shop_player_accounts BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_player_accounts_delete
AFTER DELETE ON shop_player_accounts BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_staff_accounts_insert
AFTER INSERT ON shop_staff_accounts BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_staff_accounts_update
AFTER UPDATE ON shop_staff_accounts BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shop_staff_accounts_delete
AFTER DELETE ON shop_staff_accounts BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_staff_users_insert
AFTER INSERT ON staff_users BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_staff_users_update
AFTER UPDATE ON staff_users BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.shop_id OR shop_id=OLD.shop_id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_staff_users_delete
AFTER DELETE ON staff_users BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.shop_id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shops_insert
AFTER INSERT ON shops BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=NEW.id AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shops_update
AFTER UPDATE ON shops BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE (shop_id=NEW.id OR shop_id=OLD.id) AND kind='import' AND status='ready';
END;
CREATE TRIGGER IF NOT EXISTS shop_import_target_shops_delete
AFTER DELETE ON shops BEGIN
 UPDATE shop_data_jobs SET status='stale' WHERE shop_id=OLD.id AND kind='import' AND status='ready';
END;
