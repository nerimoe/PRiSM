CREATE TABLE IF NOT EXISTS player_sessions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE INDEX IF NOT EXISTS idx_player_sessions_token
  ON player_sessions(token_hash);
