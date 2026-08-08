CREATE TABLE IF NOT EXISTS machine_connections (
  machine_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('online', 'offline')),
  capabilities_json TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  disconnected_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_machine_connections_status_seen
  ON machine_connections(status, last_seen_at);
