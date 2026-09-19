CREATE TABLE IF NOT EXISTS checkout_timelines (
  shop_id TEXT NOT NULL DEFAULT 'legacy',
  checkout_id TEXT NOT NULL,
  timeline_json TEXT NOT NULL,
  PRIMARY KEY (shop_id, checkout_id),
  FOREIGN KEY (shop_id, checkout_id) REFERENCES player_checkouts(shop_id, id)
);
