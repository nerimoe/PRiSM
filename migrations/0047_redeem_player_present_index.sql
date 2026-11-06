CREATE INDEX IF NOT EXISTS idx_redeem_records_player_present
  ON redeem_records(shop_id, player_id, present_id);
