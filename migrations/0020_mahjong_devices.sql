ALTER TABLE machines ADD COLUMN mahjong_config_json TEXT;
CREATE TABLE mahjong_seats (
  shop_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  session_id TEXT NOT NULL,
  entry_session_id TEXT,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (shop_id,player_id),
  UNIQUE (shop_id,session_id),
  FOREIGN KEY (shop_id,player_id) REFERENCES players(shop_id,id),
  FOREIGN KEY (shop_id,entry_session_id) REFERENCES sessions(shop_id,id)
);
CREATE INDEX mahjong_seats_device ON mahjong_seats(machine_id);
