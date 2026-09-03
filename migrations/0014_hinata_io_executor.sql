PRAGMA foreign_keys = OFF;

CREATE TABLE device_commands_next (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('power.on', 'power.off', 'ac.set_temperature', 'coin', 'aime.scan', 'door.open')),
  device_id TEXT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('facility', 'game_machine')),
  executor_kind TEXT NOT NULL CHECK (executor_kind IN ('home_assistant', 'machine_ws', 'hinata_io')),
  player_id TEXT,
  staff_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'acked', 'expired', 'rejected')),
  payload_json TEXT,
  requested_at TEXT NOT NULL,
  acked_at TEXT,
  expired_at TEXT,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

INSERT INTO device_commands_next (
  id,
  type,
  device_id,
  target_kind,
  executor_kind,
  player_id,
  staff_id,
  status,
  payload_json,
  requested_at,
  acked_at,
  expired_at
)
SELECT
  id,
  type,
  device_id,
  target_kind,
  executor_kind,
  player_id,
  staff_id,
  status,
  payload_json,
  requested_at,
  acked_at,
  expired_at
FROM device_commands;

DROP TABLE device_commands;
ALTER TABLE device_commands_next RENAME TO device_commands;

CREATE INDEX IF NOT EXISTS idx_device_commands_status_requested
  ON device_commands(status, requested_at);

CREATE TABLE device_states_next (
  device_id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('power.on', 'power.off', 'ac.set_temperature', 'coin', 'aime.scan', 'door.open')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('facility', 'game_machine')),
  executor_kind TEXT NOT NULL CHECK (executor_kind IN ('home_assistant', 'machine_ws', 'hinata_io')),
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'degraded')),
  state TEXT NOT NULL,
  metadata_json TEXT,
  reported_at TEXT NOT NULL,
  reported_by TEXT NOT NULL
);

INSERT INTO device_states_next (
  device_id,
  type,
  target_kind,
  executor_kind,
  label,
  status,
  state,
  metadata_json,
  reported_at,
  reported_by
)
SELECT
  device_id,
  type,
  target_kind,
  executor_kind,
  label,
  status,
  state,
  metadata_json,
  reported_at,
  reported_by
FROM device_states;

DROP TABLE device_states;
ALTER TABLE device_states_next RENAME TO device_states;

CREATE INDEX IF NOT EXISTS idx_device_states_reported_at
  ON device_states(reported_at);

PRAGMA foreign_keys = ON;
