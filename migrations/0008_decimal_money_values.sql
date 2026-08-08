PRAGMA foreign_keys = OFF;

CREATE TABLE asset_holdings_decimal (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_code TEXT NOT NULL,
  quantity REAL NOT NULL,
  active_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (asset_type, asset_code) REFERENCES asset_definitions(type, code)
);
INSERT INTO asset_holdings_decimal SELECT id, player_id, asset_type, asset_code, quantity, active_at, expires_at FROM asset_holdings;
DROP TABLE asset_holdings;
ALTER TABLE asset_holdings_decimal RENAME TO asset_holdings;

CREATE TABLE asset_ledger_entries_decimal (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  transaction_id TEXT,
  asset_type TEXT NOT NULL,
  asset_code TEXT NOT NULL,
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (transaction_id) REFERENCES asset_transactions(id),
  FOREIGN KEY (asset_type, asset_code) REFERENCES asset_definitions(type, code)
);
INSERT INTO asset_ledger_entries_decimal SELECT id, player_id, transaction_id, asset_type, asset_code, delta, reason, ref_id, created_at FROM asset_ledger_entries;
DROP TABLE asset_ledger_entries;
ALTER TABLE asset_ledger_entries_decimal RENAME TO asset_ledger_entries;

CREATE TABLE pricing_effects_decimal (
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
INSERT INTO pricing_effects_decimal SELECT id, name, type, scope, value, consumable, limit_per_day, active_at, expires_at, status, config_json FROM pricing_effects;
DROP TABLE pricing_effects;
ALTER TABLE pricing_effects_decimal RENAME TO pricing_effects;

CREATE TABLE settlements_decimal (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  subtotal REAL NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('settled')),
  settled_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
INSERT INTO settlements_decimal SELECT id, session_id, subtotal, total, status, settled_at FROM settlements;
DROP TABLE settlements;
ALTER TABLE settlements_decimal RENAME TO settlements;

CREATE TABLE settlement_charge_items_decimal (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  item_order INTEGER NOT NULL,
  source TEXT NOT NULL,
  label TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
INSERT INTO settlement_charge_items_decimal SELECT id, session_id, item_order, source, label, amount FROM settlement_charge_items;
DROP TABLE settlement_charge_items;
ALTER TABLE settlement_charge_items_decimal RENAME TO settlement_charge_items;

CREATE TABLE settlement_adjustments_decimal (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  adjustment_order INTEGER NOT NULL,
  source TEXT NOT NULL,
  label TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
INSERT INTO settlement_adjustments_decimal SELECT id, session_id, adjustment_order, source, label, amount FROM settlement_adjustments;
DROP TABLE settlement_adjustments;
ALTER TABLE settlement_adjustments_decimal RENAME TO settlement_adjustments;

CREATE TABLE pricing_history_entries_decimal (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  pricing_config_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_anchor_at TEXT NOT NULL,
  session_id TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY (player_id) REFERENCES players(id)
);
INSERT INTO pricing_history_entries_decimal SELECT id, player_id, pricing_config_id, provider_id, rule_id, rule_anchor_at, session_id, amount, created_at, metadata_json FROM pricing_history_entries;
DROP TABLE pricing_history_entries;
ALTER TABLE pricing_history_entries_decimal RENAME TO pricing_history_entries;

CREATE TABLE business_items_decimal (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  price REAL NOT NULL,
  asset_type TEXT,
  asset_code TEXT,
  active_at TEXT,
  expires_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO business_items_decimal SELECT id, kind, name, status, price, asset_type, asset_code, active_at, expires_at, metadata_json, created_at, updated_at FROM business_items;
DROP TABLE business_items;
ALTER TABLE business_items_decimal RENAME TO business_items;

CREATE TABLE business_item_orders_decimal (
  id TEXT PRIMARY KEY,
  business_item_id TEXT NOT NULL,
  business_item_kind TEXT NOT NULL,
  business_item_name TEXT NOT NULL,
  player_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('paid', 'fulfilled', 'cancelled')),
  price REAL NOT NULL,
  asset_type TEXT,
  asset_code TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fulfilled_at TEXT,
  cancelled_at TEXT,
  FOREIGN KEY (business_item_id) REFERENCES business_items(id),
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
INSERT INTO business_item_orders_decimal SELECT id, business_item_id, business_item_kind, business_item_name, player_id, session_id, status, price, asset_type, asset_code, metadata_json, created_at, updated_at, fulfilled_at, cancelled_at FROM business_item_orders;
DROP TABLE business_item_orders;
ALTER TABLE business_item_orders_decimal RENAME TO business_item_orders;

CREATE INDEX IF NOT EXISTS idx_asset_holdings_player ON asset_holdings(player_id);
CREATE INDEX IF NOT EXISTS idx_asset_ledger_player_created ON asset_ledger_entries(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_business_items_status_updated ON business_items(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_business_items_kind_status ON business_items(kind, status);
CREATE INDEX IF NOT EXISTS idx_business_item_orders_player_created ON business_item_orders(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_business_item_orders_item_status ON business_item_orders(business_item_id, status);
CREATE INDEX IF NOT EXISTS idx_settlement_charge_items_session_order ON settlement_charge_items(session_id, item_order);
CREATE INDEX IF NOT EXISTS idx_settlement_adjustments_session_order ON settlement_adjustments(session_id, adjustment_order);
CREATE INDEX IF NOT EXISTS idx_pricing_history_player_rule_anchor ON pricing_history_entries(player_id, provider_id, rule_id, rule_anchor_at);
CREATE INDEX IF NOT EXISTS idx_pricing_history_session ON pricing_history_entries(session_id);

PRAGMA foreign_keys = ON;
