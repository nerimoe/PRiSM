CREATE INDEX IF NOT EXISTS idx_device_commands_player_requested
ON device_commands(shop_id, player_id, requested_at, type, status);
