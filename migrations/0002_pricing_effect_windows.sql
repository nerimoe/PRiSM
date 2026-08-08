CREATE TABLE IF NOT EXISTS pricing_effects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('free', 'discount', 'percentage-discount', 'surcharge')),
  scope TEXT NOT NULL CHECK (scope IN ('session', 'unified')),
  value REAL,
  consumable INTEGER NOT NULL DEFAULT 0 CHECK (consumable IN (0, 1)),
  limit_per_day INTEGER,
  active_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  config_json TEXT
);

ALTER TABLE asset_definitions ADD COLUMN pricing_effect_id TEXT;
ALTER TABLE asset_definitions ADD COLUMN active_at TEXT;
ALTER TABLE asset_definitions ADD COLUMN expires_at TEXT;

ALTER TABLE presents ADD COLUMN active_at TEXT;
ALTER TABLE presents ADD COLUMN expires_at TEXT;
