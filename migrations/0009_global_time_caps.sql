CREATE TABLE pricing_configs_global_cap_migration (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('time.priority', 'time.cap', 'charge.fixed')),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  provider_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO pricing_configs_global_cap_migration
SELECT id, kind, name, enabled, status, provider_json, created_at, updated_at
FROM pricing_configs;

DROP TABLE pricing_configs;

ALTER TABLE pricing_configs_global_cap_migration RENAME TO pricing_configs;

CREATE INDEX IF NOT EXISTS idx_pricing_configs_enabled_updated ON pricing_configs(enabled, updated_at);

DROP INDEX IF EXISTS idx_pricing_history_player_rule_anchor;
CREATE INDEX IF NOT EXISTS idx_pricing_history_player_rule_anchor
  ON pricing_history_entries(player_id, pricing_config_id, provider_id, rule_id, rule_anchor_at);

CREATE TABLE IF NOT EXISTS pricing_cap_history_entries (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  cap_config_id TEXT NOT NULL,
  cap_rule_id TEXT NOT NULL,
  cap_anchor_at TEXT NOT NULL,
  included_pricing_config_ids_json TEXT NOT NULL,
  session_ids_json TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE INDEX IF NOT EXISTS idx_pricing_cap_history_player_rule_anchor
  ON pricing_cap_history_entries(player_id, cap_config_id, cap_rule_id, cap_anchor_at);
