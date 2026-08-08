CREATE TABLE IF NOT EXISTS checkout_locks (
  player_id TEXT PRIMARY KEY,
  lock_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE INDEX IF NOT EXISTS idx_checkout_locks_expires_at
  ON checkout_locks(expires_at);
