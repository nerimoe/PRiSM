CREATE TABLE IF NOT EXISTS staff_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'viewer')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  staff_user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  FOREIGN KEY (staff_user_id) REFERENCES staff_users(id)
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('player', 'bot', 'agent')),
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'banned')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS player_identities (
  player_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS asset_definitions (
  type TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  stackable INTEGER NOT NULL DEFAULT 1 CHECK (stackable IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  metadata_json TEXT,
  PRIMARY KEY (type, code)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  pricing_config_ids_json TEXT NOT NULL DEFAULT '[]',
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
  label TEXT,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS asset_holdings (
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

CREATE TABLE IF NOT EXISTS asset_transactions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS asset_ledger_entries (
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

CREATE TABLE IF NOT EXISTS redeem_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  present_id TEXT NOT NULL,
  active_at TEXT,
  expires_at TEXT,
  max_use_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  once_per_player INTEGER NOT NULL DEFAULT 0 CHECK (once_per_player IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  grants_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS redeem_records (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  code_id TEXT NOT NULL,
  present_id TEXT NOT NULL,
  redeemed_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (code_id) REFERENCES redeem_codes(id)
);

CREATE TABLE IF NOT EXISTS device_commands (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('door', 'power', 'coin', 'scan')),
  device_id TEXT NOT NULL,
  player_id TEXT,
  staff_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'acked', 'expired', 'rejected')),
  payload_json TEXT,
  requested_at TEXT NOT NULL,
  acked_at TEXT,
  expired_at TEXT,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS device_states (
  device_id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('door', 'power', 'coin', 'scan')),
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'degraded')),
  state TEXT NOT NULL,
  metadata_json TEXT,
  reported_at TEXT NOT NULL,
  reported_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  subtotal REAL NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('settled')),
  settled_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS settlement_charge_items (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  item_order INTEGER NOT NULL,
  source TEXT NOT NULL,
  label TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS settlement_adjustments (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  adjustment_order INTEGER NOT NULL,
  source TEXT NOT NULL,
  label TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS pricing_history_entries (
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

CREATE TABLE IF NOT EXISTS pricing_configs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('time.priority', 'charge.fixed')),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  provider_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS business_items (
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

CREATE TABLE IF NOT EXISTS business_item_orders (
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

CREATE INDEX IF NOT EXISTS idx_sessions_player_status ON sessions(player_id, status);
CREATE INDEX IF NOT EXISTS idx_player_identities_player ON player_identities(player_id);
CREATE INDEX IF NOT EXISTS idx_asset_holdings_player ON asset_holdings(player_id);
CREATE INDEX IF NOT EXISTS idx_asset_transactions_player_created ON asset_transactions(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_asset_ledger_player_created ON asset_ledger_entries(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_redeem_records_code ON redeem_records(code_id);
CREATE INDEX IF NOT EXISTS idx_device_commands_status_requested ON device_commands(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_device_states_reported_at ON device_states(reported_at);
CREATE INDEX IF NOT EXISTS idx_pricing_configs_enabled_updated ON pricing_configs(enabled, updated_at);
CREATE INDEX IF NOT EXISTS idx_business_items_status_updated ON business_items(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_business_items_kind_status ON business_items(kind, status);
CREATE INDEX IF NOT EXISTS idx_business_item_orders_player_created ON business_item_orders(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_business_item_orders_item_status ON business_item_orders(business_item_id, status);
CREATE INDEX IF NOT EXISTS idx_settlement_charge_items_session_order ON settlement_charge_items(session_id, item_order);
CREATE INDEX IF NOT EXISTS idx_settlement_adjustments_session_order ON settlement_adjustments(session_id, adjustment_order);
CREATE INDEX IF NOT EXISTS idx_pricing_history_player_rule_anchor ON pricing_history_entries(player_id, provider_id, rule_id, rule_anchor_at);
CREATE INDEX IF NOT EXISTS idx_pricing_history_session ON pricing_history_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_staff_users_role_status ON staff_users(role, status);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_role_status ON api_tokens(role, status);
